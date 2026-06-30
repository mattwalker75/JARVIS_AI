"use strict";
const fs = require("fs");

const CONFIG_FILE = process.env.JARVIS_CONFIG_FILE || "/cfg/JARVIS_CONFIG.json";

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
function systemPrompt() {
  const sp = (config.llm && config.llm.system_prompt) || "You are {assistant_name}, a helpful AI assistant.";
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
    },
    workbench_url: (config.workbench && config.workbench.desktop_url) || "",
  };
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

module.exports = { config, loadError, publicConfig, CONFIG_FILE, modelFor, modelMode, getSecrets, setSecret, deleteSecret, assistantName, systemPrompt };
