"use strict";
// The optional login, users, and network access — against the REAL server (mock LLM
// provider, scratch dirs, no Docker). Covers the REST gate, the chat WebSocket, every user
// action, turning the login on and off, the password file, the protected config keys, the
// network-aware Host/Origin guard, and the in-container loopback exemption the terminal
// client relies on. Run alone (node test/auth.test.js) or via test/run.js.
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 18132;
let passed = 0, failed = 0, child = null, tmp = null, serverLog = "";
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

/** A tiny browser: keeps its cookie. call(method, path, body, headers) → { status, json, body }. */
function client() {
  let cookie = "";
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);   // always sent with a Content-Length: Node frames no body on DELETE otherwise
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        for (const c of res.headers["set-cookie"] || []) { const kv = c.split(";")[0]; cookie = /=$/.test(kv) ? "" : kv; }
        let json = null; try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
  call.cookie = () => cookie;
  return call;
}
/** Open the chat socket; resolves "open:<reply>" after one mock chat turn, or "refused:<code>". */
function chatOver(cookie, origin = `http://127.0.0.1:${PORT}`) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} resolve("timeout"); }, 8000);
    ws.on("unexpected-response", (_rq, res) => { clearTimeout(timer); resolve("refused:" + res.statusCode); });
    ws.on("open", () => ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hello" }] })));
    ws.on("message", (raw) => { let d; try { d = JSON.parse(raw); } catch (_) { return; } if (d.type === "reply" || d.type === "error") { clearTimeout(timer); ws.close(); resolve("open:" + (d.text || d.error)); } });
    ws.on("error", () => {});
  });
}

async function boot(extraEnv = {}, config = null) {
  if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-auth-"));
  const mk = (d) => { const p = path.join(tmp, d); fs.mkdirSync(p, { recursive: true }); return p; };
  const data = mk("data"); const cfgFile = path.join(tmp, "config.json");
  if (config || !fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify(config || { llm: { provider: "mock", model: "mock-model" }, shared: { read_only_dir: mk("ro"), read_write_dir: mk("rw") }, security: { allowed_hosts: [] } }));
  serverLog = "";
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env, PORT: String(PORT), BIND_HOST: "127.0.0.1", JARVIS_NO_RATE_LIMIT: "1",
      JARVIS_CONFIG_FILE: cfgFile, JARVIS_SECRETS_FILE: path.join(tmp, "secrets.json"),
      JARVIS_TASKS_FILE: path.join(data, "tasks.json"), JARVIS_AUDIT_FILE: path.join(data, "audit.log"),
      JARVIS_PLAN_FILE: path.join(data, "plan.json"), JARVIS_AUTOPILOT_FILE: path.join(data, "autopilot.json"),
      JARVIS_AUTOBACKUP_FILE: path.join(data, "autobackup.json"), JARVIS_AUTOBACKUP_DIR: path.join(data, "backups"),
      JARVIS_SESSIONS_DIR: mk("sessions"), JARVIS_PROMPTS_DIR: mk("prompts"), JARVIS_LOG_DIR: mk("logs"),
      JARVIS_BACKUP_DIR: data, ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => (serverLog += c)); child.stderr.on("data", (c) => (serverLog += c));
  const probe = client();
  for (let i = 0; i < 60; i++) { try { if ((await probe("GET", "/healthz")).status === 200) return; } catch (_) {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not come up:\n" + serverLog.slice(-800));
}
const stop = () => new Promise((resolve) => { if (!child) return resolve(); const c = child; child = null; c.on("exit", resolve); c.kill(); setTimeout(() => { try { c.kill("SIGKILL"); } catch (_) {} resolve(); }, 3000); });
const pwFile = () => path.join(tmp, "data", ".password");
const cfgOnDisk = () => JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8"));

(async () => {
  console.log("AUTH (login, users, network — mock provider, scratch dirs):");
  const stale = await new Promise((r) => { const q = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz" }, (res) => { res.resume(); r(true); }); q.on("error", () => r(false)); });
  if (stale) { console.log(`  ✗ port ${PORT} is already in use (a server from an earlier run?) — stop it and run again`); process.exit(1); }
  await boot();
  const matt = client(), amy = client(), anon = client();

  // ---- off by default: nothing changes for a single user
  ok("login off: /api/auth/me says disabled", (await anon("GET", "/api/auth/me")).json.status === "disabled");
  ok("login off: the API is open", (await anon("GET", "/api/config")).status === 200);
  ok("login off: the chat socket is open", /^open:.*MOCK/.test(await chatOver("")));
  ok("login off: users do not exist", /only exist while the login is on/.test((await anon("GET", "/api/users")).json.error));
  let acc = (await anon("GET", "/api/access")).json;
  ok("access info: login off, this computer only", acc.login_enabled === false && acc.network.allow === false && acc.network.published === false && acc.network.urls.length === 0);

  // ---- turning it on: everything needs a login, the page itself still loads
  ok("turn the login on", (await anon("POST", "/api/access/login", { enabled: true })).json.login_enabled === true);
  ok("config.json records it", cfgOnDisk().security.login_enabled === true);
  ok("no password file yet → not_initialized", (await anon("GET", "/api/auth/me")).json.status === "not_initialized");
  const gated = await anon("GET", "/api/config");
  ok("the API now answers 401", gated.status === 401 && gated.json.auth.status === "not_initialized");
  for (const [m, p] of [["GET", "/api/config/full"], ["POST", "/api/chat"], ["GET", "/api/sessions"], ["GET", "/api/files?dir=rw"], ["GET", "/view?path=x.md"], ["POST", "/api/access/login"], ["GET", "/api/users"]])
    ok(`401 without a login: ${m} ${p.split("?")[0]}`, (await anon(m, p, m === "POST" ? {} : undefined)).status === 401);
  ok("the page, its assets and /healthz still load", (await anon("GET", "/")).status === 200 && (await anon("GET", "/app.js")).status === 200 && (await anon("GET", "/healthz")).status === 200);
  ok("the chat socket refuses without a login (401)", (await chatOver("")) === "refused:401");

  // ---- creating the first login
  ok("a short password is refused", /at least 8/.test((await matt("POST", "/api/auth/setup", { loginName: "matt", password: "seven77" })).json.error));
  ok("a blank name is refused", /login name/.test((await matt("POST", "/api/auth/setup", { loginName: " ", password: "long-enough" })).json.error));
  const made = await matt("POST", "/api/auth/setup", { loginName: " matt ", password: "matt-password" });
  ok("create the first login → signed in", made.status === 200 && made.json.loginName === "matt" && /^jarvis_session=/.test(matt.cookie()));
  ok("a second setup is refused", (await anon("POST", "/api/auth/setup", { loginName: "x", password: "whatever-1" })).status === 409);
  const file = JSON.parse(fs.readFileSync(pwFile(), "utf8"));
  ok("password file: one user, a salted scrypt hash, never the password", file.users.length === 1 && /^scrypt\$16384\$8\$1\$/.test(file.users[0].passwordHash) && !fs.readFileSync(pwFile(), "utf8").includes("matt-password"));
  ok("password file is owner-only (0600)", (fs.statSync(pwFile()).mode & 0o777) === 0o600);
  ok("signed in: the API works", (await matt("GET", "/api/config")).status === 200 && (await matt("GET", "/api/auth/me")).json.loginName === "matt");
  ok("signed in: the chat socket works", /^open:.*MOCK/.test(await chatOver(matt.cookie())));
  ok("a forged cookie is refused", (await anon("GET", "/api/config", undefined, { Cookie: matt.cookie().replace(/.$/, (c) => (c === "A" ? "B" : "A")) })).status === 401);

  // ---- signing in
  ok("wrong password → 401", (await amy("POST", "/api/auth/login", { loginName: "matt", password: "wrong-password" })).status === 401);
  ok("unknown name → the same 401", (await amy("POST", "/api/auth/login", { loginName: "nobody", password: "matt-password" })).json.error === "That login name and password do not match.");

  // ---- users: every user may add, reset and remove
  ok("add a user", (await matt("POST", "/api/users", { loginName: "amy", password: "amy-password" })).json.name === "amy");
  ok("a name that differs only by capitals is refused", /already a user called/.test((await matt("POST", "/api/users", { loginName: "AMY", password: "whatever-1" })).json.error));
  ok("a short password is refused", /at least 8/.test((await matt("POST", "/api/users", { loginName: "bo", password: "short" })).json.error));
  ok("adding a user needs a login", (await anon("POST", "/api/users", { loginName: "eve", password: "long-enough" })).status === 401);
  ok("amy signs in", (await amy("POST", "/api/auth/login", { loginName: "amy", password: "amy-password" })).json.loginName === "amy");
  let list = (await amy("GET", "/api/users")).json;
  ok("the list: you first, no hashes", JSON.stringify(list) === JSON.stringify([{ name: "amy", isYou: true }, { name: "matt", isYou: false }]));
  ok("amy (any user) can add a user too", (await amy("POST", "/api/users", { loginName: "bo", password: "bo-password" })).status === 200);
  // everything is shared: a session matt saves is amy's too
  const saved = (await matt("POST", "/api/sessions", { name: "shared chat", messages: [{ role: "user", content: "hi" }] })).json;
  ok("data is shared between users", (await amy("GET", "/api/sessions")).json.some((s) => s.id === saved.id));

  // ---- passwords
  ok("you cannot reset your own password that way", /Change my password/.test((await matt("PUT", "/api/users/matt/password", { password: "new-password" })).json.error));
  ok("reset another user's password", (await matt("PUT", "/api/users/amy/password", { password: "amy-second" })).status === 200);
  ok("…which ends her session", (await amy("GET", "/api/config")).status === 401 && (await chatOver(amy.cookie())) === "refused:401");
  ok("…and the old password", (await amy("POST", "/api/auth/login", { loginName: "amy", password: "amy-password" })).status === 401);
  ok("she signs in with the new one", (await amy("POST", "/api/auth/login", { loginName: "amy", password: "amy-second" })).status === 200);
  const phone = client(); await phone("POST", "/api/auth/login", { loginName: "amy", password: "amy-second" });
  ok("change my password: the current one must be right", (await amy("POST", "/api/auth/password", { currentPassword: "wrong", newPassword: "amy-third-pw" })).status === 403);
  ok("change my password", (await amy("POST", "/api/auth/password", { currentPassword: "amy-second", newPassword: "amy-third-pw" })).status === 200);
  ok("…this browser stays signed in, the other one does not", (await amy("GET", "/api/config")).status === 200 && (await phone("GET", "/api/config")).status === 401);

  // ---- removing a user
  ok("you cannot remove yourself", /signed in as/.test((await matt("DELETE", "/api/users/matt", { confirm: "DELETE" })).json.error));
  ok("removing needs the typed word", /Type DELETE/.test((await matt("DELETE", "/api/users/bo", {})).json.error));
  ok("an unknown user is a 404", (await matt("DELETE", "/api/users/ghost", { confirm: "DELETE" })).status === 404);
  ok("remove a user", (await matt("DELETE", "/api/users/amy", { confirm: "DELETE" })).status === 200);
  ok("…she is signed out and cannot sign in", (await amy("GET", "/api/config")).status === 401 && (await amy("POST", "/api/auth/login", { loginName: "amy", password: "amy-third-pw" })).status === 401);
  ok("…and is off the list", JSON.stringify((await matt("GET", "/api/users")).json.map((u) => u.name)) === '["matt","bo"]');

  // ---- the Config tab's full editor can never switch the login off or move the password file
  const full = (await matt("GET", "/api/config/full")).json.config;
  full.security = { ...full.security, login_enabled: false, password_file: "/tmp/elsewhere", session_hours: 24, allowed_hosts: ["jarvis.tail1234.ts.net"] };
  full.server = { allow_network: true };
  ok("full-config save works", (await matt("POST", "/api/config/full", { config: full })).status === 200);
  const after = cfgOnDisk();
  ok("…but leaves the login on and the password file where it was", after.security.login_enabled === true && after.security.password_file === undefined && (await anon("GET", "/api/config")).status === 401);
  ok("…while ordinary access settings are saved", after.security.session_hours === 24 && after.server.allow_network === true && after.security.allowed_hosts[0] === "jarvis.tail1234.ts.net");
  acc = (await matt("GET", "/api/access")).json;
  ok("network access saved but not applied until a reload", acc.network.allow === true && acc.network.published === false && acc.network.restart_needed === true && acc.session_hours === 24);
  ok("an extra name is accepted at once", (await matt("GET", "/api/config", undefined, { Host: "jarvis.tail1234.ts.net" })).status === 200);

  // ---- a restart signs everyone out; the password file survives
  const before = matt.cookie();
  await stop(); await boot();
  ok("after a restart the old session is over", (await matt("GET", "/api/config")).status === 401 && before === matt.cookie());
  ok("…and signing in again works", (await matt("POST", "/api/auth/login", { loginName: "matt", password: "matt-password" })).status === 200);

  // ---- deleting the password file resets every password, nothing else
  fs.rmSync(pwFile());
  ok("password file deleted → not_initialized, API closed", (await matt("GET", "/api/auth/me")).json.status === "not_initialized" && (await matt("GET", "/api/config")).status === 401);
  ok("create a login again", (await matt("POST", "/api/auth/setup", { loginName: "matt", password: "fresh-password" })).status === 200);
  ok("…and the shared data is still there", (await matt("GET", "/api/sessions")).json.some((s) => s.id === saved.id));

  // ---- turning it off
  ok("turning the login off needs the typed word", /Type DISABLE/.test((await matt("POST", "/api/access/login", { enabled: false })).json.error));
  ok("turning it off needs a login", (await anon("POST", "/api/access/login", { enabled: false, confirm: "DISABLE" })).status === 401);
  ok("turn the login off", (await matt("POST", "/api/access/login", { enabled: false, confirm: "DISABLE" })).json.login_enabled === false);
  ok("…the app is open again, users and passwords are gone", (await anon("GET", "/api/config")).status === 200 && !fs.existsSync(pwFile()) && cfgOnDisk().security.login_enabled === false);
  ok("…and the data is untouched", (await anon("GET", "/api/sessions")).json.some((s) => s.id === saved.id));

  // ---- network access: which Host names the app answers to
  const host = (h, extra = {}) => anon("GET", "/api/config", undefined, { Host: h, ...extra }).then((r) => r.status);
  ok("this computer only: a LAN address is refused", (await host("192.168.1.5:8110")) === 403);
  await stop(); await boot({ JARVIS_APP_BIND: "0.0.0.0", JARVIS_HOSTNAMES: "mini,mini.local", JARVIS_HOST_ADDRS: "192.168.1.5,100.101.102.103", JARVIS_PUBLIC_PORT: "8110" });
  acc = (await anon("GET", "/api/access")).json;
  ok("open to the network: reported, with the addresses to use", acc.network.published === true && acc.network.restart_needed === false && JSON.stringify(acc.network.urls) === '["http://192.168.1.5:8110","http://100.101.102.103:8110"]');
  ok("a LAN address is accepted", (await host("192.168.1.5:8110")) === 200 && (await host("10.0.0.7")) === 200 && (await host("172.20.1.1:8110")) === 200);
  ok("a VPN (Tailscale-range) address is accepted", (await host("100.101.102.103:8110")) === 200);
  ok("this computer's own names are accepted", (await host("mini.local:8110")) === 200 && (await host("MINI")) === 200);
  ok("a public address or a foreign name is refused", (await host("8.8.8.8")) === 403 && (await host("172.32.0.1")) === 403 && (await host("evil.example")) === 403 && (await host("100.128.0.1")) === 403);
  const lan = { Host: "192.168.1.5:8110" };
  ok("a page on ANOTHER LAN machine cannot post here", (await anon("POST", "/api/notifications/clear", {}, { ...lan, Origin: "http://192.168.1.9:8110" })).status === 403);
  ok("…the same origin can", (await anon("POST", "/api/notifications/clear", {}, { ...lan, Origin: "http://192.168.1.5:8110" })).status === 200);
  ok("the chat socket follows the same rule", (await chatOver("", "http://192.168.1.9")) === "refused:403");

  // ---- the terminal client inside the container
  await anon("POST", "/api/access/login", { enabled: true });
  ok("login on, no exemption: loopback needs a login", (await anon("GET", "/api/notifications")).status === 401);
  await stop(); await boot({ JARVIS_TRUST_LOOPBACK: "1" });
  ok("in the container (JARVIS_TRUST_LOOPBACK): the terminal client's loopback calls pass", (await anon("GET", "/api/notifications")).status === 200 && (await anon("GET", "/api/tasks")).status === 200);
  ok("…while the page still reports that a login is required", (await anon("GET", "/api/auth/me")).json.status === "not_initialized");

  // ---- sign-in attempts are limited
  await stop(); await boot({ JARVIS_NO_RATE_LIMIT: "" });
  await anon("POST", "/api/auth/setup", { loginName: "matt", password: "matt-password" });
  let last = 0; for (let i = 0; i < 11; i++) last = (await client()("POST", "/api/auth/login", { loginName: "matt", password: "wrong-password" })).status;
  ok("more than 10 attempts in 5 minutes → 429", last === 429);

  await stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `AUTH: ${failed} FAILED` : "AUTH: ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("auth test crashed:", e, "\n--- server log tail ---\n" + serverLog.slice(-600));
  try { await stop(); } catch (_) {}
  process.exit(1);
});
