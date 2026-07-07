"use strict";
// The LLM's real capabilities: semantic memory, a root workbench shell, and shared files.
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const Docker = require("dockerode");
const { config, getSecrets, setSecret: cfgSetSecret, deleteSecret: cfgDeleteSecret } = require("./config");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Truncate long tool output keeping the HEAD and the TAIL (errors usually live at the
// tail of a log) with an explicit marker so the model KNOWS content was cut.
function clipOutput(s, headMax = 12000, tailMax = 8000) {
  if (s.length <= headMax + tailMax) return s;
  const cut = s.length - headMax - tailMax;
  return s.slice(0, headMax) + `\n... [TRUNCATED: ${cut} bytes omitted from the middle — total output ${s.length} bytes] ...\n` + s.slice(-tailMax);
}

// --- run_shell: root command in the workbench container ---
async function runShell(command, timeoutS) {
  const name = (config.workbench && config.workbench.container) || "jarvis-workbench";
  const container = docker.getContainer(name);
  // Enforce a hard time limit INSIDE the container so an interactive prompt or a
  // foreground server can't hang the whole turn forever (`timeout` sends TERM, then KILL).
  const t = Math.min(600, Math.max(1, Number(timeoutS) || 120));
  const exec = await container.exec({
    Cmd: ["timeout", "-k", "5", String(t), "bash", "-lc", command], AttachStdout: true, AttachStderr: true, User: "0",
    Env: ["DISPLAY=:1"], // so GUI commands target the watchable desktop
    WorkingDir: "/workspace", // persistent project dir (survives rebuilds)
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise((resolve, reject) => {
    let out = Buffer.alloc(0), settled = false;
    const finish = async (timedOut) => {
      if (settled) return; settled = true;
      clearTimeout(guard);
      let info = {};
      try { info = await exec.inspect(); } catch (_) {}
      const code = info.ExitCode ?? null;
      let output = clipOutput(out.toString("utf8"));
      if (code === 124 || timedOut) output += `\n[KILLED: command exceeded the ${t}s time limit — pass a larger timeout_s or run it in the background with nohup]`;
      resolve({ exit_code: code, output });
    };
    // Node-side safety net in case the in-container timeout itself wedges.
    const guard = setTimeout(() => { try { stream.destroy(); } catch (_) {} finish(true); }, (t + 15) * 1000);
    const sink = { write: (c) => { out = Buffer.concat([out, c]); } };
    container.modem.demuxStream(stream, sink, sink);
    stream.on("end", () => finish(false));
    stream.on("close", () => finish(false));
    stream.on("error", (e) => { if (!settled) { settled = true; clearTimeout(guard); reject(e); } });
  });
}

// Write a file anywhere in the workbench (e.g. /workspace/app.py) RELIABLY, with no
// shell-quoting issues — content is base64-piped in. Use this to create code/config
// files for the workbench instead of run_shell heredocs/echo.
async function writeWorkbenchFile(p, content) {
  if (!p || !String(p).startsWith("/")) throw new Error("path must be an absolute workbench path, e.g. /workspace/app.py");
  const b64 = Buffer.from(content == null ? "" : String(content)).toString("base64");
  const dir = String(p).replace(/\/[^/]*$/, "") || "/";
  const r = await runShell(`mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(p)} && wc -c < ${shq(p)}`);
  if (r.exit_code) throw new Error("write failed: " + (r.output || "").slice(0, 300));
  return { written: p, bytes: parseInt((r.output || "0").trim(), 10) || 0 };
}

// --- shared files (read-only + read-write dirs) ---
function resolveShared(p, mustWrite) {
  const ro = config.shared.read_only_dir;
  const rw = config.shared.read_write_dir;
  let abs;
  if (!p) abs = path.resolve(rw);
  else if (path.isAbsolute(p)) abs = path.resolve(p);
  else abs = path.resolve(rw, p); // a bare/relative name goes into the read-write folder
  // Resolve symlinks so a link planted inside the shared dirs can't escape them.
  try { abs = fs.realpathSync(abs); }
  catch { try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_) {} }
  const inRo = abs === ro || abs.startsWith(ro + path.sep);
  const inRw = abs === rw || abs.startsWith(rw + path.sep);
  if (mustWrite && !inRw) throw new Error(`write is only allowed under ${rw}`);
  if (!inRo && !inRw) throw new Error(`path must be under ${ro} (read-only) or ${rw} (read-write)`);
  return abs;
}

// Read an image file and hand it back as an inline image; the llm.js "look step" sees the
// __image__ marker and runs it through the vision model (with the tool call's `question`).
const IMG_MIME = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp", svg: "svg+xml", tif: "tiff", tiff: "tiff" };
async function analyzeImageFile(p) {
  if (!p) throw new Error("path to the image is required");
  const abs = resolveShared(p, false);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  const st = fs.statSync(abs);
  if (st.size > 8 * 1024 * 1024) throw new Error(`image too large (${Math.round(st.size / 1048576)}MB, max 8MB) — downscale it first with run_shell (e.g. convert in.png -resize 1600x out.png)`);
  const buf = fs.readFileSync(abs);
  const ext = (path.extname(abs).slice(1) || "").toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) throw new Error(`'.${ext || "?"}' is not a supported image type (${Object.keys(IMG_MIME).join(", ")}) — convert it first with run_shell`);
  return { __image__: `data:image/${mime};base64,` + buf.toString("base64"), file: path.basename(abs), bytes: buf.length };
}
async function listDir(p) {
  const abs = resolveShared(p, false);
  return fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
    const e = { name: d.name, type: d.isDirectory() ? "dir" : "file" };
    if (!d.isDirectory()) { try { const st = fs.statSync(path.join(abs, d.name)); e.bytes = st.size; e.modified = new Date(st.mtimeMs).toISOString(); } catch (_) {} }
    return e;
  });
}
async function readFile(p, offset, maxChars) {
  const abs = resolveShared(p, false);
  const buf = fs.readFileSync(abs);
  // Binary sniff: a NUL byte in the head means this isn't text — give a directive
  // error instead of returning mojibake the model will try to reason about.
  if (buf.subarray(0, 8192).includes(0)) {
    throw new Error(`'${path.basename(abs)}' is a binary file (${buf.length} bytes) — use analyze_image for images, read_document for PDFs/Office docs, or run_shell to process it`);
  }
  const text = buf.toString("utf8");
  const off = Math.max(0, Number(offset) || 0);
  const max = Math.min(100000, Math.max(100, Number(maxChars) || 50000));
  const out = { path: abs, total_chars: text.length, content: text.slice(off, off + max) };
  if (text.length > off + max) out.note = `truncated: showing chars ${off}-${off + max} of ${text.length} — re-call with offset:${off + max} for the rest`;
  return out;
}
async function writeFile(p, content, append) {
  const abs = resolveShared(p, true);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let data = content == null ? "" : String(content);
  if (append) {
    // Guarantee each appended entry starts on its own line: if the file already
    // has content that doesn't end in a newline, insert one before the new data.
    let needsNewline = false;
    try {
      const st = fs.statSync(abs);
      if (st.size > 0) {
        const fd = fs.openSync(abs, "r");
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st.size - 1);
        fs.closeSync(fd);
        needsNewline = last[0] !== 0x0a; // last byte is not "\n"
      }
    } catch (_) {}
    if (needsNewline && !data.startsWith("\n")) data = "\n" + data;
    fs.appendFileSync(abs, data);
  } else {
    fs.writeFileSync(abs, data);
  }
  return { [append ? "appended" : "written"]: abs, bytes: Buffer.byteLength(data) };
}

// Append one consistently-formatted log line. The CODE owns the format so every
// entry looks the same regardless of how the model phrases it: an ISO-8601 UTC
// timestamp, a " | " separator, the message collapsed to a single line, and a
// guaranteed trailing newline. Optional structured fields are appended as k=v.
async function appendLog(p, message, fields) {
  const ts = new Date().toISOString();
  const msg = (message == null ? "" : String(message)).replace(/\s*\r?\n\s*/g, " ").trim();
  let extra = "";
  if (fields && typeof fields === "object") {
    extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v).replace(/\s*\r?\n\s*/g, " ")}`)
      .join(" ");
    if (extra) extra = " | " + extra;
  }
  const line = `${ts} | ${msg}${extra}\n`;
  const r = await writeFile(p, line, true);
  return { appended: r.appended, entry: line.trimEnd() };
}

// --- internet access (open; no allow-list) ---
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function decodeDuck(href) {
  try { const u = new URL(href, "https://duckduckgo.com"); const t = u.searchParams.get("uddg"); return t ? decodeURIComponent(t) : href; }
  catch { return href; }
}

// SSRF guard: refuse to fetch private/loopback/link-local addresses so a
// prompt-injected page can't make JARVIS hit internal services or cloud metadata.
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const s = (ip || "").toLowerCase();
  return s === "::1" || s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("::ffff:127.") || s.startsWith("::ffff:10.") || s.startsWith("::ffff:192.168.");
}
async function assertPublicUrl(url) {
  let host; try { host = new URL(url).hostname; } catch { throw new Error("invalid url"); }
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    // Fail CLOSED: if we can't resolve the host ourselves, don't let fetch try anyway.
    try { ips = (await dns.lookup(host, { all: true })).map((a) => a.address); }
    catch (e) { throw new Error("SSRF guard: could not resolve host '" + host + "' (" + e.code + ")"); }
  }
  if (ips.some(isPrivateIp)) throw new Error("blocked by SSRF guard: refusing to fetch a private/loopback/link-local address (" + ips.join(",") + ")");
}

async function fetchUrl(url, opts = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  const timeoutMs = Math.min(120, Math.max(2, Number(opts.timeout_s) || 30)) * 1000;
  const reqHeaders = { "User-Agent": "JARVIS/1.0", ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined && body === undefined) { body = JSON.stringify(opts.json); if (!reqHeaders["Content-Type"]) reqHeaders["Content-Type"] = "application/json"; }
  // Follow redirects MANUALLY so every hop is re-checked by the SSRF guard (a public
  // page 302ing to an internal address must be blocked, not followed).
  let current = url, resp;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(current);
    resp = await fetch(current, {
      method: opts.method || "GET", headers: reqHeaders, body,
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      current = new URL(resp.headers.get("location"), current).href;
      if (hop === 5) throw new Error("too many redirects");
      continue;
    }
    break;
  }
  const ct = resp.headers.get("content-type") || "";
  const isText = /text|html|json|xml|javascript|csv|urlencoded/i.test(ct) || ct === "";
  // Binary responses: save to the shared folder (for analyze_image / read_document)
  // instead of returning mojibake.
  if (!isText) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (opts.save_to) {
      const abs = resolveShared(opts.save_to, true);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return { url: current, status: resp.status, content_type: ct, saved_to: abs, bytes: buf.length };
    }
    return { url: current, status: resp.status, content_type: ct, note: "binary content (" + buf.length + " bytes) — re-call with save_to:'downloads/<name>' to save it to the shared folder, then use analyze_image or read_document on it" };
  }
  let text = await resp.text();
  if (/html/i.test(ct)) text = stripHtml(text);
  const off = Math.max(0, Number(opts.offset) || 0);
  const slice = text.slice(off, off + 15000);
  const out = { url: current, status: resp.status, content_type: ct, content: slice };
  if (text.length > off + 15000) out.note = `truncated: showing chars ${off}-${off + 15000} of ${text.length} — re-call with offset:${off + 15000} for more`;
  return out;
}

async function webSearch(query, limit = 8) {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": "Mozilla/5.0 JARVIS/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  const html = await resp.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < Math.min(20, Math.max(1, limit || 8))) {
    const entry = { title: stripHtml(m[2]), url: decodeDuck(m[1]) };
    // Grab the snippet that follows this result so the model learns something without
    // having to fetch every page.
    const after = html.slice(m.index, m.index + 3000);
    const sm = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(after) || /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div)>/i.exec(after);
    if (sm) entry.snippet = stripHtml(sm[1]).slice(0, 300);
    results.push(entry);
  }
  // A rate-limit/anomaly page parses as zero results — say so EXPLICITLY instead of
  // looking identical to "nothing found".
  if (!results.length) {
    if (/anomaly|captcha|unusual traffic|challenge/i.test(html) || html.length < 2000) {
      return { query, results: [], error: "search engine blocked/rate-limited this request (not an empty result) — wait and retry, or fetch a known site directly" };
    }
    return { query, results: [], note: "no results parsed — the query may have no matches, or the result page format changed" };
  }
  return { query, results };
}

// --- desktop control (computer use) on the watchable XFCE desktop ---
const SCREEN_PATH = "/READ_WRITE_FILES/.jarvis_screen.png"; // mounted in both app + workbench
const px = (n) => Math.round(Number(n)) || 0;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function screenshot() {
  const r = await runShell(
    `import -window root ${SCREEN_PATH} 2>/dev/null || (xwd -root -silent | convert xwd:- ${SCREEN_PATH}); xdotool getdisplaygeometry`
  );
  const geo = (r.output || "").trim().split(/\s+/);
  try {
    const buf = fs.readFileSync(SCREEN_PATH);
    return { __image__: "data:image/png;base64," + buf.toString("base64"), width: Number(geo[0]) || null, height: Number(geo[1]) || null, bytes: buf.length };
  } catch (e) {
    return { error: "screenshot read failed: " + e.message, shell: r };
  }
}
// `button` is clamped to an integer 1-9 — it reaches a shell line, so it must never
// pass through as a raw string.
async function clickAt(x, y, button = 1) {
  const btn = Math.min(9, Math.max(1, px(button) || 1));
  return runShell(`xdotool mousemove ${px(x)} ${px(y)} click ${btn}`);
}
async function doubleClick(x, y) { return runShell(`xdotool mousemove ${px(x)} ${px(y)} click --repeat 2 1`); }
async function moveMouse(x, y) { return runShell(`xdotool mousemove ${px(x)} ${px(y)}`); }
async function typeText(text) {
  const b64 = Buffer.from(String(text == null ? "" : text)).toString("base64");
  return runShell(`echo ${b64} | base64 -d | xdotool type --clearmodifiers --file -`);
}
async function pressKey(keys) {
  // Support a SEQUENCE separated by spaces ("ctrl+a BackSpace") — each token is
  // sanitized separately so the old sanitizer can't silently glue them into one chord.
  const toks = String(keys || "").trim().split(/\s+/)
    .map((k) => k.replace(/[^a-zA-Z0-9+_]/g, "")).filter(Boolean);
  if (!toks.length) throw new Error("no key specified");
  return runShell(`xdotool key --clearmodifiers ${toks.join(" ")}`);
}
async function scrollWheel(direction, amount = 3) {
  const btn = String(direction).toLowerCase() === "up" ? 4 : 5;
  return runShell(`xdotool click --repeat ${px(amount) || 1} ${btn}`);
}
async function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  return runShell(`nohup chromium --no-sandbox --new-window ${shq(url)} >/dev/null 2>&1 & disown; echo launched`);
}
async function openApp(command) {
  if (!command) throw new Error("no command");
  return runShell(`nohup ${command} >/dev/null 2>&1 & disown; echo launched`);
}
// Run a SEQUENCE of desktop actions in one tool call (one LLM turn) instead of many.
// Each step's exit code is checked — the sequence STOPS at the first failure and says
// which step failed, so a broken 10-step plan can't report itself as fully performed.
async function uiActions(actions) {
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions must be a non-empty array of {action, ...} steps");
  if (actions.length > 50) throw new Error("too many actions (max 50 per call) — split the plan");
  const performed = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] || {};
    const act = a.action;
    let r = null, label;
    if (act === "click") { r = await clickAt(a.x, a.y, a.button || 1); label = `click(${px(a.x)},${px(a.y)})`; }
    else if (act === "double_click") { r = await doubleClick(a.x, a.y); label = `double_click(${px(a.x)},${px(a.y)})`; }
    else if (act === "right_click") { r = await clickAt(a.x, a.y, 3); label = `right_click(${px(a.x)},${px(a.y)})`; }
    else if (act === "move") { r = await moveMouse(a.x, a.y); label = `move(${px(a.x)},${px(a.y)})`; }
    else if (act === "type") { r = await typeText(a.text); label = `type(${String(a.text || "").slice(0, 24)})`; }
    else if (act === "key") { r = await pressKey(a.keys); label = `key(${a.keys})`; }
    else if (act === "scroll") { r = await scrollWheel(a.direction, a.amount || 3); label = `scroll(${a.direction})`; }
    else if (act === "sleep") { await new Promise((res) => setTimeout(res, Math.min(5000, Number(a.ms) || 0))); performed.push(`sleep(${a.ms}ms)`); continue; }
    else { return { performed, failed_step: i, error: `unknown action '${act}' at step ${i} — valid: click, double_click, right_click, move, type, key, scroll, sleep` }; }
    if (r && r.exit_code) {
      return { performed, failed_step: i, error: `${label} failed (exit ${r.exit_code}): ${(r.output || "").slice(0, 200)} — remaining ${actions.length - i - 1} step(s) NOT performed` };
    }
    performed.push(label);
    // brief settle delay so the UI can react between steps
    await new Promise((res) => setTimeout(res, Math.min(2000, a.after_ms != null ? Number(a.after_ms) : 120)));
  }
  return { performed };
}

// Extract text from a PDF/Office document in the shared folders (pdftotext/pandoc run
// in the workbench, which mounts the same paths). Paged like read_file.
async function readDocument(p, offset, maxChars) {
  const abs = resolveShared(p, false);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  const ext = path.extname(abs).slice(1).toLowerCase();
  let conv;
  if (ext === "pdf") conv = `pdftotext -layout ${shq(abs)} -`;
  else if (["docx", "odt", "rtf", "epub", "html", "htm"].includes(ext)) conv = `pandoc -t plain ${shq(abs)}`;
  else if (["txt", "md", "csv", "json", "log"].includes(ext) || !ext) return await readFile(p, offset, maxChars);
  else throw new Error(`unsupported document type '.${ext}' — supported: pdf, docx, odt, rtf, epub, html (for images use analyze_image; for anything else use run_shell)`);
  const off = Math.max(0, Number(offset) || 0);
  const max = Math.min(50000, Math.max(100, Number(maxChars) || 15000));
  const r = await runShell(`t=$(mktemp); if ! ${conv} > "$t" 2>/tmp/.docerr; then echo "@@FAIL@@"; head -c 200 /tmp/.docerr; rm -f "$t"; exit 9; fi; total=$(wc -c < "$t"); echo "@@TOTAL:$total@@"; tail -c +${off + 1} "$t" | head -c ${max}; rm -f "$t"`, 120);
  if (r.exit_code || /@@FAIL@@/.test(r.output || "")) throw new Error(`document conversion failed: ${(r.output || "").replace("@@FAIL@@", "").trim().slice(0, 200)}`);
  const m = /@@TOTAL:(\d+)@@\n?/.exec(r.output || "");
  const total = m ? Number(m[1]) : null;
  const text = (r.output || "").replace(/^[\s\S]*?@@TOTAL:\d+@@\n?/, "");
  const out = { path: abs, total_chars: total, content: text };
  if (total && total > off + max) out.note = `truncated: showing chars ${off}-${off + max} of ${total} — re-call with offset:${off + max} for more`;
  return out;
}

// --- browser_* tools: deterministic DOM-level browser control via a Playwright ---
// daemon in the workbench (headed on the visible desktop; profile persists under
// /workspace/.browser_profile so logins survive). Far more reliable than pixel
// clicking for anything inside a web page.
const BROWSERD_URL = "http://jarvis-workbench:9251";
const BROWSERD_PY = fs.readFileSync(path.join(__dirname, "browserd.py"), "utf8");
let browserdStarting = null;
async function ensureBrowserd() {
  if (browserdStarting) return browserdStarting;
  browserdStarting = (async () => {
    try { const r = await fetch(BROWSERD_URL, { signal: AbortSignal.timeout(1500) }); if (r.ok) return; } catch (_) {}
    await writeWorkbenchFile("/opt/jarvis/browserd.py", BROWSERD_PY);
    // '[b]rowserd' so pkill can't match this very command line and kill its own shell;
    // setsid + </dev/null so the daemon escapes the exec session's process group and
    // survives after this shell exits (a plain nohup dies with the docker exec).
    await runShell("pkill -f '[b]rowserd.py' 2>/dev/null; sleep 0.3; setsid nohup python3 /opt/jarvis/browserd.py > /workspace/.browserd.log 2>&1 < /dev/null & disown; echo started");
    for (let i = 0; i < 30; i++) {
      await tsleep(1000);
      try { const r = await fetch(BROWSERD_URL, { signal: AbortSignal.timeout(1500) }); if (r.ok) return; } catch (_) {}
    }
    const log = await runShell("tail -5 /workspace/.browserd.log 2>/dev/null");
    throw new Error("browser daemon failed to start: " + (log.output || "").slice(0, 300));
  })().finally(() => { browserdStarting = null; });
  return browserdStarting;
}
async function browserCmd(op, params = {}) {
  const call = async () => {
    const r = await fetch(BROWSERD_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...params }), signal: AbortSignal.timeout(60000) });
    return await r.json();
  };
  try { return await call(); }
  catch (_) { await ensureBrowserd(); return await call(); }   // daemon down → start it once
}

// --- credential vault (the user's OWN accounts) ---
function listSecrets() {
  return Object.entries(getSecrets()).map(([name, v]) => ({ name, username: v.username || null, url: v.url || null, notes: v.notes || null }));
}
function getSecret(name) {
  const s = getSecrets();
  if (!s[name]) throw new Error("no secret named '" + name + "'");
  return s[name];
}

// --- OpenAI-style tool definitions exposed to the model ---
// --- semantic long-term memory (Mem0 sidecar: jarvis-memory) ---
function mem0Url() { return (((config.mem0 && config.mem0.url) || "http://jarvis-memory:8000")).replace(/\/+$/, ""); }
function mem0User() { return (config.mem0 && config.mem0.user_id) || "default"; }
async function mem0Fetch(p, opts = {}) {
  const resp = await fetch(mem0Url() + p, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(`memory service ${resp.status}: ${text.slice(0, 300)}`);
  return json;
}
async function addMemory(text, metadata) {
  return await mem0Fetch("/add", { method: "POST", body: { text, user_id: mem0User(), metadata: metadata || {} } });
}
async function searchMemory(query, limit) {
  const r = await mem0Fetch("/search", { method: "POST", body: { query, user_id: mem0User(), limit: limit || 8 } });
  // Keep timestamps/metadata so the model can reason about WHEN something was saved.
  const items = (r.results || []).map((m) => ({ id: m.id, memory: m.memory || m.text, score: m.score, created_at: m.created_at || undefined, metadata: m.metadata && Object.keys(m.metadata).length ? m.metadata : undefined }));
  return { results: items };
}
async function listMemories() {
  const r = await mem0Fetch("/all?user_id=" + encodeURIComponent(mem0User()));
  return { results: (r.results || []).map((m) => ({ id: m.id, memory: m.memory || m.text, created_at: m.created_at || undefined })) };
}
async function deleteMemory(id) {
  return await mem0Fetch("/delete", { method: "POST", body: { memory_id: id } });
}
async function updateMemory(id, text) {
  if (!id || !text) throw new Error("id and text are both required");
  return await mem0Fetch("/update", { method: "POST", body: { memory_id: id, text } });
}

// --- web app preview: run a server in the workbench on a host-reachable port ---
const tsleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREVIEW_MIN = 9101, PREVIEW_MAX = 9150;
async function serveApp(command, port, cwd) {
  if (!command) throw new Error("command is required (the server start command)");
  port = parseInt(port, 10);
  if (!(port >= PREVIEW_MIN && port <= PREVIEW_MAX)) throw new Error(`port must be in ${PREVIEW_MIN}-${PREVIEW_MAX} (these are the ports exposed to the user's browser)`);
  const dir = cwd || "/workspace";
  await runShell(`fuser -k ${port}/tcp 2>/dev/null; true`); // free the port if something's on it
  await runShell(`cd ${shq(dir)} 2>/dev/null; nohup bash -lc ${shq(command)} > /workspace/.preview_${port}.log 2>&1 & disown; echo launched`);
  // Reachable from another container == bound to 0.0.0.0 == reachable from the host mapping.
  let reachable = false, status = null;
  for (let i = 0; i < 10; i++) {
    await tsleep(1000);
    try { const r = await fetch(`http://jarvis-workbench:${port}/`, { signal: AbortSignal.timeout(2500) }); status = r.status; reachable = true; break; } catch (_) {}
  }
  const log = await runShell(`tail -n 20 /workspace/.preview_${port}.log 2>/dev/null`);
  let note;
  if (!reachable) {
    note = `NOT reachable: make sure the server binds to 0.0.0.0:${port} (NOT 127.0.0.1/localhost), and that it started without errors (see log). Do not tell the user it's ready.`;
  } else if (status >= 400) {
    note = `Server is UP but GET / returned ${status} — there is NO page at the root, so the user's browser will show an error. The user opens http://localhost:${port}/ in a browser, so you MUST serve an interactive HTML UI at GET / (a real page they can use), not only API endpoints. Add the homepage, restart, and re-check that GET / returns 200 before telling the user.`;
  } else {
    note = `Live and serving a page at / (HTTP ${status}) — tell the user to open http://localhost:${port} in their browser to preview/test it.`;
  }
  return { url: `http://localhost:${port}`, reachable, status, ok_homepage: reachable && status < 400, note, log: (log.output || "").slice(-1500) };
}

const toolDefs = [
  { type: "function", function: { name: "add_memory",
    description: "Save a durable fact about the user or the world to your long-term semantic memory (Mem0). It auto-extracts the salient fact(s), dedupes, and makes them searchable by meaning. Use for names, preferences, relationships, places, decisions — anything worth recalling in future conversations.",
    parameters: { type: "object", properties: { text: { type: "string", description: "The fact(s) to remember, in natural language." }, metadata: { type: "object", description: "Optional tags, e.g. {category: 'preference', topic: 'food'} — returned with search results." } }, required: ["text"] } } },
  { type: "function", function: { name: "update_memory",
    description: "Correct/replace an existing long-term memory IN PLACE (keeps its id). Get the id from search_memory/list_memories. Prefer this over delete+add when a fact changed (moved house, new preference).",
    parameters: { type: "object", properties: { id: { type: "string" }, text: { type: "string", description: "The corrected fact." } }, required: ["id", "text"] } } },
  { type: "function", function: { name: "search_memory",
    description: "Recall relevant facts from your long-term semantic memory by meaning (not exact match). ALWAYS call this when the user refers to themselves or past context (their name, home, preferences, prior decisions) before answering.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What you want to recall, in natural language." }, limit: { type: "integer", description: "Max memories to return (default 8)." } }, required: ["query"] } } },
  { type: "function", function: { name: "list_memories",
    description: "List all stored long-term memories for the user (ids + text). Use to review or before deleting one.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "delete_memory",
    description: "Delete a long-term memory by its id (from search_memory/list_memories).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "run_shell",
    description: "Run a bash command as ROOT in your Linux workbench container. You may install packages (apt-get) and do any work or research. Returns stdout/stderr and the exit code. Commands are killed after timeout_s (default 120s) — pass a larger timeout_s for long builds/installs, and run servers in the background (nohup ... &) instead of foreground. Long output is truncated in the MIDDLE (head+tail kept) with an explicit marker.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_s: { type: "integer", description: "Max seconds before the command is killed (default 120, max 600)." } }, required: ["command"] } } },
  { type: "function", function: { name: "write_workbench_file",
    description: "Write a text/code file to an absolute path in your workbench (e.g. /workspace/app.py). Use THIS to create code/config files for the workbench — it's reliable with any content (quotes, backticks, newlines) unlike run_shell heredocs/echo. Then run it with run_shell. (For files you hand to the USER, use write_file -> /READ_WRITE_FILES instead.)",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute workbench path, e.g. /workspace/app.py" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "serve_app",
    description: "Run a web app/server inside the workbench and expose it so the USER can open it in their OWN browser to preview/test it (e.g. before you hand over the code). The app MUST serve a real, interactive HTML page at GET / (a working UI the user can actually use) — NOT just JSON/API endpoints, or the browser shows 'Cannot GET /' and it looks broken. Build the app under /workspace, then call this with the command that starts the server BOUND TO 0.0.0.0 on one of the preview ports (9101-9150). The tool reports whether GET / returned 200 (ok_homepage); if it didn't, add the homepage UI and call again BEFORE telling the user it's ready. Returns http://localhost:<port> for the user to visit; the server keeps running in the background. Bind-correct examples: 'python3 -m http.server 9101 --bind 0.0.0.0' (serves files incl. index.html); a Node/Express app that serves a page at '/' and listens on 0.0.0.0:9102; 'flask run --host 0.0.0.0 --port 9103'. Also save the final code to /READ_WRITE_FILES.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "Command that starts the server, listening on 0.0.0.0:<port>." },
      port: { type: "integer", description: "One of 9101-9150 (exposed to the host browser)." },
      cwd: { type: "string", description: "Working directory to run in (default /workspace)." },
    }, required: ["command", "port"] } } },
  { type: "function", function: { name: "list_dir",
    description: "List a directory inside the shared folders (read-only or read-write).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "read_file",
    description: "Read a TEXT file from the shared folders. Long files are paged: a truncated response tells you the offset to re-call with. Binary files error with a pointer to the right tool (analyze_image / read_document).",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "Character offset to start from (for long files)." }, max_chars: { type: "integer", description: "Max characters to return (default 50000)." } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file",
    description: "Write a text file into the read-write shared folder to share it back to the user. By default this OVERWRITES the file; pass append=true to add to the end instead (e.g. for a running log). This tool only reaches the shared folders — to write under the workbench /workspace, use run_shell (with `>>` to append).",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean", description: "Append to the end instead of overwriting (default false)." } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "append_log",
    description: "Append ONE consistently-formatted line to a log file in the read-write shared folder. ALWAYS PREFER THIS over write_file/run_shell for recurring logs (e.g. periodic price checks): the code stamps a uniform ISO-8601 UTC timestamp, keeps each entry to exactly one newline-terminated line, and never lets entries run together — so every run produces identical formatting. Just pass the message (and optional structured fields); do NOT include your own timestamp.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Log file name/path in the read-write shared folder, e.g. 'bitcoin_price_log.txt'." },
      message: { type: "string", description: "The event text, e.g. 'BTC $59,841.91 WOOOHOOO!'. Keep it to one logical entry." },
      fields: { type: "object", description: "Optional structured key/values appended as k=v, e.g. {price: 59841.91, signal: 'up'}." },
    }, required: ["path", "message"] } } },
  { type: "function", function: { name: "fetch_url",
    description: "HTTP request to any internet URL (GET/POST/PUT/DELETE...). Returns status + text content (HTML stripped to text). Supports custom headers (e.g. Authorization with a token from get_secret), a request body or json payload, a timeout, paging long responses via offset, and saving binary responses (PDF/image/zip) into the shared folder via save_to for analyze_image/read_document.",
    parameters: { type: "object", properties: {
      url: { type: "string" },
      method: { type: "string", description: "HTTP method (default GET)." },
      headers: { type: "object", description: "Request headers, e.g. {\"Authorization\": \"Bearer <token>\"}." },
      body: { type: "string", description: "Raw request body (set your own Content-Type header)." },
      json: { type: "object", description: "JSON payload — sent as the body with Content-Type: application/json." },
      timeout_s: { type: "integer", description: "Max seconds to wait (default 30)." },
      offset: { type: "integer", description: "Character offset for paging a long text response (a truncated response tells you the next offset)." },
      save_to: { type: "string", description: "For binary downloads: a path in the read-write shared folder to save the response to, e.g. 'downloads/report.pdf'." },
    }, required: ["url"] } } },
  { type: "function", function: { name: "web_search",
    description: "Search the web (DuckDuckGo) and get result titles, URLs, and snippets. Follow up with fetch_url to read a result. If it reports being rate-limited/blocked, that is NOT an empty result — wait and retry or go directly to a known site.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "Max results (default 8, max 20)." } }, required: ["query"] } } },

  { type: "function", function: { name: "screenshot",
    description: "Look at the current desktop screen. This captures the screen and returns a TEXT analysis from a vision model: a description of what is visible plus the interactive elements (buttons, links, fields, icons, tabs) with their approximate CENTER pixel coordinates (x, y from the top-left). Use those coordinates with click/type/move_mouse to act. Optionally pass 'question' to focus the analysis (e.g. 'where is the address bar?', 'what are the search results?'). Take a screenshot to locate elements before acting, and again afterward to verify the result. The screen is 1024x768.",
    parameters: { type: "object", properties: { question: { type: "string", description: "Optional: focus the visual analysis on a specific question about the screen." } }, required: [] } } },
  { type: "function", function: { name: "analyze_image",
    description: "Look at / analyze an image FILE with the vision model — describe it, read text in it, or answer a question about it. Use this for images the user uploaded (they land in /READ_WRITE_FILES/uploads/) or any image in the shared folders. Pass the image's path and an optional question.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Path to the image, e.g. /READ_WRITE_FILES/uploads/photo.jpg" },
      question: { type: "string", description: "Optional: what to focus on or ask about the image." }
    }, required: ["path"] } } },
  { type: "function", function: { name: "check_email",
    description: "List recent messages in the user's OWN email inbox (headers: from/subject/date/uid). Requires an 'email' secret in the vault ({username, password, imap_host, smtp_host} — app password for Gmail/Outlook). Use read_email with a uid to get a message body. Great in scheduled tasks: 'tell me when X emails me'.",
    parameters: { type: "object", properties: { folder: { type: "string", description: "Mailbox (default INBOX)." }, limit: { type: "integer", description: "Max messages (default 10)." }, unseen_only: { type: "boolean", description: "Only unread messages." } }, required: [] } } },
  { type: "function", function: { name: "read_email",
    description: "Read ONE email's full body (+attachment names) by uid from check_email.",
    parameters: { type: "object", properties: { uid: { type: "integer" }, folder: { type: "string", description: "Mailbox (default INBOX)." } }, required: ["uid"] } } },
  { type: "function", function: { name: "send_email",
    description: "Send a plain-text email FROM the user's own account (the 'email' secret). Confirm with the user before sending anything they haven't explicitly asked you to send.",
    parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } } },
  { type: "function", function: { name: "read_document",
    description: "Extract the TEXT of a PDF, DOCX, ODT, RTF, EPUB, or HTML document from the shared folders (e.g. a file the user uploaded to /READ_WRITE_FILES/uploads/ or one you downloaded with fetch_url save_to). Paged: a truncated response tells you the offset to continue from.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Document path, e.g. /READ_WRITE_FILES/uploads/report.pdf" }, offset: { type: "integer" }, max_chars: { type: "integer", description: "Default 15000." } }, required: ["path"] } } },
  { type: "function", function: { name: "browser_goto",
    description: "PREFERRED way to work with websites: open a URL in the agent-controlled browser (visible on the workbench desktop; logins/cookies persist across sessions). Then use browser_snapshot to see the page structure and browser_click/browser_fill to act by SELECTOR — deterministic, no pixel-coordinate guessing. Use the pixel tools (screenshot/click) only for non-browser desktop apps.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "browser_snapshot",
    description: "See the current page in the agent browser: URL, title, a text preview, and the visible interactive elements (links, buttons, inputs) each with a short ref (e.g. 'e3') plus tag/text/name. Use the refs (or any CSS selector) with browser_click / browser_fill. Refs go stale after navigation — snapshot again.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_click",
    description: "Click an element in the agent browser by ref from browser_snapshot (e.g. 'e3') or any CSS selector (e.g. 'button[type=submit]', 'text=Sign in'). Returns the resulting URL/title.",
    parameters: { type: "object", properties: { target: { type: "string", description: "Snapshot ref like 'e3' or a CSS/Playwright selector." } }, required: ["target"] } } },
  { type: "function", function: { name: "browser_fill",
    description: "Type into an input/textarea in the agent browser by ref or CSS selector (clears it first). Set press_enter=true to submit afterwards.",
    parameters: { type: "object", properties: { target: { type: "string" }, text: { type: "string" }, press_enter: { type: "boolean", description: "Press Enter after filling (submit)." } }, required: ["target", "text"] } } },
  { type: "function", function: { name: "browser_extract",
    description: "Extract the visible TEXT of the current page in the agent browser (or of one element via a CSS selector). Long text is paged via offset. Use this to READ page content — it is exact, unlike the vision screenshot.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "Optional CSS selector (default: whole page body)." }, offset: { type: "integer", description: "Character offset for paging." } }, required: [] } } },
  { type: "function", function: { name: "ui_actions",
    description: "Perform a SEQUENCE of desktop UI actions in ONE call — far fewer round-trips than separate click/type/key calls. After a screenshot gives you element coordinates, use this to run the whole plan at once, e.g. click a field → type text → press Enter. A short settle delay runs between steps; the sequence STOPS at the first failing step and reports it. Screen is 1024x768; screenshot again afterward to verify. Each step is one of: {action:'click'|'double_click'|'right_click'|'move', x, y} , {action:'type', text} , {action:'key', keys:'Return'} , {action:'scroll', direction:'up'|'down', amount} , {action:'sleep', ms}. NOTE: for actions INSIDE a web page, prefer the browser_* tools (deterministic selectors) over pixel clicking.",
    parameters: { type: "object", properties: { actions: { type: "array", items: { type: "object" }, description: "Ordered list of action steps to perform in sequence." } }, required: ["actions"] } } },
  { type: "function", function: { name: "open_url",
    description: "Open a URL in the Chromium browser on the desktop.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "open_app",
    description: "Launch a GUI application on the desktop (e.g. 'chromium', 'xterm', 'thunar').",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "click",
    description: "Left-click at pixel (x, y) on the desktop.",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "double_click",
    description: "Double-click at pixel (x, y).",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "right_click",
    description: "Right-click at pixel (x, y).",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "move_mouse",
    description: "Move the mouse to pixel (x, y) without clicking.",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "type_text",
    description: "Type text at the current keyboard focus (e.g. into a focused form field or address bar).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "press_key",
    description: "Press a key or chord using xdotool keysyms, e.g. 'Return', 'Tab', 'ctrl+l', 'ctrl+t', 'BackSpace'.",
    parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] } } },
  { type: "function", function: { name: "scroll",
    description: "Scroll the mouse wheel up or down by an amount (wheel clicks).",
    parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, amount: { type: "number" } }, required: ["direction"] } } },

  { type: "function", function: { name: "list_secrets",
    description: "List saved credential names (with usernames/urls/notes, NOT passwords) from the user's vault. These are the user's OWN accounts.",
    parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_secret",
    description: "Get a saved credential (including password) by name, to log in to the user's own account.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "set_secret",
    description: "Create or update a saved credential in the user's vault (e.g. after the user gives you a login for one of their own accounts, or after you change a password on a site they own). Only the fields you pass are updated.",
    parameters: { type: "object", properties: { name: { type: "string" }, username: { type: "string" }, password: { type: "string" }, url: { type: "string" }, notes: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "delete_secret",
    description: "Delete a saved credential from the vault by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },

  { type: "function", function: { name: "schedule_task",
    description: "Schedule a task to run later. Provide the task as a 'prompt' (what JARVIS should do when it runs). Use IN_SECONDS for a delay (e.g. 'in 10 minutes' -> 600), AT for an absolute ISO time (e.g. 'at 5pm' -> compute today's ISO datetime from the current time you were given), or EVERY_SECONDS for a recurring task (e.g. 'every 5 minutes' -> 300) with an optional natural-language 'until' stop condition. The current date/time is provided to you in context. IMPORTANT: the prompt is run by the model THROUGH ITS TOOLS at run time (it is NOT executed as literal code). Write a clear, concrete, VERIFIABLE instruction — name the exact tool/command and the exact file path. For deterministic jobs (data fetch + log to a file), prefer a single explicit run_shell command, e.g. 'Run exactly this with run_shell and report its output: <shell command using >> to append>'. Use real API ids/paths. Each run is a fresh, stateless conversation, so the prompt must be self-contained. A task CAN see the live conversation via read_recent_chat — e.g. to check whether the user has replied (roles:[\"user\"]) so it can escalate an unanswered prompt, or to review its own recent posts to avoid repeating itself — so requests like 'notice if I'm not answering and escalate' ARE doable; author the prompt to use read_recent_chat, don't refuse them.",
    parameters: { type: "object", properties: {
      prompt: { type: "string", description: "What to do when the task runs — a clear, concrete, self-contained instruction (the model executes it via its tools, not as literal code)." },
      in_seconds: { type: "number", description: "Run once after this many seconds." },
      at: { type: "string", description: "Run once at this ISO 8601 datetime." },
      every_seconds: { type: "number", description: "Recurring: run every this many seconds." },
      until: { type: "string", description: "Recurring stop condition in plain language; the task stops when met (it notifies you)." },
      label: { type: "string", description: "Short label for the task." },
    }, required: ["prompt"] } } },
  { type: "function", function: { name: "list_tasks",
    description: "List the user's scheduled/recurring tasks that are still active.",
    parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "update_task",
    description: "Change an EXISTING scheduled task IN PLACE (it keeps running). ALWAYS use this to modify a task — do NOT cancel_task + schedule_task, which stops the original. Get the id from list_tasks. Only the fields you pass are changed; omit the rest to keep them (e.g. change just the prompt and the recurring schedule is preserved).",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "Task id from list_tasks." },
      prompt: { type: "string", description: "New instruction for the task." },
      label: { type: "string" },
      every_seconds: { type: "number", description: "New recurring interval." },
      until: { type: "string", description: "New stop condition (plain language); pass empty to clear." },
      in_seconds: { type: "number", description: "Re-time the NEXT run to this many seconds from now." },
      at: { type: "string", description: "Re-time the next run to this ISO datetime." },
    }, required: ["id"] } } },
  { type: "function", function: { name: "cancel_task",
    description: "Cancel a scheduled task by id (e.g. when the user says to stop it). To CHANGE a task without stopping it, use update_task instead.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "notify_user",
    description: "Send a notification to the user (shows in the app and as a desktop notification). Use it to alert the user about a result or when a monitored condition is met.",
    parameters: { type: "object", properties: { message: { type: "string" }, level: { type: "string", enum: ["info", "warning", "error"] } }, required: ["message"] } } },

  { type: "function", function: { name: "post_to_chat",
    description: "Post a message directly into the user's live chat conversation window (it appears as a message from you in the web chat). Use this when a task should speak up in the conversation, e.g. to report an outcome or ask a follow-up. For a passive alert/badge instead, use notify_user.",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
  { type: "function", function: { name: "read_recent_chat",
    description: "Read recent messages from the user's live chat conversation (oldest→newest, each with an ISO timestamp). This is how a scheduled/background task can SEE the conversation it otherwise can't: use roles:[\"user\"] to check whether the USER has replied lately (e.g. to decide whether to escalate an unanswered prompt), or look at your own recent role:\"task\"/\"assistant\" posts to avoid repeating yourself. Returns [{at, role, text}]. Roles are \"user\", \"assistant\", \"task\".",
    parameters: { type: "object", properties: {
      since_minutes: { type: "number", description: "Only return messages from the last N minutes (omit for the most recent regardless of age)." },
      roles: { type: "array", items: { type: "string" }, description: "Filter to these roles, e.g. [\"user\"] to see only the user's replies." },
      limit: { type: "number", description: "Max messages to return (default 30)." }
    }, required: [] } } },

  { type: "function", function: { name: "list_skills",
    description: "List your available skill playbooks (name + category + summary). Skills are detailed how-to guides for your capabilities and common workflows.",
    parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_skill",
    description: "Get the full step-by-step playbook for a skill by name (from list_skills). Read the relevant skill before doing an unfamiliar or multi-step task.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
];

// Append-only action audit log: one JSON line per tool call (secrets redacted).
const AUDIT_FILE = process.env.JARVIS_AUDIT_FILE || "/data/audit.log";
function audit(name, args, status, ms) {
  try {
    const safe = JSON.parse(JSON.stringify(args == null ? {} : args));
    for (const k of Object.keys(safe)) if (/pass|secret|token|api_?key|password/i.test(k)) safe[k] = "***";
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), tool: name, args: safe, status, ms }) + "\n");
  } catch (_) {}
}

async function execTool(name, args) {
  const started = Date.now();
  try {
    const result = await _execTool(name, args);
    audit(name, args, "ok", Date.now() - started);
    return result;
  } catch (e) {
    audit(name, args, "error: " + (e.message || e), Date.now() - started);
    throw e;
  }
}

async function _execTool(name, args) {
  switch (name) {
    case "add_memory": return await addMemory(args.text, args.metadata);
    case "search_memory": return await searchMemory(args.query, args.limit);
    case "list_memories": return await listMemories();
    case "delete_memory": return await deleteMemory(args.id);
    case "update_memory": return await updateMemory(args.id, args.text);
    case "run_shell": return await runShell(args.command, args.timeout_s);
    case "write_workbench_file": return await writeWorkbenchFile(args.path, args.content);
    case "serve_app": return await serveApp(args.command, args.port, args.cwd);
    case "list_dir": return await listDir(args.path);
    case "read_file": return await readFile(args.path, args.offset, args.max_chars);
    case "read_document": return await readDocument(args.path, args.offset, args.max_chars);
    case "check_email": return await require("./email").checkEmail(args);
    case "read_email": return await require("./email").readEmail(args);
    case "send_email": return await require("./email").sendEmail(args);
    case "write_file": return await writeFile(args.path, args.content, args.append);
    case "append_log": return await appendLog(args.path, args.message, args.fields);
    case "fetch_url": return await fetchUrl(args.url, { method: args.method, headers: args.headers, body: args.body, json: args.json, timeout_s: args.timeout_s, offset: args.offset, save_to: args.save_to });
    case "web_search": return await webSearch(args.query, args.limit);
    case "screenshot": return await screenshot();
    case "analyze_image": return await analyzeImageFile(args.path);
    case "ui_actions": return await uiActions(args.actions);
    case "browser_goto": return await browserCmd("goto", { url: args.url });
    case "browser_snapshot": return await browserCmd("snapshot");
    case "browser_click": return await browserCmd("click", { target: args.target });
    case "browser_fill": return await browserCmd("fill", { target: args.target, text: args.text, press_enter: args.press_enter });
    case "browser_extract": return await browserCmd("extract", { selector: args.selector, offset: args.offset });
    case "open_url": return await openUrl(args.url);
    case "open_app": return await openApp(args.command);
    case "click": return await clickAt(args.x, args.y, 1);
    case "double_click": return await doubleClick(args.x, args.y);
    case "right_click": return await clickAt(args.x, args.y, 3);
    case "move_mouse": return await moveMouse(args.x, args.y);
    case "type_text": return await typeText(args.text);
    case "press_key": return await pressKey(args.keys);
    case "scroll": return await scrollWheel(args.direction, args.amount);
    case "list_secrets": return listSecrets();
    case "get_secret": return getSecret(args.name);
    case "schedule_task": return require("./scheduler").schedule(args);
    case "list_tasks": return require("./scheduler").list();
    case "update_task": return require("./scheduler").update(args);
    case "cancel_task": return require("./scheduler").cancel(args.id);
    case "notify_user": return require("./scheduler").pushNotification({ message: args.message, level: args.level });
    case "post_to_chat": return require("./scheduler").postToChat(args.message);
    case "read_recent_chat": return require("./chatlog").recent(args);
    case "list_skills": return require("./skills").list();
    case "get_skill": return require("./skills").get(args.name);
    case "set_secret": {
      const fields = {};
      for (const k of ["username", "password", "url", "notes"]) if (args[k] !== undefined) fields[k] = args[k];
      return cfgSetSecret(args.name, fields);
    }
    case "delete_secret": return cfgDeleteSecret(args.name);
    default: {
      if (customRegistry[name]) return await customRegistry[name].handler(args || {});
      const mcp = require("./mcp");
      if (mcp.has(name)) return await mcp.call(name, args);
      throw new Error("unknown tool: " + name);
    }
  }
}

// --- custom tools: drop-in extensibility, no core edits or image rebuild ---
// Put a JS file in ./data/custom_tools/ (host side) exporting
//   module.exports = { name, description, parameters, retryable, handler: async (args) => ... }
// and restart the app. If custom_tools.allow_model_authored is true in config,
// /READ_WRITE_FILES/custom_tools is ALSO loaded — files JARVIS itself can write.
// (Default OFF: model-authored code executing in the app container is a real
// escalation path; enable it deliberately.)
const customRegistry = {};
function loadCustomTools() {
  const dirs = ["/data/custom_tools"];
  if (config.custom_tools && config.custom_tools.allow_model_authored) {
    dirs.push(((config.shared && config.shared.read_write_dir) || "/READ_WRITE_FILES") + "/custom_tools");
  }
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")); } catch (_) { continue; }
    for (const f of files) {
      try {
        const mod = require(path.join(dir, f));
        if (!mod || !mod.name || typeof mod.handler !== "function") { console.log(`custom tool skipped (${f}): must export {name, handler}`); continue; }
        customRegistry[mod.name] = mod;
        toolDefs.push({ type: "function", function: { name: mod.name, description: mod.description || ("Custom tool " + mod.name), parameters: mod.parameters || { type: "object", properties: {} } } });
        console.log(`custom tool loaded: ${mod.name} (${dir}/${f})`);
      } catch (e) { console.log(`custom tool FAILED to load (${f}): ${e.message}`); }
    }
  }
}
loadCustomTools();

// Register external MCP tools (async — they join toolDefs once the handshake finishes).
require("./mcp").init().then((defs) => { for (const d of defs) toolDefs.push(d); }).catch(() => {});

// Retryability lives WITH the tool (read-only/idempotent tools only — mutating tools
// are never auto-retried to avoid double execution).
const RETRYABLE = new Set(["fetch_url", "web_search", "search_memory", "list_memories", "screenshot", "read_file", "read_document", "list_dir", "browser_snapshot", "browser_extract", "check_email", "read_email"]);
function isRetryable(name) {
  if (RETRYABLE.has(name)) return true;
  const c = customRegistry[name];
  return !!(c && c.retryable);
}

// Only what's imported elsewhere is exported; everything else is reached via execTool.
module.exports = { toolDefs, execTool, isRetryable, searchMemory, runShell, listDir, fetchUrl };
