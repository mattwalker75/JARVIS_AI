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
  "voice.stt_engine",
  "llm.model", "llm.models.chat", "llm.temperature", "llm.max_tokens", "assistant_name",
  "skills_autohint",
]);

// Expected value type for each allowlisted setting — a wrong type (a string where a number
// belongs, an object, …) is refused instead of being written into the file.
const SETTING_TYPES = {
  "voice.tts": "boolean", "voice.stt": "boolean", "voice.enabled": "boolean", "skills_autohint": "boolean",
  "voice.silence_timeout_seconds": "number", "voice.followup_seconds": "number",
  "voice.tts_rate": "number", "voice.tts_pitch": "number", "llm.temperature": "number", "llm.max_tokens": "number",
  "voice.mic_mode": "string", "voice.ambient_style": "string", "voice.tts_engine": "string", "voice.tts_voice": "string",
  "voice.stt_engine": "string", "assistant_name": "string", "llm.model": "name", "llm.models.chat": "name",
};

let config = {};
let loadError = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) { config = {}; throw new Error("the file must hold one JSON object"); }
} catch (e) {
  loadError = e.message;
}
// The plain sentence shown while the config file can't be read. Writes are refused then (they
// would overwrite the user's broken-but-recoverable file with an empty config) and the API stays
// locked (the login settings live in that file, so running without them would mean no login).
function configProblem() {
  return loadError ? `config/JARVIS_CONFIG.json can't be read (${loadError}). Fix the file, then reload — nothing was saved.` : null;
}
function refuseIfBroken() {
  if (loadError) { const e = new Error(configProblem()); e.status = 503; throw e; }
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
// The Linux workbench container is OPTIONAL (workbench.enabled, default on — Config →
// Workbench). With it off there is no shell, desktop, browser automation, app preview,
// PDF/Office reading or local speech-to-text: those tools are withheld from the model
// (tools.activeToolDefs), the Workbench tab is hidden, and ./JARVIS.sh leaves the container
// stopped. Everything else — chat, memory, web search, files, email, tasks — keeps working.
function workbenchEnabled() { return !(config.workbench && config.workbench.enabled === false); }
const NO_WORKBENCH_RULE =
  "\n\nNO WORKBENCH: the Linux workbench is switched OFF in this setup, so you have NO shell, NO desktop, NO browser automation and NO app previews. " +
  "Do not promise or attempt to run commands, install software, build or serve apps, click through websites, take screenshots, read PDF/Office documents, or transcribe audio — those tools do not exist right now. " +
  "You still have long-term memory, web search and page fetching, the shared folders (list/read/write/edit files), image analysis, email, the credential vault, scheduled tasks and plans. " +
  "If a request truly needs the workbench, say so plainly and tell the user it can be switched on in the Config tab (Workbench & shared folders).";
// The ACTIVE prompt lives in editable files: /Prompts/default_master.prompt + default_system.prompt
// (all file access via ./prompts — shared with the /api/prompts routes). Read fresh (small files)
// so edits apply on the next turn without a restart; fall back to the config values (then a
// built-in default) if a file is absent.
const promptFiles = require("./prompts");
function systemPrompt(persona) {
  const llm = config.llm || {};
  let sp = promptFiles.readPart("default", "system");
  if (sp == null) sp = llm.system_prompt || "You are {assistant_name}, a helpful AI assistant.";
  let master = promptFiles.readPart("default", "master");
  if (master == null) master = llm.master_prompt || "";
  master = master.trim();
  const p = persona && config.personas && config.personas[persona];
  if (p && p.system_prompt) sp = p.system_prompt;
  else if (p && p.append) sp = sp + "\n\n" + p.append;
  // Order: MASTER (identity/mission) -> SYSTEM (operating instructions) -> constant guardrails.
  const base = (master ? master + "\n\n" : "") + sp;
  return base.replace(/\{assistant_name\}/g, assistantName()) + TOOL_USE_RULE + PLANNER_RULE + (workbenchEnabled() ? CODING_RULE : NO_WORKBENCH_RULE);
}

// Name of the prompt set in use (null = custom/hand-edited default) — see ./prompts.
// Re-exported here because llm.js and skills.js already import it from config.
const activePromptName = promptFiles.activePromptName;

// "single" => every task tier uses llm.model (the models block is ignored).
// "multi"  => use the per-task tiers (with fallback). If unset, infer: multi when a
// non-empty models block is present, else single.
function modelMode() {
  const llm = config.llm || {};
  const mode = String(llm.model_mode || "").toLowerCase();
  if (mode === "single" || mode === "multi") return mode;
  return llm.models && Object.keys(llm.models).length ? "multi" : "single";
}

// A tier entry is either a model-name string, or an object with per-tier overrides:
//   "smart": "qwen3:32b"                                       — just the model
//   "smart": { "model": "qwen3:32b", "temperature": 0.2, "max_tokens": 8000 }
const entryModel = (e) => (e && typeof e === "object" ? e.model : e);

// Resolve a model for a task tier (chat | cheap | vision | smart). In multi-model
// mode each tier can name ANY model the gateway knows (under llm.models), falling
// back to the chat tier then llm.model. In single-model mode all tiers use llm.model.
function modelFor(tier) {
  const llm = config.llm || {};
  if (modelMode() === "single") return llm.model || "gpt-4o-mini";
  const m = llm.models || {};
  return entryModel(m[tier]) || entryModel(m.chat) || llm.model || "gpt-4o-mini";
}

// Per-tier generation overrides from the object form (empty when the tier is a plain
// string / single mode) — llm.js merges these over the global llm.temperature/max_tokens.
function paramsFor(tier) {
  const llm = config.llm || {};
  if (modelMode() === "single") return {};
  const e = (llm.models || {})[tier];
  if (!e || typeof e !== "object") return {};
  const out = {};
  if (Number.isFinite(Number(e.temperature))) out.temperature = Number(e.temperature);
  if (Number(e.max_tokens) > 0) out.max_tokens = Number(e.max_tokens);
  return out;
}

// The context-window size assumed when neither the config nor the endpoint says (shared with
// server.js /api/context-window so the meter and the page agree).
const DEFAULT_CONTEXT_WINDOW = 32768;

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
    // Display map is always plain strings, even when a tier uses the object form.
    models: modelMode() === "multi"
      ? Object.fromEntries(Object.entries(llm.models || {}).map(([k, v]) => [k, entryModel(v) || ""]))
      : {},
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
      stt_engine: v.stt_engine === "local" && workbenchEnabled() ? "local" : "browser",   // local = whisper in the workbench
      tts_engine: v.tts_engine === "piper" ? "piper" : "browser",
      tts_voice: v.tts_voice || "",
      tts_rate: v.tts_rate || 1.0,
      tts_pitch: v.tts_pitch || 1.0,
    },
    workbench_url: (config.workbench && config.workbench.desktop_url) || "",
    workbench_enabled: workbenchEnabled(),
    personas: Object.keys(config.personas || {}),
    skills_autohint: config.skills_autohint !== false,
    stall_seconds: Number((config.ui || {}).stall_seconds) || 25,
    auto_compact_pct: Number((config.ui || {}).auto_compact_pct ?? 85),   // 0 = never auto-compact
    autopilot: { autonomy: ((config.autopilot || {}).autonomy === "full") ? "full" : "guarded", default_minutes: Number((config.autopilot || {}).default_minutes) || 30 },
    context_window: Number((config.llm || {}).context_window) || Number((config.ollama || {}).context_length) || DEFAULT_CONTEXT_WINDOW,
  };
}

// Update one allowlisted setting IN MEMORY (takes effect immediately) and persist it
// atomically to JARVIS_CONFIG.json so it survives restarts/rebuilds.
function checkSettingType(pathStr, value) {
  const want = SETTING_TYPES[pathStr];
  const bad = (what) => { throw new Error(`${pathStr} must be ${what} — nothing was saved.`); };
  if (want === "boolean" && typeof value !== "boolean") bad("true or false");
  if (want === "number" && !(typeof value === "number" && Number.isFinite(value))) bad("a number");
  if (want === "number" && pathStr === "llm.max_tokens" && !(value > 0)) bad("a number above 0");
  if (want === "string" && typeof value !== "string") bad("text");
  if (want === "name" && !(typeof value === "string" && value.trim())) bad("a model name");
  if (typeof value === "string" && value.length > 500) bad("shorter than 500 characters");
}
function setSetting(pathStr, value) {
  if (!SETTABLE.has(pathStr)) throw new Error("setting not allowed: " + pathStr);
  refuseIfBroken();
  checkSettingType(pathStr, value);
  if (pathStr.startsWith("llm.models.")) {
    // A tier's model. In single-model mode every tier runs llm.model, and creating a models block
    // would silently flip the app into multi-model mode — so set llm.model instead. A tier written
    // in the object form ({model, temperature, …}) keeps its other overrides: only .model changes.
    const tier = pathStr.slice("llm.models.".length);
    if (!config.llm || typeof config.llm !== "object") config.llm = {};
    if (modelMode() === "single") {
      config.llm.model = value;
      _persist();
      return { path: "llm.model", value };
    }
    if (!config.llm.models || typeof config.llm.models !== "object") config.llm.models = {};
    const cur = config.llm.models[tier];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur.model = value;
    else config.llm.models[tier] = value;
    _persist();
    return { path: pathStr, value };
  }
  const parts = pathStr.split(".");
  let o = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  _persist();
  return { path: pathStr, value };
}
// Write IN PLACE: CONFIG_FILE is a bind-mounted single file, so a tmp+rename swap fails
// with EBUSY (can't rename over a mount point). Back up first so a crash mid-write (which would
// truncate the file and wipe every persisted setting on next boot) is recoverable.
function _persist() {
  _backup(CONFIG_FILE);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
  const out = { config: null, secrets: null, config_error: null, secrets_error: null, version: fullConfigVersion() };
  try { out.config = _readJson(CONFIG_FILE); } catch (e) { out.config_error = e.message; }
  try { out.secrets = _readJson(SECRETS_FILE); } catch (e) { out.secrets_error = e.message; }
  return out;
}

// "<config hash>:<secrets hash>" of the files on disk. The Config tab sends back the version it
// loaded; a save is refused if a file changed since (a header toggle, a secret the model saved,
// another tab) — it used to silently overwrite those changes with the tab's stale copy.
function _fileHash(f) {
  try { return require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); }
  catch (_) { return "none"; }
}
function fullConfigVersion() { return _fileHash(CONFIG_FILE) + ":" + _fileHash(SECRETS_FILE); }

// Keep only the newest N backups per file (backups.retain in JARVIS_CONFIG.json, default
// 10; 0 = keep everything). Every CONFIG backup carries the live api_key, so an unbounded
// pile of them is a steadily growing pool of key copies on disk — prune on each new backup.
function _pruneBackups(base) {
  const raw = Number(config.backups && config.backups.retain);
  const retain = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 10;
  if (retain === 0) return;   // explicitly unlimited
  const prefix = base + ".backup.";
  const files = fs.readdirSync(CONFIG_BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();   // names embed an ISO timestamp, so lexical order == chronological order
  for (const f of files.slice(0, Math.max(0, files.length - retain))) {
    fs.rmSync(path.join(CONFIG_BACKUP_DIR, f), { force: true });
  }
}

function _backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const base = path.basename(file, ".json");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(CONFIG_BACKUP_DIR, base + ".backup." + ts + ".json");
    fs.copyFileSync(file, dest);
    try { _pruneBackups(base); } catch (_) {}   // pruning must never block the backup itself
    return dest;
  } catch (_) { return null; }
}

// Whether the login is on, and where its password file lives, change ONLY through the
// dedicated actions (Config → Access & users → setProtected below). The full-config editor
// works on a copy of the file that may be minutes old; letting it write these two keys
// would let a stale Save silently switch the login off (or point it at another file).
const PROTECTED = ["security.login_enabled", "security.password_file"];
function _get(obj, dotted) { return dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj); }
function _put(obj, dotted, value) {
  const parts = dotted.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== "object" || Array.isArray(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
  if (value === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = value;
}
/** Set one protected key (in memory + on disk, with a backup). Server-internal: never reachable with a caller-chosen path. */
function setProtected(pathStr, value) {
  if (!PROTECTED.includes(pathStr)) throw new Error("not a protected setting: " + pathStr);
  refuseIfBroken();
  _put(config, pathStr, value);
  _backup(CONFIG_FILE);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return { path: pathStr, value };
}

function writeFullConfig({ config: newConfig, secrets: newSecrets, version }) {
  refuseIfBroken();
  if (typeof version === "string" && version) {
    const [cv, sv] = version.split(":");
    const [ncv, nsv] = fullConfigVersion().split(":");
    const stale = (newConfig != null && cv !== ncv) || (newSecrets != null && sv !== nsv);
    if (stale) {
      const e = new Error("The config changed since you opened this tab (for example a header toggle, or a secret JARVIS saved). Reload the tab to see the latest, then make your change again — nothing was saved.");
      e.status = 409; e.code = "stale";
      throw e;
    }
  }
  const result = { saved: [], backups: [] };
  if (newConfig !== undefined && newConfig !== null) {
    if (typeof newConfig !== "object" || Array.isArray(newConfig)) throw new Error("config must be a JSON object");
    if (!newConfig.llm || typeof newConfig.llm !== "object") throw new Error("config.llm must be present and be an object");
    for (const k of PROTECTED) _put(newConfig, k, _get(config, k));   // keep the live values, whatever the editor sent
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
function persistSecrets() { _backup(SECRETS_FILE); fs.writeFileSync(SECRETS_FILE, JSON.stringify(secretsDoc, null, 2)); }
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

module.exports = {
  fullConfigVersion, config, loadError, configProblem, DEFAULT_CONTEXT_WINDOW, publicConfig, workbenchEnabled, modelFor, modelMode, paramsFor, setSetting, setProtected, getSecrets, setSecret, deleteSecret, assistantName, systemPrompt, activePromptName, readFullConfig, writeFullConfig, logLevel };
