"use strict";
// The optional Linux workbench, end to end against the REAL server: flipping the switch in
// a config save stops / starts the workbench container, and the routes that need the
// workbench say so. Docker itself is a small FAKE Docker API on a local port (the app talks
// to it exactly as it talks to jarvis-docker-proxy), so this runs on the host with no Docker.
// The in-process half (tool list, prompt, skills) is workbench.test.js.
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 18133, DOCKER_PORT = 18134;
let passed = 0, failed = 0, child = null, serverLog = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wb-srv-"));
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
};

// ---- the fake Docker API: one container, "jarvis-workbench" ----
const dockerSeen = [];                                  // "METHOD path" of every request
const box = { exists: true, running: true, failStop: false };
const fakeDocker = http.createServer((req, res) => {
  const p = req.url.replace(/^\/v[\d.]+/, "").split("?")[0];
  dockerSeen.push(req.method + " " + p);
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  req.resume();
  req.on("end", () => {
    const m = /^\/containers\/([^/]+)\/(json|stop|start)$/.exec(p);
    if (!m) return send(404, { message: "not found" });
    if (m[1] !== "jarvis-workbench" || !box.exists) return send(404, { message: "No such container: " + m[1] });
    if (m[2] === "json") return send(200, { Id: "abc", State: { Running: box.running, Status: box.running ? "running" : "exited" } });
    if (m[2] === "stop") {
      if (box.failStop) return send(500, { message: "cannot stop container: permission denied" });
      if (!box.running) return send(304);
      box.running = false; return send(204);
    }
    if (box.running) return send(304);
    box.running = true; return send(204);
  });
});
const count = (what) => dockerSeen.filter((s) => s === what).length;

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 60000, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json, body: buf }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const portBusy = (port) => new Promise((resolve) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });

const mk = (d) => { const p = path.join(tmp, d); fs.mkdirSync(p, { recursive: true }); return p; };
const cfgFile = path.join(tmp, "config.json");
async function boot(workbench) {
  const data = mk("data");
  fs.writeFileSync(cfgFile, JSON.stringify({
    llm: { provider: "mock", model: "mock-model" },
    shared: { read_only_dir: mk("ro"), read_write_dir: mk("rw") },
    mem0: { url: "http://127.0.0.1:9" },                       // nothing listens: memory checks fail fast
    workbench,
  }, null, 2));
  serverLog = "";
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env, PORT: String(PORT), BIND_HOST: "127.0.0.1", JARVIS_NO_RATE_LIMIT: "1",
      DOCKER_PROXY_HOST: "127.0.0.1", DOCKER_PROXY_PORT: String(DOCKER_PORT),
      JARVIS_CONFIG_FILE: cfgFile, JARVIS_SECRETS_FILE: path.join(tmp, "secrets.json"),
      JARVIS_TASKS_FILE: path.join(data, "tasks.json"), JARVIS_AUDIT_FILE: path.join(data, "audit.log"),
      JARVIS_PLAN_FILE: path.join(data, "plan.json"), JARVIS_AUTOPILOT_FILE: path.join(data, "autopilot.json"),
      JARVIS_AUTOBACKUP_FILE: path.join(data, "autobackup.json"), JARVIS_AUTOBACKUP_DIR: path.join(data, "backups"),
      JARVIS_SESSIONS_DIR: mk("sessions"), JARVIS_PROMPTS_DIR: mk("prompts"), JARVIS_LOG_DIR: mk("logs"),
      JARVIS_BACKUP_DIR: data,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => (serverLog += c)); child.stderr.on("data", (c) => (serverLog += c));
  for (let i = 0; i < 60; i++) { try { if ((await call("GET", "/healthz")).status === 200) return; } catch (_) {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not come up:\n" + serverLog.slice(-800));
}
const stop = () => new Promise((resolve) => { if (!child) return resolve(); const c = child; child = null; c.on("exit", resolve); c.kill(); setTimeout(() => { try { c.kill("SIGKILL"); } catch (_) {} resolve(); }, 3000); });
const onDisk = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));
/** Save the config the way the Config tab does: read the whole file, change it, post it back. */
async function save(change) {
  const full = (await call("GET", "/api/config/full")).json.config;
  change(full);
  return call("POST", "/api/config/full", { config: full });
}
const AUDIO = "data:audio/webm;base64," + Buffer.from("not really audio").toString("base64");

(async () => {
  if (await portBusy(PORT) || await portBusy(DOCKER_PORT)) { console.log(`  ✗ port ${PORT} or ${DOCKER_PORT} is already in use (a server from an earlier run?) — stop it and run again`); process.exit(1); }
  await new Promise((r) => fakeDocker.listen(DOCKER_PORT, "127.0.0.1", r));

  // ---- a config with no workbench.enabled key: on, exactly as before
  await boot({ container: "jarvis-workbench", desktop_url: "http://localhost:8111" });
  let r = await call("GET", "/api/config");
  ok("no key in the config: the page is told the workbench is on", r.json.workbench_enabled === true && r.json.workbench_url === "http://localhost:8111", r.json);
  r = await call("GET", "/api/workbench");
  ok("GET /api/workbench: on, container running", r.status === 200 && r.json.enabled === true && r.json.container === "running", r.json);
  ok("starting the app did not stop or start anything", count("POST /containers/jarvis-workbench/stop") === 0 && count("POST /containers/jarvis-workbench/start") === 0, dockerSeen);

  // ---- a save that does not touch the switch leaves the container alone
  r = await save((c) => { c.assistant_name = "Friday"; });
  ok("an unrelated save reports nothing about the workbench", r.status === 200 && r.json.workbench === undefined, r.json);
  ok("…and sends Docker no stop", count("POST /containers/jarvis-workbench/stop") === 0);

  // ---- turn it off in the Config tab
  r = await save((c) => { c.workbench.enabled = false; });
  ok("turning it off: saved, and the container was stopped", r.status === 200 && r.json.workbench && r.json.workbench.changed === true && r.json.workbench.enabled === false && r.json.workbench.action === "stopped" && r.json.workbench.container === "stopped" && !r.json.workbench.note, r.json);
  ok("Docker really got the stop", count("POST /containers/jarvis-workbench/stop") === 1 && box.running === false, dockerSeen);
  ok("the file on disk says enabled: false", onDisk().workbench.enabled === false);
  r = await call("GET", "/api/config");
  ok("the page is now told to hide the Workbench tab", r.json.workbench_enabled === false, r.json.workbench_enabled);
  r = await call("GET", "/api/workbench");
  ok("GET /api/workbench: off, container stopped", r.json.enabled === false && r.json.container === "stopped", r.json);
  r = await call("POST", "/api/stt", { dataUrl: AUDIO });
  ok("local speech input is refused with a plain reason", r.status === 409 && /turned off/.test(r.json.error) && /Browser/.test(r.json.error), r.json);
  r = await call("GET", "/api/selftest");
  ok("the self-test skips the workbench and desktop checks", r.status === 200 && r.json.workbench && /turned off/.test(r.json.workbench.skipped || "") && /turned off/.test((r.json.desktop || {}).skipped || ""), { workbench: r.json.workbench, desktop: r.json.desktop });
  ok("…and still runs the others", "shared_rw" in r.json && "vault" in r.json && "semantic_memory" in r.json);
  const stopsNow = count("POST /containers/jarvis-workbench/stop");
  r = await save((c) => { c.assistant_name = "Jarvis"; });
  ok("another save while it is off does not stop it again", r.json.workbench === undefined && count("POST /containers/jarvis-workbench/stop") === stopsNow);

  // ---- it stays off across a restart, and the app does not start the container by itself
  await stop(); await boot(onDisk().workbench);
  r = await call("GET", "/api/config");
  ok("after a restart it is still off", r.json.workbench_enabled === false);
  ok("…and nothing started the container", count("POST /containers/jarvis-workbench/start") === 0 && box.running === false);

  // ---- turn it back on
  r = await save((c) => { c.workbench.enabled = true; });
  ok("turning it on: the container was started", r.status === 200 && r.json.workbench.enabled === true && r.json.workbench.action === "started" && r.json.workbench.container === "running" && !r.json.workbench.note, r.json);
  ok("Docker really got the start", count("POST /containers/jarvis-workbench/start") === 1 && box.running === true, dockerSeen);
  r = await call("GET", "/api/config");
  ok("the page shows the Workbench tab again", r.json.workbench_enabled === true);
  r = await call("POST", "/api/stt", { dataUrl: AUDIO });
  ok("local speech input is no longer refused for being off", !/turned off/.test((r.json || {}).error || ""), r.json);

  // ---- the container is already in the state the switch asks for
  box.running = false;
  r = await save((c) => { c.workbench.enabled = false; });
  ok("off while already stopped: nothing to do, no complaint", r.json.workbench.action === "none" && r.json.workbench.container === "stopped" && !r.json.workbench.note, r.json);

  // ---- the container was never created (workbench image never built)
  box.exists = false;
  r = await save((c) => { c.workbench.enabled = true; });
  ok("on with no container: says to run ./JARVIS.sh --reload", r.status === 200 && r.json.workbench.container === "missing" && r.json.workbench.action === "none" && /JARVIS\.sh --reload/.test(r.json.workbench.note), r.json);
  r = await call("GET", "/api/workbench");
  ok("GET /api/workbench: on, container missing", r.json.enabled === true && r.json.container === "missing", r.json);
  r = await save((c) => { c.workbench.enabled = false; });
  ok("off with no container: fine, nothing to stop", r.json.workbench.container === "missing" && !r.json.workbench.note, r.json);

  // ---- Docker refuses the stop
  box.exists = true; box.running = true;
  await save((c) => { c.workbench.enabled = true; });
  box.failStop = true;
  r = await save((c) => { c.workbench.enabled = false; });
  ok("a refused stop: the setting is saved and the note says how to finish", r.status === 200 && r.json.workbench.enabled === false && r.json.workbench.container === "running" && /Could not stop/.test(r.json.workbench.note) && /--reload/.test(r.json.workbench.note), r.json);
  ok("…the tools are off regardless", (await call("GET", "/api/config")).json.workbench_enabled === false && onDisk().workbench.enabled === false);
  box.failStop = false;

  // ---- Docker is not reachable at all
  await new Promise((r2) => fakeDocker.close(r2)); if (fakeDocker.closeAllConnections) fakeDocker.closeAllConnections();
  r = await save((c) => { c.workbench.enabled = true; });
  ok("Docker unreachable: the save still succeeds, with a note", r.status === 200 && r.json.saved.includes("config") && r.json.workbench.container === "unknown" && /--reload/.test(r.json.workbench.note), r.json);
  r = await call("GET", "/api/workbench");
  ok("GET /api/workbench: state unknown, no error", r.status === 200 && r.json.container === "unknown", r.json);

  await stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `\nWORKBENCH-SERVER: ${failed} FAILED (${passed} passed)` : `\nWORKBENCH-SERVER: ALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("workbench-server test crashed:", e, "\n--- server log tail ---\n" + serverLog.slice(-600));
  try { await stop(); } catch (_) {}
  process.exit(1);
});
