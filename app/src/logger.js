"use strict";
// Leveled debug logger. Off by default (level 0). Set logging.level (0-5) in
// JARVIS_CONFIG.json / the Config tab; the level is read LIVE per call, so it can be
// raised to 5 to capture a failing session and dropped back to 0 without a restart.
//
//   1 error   — failures, exceptions, failed tool calls, LLM errors
//   2 warn    — retries, recoverable issues, guardrail triggers
//   3 info    — turn start/end, each tool call (name), model, timings
//   4 verbose — full tool args + results, token usage, per-iteration loop detail
//   5 debug   — the complete LLM request (messages) + raw response, browser actions
//
// Writes one file per day to JARVIS_AI/Logs/ (bind-mounted at /logs). Secret values are
// redacted so a level-5 log is never a credential leak. Logging never throws — a broken
// log write must not take down JARVIS.
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const LOG_DIR = process.env.JARVIS_LOG_DIR || "/logs";
const NAMES = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "VERBOSE", 5: "DEBUG" };
const MAX_FIELD_CHARS = 20000; // cap a single logged payload so one turn can't dump MBs

let dirReady = false;
let writeCount = 0;
function ensureDir() {
  if (dirReady) return true;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); dirReady = true; cleanupOldLogs(); return true; }
  catch (_) { return false; }
}

// --- rotation + retention (level-5 logs grow fast; keep the dir bounded) ---
function logCfg() { const l = (cfg.config && cfg.config.logging) || {}; return { maxMb: Number(l.max_mb) || 50, retainDays: Number(l.retain_days) || 14 }; }
let _cleanedDay = "";
function cleanupOldLogs() {
  // Run at most once per calendar day (not once per process) so retain_days is actually enforced on
  // a long-lived server — the first log write after midnight re-prunes.
  const today = new Date().toISOString().slice(0, 10);
  if (_cleanedDay === today) return; _cleanedDay = today;
  try {
    const { retainDays } = logCfg();
    const cutoff = Date.now() - retainDays * 86400000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^jarvis-.*\.log$/.test(f)) continue;
      const fp = path.join(LOG_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true }); } catch (_) {}
    }
  } catch (_) {}
}
// If today's file exceeds the size cap, roll it to jarvis-<day>.<n>.log so no single file grows unbounded.
function rotateIfBig(file, day) {
  try {
    const { maxMb } = logCfg();
    const st = fs.statSync(file);
    if (st.size < maxMb * 1024 * 1024) return;
    let n = 1;
    while (fs.existsSync(path.join(LOG_DIR, `jarvis-${day}.${n}.log`))) n++;
    fs.renameSync(file, path.join(LOG_DIR, `jarvis-${day}.${n}.log`));
  } catch (_) {}
}

// Gather current secret values (vault + provider api keys) to scrub from output.
const SECRET_KEY_RE = /pass|secret|token|api[_-]?key|auth|credential|cookie|private[_-]?key/i;
function secretValues() {
  const out = new Set();
  const add = (v) => { if (typeof v === "string" && v.length >= 4) out.add(v); };
  try {
    // The vault is secret by definition: scrub every field of every entry.
    const secrets = cfg.getSecrets ? cfg.getSecrets() : {};
    for (const entry of Object.values(secrets || {})) {
      if (entry && typeof entry === "object") for (const v of Object.values(entry)) add(v);
    }
    // Config: recursively scrub any string whose KEY looks like a credential (db.password, any
    // *_api_key, oauth tokens, cookies …) — not just a fixed allowlist. Non-secret config keys
    // (base_url, model, …) are left intact so logs stay readable.
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 6) return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") { if (SECRET_KEY_RE.test(k)) add(v); }
        else walk(v, depth + 1);
      }
    };
    walk(cfg.config || {}, 0);
  } catch (_) {}
  return [...out];
}
function redact(s) {
  let out = String(s);
  for (const v of secretValues()) { if (v) out = out.split(v).join("***REDACTED***"); }
  return out;
}

function serialize(data) {
  if (data === undefined) return "";
  let s;
  try { s = typeof data === "string" ? data : JSON.stringify(data); }
  catch (_) { s = String(data); }
  if (s.length > MAX_FIELD_CHARS) s = s.slice(0, MAX_FIELD_CHARS) + `…[+${s.length - MAX_FIELD_CHARS} chars]`;
  return redact(s);
}

function write(lvl, category, message, data) {
  try {
    if (cfg.logLevel() < lvl) return;      // cheap early-out when disabled or below level
    if (!ensureDir()) return;
    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);
    const file = path.join(LOG_DIR, `jarvis-${day}.log`);
    if ((++writeCount & 0x3f) === 0) rotateIfBig(file, day);   // check size ~every 64 writes
    const extra = data === undefined ? "" : " | " + serialize(data);
    fs.appendFileSync(file, `${ts} ${NAMES[lvl]} [${category}] ${redact(message)}${extra}\n`);
  } catch (_) { /* logging must never throw */ }
}

module.exports = {
  error:   (category, message, data) => write(1, category, message, data),
  warn:    (category, message, data) => write(2, category, message, data),
  info:    (category, message, data) => write(3, category, message, data),
  verbose: (category, message, data) => write(4, category, message, data),
  debug:   (category, message, data) => write(5, category, message, data),
  level:   () => cfg.logLevel(),
  LOG_DIR,
};
