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
// Always-present, constant rule appended to every system prompt. Stays byte-stable so it
// doesn't hurt KV-cache reuse. Reduces the "tool call written as text" failure at the source
// (the harness also salvages/executes such calls — see llm.js parseTextToolCalls).
const TOOL_USE_RULE =
  "\n\nIMPORTANT — tool use: always invoke tools through the real function/tool-call mechanism. " +
  "NEVER write a tool call as text in your reply (no <tool_call> tags, no <parameter=…> blocks, no JSON pretending to be a call) — text like that does NOT execute, it just gets shown to the user. If you want to run something, actually call the tool.";
const PLANNER_RULE =
  "\n\nPLANS (task ledger): for any MULTI-STEP job (build/fix an app, research then produce something, changes across several files/steps), FIRST call plan_create(objective, steps) to lay out an ordered checklist. Then, as you work, call plan_update(step, status) the moment a step's status changes (active → done, or blocked). Your active plan is shown to you at the start of every turn — you do NOT need to call plan_show to re-read it. This is how you keep your place and RESUME correctly after any interruption — never restart steps already marked done. Add unforeseen steps with plan_add_step, and call plan_clear when the whole objective is finished. Skip the ledger for trivial one-shot requests.";
// Workbench coding habits — these fix concrete weaknesses a small model exposed: rewriting
// whole files (bugs), debugging runtime issues by re-reading static code (can't see the error),
// and putting build files in the user-facing folder.
const CODING_RULE =
  "\n\nWORKBENCH CODING: Build and iterate in /LLM_WORKSPACE (that is your scratch/build area). Save FINISHED deliverables for the user to /LLM_READ_WRITE_FILES — do NOT put in-progress build files there, and do NOT look for your own code there (it's in /LLM_WORKSPACE). " +
  "To CHANGE an existing file, use edit_workbench_file (a targeted find-and-replace of an exact snippet) instead of rewriting the whole file with write_workbench_file — whole-file rewrites are slow and tend to reintroduce bugs. Use write_workbench_file only to CREATE a file or replace a small one. " +
  "To DEBUG a web app that renders wrong/blank or misbehaves at RUNTIME: serve it, then browser_goto its URL and call browser_console to read the actual JavaScript error + console output (browser_goto also reports load-time errors). Do NOT try to diagnose a runtime rendering bug by only re-reading the static HTML/JS — you cannot see a runtime error that way. " +
  "After you CREATE or EDIT code, quickly syntax-check it before moving on (e.g. run_shell `node -c file.js`, `python3 -m py_compile file.py`, `bash -n script.sh`, or just run it) — this catches typos and undefined variables you introduced, instead of shipping a silently-broken file.";
// The ACTIVE prompt lives in editable files: /Prompts/default_master.prompt + default_system.prompt.
// Read fresh (small files) so edits apply on the next turn without a restart; fall back to the
// config values (then a built-in default) if a file is absent.
const PROMPTS_DIR = process.env.JARVIS_PROMPTS_DIR || "/Prompts";
function readPromptFile(name) { try { return fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8"); } catch (_) { return null; } }
function systemPrompt(persona) {
  const llm = config.llm || {};
  let sp = readPromptFile("default_system.prompt");
  if (sp == null) sp = llm.system_prompt || "You are {assistant_name}, a helpful AI assistant.";
  let master = readPromptFile("default_master.prompt");
  if (master == null) master = llm.master_prompt || "";
  master = master.trim();
  const p = persona && config.personas && config.personas[persona];
  if (p && p.system_prompt) sp = p.system_prompt;
  else if (p && p.append) sp = sp + "\n\n" + p.append;
  // Order: MASTER (identity/mission) -> SYSTEM (operating instructions) -> constant guardrails.
  const base = (master ? master + "\n\n" : "") + sp;
  return base.replace(/\{assistant_name\}/g, assistantName()) + TOOL_USE_RULE + PLANNER_RULE + CODING_RULE;
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
    stall_seconds: Number((config.ui || {}).stall_seconds) || 25,
    autopilot: { autonomy: ((config.autopilot || {}).autonomy === "full") ? "full" : "guarded", default_minutes: Number((config.autopilot || {}).default_minutes) || 30 },
    context_window: Number((config.llm || {}).context_window) || Number((config.ollama || {}).context_length) || 32768,
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
