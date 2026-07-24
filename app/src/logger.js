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
function ensureDir() {
  if (dirReady) return true;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); dirReady = true; return true; }
  catch (_) { return false; }
}

// Gather current secret values (vault + provider api keys) to scrub from output.
function secretValues() {
  const vals = [];
  try {
    const secrets = cfg.getSecrets ? cfg.getSecrets() : {};
    for (const entry of Object.values(secrets || {})) {
      if (entry && typeof entry === "object") {
        for (const v of Object.values(entry)) if (typeof v === "string" && v.length >= 6) vals.push(v);
      }
    }
    const llm = (cfg.config && cfg.config.llm) || {};
    for (const k of ["api_key", "anthropic_api_key", "gemini_api_key"]) {
      if (typeof llm[k] === "string" && llm[k].length >= 6) vals.push(llm[k]);
    }
  } catch (_) {}
  return vals;
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
