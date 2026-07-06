"use strict";
// A small, persisted ring buffer of recent chat messages so that scheduled/background
// tasks (which run with a fresh, stateless context) can see what has happened in the
// user's live conversation — e.g. whether the USER has replied recently, or what the
// task itself has already posted (to avoid repeating). Exposed to the model via the
// read_recent_chat tool. Roles: "user", "assistant", "task".
const path = require("path");
const persist = require("./persist");

const DIR = path.dirname(process.env.JARVIS_TASKS_FILE || "/data/tasks.json");
const FILE = path.join(DIR, "chatlog.json");
const MAX = 300;               // keep at most this many recent messages

let buf = [];
{ const j = persist.readJson(FILE, null); if (Array.isArray(j)) buf = j; }

let writeTimer = null;
function flush() { try { persist.writeJsonAtomic(FILE, buf.slice(-MAX)); } catch (_) {} }
function schedulePersist() {
  if (writeTimer) return;      // debounce bursts of writes
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, 250);
}
// Don't lose the last few messages on shutdown.
process.on("SIGTERM", flush); process.on("SIGINT", flush); process.on("beforeExit", flush);

// Record one chat-visible message.
function record(role, text) {
  if (!text || typeof text !== "string") return;
  buf.push({ at: Date.now(), role, text: text.length > 2000 ? text.slice(0, 2000) + "…" : text });
  if (buf.length > MAX) buf = buf.slice(-MAX);
  schedulePersist();
}

// Return recent messages (oldest→newest) with ISO timestamps, optionally filtered.
function recent(opts) {
  opts = opts || {};
  let out = buf;
  if (opts.since_minutes != null) {
    const cut = Date.now() - Number(opts.since_minutes) * 60000;
    out = out.filter((m) => m.at >= cut);
  }
  if (Array.isArray(opts.roles) && opts.roles.length) {
    const set = new Set(opts.roles);
    out = out.filter((m) => set.has(m.role));
  }
  const lim = opts.limit != null ? Math.max(1, Number(opts.limit)) : 30;
  return out.slice(-lim).map((m) => ({ at: new Date(m.at).toISOString(), role: m.role, text: m.text }));
}

module.exports = { record, recent };
