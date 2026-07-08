"use strict";
const fs = require("fs");

const CONFIG_FILE = process.env.JARVIS_CONFIG_FILE || "/cfg/JARVIS_CONFIG.json";

// Settings the UI is allowed to change and persist back to JARVIS_CONFIG.json (so they
// survive reboots/rebuilds). An allowlist — never let arbitrary or secret keys be written.
const SETTABLE = new Set([
  "voice.tts", "voice.stt", "voice.enabled", "voice.mic_mode", "voice.silence_timeout_seconds",
  "voice.tts_voice", "voice.tts_rate", "voice.tts_pitch",
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
      mic_mode: v.mic_mode || "off",
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

module.exports = { config, loadError, publicConfig, CONFIG_FILE, modelFor, modelMode, setSetting, getSecrets, setSecret, deleteSecret, assistantName, systemPrompt };
