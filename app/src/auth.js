"use strict";
// The optional login — the same design as My Business Manager, People Manager and AI Data
// Depot, with My Business Manager's sharing model: several users, ONE JARVIS. Everything
// (chats, memory, tasks, files, settings, the vault) is shared; a login only decides who
// may open it.
//
//   - security.login_enabled turns it on (Config → Access & users). Off by default.
//   - Passwords live in ONE file, the password file (default /data/.password — on the
//     host that is data/.password):  {"users":[{"loginName":"…","passwordHash":"scrypt$…"}]}
//     Salted scrypt hashes, never the passwords; owner-only (0600).
//   - No file → the page asks you to create a login name and password, then writes the
//     file. Forgot every password? Delete the file and reload. Nothing else is touched.
//   - Every user is an admin: any of them may add a user, remove another user, reset
//     another user's password and change their own.
//   - A session is a signed cookie. The signing key is made fresh at every start, so a
//     restart signs everyone out; the cookie also carries a fingerprint of the password
//     it was made with, so removing a user or changing their password ends their sessions.
//
// No dependencies on purpose (Node's own crypto): the app's node_modules are baked into
// the Docker image, so a new package would mean rebuilding the image before JARVIS starts.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { config } = require("./config");

const MIN_PASSWORD = 8;   // the same minimum as the other apps; only checked when a password is SET
const COOKIE = "jarvis_session";
const KEY = crypto.randomBytes(32);   // per-boot signing key
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** An error whose message is shown to the user as-is, with an HTTP status. */
function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }

const sec = () => config.security || {};
function file() {
  return process.env.JARVIS_PASSWORD_FILE || sec().password_file || path.join(process.env.JARVIS_BACKUP_DIR || "/data", ".password");
}
function enabled() { return sec().login_enabled === true; }
function initialized() { return fs.existsSync(file()); }
function sessionHours() { const h = Number(sec().session_hours); return Number.isFinite(h) && h >= 1 ? Math.min(h, 720) : 12; }

// ---- password hashing (scrypt) ---------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const want = Buffer.from(m[5], "base64");
  let got;
  try { got = crypto.scryptSync(String(password), Buffer.from(m[4], "base64"), want.length, { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }); } catch (_) { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const tagOf = (passwordHash) => crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);

// ---- the password file -----------------------------------------------------------------
function read() {
  const damaged = () => fail(`The password file ${file()} is damaged. Delete it and reload to create a new login.`, 500);
  let parsed; try { parsed = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) { throw damaged(); }
  const list = parsed && Array.isArray(parsed.users) ? parsed.users : null;
  if (!list || !list.length || list.some((u) => !u || typeof u.loginName !== "string" || typeof u.passwordHash !== "string")) throw damaged();
  return list.map((u) => ({ loginName: u.loginName, passwordHash: u.passwordHash }));
}
function write(list) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ users: list }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file());
  try { fs.chmodSync(file(), 0o600); } catch (_) {}
}
const logins = () => (initialized() ? read() : []);
const find = (name) => logins().find((u) => same(u.loginName, name));
/** Every login name in the password file. */
function names() { try { return logins().map((u) => u.loginName); } catch (_) { return []; } }
function removeFile() { fs.rmSync(file(), { force: true }); }

// ---- sessions (a signed cookie) --------------------------------------------------------
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (payload) => crypto.createHmac("sha256", KEY).update(payload).digest("base64url");
function cookieOf(req) {
  const raw = String((req && req.headers && req.headers.cookie) || "");
  for (const part of raw.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1); }
  return "";
}
/** The login name of a signed-in request (an Express request or a WebSocket upgrade request), or null. */
function current(req) {
  const c = cookieOf(req); const dot = c.lastIndexOf(".");
  if (dot < 1 || !initialized()) return null;
  const payload = c.slice(0, dot), mac = c.slice(dot + 1), want = sign(payload);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let s; try { s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch (_) { return null; }
  if (!s || !s.n || !s.t || !(Number(s.e) > Date.now())) return null;
  try { const u = find(s.n); return u && tagOf(u.passwordHash) === s.t ? u.loginName : null; } catch (_) { return null; }
}
function startSession(res, user) {
  const payload = b64(JSON.stringify({ n: user.loginName, t: tagOf(user.passwordHash), e: Date.now() + sessionHours() * 3600 * 1000 }));
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionHours() * 3600}`);
}
function endSession(res) { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`); }

// ---- who may use the app ---------------------------------------------------------------
// In the Docker deployment the terminal client (./JARVIS.sh --terminal / --prompt) runs
// INSIDE the app container and talks to http://localhost:80. Nothing else can come from the
// container's own loopback — every browser arrives through the published port, i.e. from
// the Docker bridge — so docker-compose sets JARVIS_TRUST_LOOPBACK=1 and loopback is let in
// without a login. Never set it when the app runs directly on a host.
function trustedLoopback(req) {
  if (process.env.JARVIS_TRUST_LOOPBACK !== "1") return false;
  const a = String((req.socket && req.socket.remoteAddress) || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
/** "disabled" | "not_initialized" | "unauthenticated" | "authenticated" */
function status(req) {
  if (!enabled()) return "disabled";
  if (!initialized()) return "not_initialized";
  return current(req) ? "authenticated" : "unauthenticated";
}
/** What the page needs to choose a screen. */
function state(req) {
  const st = status(req);
  return st === "authenticated" ? { status: st, loginName: current(req) } : { status: st };
}
function allowed(req) { const st = status(req); return st === "disabled" || st === "authenticated" || trustedLoopback(req); }

// ---- operations ------------------------------------------------------------------------
function checkPassword(password) {
  if (!password || String(password).length < MIN_PASSWORD) throw fail(`Choose a password of at least ${MIN_PASSWORD} characters.`);
  if (String(password).length > 1024) throw fail("That password is too long.");
}
function checkName(loginName) {
  const name = String(loginName || "").trim();
  if (!name) throw fail("Choose a login name.");
  if (name.length > 64) throw fail("Keep the login name under 64 characters.");
  return name;
}

/** First run: create the first login and sign in. */
function setup(res, loginName, password) {
  if (!enabled()) throw fail("The login is turned off — turn it on in Config → Access & users first.", 409);
  if (initialized()) throw fail("A login already exists. To start over, delete the password file and reload.", 409);
  const name = checkName(loginName); checkPassword(password);
  const u = { loginName: name, passwordHash: hashPassword(password) };
  write([u]); startSession(res, u);
  return u.loginName;
}
const DECOY = hashPassword(crypto.randomBytes(8).toString("hex"));   // an unknown name costs the same time as a wrong password
function login(res, loginName, password) {
  if (!initialized()) throw fail("No login has been created yet.", 409);
  const u = find(String(loginName || "").trim());
  const ok = verifyPassword(String(password || ""), u ? u.passwordHash : DECOY);
  if (!u || !ok) throw fail("That login name and password do not match.", 401);
  startSession(res, u);
  return u.loginName;
}
/** The signed-in user's name, or throw 401. */
function me(req) { const n = current(req); if (!n) throw fail("Sign in first.", 401); return n; }
function requireOn() { if (!enabled()) throw fail("Users only exist while the login is on. Turn it on in Config → Access & users first.", 409); }

function list(req) {
  requireOn();
  const mine = current(req);
  return logins().map((u) => ({ name: u.loginName, isYou: !!mine && same(u.loginName, mine) }))
    .sort((a, b) => Number(b.isYou) - Number(a.isYou) || a.name.localeCompare(b.name));
}
/** Add another login. Names are unique whatever their capitals. */
function add(loginName, password) {
  requireOn();
  const name = checkName(loginName); checkPassword(password);
  const all = logins();
  if (all.some((u) => same(u.loginName, name))) throw fail(`There is already a user called “${name}”. Pick a different login name.`, 409);
  write([...all, { loginName: name, passwordHash: hashPassword(password) }]);
  return name;
}
/** Set a new password for ANOTHER user (they forgot theirs). Their sessions end. */
function resetPassword(req, name, password) {
  requireOn();
  if (same(name, me(req))) throw fail("To change your own password use “Change my password” — it asks for the current one.");
  const u = find(name); if (!u) throw fail("That user no longer exists.", 404);
  checkPassword(password);
  write(logins().map((x) => (same(x.loginName, name) ? { loginName: x.loginName, passwordHash: hashPassword(password) } : x)));
}
/** Change your own password and stay signed in here (other devices are signed out). */
function changeOwn(req, res, currentPassword, next) {
  requireOn();
  const u = find(me(req));
  if (!u || !verifyPassword(String(currentPassword || ""), u.passwordHash)) throw fail("That is not your current password.", 403);
  checkPassword(next);
  const nu = { loginName: u.loginName, passwordHash: hashPassword(next) };
  write(logins().map((x) => (same(x.loginName, u.loginName) ? nu : x)));
  startSession(res, nu);
}
/** Remove another user: they can no longer sign in and are signed out everywhere. */
function remove(req, name) {
  requireOn();
  if (same(name, me(req))) throw fail("You can't remove the user you are signed in as. Sign in as another user to remove this one.");
  if (!find(name)) throw fail("That user no longer exists.", 404);
  write(logins().filter((u) => !same(u.loginName, name)));
}

module.exports = { MIN_PASSWORD, fail, file, enabled, initialized, names, status, state, allowed, current, setup, login, endSession, list, add, resetPassword, changeOwn, remove, removeFile, sessionHours, hashPassword, verifyPassword };
