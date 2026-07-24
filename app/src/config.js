"use strict";
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = process.env.JARVIS_CONFIG_FILE || "/cfg/JARVIS_CONFIG.json";
// Timestamped backups of the config/secrets files land here before every full-editor
// save, so a bad edit is always recoverable. /data is bind-mounted and gitignored.
const CONFIG_BACKUP_DIR = process.env.JARVIS_BACKUP_DIR || "/data";

// Settings the UI is allowed to change and persist back to JARVIS_CONFIG.json (so they
// survive reboots/rebuilds). An allowlist — never let arbitrary or secret keys be written.
const SETTABLE = new Set([
  "voice.tts", "voice.stt", "voice.enabled", "voice.mic_mode", "voice.silence_timeout_seconds",
  "voice.followup_seconds", "voice.ambient_style", "voice.tts_engine", "voice.tts_voice", "voice.tts_rate", "voice.tts_pitch",
  "llm.model", "llm.models.chat", "llm.temperature", "llm.max_tokens", "assistant_name",
  "skills_autohint",
]);

let config = {};
let loadError = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
  loadError = e.message;
}

// The AI's name. Drives identity (system prompt), the displayed title, and the
// voice wake word / stop phrase (which derive from it unless explicitly set).
function assistantName() {
  return (config.assistant_name && String(config.assistant_name).trim()) ||
    (config.app && config.app.title) || "JARVIS";
}
// The system prompt with {assistant_name} substituted, so the model knows its name.
// Optional personas (config.personas.<name>) override or extend the base prompt:
//   "personas": { "work": { "system_prompt": "..." },          // full replacement
//                 "brief": { "append": "Answer in 2 sentences max." } }  // addition
function systemPrompt(persona) {
  let sp = (config.llm && config.llm.system_prompt) || "You are {assistant_name}, a helpful AI assistant.";
  const p = persona && config.personas && config.personas[persona];
  if (p && p.system_prompt) sp = p.system_prompt;
  else if (p && p.append) sp = sp + "\n\n" + p.append;
  return sp.replace(/\{assistant_name\}/g, assistantName());
}

// "single" => every task tier uses llm.model (the models block is ignored).
// "multi"  => use the per-task tiers (with fallback). If unset, infer: multi when a
// non-empty models block is present, else single.
function modelMode() {
  const llm = config.llm || {};
  const mode = String(llm.model_mode || "").toLowerCase();
  if (mode === "single" || mode === "multi") return mode;
  return llm.models && Object.keys(llm.models).length ? "multi" : "single";
}

// Resolve a model for a task tier (chat | cheap | vision | smart). In multi-model
// mode each tier can name ANY model the gateway knows (under llm.models), falling
// back to the chat tier then llm.model. In single-model mode all tiers use llm.model.
function modelFor(tier) {
  const llm = config.llm || {};
  if (modelMode() === "single") return llm.model || "gpt-4o-mini";
  const m = llm.models || {};
  return m[tier] || m.chat || llm.model || "gpt-4o-mini";
}

// Safe subset sent to the browser (no api_key, no db password).
function publicConfig() {
  const v = config.voice || {};
  const llm = config.llm || {};
  const name = assistantName();
  return {
    title: name,
    provider: llm.provider || "",
    model: modelFor("chat"),
    model_mode: modelMode(),
    models: modelMode() === "multi" ? (llm.models || {}) : {},
    voice: {
      enabled: v.enabled !== false,
      tts: v.tts !== false,
      stt: v.stt !== false,
      wake_word: (v.wake_word || name).toLowerCase(),
      stop_phrase: (v.stop_phrase || (name + " stop listening")).toLowerCase(),
      silence_timeout_seconds: v.silence_timeout_seconds || 12,
      followup_seconds: Number(v.followup_seconds) || 0,
      ambient_style: v.ambient_style === "orb" ? "orb" : "face",
      mic_mode: v.mic_mode || "off",
      tts_engine: v.tts_engine === "piper" ? "piper" : "browser",
      tts_voice: v.tts_voice || "",
      tts_rate: v.tts_rate || 1.0,
      tts_pitch: v.tts_pitch || 1.0,
    },
    workbench_url: (config.workbench && config.workbench.desktop_url) || "",
    personas: Object.keys(config.personas || {}),
    skills_autohint: config.skills_autohint !== false,
  };
}

// Update one allowlisted setting IN MEMORY (takes effect immediately) and persist it
// atomically to JARVIS_CONFIG.json so it survives restarts/rebuilds.
function setSetting(pathStr, value) {
  if (!SETTABLE.has(pathStr)) throw new Error("setting not allowed: " + pathStr);
  const parts = pathStr.split(".");
  let o = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  // Write IN PLACE: CONFIG_FILE is a bind-mounted single file, so a tmp+rename swap fails
  // with EBUSY (can't rename over a mount point). One writeFileSync is fine for a config
  // that's only changed occasionally by a single user.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return { path: pathStr, value };
}

// Current debug-logging level (0 off .. 5 full). Read live from `config` so a change
// saved from the Config tab takes effect immediately (no --reload needed for logging).
function logLevel() {
  const n = Number(config.logging && config.logging.level);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.trunc(n))) : 0;
}

// --- full-config editor (the UI Config tab) -------------------------------------
// The Config tab reads and writes the WHOLE JARVIS_CONFIG.json + JARVIS_SECRETS.json,
// not just the small SETTABLE allowlist. Reads come straight from disk (so the editor
// reflects the on-disk state even if the in-memory config is stale after a prior save),
// and writes validate, back up the previous file, then overwrite in place. Applying the
// change is a separate explicit step: `./JARVIS.sh --reload`.
function _readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function readFullConfig() {
  const out = { config: null, secrets: null, config_error: null, secrets_error: null };
  try { out.config = _readJson(CONFIG_FILE); } catch (e) { out.config_error = e.message; }
  try { out.secrets = _readJson(SECRETS_FILE); } catch (e) { out.secrets_error = e.message; }
  return out;
}

function _backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(CONFIG_BACKUP_DIR, path.basename(file, ".json") + ".backup." + ts + ".json");
    fs.copyFileSync(file, dest);
    return dest;
  } catch (_) { return null; }
}

function writeFullConfig({ config: newConfig, secrets: newSecrets }) {
  const result = { saved: [], backups: [] };
  if (newConfig !== undefined && newConfig !== null) {
    if (typeof newConfig !== "object" || Array.isArray(newConfig)) throw new Error("config must be a JSON object");
    if (!newConfig.llm || typeof newConfig.llm !== "object") throw new Error("config.llm must be present and be an object");
    const b = _backup(CONFIG_FILE); if (b) result.backups.push(b);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    // Mutate the SAME `config` object in place (not reassign) so every module that
    // captured the reference at require-time — and live accessors like logLevel() —
    // see the update immediately (e.g. a log-level change applies without --reload).
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, newConfig);
    result.saved.push("config");
  }
  if (newSecrets !== undefined && newSecrets !== null) {
    if (typeof newSecrets !== "object" || Array.isArray(newSecrets)) throw new Error("secrets must be a JSON object");
    if (!newSecrets.secrets || typeof newSecrets.secrets !== "object") throw new Error("secrets file must have a 'secrets' object");
    const b = _backup(SECRETS_FILE); if (b) result.backups.push(b);
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(newSecrets, null, 2));
    for (const k of Object.keys(secretsDoc)) delete secretsDoc[k];
    Object.assign(secretsDoc, newSecrets);
    result.saved.push("secrets");
  }
  return result;
}

// --- credential vault (the user's own accounts) ---
const SECRETS_FILE = process.env.JARVIS_SECRETS_FILE || "/cfg/JARVIS_SECRETS.json";
let secretsDoc = { secrets: {} };
try {
  const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  if (raw && typeof raw === "object") secretsDoc = raw;
  if (!secretsDoc.secrets || typeof secretsDoc.secrets !== "object") secretsDoc.secrets = {};
} catch (_) {
  secretsDoc = { secrets: {} };
}
function getSecrets() { return secretsDoc.secrets; }
function persistSecrets() { fs.writeFileSync(SECRETS_FILE, JSON.stringify(secretsDoc, null, 2)); }
function setSecret(name, fields) {
  if (!name) throw new Error("secret name is required");
  const existing = secretsDoc.secrets[name] || {};
  secretsDoc.secrets[name] = { ...existing, ...(fields || {}) }; // partial update
  persistSecrets();
  return { name, saved: true };
}
function deleteSecret(name) {
  if (!secretsDoc.secrets[name]) return { name, deleted: false };
  delete secretsDoc.secrets[name];
  persistSecrets();
  return { name, deleted: true };
}

module.exports = { config, loadError, publicConfig, CONFIG_FILE, modelFor, modelMode, setSetting, getSecrets, setSecret, deleteSecret, assistantName, systemPrompt, readFullConfig, writeFullConfig, logLevel };
