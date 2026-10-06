"use strict";
// Regression tests for the core fixes (server.js, config.js, logger.js, llm.js, autobackup.js,
// chatlog.js): a malformed WebSocket frame must not kill the server, a broken config file locks
// the API and refuses writes, quoted secrets are redacted, only FAILED sign-ins are rate-limited,
// body errors answer in JSON, the prompt guards are case-insensitive, setSetting keeps the model
// mode and tier objects, uploads never overwrite, and SIGTERM saves and exits.
// Part 1 runs modules in-process (fresh copies per scenario); part 2 boots real servers on
// ports 18250-18259 with scratch dirs and the mock provider. Run: node test/core-fixes.test.js
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// dockerode is only needed inside the container; stub it like llm-loop.test.js does.
const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "dockerode" ? "dockerode-stub" : _resolve.call(this, req, ...a); };
require.cache["dockerode-stub"] = { id: "dockerode-stub", loaded: true, exports: function Docker() { return { getContainer: () => ({}) }; } };

const SRC = path.join(__dirname, "..", "src");
const SERVER = path.join(__dirname, "..", "server.js");
const WebSocket = require("ws");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-core-"));
const mk = (...d) => { const p = path.join(tmp, ...d); fs.mkdirSync(p, { recursive: true }); return p; };

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load src/<name> fresh (every src module re-required) against the given config object/text. */
function fresh(name, cfg, env = {}, secrets = null) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k];
  const dir = mk("unit-" + Math.random().toString(36).slice(2));
  const cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2));
  if (secrets) fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets));
  Object.assign(process.env, {
    JARVIS_CONFIG_FILE: cfgFile, JARVIS_SECRETS_FILE: path.join(dir, "secrets.json"), JARVIS_BACKUP_DIR: dir,
    JARVIS_LOG_DIR: mk(path.basename(dir), "logs"), JARVIS_TASKS_FILE: path.join(dir, "tasks.json"),
    JARVIS_PLAN_FILE: path.join(dir, "plan.json"), JARVIS_AUTOPILOT_FILE: path.join(dir, "autopilot.json"),
    JARVIS_AUTOBACKUP_FILE: path.join(dir, "autobackup.json"), JARVIS_AUTOBACKUP_DIR: path.join(dir, "backups"),
    JARVIS_AUDIT_FILE: path.join(dir, "audit.log"), ...env,
  });
  return { mod: require(path.join(SRC, name)), cfgFile, dir };
}

// ---------------------------------------------------------------------------------------------
async function unitTests() {
  console.log("CONFIG (broken file):");
  {
    const broken = '{ "llm": { "model": "x", }';
    const { mod: c, cfgFile } = fresh("config", broken);
    ok("loadError is set", !!c.loadError);
    ok("configProblem() is the plain sentence", /^config\/JARVIS_CONFIG\.json can't be read \(.+\)\. Fix the file, then reload — nothing was saved\.$/.test(c.configProblem() || ""), c.configProblem());
    const refused = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    const m1 = refused(() => c.setSetting("voice.tts", false));
    const m2 = refused(() => c.setProtected("security.login_enabled", false));
    const m3 = refused(() => c.writeFullConfig({ config: { llm: { model: "y" } } }));
    ok("setSetting refused", m1 === c.configProblem(), m1);
    ok("setProtected refused", m2 === c.configProblem(), m2);
    ok("writeFullConfig refused", m3 === c.configProblem(), m3);
    ok("the broken file is left untouched", fs.readFileSync(cfgFile, "utf8") === broken);
  }

  console.log("CONFIG (setSetting llm.models.<tier> + value types):");
  {
    const { mod: c, cfgFile } = fresh("config", { llm: { provider: "mock", model: "base-model" } });
    const r = c.setSetting("llm.models.chat", "new-model");
    const disk = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    ok("single mode: sets llm.model instead", disk.llm.model === "new-model" && r.path === "llm.model", JSON.stringify(disk.llm));
    ok("single mode: no models block created (mode stays single)", disk.llm.models === undefined && c.modelMode() === "single");
  }
  {
    const { mod: c, cfgFile } = fresh("config", { llm: { provider: "mock", model: "base", models: { chat: { model: "old", temperature: 0.1, max_tokens: 900 }, smart: "s" } } });
    c.setSetting("llm.models.chat", "fresh");
    const chat = JSON.parse(fs.readFileSync(cfgFile, "utf8")).llm.models.chat;
    ok("multi mode: object tier keeps its overrides, only .model changes", chat && chat.model === "fresh" && chat.temperature === 0.1 && chat.max_tokens === 900, JSON.stringify(chat));
    ok("multi mode: modelFor('chat') is the new model", c.modelFor("chat") === "fresh");
  }
  {
    const { mod: c } = fresh("config", { llm: { provider: "mock", model: "m", models: { chat: "plain" } } });
    c.setSetting("llm.models.chat", "plain2");
    ok("multi mode: string tier replaced", c.config.llm.models.chat === "plain2");
    const bad = [["voice.tts", "yes"], ["llm.temperature", "0.5"], ["llm.max_tokens", -3], ["llm.model", ""], ["voice.mic_mode", { x: 1 }], ["skills_autohint", 1]];
    for (const [p, v] of bad) {
      let msg = null; try { c.setSetting(p, v); } catch (e) { msg = e.message; }
      ok(`type check refuses ${p} = ${JSON.stringify(v)}`, msg && /must be .*nothing was saved/.test(msg), msg);
    }
    let okMsg = null; try { c.setSetting("voice.tts_voice", ""); c.setSetting("llm.temperature", 0.3); c.setSetting("voice.tts", true); } catch (e) { okMsg = e.message; }
    ok("valid values still accepted", okMsg === null, okMsg);
  }

  console.log("LOGGER (redaction):");
  {
    const secret = 'pa"ss\\wo"rd!42';
    const { mod: log2 } = fresh("logger", { llm: { provider: "mock", model: "m", api_key: "sk-\"quoted\\key-123" }, logging: { level: 5 } }, {}, { secrets: { bank: { password: secret } } });
    const payload = { args: { password: secret, note: "x" }, nested: JSON.stringify({ key: "sk-\"quoted\\key-123" }), basic: Buffer.from(secret).toString("base64") };
    log2.debug("test", "request", payload);
    const files = fs.readdirSync(process.env.JARVIS_LOG_DIR).filter((f) => f.endsWith(".log"));
    const text = files.map((f) => fs.readFileSync(path.join(process.env.JARVIS_LOG_DIR, f), "utf8")).join("");
    ok("a log line was written", text.includes("request"), text.slice(0, 200));
    ok("JSON-escaped secret (\" and \\) is redacted", !text.includes(JSON.stringify(secret).slice(1, -1)) && !text.includes("ss\\\\wo"), text);
    ok("doubly-escaped api key is redacted", !text.includes("quoted"), text);
    ok("base64 form is redacted", !text.includes(Buffer.from(secret).toString("base64").replace(/=+$/, "")), text);
    ok("redact() covers the raw value too", log2.redact("x " + secret + " y") === "x ***REDACTED*** y");
  }

  console.log("LLM (stream errors, retry waits, out-of-tokens message):");
  {
    const realFetch = global.fetch;
    const sseResp = (lines) => {
      const bytes = new TextEncoder().encode(lines.map((l) => "data: " + l).join("\n") + "\n"); let sent = false;
      return { ok: true, status: 200, headers: new Headers(), body: new ReadableStream({ pull(c) { if (!sent) { c.enqueue(bytes); sent = true; } else c.close(); } }) };
    };
    const { mod: c } = fresh("config", { llm: { provider: "openai", base_url: "http://127.0.0.1:9/v1", model: "m", models: { chat: { model: "m", max_tokens: 777 } } } });
    const llm = require(path.join(SRC, "llm"));
    void c;
    global.fetch = async () => sseResp([JSON.stringify({ error: { message: "context length exceeded" } }), "[DONE]"]);
    let msg = null; try { await llm.chat({ messages: [{ role: "user", content: "hi" }], noTools: true }); } catch (e) { msg = e.message; }
    ok("a json.error chunk throws 'LLM error: <message>'", msg === "LLM error: context length exceeded", msg);

    global.fetch = async () => sseResp([JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }), "[DONE]"]);
    const reply = await llm.chat({ messages: [{ role: "user", content: "hi" }], noTools: true });
    ok("out-of-tokens message reports the tier's max_tokens", /max_tokens = 777/.test(reply) && /llm\.models\.chat\.max_tokens/.test(reply), reply);

    global.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "3600" }), body: null, text: async () => "" });
    const ac = new AbortController(); setTimeout(() => ac.abort(), 150);
    const t0 = Date.now(); let threw = false;
    try { await llm.chat({ messages: [{ role: "user", content: "hi" }], noTools: true, signal: ac.signal }); } catch (_) { threw = true; }
    ok("Stop ends a Retry-After wait at once (not after an hour)", threw && Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
    global.fetch = realFetch;
  }

  console.log("AUTOBACKUP (one run at a time, timeout):");
  {
    fresh("config", { llm: { provider: "mock", model: "m" }, workbench: { enabled: false } }, { JARVIS_AUTOBACKUP_TIMEOUT_MS: "300" });
    const toolsPath = require.resolve(path.join(SRC, "tools"));
    require.cache[toolsPath] = { id: toolsPath, filename: toolsPath, loaded: true, exports: { docker: { getContainer: () => ({ exec: () => {}, modem: {} }) } } };   // an exec that never answers
    const ab = require(path.join(SRC, "autobackup"));
    const first = ab.runBackups();
    let second = null; try { await ab.runBackups(); } catch (e) { second = e.message; }
    ok("a second concurrent run is refused with a plain message", second === "A backup is already running. Wait for it to finish, then try again.", second);
    const res = await first;
    ok("a hung exec times out and is reported as failed", Array.isArray(res) && /FAILED \(the backup took longer/.test(res.join(" ")), JSON.stringify(res));
    delete require.cache[toolsPath];
  }
  delete process.env.JARVIS_AUTOBACKUP_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------------------------
function request(port, method, p, { headers = {}, body = null, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(data != null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(out); } catch (_) {} resolve({ status: res.statusCode, body: out, json, headers: res.headers }); });
    });
    r.on("error", reject);
    if (data != null) r.write(data);
    r.end();
  });
}
const portBusy = (port) => new Promise((resolve) => { const s = require("net").connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });

const children = new Set();
async function boot(port, cfg, extraEnv = {}) {
  if (await portBusy(port)) throw new Error(`port ${port} is already in use (a server from an earlier run?) — stop it and run again`);
  const dir = mk("srv-" + port + "-" + Math.random().toString(36).slice(2));
  const data = mk(path.basename(dir), "data");
  const cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1",
      JARVIS_CONFIG_FILE: cfgFile, JARVIS_SECRETS_FILE: path.join(dir, "secrets.json"),
      JARVIS_TASKS_FILE: path.join(data, "tasks.json"), JARVIS_AUDIT_FILE: path.join(data, "audit.log"),
      JARVIS_PLAN_FILE: path.join(data, "plan.json"), JARVIS_AUTOPILOT_FILE: path.join(data, "autopilot.json"),
      JARVIS_AUTOBACKUP_FILE: path.join(data, "autobackup.json"), JARVIS_AUTOBACKUP_DIR: path.join(data, "backups"),
      JARVIS_SESSIONS_DIR: mk(path.basename(dir), "sessions"), JARVIS_PROMPTS_DIR: mk(path.basename(dir), "prompts"),
      JARVIS_LOG_DIR: mk(path.basename(dir), "logs"), JARVIS_BACKUP_DIR: data, JARVIS_NO_RATE_LIMIT: "", JARVIS_TRUST_LOOPBACK: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let log = ""; child.stdout.on("data", (c) => (log += c)); child.stderr.on("data", (c) => (log += c));
  child.exitInfo = new Promise((resolve) => child.on("exit", (code, sig) => { children.delete(child); resolve({ code, sig }); }));
  for (let i = 0; i < 60; i++) {
    try { if ((await request(port, "GET", "/healthz")).status === 200) return { child, dir, data, log: () => log, port }; } catch (_) {}
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error("server did not come up:\n" + log.slice(-800));
}
async function kill(srv) {
  if (!srv || srv.child.exitCode !== null) return;
  srv.child.kill("SIGKILL");
  await Promise.race([srv.child.exitInfo, sleep(3000)]);
}
const alive = async (port) => { try { return (await request(port, "GET", "/healthz")).status === 200; } catch (_) { return false; } };
function wsOpen(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}) } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => reject(new Error("handshake " + res.statusCode)));
  });
}
const nextMessage = (ws, ms = 5000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  ws.once("message", (raw) => { clearTimeout(t); try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
});

async function serverTests() {
  // A fake gateway: /v1/models and /model/info, recording the Authorization header it gets.
  const seenAuth = [];
  const gw = http.createServer((req, res) => {
    seenAuth.push(req.url + " " + (req.headers.authorization || "-"));
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "gw-model" }] }));
    if (req.url === "/model/info") return res.end(JSON.stringify({ data: [{ model_name: "mock-model", model_info: { max_input_tokens: 123456 } }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => gw.listen(18259, "127.0.0.1", r));

  // ---- server B: login off -------------------------------------------------------------------
  const P = 18250;
  const rw = mk("b-rw"), ro = mk("b-ro");
  const B = await boot(P, { llm: { provider: "mock", model: "mock-model", base_url: "http://127.0.0.1:18259/v1", api_key: "sk-saved-key" }, ollama: { context_length: 4096 }, shared: { read_only_dir: ro, read_write_dir: rw }, security: { allowed_hosts: [] } });
  try {
    console.log("SERVER (login off):");
    // 1 — malformed frames
    {
      const ws = await wsOpen(P);
      const closed = new Promise((r) => ws.on("close", (code) => r(code)));
      ws.on("error", () => {});
      ws._socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]));   // masked text frame, invalid UTF-8
      const code = await Promise.race([closed, sleep(3000).then(() => "timeout")]);
      await sleep(200);
      ok("invalid-UTF-8 frame closes only that connection (1007)", code === 1007, String(code));
      ok("server still alive after the bad frame", await alive(P));
      const ws2 = await wsOpen(P);
      ws2.send("null"); ws2.send("42");   // valid JSON that isn't an object
      await sleep(200);
      ws2.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hello" }] }));
      const m = await nextMessage(ws2);
      ok("non-object JSON frames ignored; chat still answers", m && m.type === "reply", JSON.stringify(m));
      ws2.close();
    }
    // 10 — body errors in JSON
    {
      const big = JSON.stringify({ name: "big.bin", dataUrl: "data:application/octet-stream;base64," + "A".repeat(35 * 1024 * 1024) });
      const r = await request(P, "POST", "/api/upload", { body: big });
      ok("over-limit body → 413 JSON 'File too large (20MB max)'", r.status === 413 && r.json && r.json.error === "File too large (20MB max)", r.status + " " + r.body.slice(0, 120));
      const mid = JSON.stringify({ name: "mid.bin", dataUrl: "data:application/octet-stream;base64," + Buffer.alloc(19 * 1024 * 1024, 1).toString("base64") });
      const r2 = await request(P, "POST", "/api/upload", { body: mid });
      ok("a 19MB upload is accepted (body limit large enough)", r2.status === 200 && r2.json && r2.json.bytes === 19 * 1024 * 1024, r2.status + " " + r2.body.slice(0, 120));
      const r3 = await request(P, "POST", "/api/settings", { body: "{not json" });
      ok("malformed JSON → 400 JSON 'Request body is not valid JSON'", r3.status === 400 && r3.json && r3.json.error === "Request body is not valid JSON", r3.body.slice(0, 120));
    }
    // 11 — prompt guards
    {
      const a = await request(P, "DELETE", "/api/prompts/DEFAULT");
      const b = await request(P, "DELETE", "/api/prompts/Stock");
      const c = await request(P, "POST", "/api/prompts/STOCK", { body: { master: "x", system: "y" } });
      const d = await request(P, "POST", "/api/prompts/mine", { body: { master: "x", system: "y" } });
      ok("DELETE 'DEFAULT' refused", a.status === 400, a.body);
      ok("DELETE 'Stock' refused", b.status === 400, b.body);
      ok("POST 'STOCK' refused with a plain message", c.status === 400 && /can't be overwritten/.test(c.body), c.body);
      ok("POST another name still saves", d.status === 200 && d.json && d.json.saved === "mine", d.body);
    }
    // 18 — clarify / uploads
    {
      const q = await request(P, "POST", "/api/autopilot/clarify", { body: { objective: "" } });
      ok("clarify with no objective: questions is an array", q.json && Array.isArray(q.json.questions), q.body);
      const u1 = await request(P, "POST", "/api/upload", { body: { name: "notes.txt", dataUrl: "data:text/plain;charset=utf-8;base64," + Buffer.from("one").toString("base64") } });
      ok("dataUrl with ;charset=… accepted", u1.status === 200 && u1.json.path === "/LLM_READ_WRITE_FILES/uploads/notes.txt", u1.body);
      const u2 = await request(P, "POST", "/api/upload", { body: { name: "notes.txt", dataUrl: "data:text/plain;base64," + Buffer.from("two").toString("base64") } });
      ok("same name again → notes-1.txt (no overwrite)", u2.status === 200 && u2.json.path === "/LLM_READ_WRITE_FILES/uploads/notes-1.txt", u2.body);
      ok("both files keep their content", fs.readFileSync(path.join(rw, "uploads", "notes.txt"), "utf8") === "one" && fs.readFileSync(path.join(rw, "uploads", "notes-1.txt"), "utf8") === "two");
      for (const bad of [".", "..", "/", "a/.."]) {
        const r = await request(P, "POST", "/api/upload", { body: { name: bad, dataUrl: "data:text/plain;base64,eA==" } });
        ok(`upload name ${JSON.stringify(bad)} refused plainly (no path in the message)`, r.status === 400 && r.json && !/\//.test(r.json.error), r.body);
      }
    }
    // 13 / 14 — context window + models through the gateway
    {
      const cw = await request(P, "GET", "/api/context-window");
      ok("gateway: context window from /model/info, not ollama num_ctx", cw.json && cw.json.context_window === 123456 && cw.json.source === "model/info", cw.body);
      const m = await request(P, "GET", "/api/models");
      ok("GET /api/models lists the gateway's models", m.json && Array.isArray(m.json.models) && m.json.models.includes("gw-model"), m.body);
      ok("GET /api/models sends the saved key as a Bearer token", seenAuth.includes("/v1/models Bearer sk-saved-key"), seenAuth.join(", "));
    }
    // 7 — SIGTERM: flush and exit
    {
      await request(P, "POST", "/api/chat", { body: { message: "remember-me-on-shutdown" } });
      B.child.kill("SIGTERM");
      const res = await Promise.race([B.child.exitInfo, sleep(5000).then(() => null)]);
      ok("SIGTERM exits the process (code 0)", res && res.code === 0, JSON.stringify(res));
      const logFile = path.join(B.data, "chatlog.json");
      ok("chat log flushed on SIGTERM", fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("remember-me-on-shutdown"));
    }
  } finally { await kill(B); }

  // ---- server A: login on ---------------------------------------------------------------------
  const PA = 18251;
  const A = await boot(PA, { llm: { provider: "mock", model: "mock-model" }, shared: { read_only_dir: mk("a-ro"), read_write_dir: mk("a-rw") }, security: { allowed_hosts: [], login_enabled: true } });
  try {
    console.log("SERVER (login on — rate limit, socket re-check):");
    const s = await request(PA, "POST", "/api/auth/setup", { body: { loginName: "matt", password: "correct-horse" } });
    ok("first login created", s.status === 200, s.body);
    let allOk = true;
    for (let i = 0; i < 12; i++) { const r = await request(PA, "POST", "/api/auth/login", { body: { loginName: "matt", password: "correct-horse" } }); if (r.status !== 200) allOk = false; }
    ok("12 successful sign-ins are not rate-limited", allOk);
    const f1 = await request(PA, "POST", "/api/auth/login", { body: { loginName: "matt", password: "wrong-pass" } });
    ok("a wrong password after them is a plain 401, not 429", f1.status === 401, f1.status + " " + f1.body);
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await request(PA, "POST", "/api/auth/login", { body: { loginName: "guess", password: "nope-nope" } })).status);
    ok("10 failures for one name, then 429", codes.slice(0, 10).every((c) => c === 401) && (await request(PA, "POST", "/api/auth/login", { body: { loginName: "guess", password: "nope-nope" } })).status === 429, codes.join(","));
    const good = await request(PA, "POST", "/api/auth/login", { body: { loginName: "matt", password: "correct-horse" } });
    ok("another login name from the same address still signs in", good.status === 200, good.body);
    const cookie = String(good.headers["set-cookie"] || "").split(";")[0];

    // 6 — the socket re-checks the sign-in on every chat message
    const ws = await wsOpen(PA, cookie);
    ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }));
    const m1 = await nextMessage(ws);
    ok("signed-in socket chats", m1 && m1.type === "reply", JSON.stringify(m1));
    const ch = await request(PA, "POST", "/api/auth/password", { cookie, body: { currentPassword: "correct-horse", newPassword: "battery-staple" } });
    ok("password changed (ends the old sessions)", ch.status === 200, ch.body);
    const closed = new Promise((r) => ws.on("close", (code) => r(code)));
    ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "still there?" }] }));
    const m2 = await nextMessage(ws);
    ok("old socket's next chat is refused with a plain message", m2 && m2.type === "error" && /sign in again/i.test(m2.error), JSON.stringify(m2));
    ok("…and the socket is closed", (await Promise.race([closed, sleep(2000).then(() => "open")])) === 4401);
  } finally { await kill(A); }

  // ---- server C: broken config ------------------------------------------------------------------
  const PC = 18252;
  const C = await boot(PC, '{ "llm": { "provider": "mock", ');
  try {
    console.log("SERVER (broken config — fail closed):");
    const cfg = await request(PC, "GET", "/api/config");
    ok("GET /api/config → 503 with the plain sentence", cfg.status === 503 && /^config\/JARVIS_CONFIG\.json can't be read .* Fix the file, then reload — nothing was saved\.$/.test(cfg.json && cfg.json.error), cfg.status + " " + cfg.body);
    const st = await request(PC, "POST", "/api/settings", { body: { path: "voice.tts", value: false } });
    ok("POST /api/settings refused (503)", st.status === 503, st.body);
    const tasks = await request(PC, "GET", "/api/tasks");
    ok("other APIs locked too (no login = no access)", tasks.status === 503, tasks.body);
    const me = await request(PC, "GET", "/api/auth/me");
    ok("/api/auth/me reports the problem", me.status === 200 && me.json && me.json.status === "config_error" && /can't be read/.test(me.json.error), me.body);
    let wsRefused = false; try { const w = await wsOpen(PC); w.close(); } catch (e) { wsRefused = /503/.test(e.message); }
    ok("chat socket refused (503)", wsRefused);
    ok("healthz still answers", await alive(PC));
  } finally { await kill(C); }

  // ---- server D: chat-tab routing + stale Config saves (UI contract, review Oct 2026) ------------
  const PD = 18253;
  const D = await boot(PD, { llm: { provider: "mock", model: "m" } });
  try {
    console.log("SERVER (chat tab id + stale config saves):");
    const ws = await wsOpen(PD);
    ws.send(JSON.stringify({ type: "chat", chatId: "tab-7", messages: [{ role: "user", content: "hello" }] }));
    let reply = null;
    for (let i = 0; i < 40 && !reply; i++) { const m = await nextMessage(ws); if (!m) break; if (m.type === "reply") reply = m; }
    ok("the reply carries the chat tab's id", reply && reply.chatId === "tab-7", JSON.stringify(reply));
    ws.close();

    const g1 = await request(PD, "GET", "/api/config/full");
    ok("GET /api/config/full returns a version", g1.status === 200 && typeof (g1.json && g1.json.version) === "string" && g1.json.version.includes(":"), g1.body.slice(0, 200));
    const v1 = g1.json.version;
    // something else changes the config (e.g. the header voice toggle)
    const t = await request(PD, "POST", "/api/settings", { body: { path: "voice.tts", value: true } });
    ok("header toggle saved", t.status === 200, t.body);
    const cfg = { ...g1.json.config, llm: { ...g1.json.config.llm, temperature: 0.3 } };
    const stale = await request(PD, "POST", "/api/config/full", { body: { config: cfg, version: v1 } });
    ok("a save from the stale tab is refused (409, plain sentence)", stale.status === 409 && stale.json && stale.json.code === "stale" && /changed since you opened this tab/.test(stale.json.error), stale.status + " " + stale.body);
    const g2 = await request(PD, "GET", "/api/config/full");
    ok("…and the toggle survived", g2.json.config.voice && g2.json.config.voice.tts === true, JSON.stringify(g2.json.config.voice));
    const fresh2 = await request(PD, "POST", "/api/config/full", { body: { config: { ...g2.json.config, llm: { ...g2.json.config.llm, temperature: 0.3 } }, version: g2.json.version } });
    ok("a save with the current version works and returns the new version", fresh2.status === 200 && fresh2.json.version && fresh2.json.version !== g2.json.version, fresh2.body.slice(0, 200));
    const secOnly = await request(PD, "POST", "/api/config/full", { body: { secrets: { secrets: {} }, version: v1 } });
    ok("a secrets-only save is checked against the secrets file only", secOnly.status === 200, secOnly.status + " " + secOnly.body.slice(0, 200));
  } finally { await kill(D); }

  await new Promise((r) => gw.close(r));
}

(async () => {
  await unitTests();
  await serverTests();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `CORE-FIXES: ${failed} FAILED (${passed} passed)` : `CORE-FIXES: ALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("core-fixes test crashed:", e);
  for (const c of children) { try { c.kill("SIGKILL"); } catch (_) {} }
  process.exit(1);
});
