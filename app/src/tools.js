"use strict";
// The LLM's real capabilities: semantic memory, a root workbench shell, and shared files.
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const Docker = require("dockerode");
const { config, getSecrets, setSecret: cfgSetSecret, deleteSecret: cfgDeleteSecret } = require("./config");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// --- run_shell: root command in the workbench container ---
async function runShell(command) {
  const name = (config.workbench && config.workbench.container) || "jarvis-workbench";
  const container = docker.getContainer(name);
  const exec = await container.exec({
    Cmd: ["bash", "-lc", command], AttachStdout: true, AttachStderr: true, User: "0",
    Env: ["DISPLAY=:1"], // so GUI commands target the watchable desktop
    WorkingDir: "/workspace", // persistent project dir (survives rebuilds)
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise((resolve, reject) => {
    let out = Buffer.alloc(0);
    const sink = { write: (c) => { out = Buffer.concat([out, c]); } };
    container.modem.demuxStream(stream, sink, sink);
    stream.on("end", async () => {
      let info = {};
      try { info = await exec.inspect(); } catch (_) {}
      resolve({ exit_code: info.ExitCode ?? null, output: out.toString("utf8").slice(0, 20000) });
    });
    stream.on("error", reject);
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

async function listDir(p) {
  const abs = resolveShared(p, false);
  return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
    name: d.name, type: d.isDirectory() ? "dir" : "file",
  }));
}
async function readFile(p) {
  const abs = resolveShared(p, false);
  return { path: abs, content: fs.readFileSync(abs, "utf8").slice(0, 50000) };
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
  else { try { ips = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { return; } }
  if (ips.some(isPrivateIp)) throw new Error("blocked by SSRF guard: refusing to fetch a private/loopback/link-local address (" + ips.join(",") + ")");
}

async function fetchUrl(url, opts = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  await assertPublicUrl(url);
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers: { "User-Agent": "JARVIS/1.0", ...(opts.headers || {}) },
    body: opts.body,
    redirect: "follow",
  });
  const ct = resp.headers.get("content-type") || "";
  let text = await resp.text();
  if (/html/i.test(ct)) text = stripHtml(text);
  return { url, status: resp.status, content_type: ct, content: text.slice(0, 15000) };
}

async function webSearch(query, limit = 8) {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": "Mozilla/5.0 JARVIS/1.0" },
  });
  const html = await resp.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    results.push({ title: stripHtml(m[2]), url: decodeDuck(m[1]) });
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
async function clickAt(x, y, button = 1) { return runShell(`xdotool mousemove ${px(x)} ${px(y)} click ${button}`); }
async function doubleClick(x, y) { return runShell(`xdotool mousemove ${px(x)} ${px(y)} click --repeat 2 1`); }
async function moveMouse(x, y) { return runShell(`xdotool mousemove ${px(x)} ${px(y)}`); }
async function typeText(text) {
  const b64 = Buffer.from(String(text == null ? "" : text)).toString("base64");
  return runShell(`echo ${b64} | base64 -d | xdotool type --clearmodifiers --file -`);
}
async function pressKey(keys) {
  const safe = String(keys || "").trim().replace(/[^a-zA-Z0-9+_]/g, "");
  if (!safe) throw new Error("no key specified");
  return runShell(`xdotool key --clearmodifiers ${safe}`);
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
  const items = (r.results || []).map((m) => ({ id: m.id, memory: m.memory || m.text, score: m.score }));
  return { results: items };
}
async function listMemories() {
  const r = await mem0Fetch("/all?user_id=" + encodeURIComponent(mem0User()));
  return { results: (r.results || []).map((m) => ({ id: m.id, memory: m.memory || m.text })) };
}
async function deleteMemory(id) {
  return await mem0Fetch("/delete", { method: "POST", body: { memory_id: id } });
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
    parameters: { type: "object", properties: { text: { type: "string", description: "The fact(s) to remember, in natural language." } }, required: ["text"] } } },
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
    description: "Run a bash command as ROOT in your Linux workbench container. You may install packages (apt-get) and do any work or research. Returns stdout/stderr and the exit code.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
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
    description: "Read a text file from the shared folders.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
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
    description: "Fetch any URL from the internet (open access, http/https). Returns the HTTP status and the page/text content (HTML is stripped to text). Use it to read web pages and call web APIs.",
    parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "web_search",
    description: "Search the web (DuckDuckGo) and get a list of result titles and URLs. Follow up with fetch_url to read a result.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },

  { type: "function", function: { name: "screenshot",
    description: "Capture the current desktop screen and return the image so you can SEE what is on screen. Coordinates are pixels from the top-left. Take a screenshot before clicking to locate elements, and again after an action to verify the result.",
    parameters: { type: "object", properties: {}, required: [] } } },
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
    description: "Schedule a task to run later. Provide the task as a 'prompt' (what JARVIS should do when it runs). Use IN_SECONDS for a delay (e.g. 'in 10 minutes' -> 600), AT for an absolute ISO time (e.g. 'at 5pm' -> compute today's ISO datetime from the current time you were given), or EVERY_SECONDS for a recurring task (e.g. 'every 5 minutes' -> 300) with an optional natural-language 'until' stop condition. The current date/time is provided to you in context. IMPORTANT: the prompt is run by the model THROUGH ITS TOOLS at run time (it is NOT executed as literal code). Write a clear, concrete, VERIFIABLE instruction — name the exact tool/command and the exact file path. For deterministic jobs (data fetch + log to a file), prefer a single explicit run_shell command, e.g. 'Run exactly this with run_shell and report its output: <shell command using >> to append>'. Use real API ids/paths. Each run is a fresh, stateless conversation, so the prompt must be self-contained.",
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
    case "run_shell": return await runShell(args.command);
    case "write_workbench_file": return await writeWorkbenchFile(args.path, args.content);
    case "serve_app": return await serveApp(args.command, args.port, args.cwd);
    case "list_dir": return await listDir(args.path);
    case "read_file": return await readFile(args.path);
    case "write_file": return await writeFile(args.path, args.content, args.append);
    case "append_log": return await appendLog(args.path, args.message, args.fields);
    case "fetch_url": return await fetchUrl(args.url, { method: args.method });
    case "web_search": return await webSearch(args.query);
    case "screenshot": return await screenshot();
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
    case "list_skills": return require("./skills").list();
    case "get_skill": return require("./skills").get(args.name);
    case "set_secret": {
      const fields = {};
      for (const k of ["username", "password", "url", "notes"]) if (args[k] !== undefined) fields[k] = args[k];
      return cfgSetSecret(args.name, fields);
    }
    case "delete_secret": return cfgDeleteSecret(args.name);
    default: throw new Error("unknown tool: " + name);
  }
}

module.exports = { toolDefs, execTool, addMemory, searchMemory, runShell, listDir, readFile, writeFile, fetchUrl, webSearch, screenshot };
