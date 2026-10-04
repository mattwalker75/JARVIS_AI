"use strict";
// Headless end-to-end smoke test: boots the REAL server (mock LLM provider, scratch
// data dirs) and exercises the HTTP surface, the WebSocket chat loop, the PWA assets,
// and the cross-site request guard — no Docker, no model, no browser needed. This is
// the regression net for "the app doesn't even start / the UI can't reach the API"
// class of mistakes. Run alone (node test/smoke-server.test.js) or via test/run.js.
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 18131;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0, child = null;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

// Raw request helper (unlike fetch, allows overriding the Host header for guard tests).
function req(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const post = (p, obj, headers = {}) =>
  req("POST", p, { headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) });

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req("GET", "/healthz"); if (r.status === 200) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  // A server left over from an earlier run would answer on this port and the suite would
  // quietly test THAT (old code) instead of the one spawned below — refuse to start.
  const stale = await new Promise((resolve) => { const s = require("net").connect(PORT, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
  if (stale) { console.log(`  ✗ port ${PORT} is already in use (a server from an earlier run?) — stop it and run again`); process.exit(1); }
  // Scratch environment: mock provider, temp dirs for every persisted path.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-smoke-"));
  const mk = (d) => { const p = path.join(tmp, d); fs.mkdirSync(p, { recursive: true }); return p; };
  const ro = mk("ro"), rw = mk("rw"), data = mk("data");
  const cfgFile = path.join(tmp, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    llm: { provider: "mock", model: "mock-model" },
    shared: { read_only_dir: ro, read_write_dir: rw },
    security: { allowed_hosts: [] },
  }));
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env, PORT: String(PORT), BIND_HOST: "127.0.0.1",
      JARVIS_CONFIG_FILE: cfgFile, JARVIS_SECRETS_FILE: path.join(tmp, "secrets.json"),
      JARVIS_TASKS_FILE: path.join(data, "tasks.json"), JARVIS_AUDIT_FILE: path.join(data, "audit.log"),
      JARVIS_PLAN_FILE: path.join(data, "plan.json"), JARVIS_AUTOPILOT_FILE: path.join(data, "autopilot.json"),
      JARVIS_AUTOBACKUP_FILE: path.join(data, "autobackup.json"), JARVIS_AUTOBACKUP_DIR: path.join(data, "backups"),
      JARVIS_SESSIONS_DIR: mk("sessions"), JARVIS_PROMPTS_DIR: mk("prompts"), JARVIS_LOG_DIR: mk("logs"),
      JARVIS_BACKUP_DIR: data,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (c) => (serverLog += c));
  child.stderr.on("data", (c) => (serverLog += c));

  console.log("SMOKE-SERVER (mock provider, scratch dirs):");
  if (!(await waitUp())) {
    console.log("  ✗ server did not come up. Log tail:\n" + serverLog.slice(-800));
    process.exit(1);
  }
  ok("server boots + /healthz", true);

  // Static UI + PWA assets
  const index = await req("GET", "/");
  ok("serves the UI", index.status === 200 && index.body.includes("JARVIS"));
  ok("UI links the PWA manifest", index.body.includes("manifest.webmanifest"));
  const man = await req("GET", "/manifest.webmanifest");
  ok("manifest served + names icons", man.status === 200 && man.body.includes("icon-512.png"));
  const icon = await req("GET", "/icon-192.png");
  ok("icon served", icon.status === 200 && icon.body.length > 1000);

  // REST surface
  const cfg = await req("GET", "/api/config");
  ok("/api/config (mock provider)", cfg.status === 200 && /"provider":"mock"/.test(cfg.body));
  const chat = await post("/api/chat", { message: "ping" });
  ok("POST /api/chat round-trip", chat.status === 200 && /MOCK/.test(chat.body), chat.body.slice(0, 120));
  for (const [p, want] of [["/api/tasks", "["], ["/api/plan", ""], ["/api/autopilot", "active"], ["/api/prompts", "prompts"], ["/api/files?dir=rw", "files"], ["/api/context-window", "context_window"]]) {
    const r = await req("GET", p);
    ok("GET " + p, r.status === 200 && (!want || r.body.includes(want)), `status ${r.status}`);
  }

  // Sessions CRUD
  const made = JSON.parse((await post("/api/sessions", { name: "smoke", messages: [{ role: "user", content: "hi" }] })).body);
  const list = JSON.parse((await req("GET", "/api/sessions")).body);
  ok("sessions save + list", made.id && list.some((s) => s.id === made.id));
  const del = await req("DELETE", "/api/sessions/" + made.id);
  ok("sessions delete", del.status === 200);

  // Cross-site request guard
  const badHost = await req("GET", "/api/config", { headers: { Host: "evil.example" } });
  ok("foreign Host rejected (403)", badHost.status === 403, `status ${badHost.status}`);
  const badOrigin = await post("/api/notifications/clear", {}, { Origin: "https://evil.example" });
  ok("foreign Origin rejected (403)", badOrigin.status === 403, `status ${badOrigin.status}`);
  const goodOrigin = await post("/api/notifications/clear", {}, { Origin: BASE });
  ok("same-origin allowed", goodOrigin.status === 200, `status ${goodOrigin.status}`);

  // WebSocket chat loop (the UI's real transport)
  const WebSocket = require("ws");
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: BASE } });
    const timer = setTimeout(() => { ok("WS chat reply", false, "timeout"); try { ws.close(); } catch (_) {} resolve(); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hello" }] })));
    ws.on("message", (raw) => {
      let d; try { d = JSON.parse(raw); } catch (_) { return; }
      if (d.type === "reply") { clearTimeout(timer); ok("WS chat reply", /MOCK/.test(d.text)); ws.close(); resolve(); }
      if (d.type === "error") { clearTimeout(timer); ok("WS chat reply", false, d.error); ws.close(); resolve(); }
    });
    ws.on("error", (e) => { clearTimeout(timer); ok("WS chat reply", false, e.message); resolve(); });
  });
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: "https://evil.example" } });
    const timer = setTimeout(() => { ok("WS foreign Origin rejected", false, "handshake unexpectedly hung"); resolve(); }, 5000);
    ws.on("open", () => { clearTimeout(timer); ok("WS foreign Origin rejected", false, "handshake accepted"); ws.close(); resolve(); });
    ws.on("error", () => { clearTimeout(timer); ok("WS foreign Origin rejected", true); resolve(); });
  });

  // Wait for the child to actually exit before removing its scratch dirs (it may still
  // be flushing logs), and tolerate a straggler file — cleanup must never fail the run.
  // The server flushes on SIGTERM but does not exit on it, so follow up with SIGKILL —
  // otherwise it lives on, holding the port for the next run.
  await new Promise((resolve) => { child.on("exit", resolve); child.kill(); setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 1500); setTimeout(resolve, 3000); });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `SMOKE-SERVER: ${failed} FAILED` : "SMOKE-SERVER: ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("smoke test crashed:", e);
  if (child) child.kill("SIGKILL");
  process.exit(1);
});
