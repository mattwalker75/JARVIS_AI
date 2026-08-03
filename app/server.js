"use strict";
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const { config, loadError, publicConfig, systemPrompt, setSetting, readFullConfig, writeFullConfig } = require("./src/config");
const llm = require("./src/llm");
const tools = require("./src/tools");
const scheduler = require("./src/scheduler");
const chatlog = require("./src/chatlog");
const tts = require("./src/tts");
const mdview = require("./src/mdview");

const app = express();
app.use(express.json({ limit: "25mb" }));   // roomy enough for base64 file uploads
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.get("/api/config", (_req, res) => {
  if (loadError) return res.status(500).json({ error: loadError });
  res.json(publicConfig());
});

// Resolve the context-window ceiling for the meter. Manual (llm.context_window) wins; else
// AUTO: local Ollama -> the loaded num_ctx (the effective ceiling); cloud via the LiteLLM
// gateway -> /model/info; else a default. Best-effort — degrades to the config value.
app.get("/api/context-window", async (_req, res) => {
  const { config: cfg, modelFor } = require("./src/config");
  const llm = cfg.llm || {};
  const explicit = Number(llm.context_window);
  if (explicit > 0) return res.json({ context_window: explicit, source: "configured" });
  const provider = String(llm.provider || "").toLowerCase();
  const base = (llm.base_url || "").replace(/\/+$/, "");
  const numCtx = Number((cfg.ollama || {}).context_length);
  const isLocal = provider === "ollama" || provider === "local" || /ollama|litellm|11434|localhost|127\.0\.0\.1|host\.docker/.test(base);
  if (isLocal && numCtx > 0) return res.json({ context_window: numCtx, source: "ollama num_ctx" });
  // Cloud (e.g. via the LiteLLM gateway): ask the endpoint for the model's real window.
  try {
    const headers = llm.api_key && !["ollama", "local"].includes(provider) ? { Authorization: "Bearer " + llm.api_key } : {};
    const r = await fetch(base.replace(/\/v1$/, "") + "/model/info", { headers, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const model = modelFor("chat");
      const list = d.data || d.models || [];
      const hit = list.find((m) => m.model_name === model || (m.litellm_params && String(m.litellm_params.model || "").includes(model))) || (list.length === 1 ? list[0] : null);
      const info = hit && hit.model_info;
      const cw = info && (info.max_input_tokens || info.context_window || info.max_tokens);
      if (Number(cw) > 0) return res.json({ context_window: Number(cw), source: "model/info" });
    }
  } catch (_) {}
  res.json({ context_window: numCtx > 0 ? numCtx : 8192, source: "default" });
});

// Exercises the LLM's three capabilities without needing a model (offline check).
app.get("/api/selftest", async (_req, res) => {
  const out = {};
  try {
    const r = await tools.searchMemory("self-test connectivity probe", 1);
    out.semantic_memory = { ok: true, stored_memories: (r.results || []).length };
  } catch (e) { out.semantic_memory = { error: e.message }; }
  try { out.workbench = await tools.runShell("whoami; uname -sr; echo '--- shared ---'; ls -1 /LLM_READ_ONLY_FILES /LLM_READ_WRITE_FILES 2>&1"); }
  catch (e) { out.workbench = { error: e.message }; }
  try { out.shared_rw = await tools.listDir(config.shared.read_write_dir); }
  catch (e) { out.shared_rw = { error: e.message }; }
  try { out.internet = await tools.fetchUrl("https://api.ipify.org?format=json"); }
  catch (e) { out.internet = { error: e.message }; }
  try { out.desktop = await tools.runShell("xdpyinfo >/dev/null 2>&1 && echo display-ok || echo no-display; for t in chromium xdotool import; do command -v $t >/dev/null && echo have-$t; done"); }
  catch (e) { out.desktop = { error: e.message }; }
  try { out.vault = { secrets_loaded: (await tools.execTool("list_secrets", {})).length }; }
  catch (e) { out.vault = { error: e.message }; }
  res.json(out);
});

app.get("/api/notifications", (_req, res) => res.json(scheduler.recentNotifications(50)));
app.post("/api/notifications/clear", (_req, res) => res.json(scheduler.clearNotifications()));
app.delete("/api/notifications/:id", (req, res) => res.json(scheduler.dismissNotification(req.params.id)));
app.get("/api/tasks", (_req, res) => res.json(scheduler.list()));
app.post("/api/tasks/cancel", (req, res) => res.json(scheduler.cancel((req.body || {}).id)));
// List models from an ARBITRARY endpoint (base_url + optional key), so the Config tab can
// show a provider's models before you save. Tries the OpenAI-compatible /models, then the
// Ollama /api/tags fallback.
app.post("/api/models/probe", async (req, res) => {
  const llm = (config && config.llm) || {};
  // Prefer what the user typed in the form; fall back to the saved config so "List models"
  // works even when the field is left blank but a key/endpoint is already configured.
  const base = String((req.body || {}).base_url || llm.base_url || "").replace(/\/+$/, "");
  const key = (req.body || {}).api_key || llm.api_key || "";
  if (!base) return res.json({ models: [], error: "Enter an endpoint URL first." });
  const headers = key ? { Authorization: "Bearer " + key } : {};
  try {
    const r = await fetch(base + "/models", { headers, signal: AbortSignal.timeout(9000) });
    if (r.ok) {
      const d = await r.json();
      const names = (d.data || d.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
      if (names.length) return res.json({ models: names });
    } else if (r.status === 401 || r.status === 403) {
      return res.json({ models: [], error: `Auth failed (${r.status}) — check the API key.` });
    }
  } catch (_) {}
  try {
    const host = base.replace(/\/v1$/, "");
    const r2 = await fetch(host + "/api/tags", { signal: AbortSignal.timeout(9000) });
    if (r2.ok) { const d2 = await r2.json(); return res.json({ models: (d2.models || []).map((m) => m.name).filter(Boolean).sort() }); }
  } catch (e) { return res.json({ models: [], error: "Could not reach the endpoint: " + e.message }); }
  return res.json({ models: [], error: "No model list returned by that endpoint." });
});
// Summarize the conversation so it can CONTINUE with a smaller context (the frontend then
// replaces its history with this summary). No tools; uses the 'smart' tier for a good summary.
app.post("/api/summarize", async (req, res) => {
  const all = Array.isArray((req.body || {}).messages)
    ? req.body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    : [];
  if (all.length < 2) return res.json({ summary: "" });
  const messages = [
    { role: "system", content: "You compress a conversation so it can CONTINUE with less context. Write a concise but COMPLETE summary: the user's goal(s), key decisions and facts established, files/code created or changed and their paths, what is done, and what remains to do. Use terse bullet points grouped under short headings. This summary REPLACES the earlier messages, so include everything needed to continue seamlessly — omit nothing important. No preamble, no sign-off, no commentary." },
    ...all.slice(-40),
    { role: "user", content: "Summarize the conversation so far per your instructions, so we can continue with a smaller context." },
  ];
  try { res.json({ summary: await llm.chat({ messages, tier: "smart", noTools: true }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Prompt library — each set is TWO editable files in /Prompts: <name>_master.prompt and
// <name>_system.prompt. The ACTIVE prompt is the "default" set (default_master/default_system);
// saving it applies on the next turn (config.systemPrompt reads these files live). Other names
// are the saved library you can load or export to.
const PROMPTS_DIR = process.env.JARVIS_PROMPTS_DIR || "/Prompts";
function safePromptName(n) { n = String(n || "").trim(); return /^[\w.\- ]{1,80}$/.test(n) ? n : null; }
function readPart(name, part) { try { return fs.readFileSync(path.join(PROMPTS_DIR, `${name}_${part}.prompt`), "utf8"); } catch (_) { return ""; } }
function writeSet(name, master, system) {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROMPTS_DIR, `${name}_master.prompt`), String(master || ""));
  fs.writeFileSync(path.join(PROMPTS_DIR, `${name}_system.prompt`), String(system || ""));
}
app.get("/api/prompts", (_req, res) => {   // saved set NAMES + which one (if any) is currently ACTIVE
  try {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    const names = [...new Set(fs.readdirSync(PROMPTS_DIR).map((f) => (f.match(/^(.+)_(?:master|system)\.prompt$/) || [])[1]).filter(Boolean))]
      .filter((n) => n !== "default").sort();
    // The live prompt lives in default_*; report which saved set (if any) has identical content
    // so the UI can show which one is active. If none matches, the active default is a custom edit.
    const norm = (s) => String(s || "").replace(/\r\n/g, "\n").trim();
    const dm = norm(readPart("default", "master")), ds = norm(readPart("default", "system"));
    let active = null;
    for (const n of names) { if (norm(readPart(n, "master")) === dm && norm(readPart(n, "system")) === ds) { active = n; break; } }
    res.json({ dir: PROMPTS_DIR, prompts: names, active });
  } catch (e) { res.json({ dir: PROMPTS_DIR, prompts: [], error: e.message }); }
});
app.get("/api/prompts/:name", (req, res) => {
  const n = safePromptName(req.params.name); if (!n) return res.status(400).json({ error: "invalid name" });
  res.json({ name: n, master: readPart(n, "master"), system: readPart(n, "system") });
});
app.post("/api/prompts/:name", (req, res) => {
  const n = safePromptName(req.params.name); if (!n) return res.status(400).json({ error: "invalid name" });
  const b = req.body || {};
  try { writeSet(n, b.master, b.system); res.json({ saved: n, files: [`${n}_master.prompt`, `${n}_system.prompt`] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/prompts/:name", (req, res) => {
  const n = safePromptName(req.params.name); if (!n || n === "default" || n === "stock") return res.status(400).json({ error: "the active 'default' and reference 'stock' sets can't be deleted" });
  try { for (const part of ["master", "system"]) fs.rmSync(path.join(PROMPTS_DIR, `${n}_${part}.prompt`), { force: true }); res.json({ deleted: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/plan", (_req, res) => res.json(require("./src/planner").get() || null));
app.delete("/api/plan", (_req, res) => res.json(require("./src/planner").clear()));
const autopilot = require("./src/autopilot");
app.get("/api/autopilot", (_req, res) => res.json(autopilot.status()));
app.post("/api/autopilot/start", (req, res) => {
  try { res.json(autopilot.start(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/autopilot/wrapup", (_req, res) => res.json(autopilot.requestWrapUp()));
app.post("/api/autopilot/stop", (_req, res) => res.json(autopilot.requestStop()));
app.post("/api/autopilot/forcestop", (_req, res) => res.json(autopilot.forceStop()));
app.post("/api/autopilot/pause", (_req, res) => res.json(autopilot.pause()));
app.post("/api/autopilot/resume", (_req, res) => res.json(autopilot.resume()));
app.post("/api/autopilot/modify", (req, res) => res.json(autopilot.modify(req.body || {})));
app.post("/api/autopilot/extend", (req, res) => res.json(autopilot.extend(req.body || {})));
app.post("/api/autopilot/continue", (req, res) => res.json(autopilot.continueRun(req.body || {})));
app.post("/api/autopilot/dismiss", (_req, res) => res.json(autopilot.dismiss()));
// Pre-flight clarification: before an unattended run, let the model review the objective and
// ask the questions it needs (scope, architecture, storage, output, edge cases). No tools.
app.post("/api/autopilot/clarify", async (req, res) => {
  const objective = String((req.body || {}).objective || "").trim();
  if (!objective) return res.json({ ready: true, questions: "" });
  const messages = [
    { role: "system", content: "You are about to carry out a task AUTONOMOUSLY and UNATTENDED — the user cannot answer questions once you start. FIRST, review the request and ask the clarifying questions you need to build the RIGHT thing: scope and must-have features; tech stack / ARCHITECTURE (e.g. a single self-contained HTML file vs. a client + backend server, what persistence/storage, any frameworks); where the finished output should go; constraints, preferences, and important edge cases. Ask them as a CONCISE numbered list — group related questions, and don't over-ask about trivia. For almost ANY build/creation task there is at least one decision worth confirming (usually the ARCHITECTURE and WHERE the output should be saved) — ask it rather than assuming. Reply with EXACTLY the word READY and nothing else ONLY if the request is genuinely trivial or so fully specified that you would make no notable assumptions." },
    { role: "user", content: objective },
  ];
  try {
    const out = (await llm.chat({ messages, tier: "smart", noTools: true }) || "").trim();
    if (/^READY\b/i.test(out) || out.length < 4) return res.json({ ready: true, questions: [], questionsText: "" });
    // Split the numbered list into individual questions so the UI can ask them one at a time.
    // A new item starts at a line like "1." / "2)" ; intervening lines belong to the current item.
    const items = [];
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/);
      if (m) items.push(m[1].trim());
      else if (items.length) items[items.length - 1] += " " + line;   // continuation of the last question
      else items.push(line);                                          // un-numbered lead line
    }
    const questions = items.filter(Boolean);
    if (!questions.length) return res.json({ ready: true, questions: [], questionsText: "" });
    res.json({ ready: false, questions, questionsText: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/tasks/add", (req, res) => {
  try { res.json(scheduler.schedule(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Memory viewer: browse + prune the Mem0 long-term memories from the UI.
app.get("/api/memories", async (_req, res) => {
  try { res.json(await tools.execTool("list_memories", {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/memories", async (req, res) => {
  try { res.json(await tools.execTool("add_memory", { text: (req.body || {}).text })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/memories/:id", async (req, res) => {
  try { res.json(await tools.execTool("delete_memory", { id: req.params.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// REST chat for external automation (scripts, cron, Shortcuts, other machines via a
// tunnel): same brain as the WS chat, one request/response. Body:
//   { "message": "...", "messages": [...optional history...], "tier": "chat", "persona": "work" }
app.post("/api/chat", async (req, res) => {
  try {
    const b = req.body || {};
    const hist = (Array.isArray(b.messages) ? b.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    if (b.message) hist.push({ role: "user", content: String(b.message) });
    if (!hist.length || hist[hist.length - 1].role !== "user") return res.status(400).json({ error: "provide 'message' (string) and/or 'messages' ending with a user turn" });
    chatlog.record("user", hist[hist.length - 1].content);
    const reply = await llm.chat({ messages: [{ role: "system", content: systemPrompt(b.persona) }, ...hist.slice(-40)], tier: b.tier });
    chatlog.record("assistant", reply);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Persist an allowlisted setting (voice, model, etc.) to JARVIS_CONFIG.json.
app.post("/api/settings", (req, res) => {
  try {
    const { path: p, value } = req.body || {};
    if (typeof p !== "string") return res.status(400).json({ error: "path (string) required" });
    res.json(setSetting(p, value));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Full config editor (the Config tab): read/write the WHOLE JARVIS_CONFIG.json +
// JARVIS_SECRETS.json. Localhost-only single-user app, so secrets are returned in the
// clear for editing. Writes validate + auto-backup; applying is `./JARVIS.sh --reload`.
app.get("/api/config/full", (_req, res) => {
  try { res.json(readFullConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/config/full", (req, res) => {
  try {
    const { config: c, secrets: s } = req.body || {};
    if (c === undefined && s === undefined) return res.status(400).json({ error: "nothing to save" });
    const r = writeFullConfig({ config: c, secrets: s });
    // writeFullConfig mutates the in-memory config in place, so changes apply on the next turn —
    // no --reload for ordinary settings (base_url/model/tiers/params/prompts/log level, etc.).
    res.json({ ...r, reload_required: false, applied_live: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Neural TTS (Piper) — the browser fetches audio from here when the voice engine is
// "piper". Proxied to the jarvis-piper container so the browser stays same-origin.
app.get("/api/tts/voices", async (_req, res) => {
  try { res.json(await tts.voices()); }
  catch (e) { res.status(502).json({ error: e.message, voices: [] }); }
});
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice, rate } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });
    const buf = await tts.synth(text, voice, rate);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Available models for the header switcher. Works against BOTH backends: an
// OpenAI-compatible gateway (GET /v1/models — e.g. LiteLLM) and raw Ollama (/api/tags).
app.get("/api/models", async (_req, res) => {
  try {
    const base = ((config.llm && config.llm.base_url) || "").replace(/\/+$/, "");
    if (!base) return res.json({ models: [], current: publicConfig().model });
    try {
      const r = await fetch(base + "/models", { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const names = (d.data || []).map((m) => m.id).filter(Boolean).sort();
        if (names.length) return res.json({ models: names, current: publicConfig().model });
      }
    } catch (_) {}
    const host = base.replace(/\/v1$/, "");
    const r2 = await fetch(host + "/api/tags", { signal: AbortSignal.timeout(5000) });
    const d2 = await r2.json();
    res.json({ models: (d2.models || []).map((m) => m.name).sort(), current: publicConfig().model });
  } catch (e) { res.json({ models: [], current: publicConfig().model, error: e.message }); }
});

// Files: browse / download / delete the shared folders.
function sharedBase(which) {
  const s = config.shared || {};
  return which === "ro" ? (s.read_only_dir || "/LLM_READ_ONLY_FILES") : (s.read_write_dir || "/LLM_READ_WRITE_FILES");
}
function safeJoin(base, rel) {
  let abs = path.resolve(base, rel || ".");
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error("path escapes the folder");
  // Resolve symlinks and RE-CHECK: a link planted inside the shared folder must not
  // let /api/files/raw serve a target outside it (res.sendFile follows symlinks).
  try { abs = fs.realpathSync(abs); } catch (_) { return abs; }   // nonexistent → caller 404s
  const realBase = fs.realpathSync(base);
  if (abs !== realBase && !abs.startsWith(realBase + path.sep)) throw new Error("path escapes the folder (symlink)");
  return abs;
}
app.get("/api/files", (req, res) => {
  try {
    const which = req.query.dir === "ro" ? "ro" : "rw";
    const base = sharedBase(which);
    const out = [];
    const walk = (dir, rel) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name.startsWith(".") || out.length >= 500) continue;
        const r = rel ? rel + "/" + e.name : e.name, full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, r);
        else { try { const st = fs.statSync(full); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } catch (_) {} }
      }
    };
    walk(base, "");
    out.sort((a, b) => b.mtime - a.mtime);
    res.json({ dir: which, files: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/files/raw", (req, res) => {
  try {
    const which = req.query.dir === "ro" ? "ro" : "rw";
    const abs = safeJoin(sharedBase(which), String(req.query.path || ""));
    if (req.query.download) return res.download(abs);
    res.sendFile(abs);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Open a Markdown guide RENDERED in a browser tab (and, via #anchor, scrolled to a section).
// Non-Markdown files (PDF/image) fall through to the raw file API so they open natively.
app.get("/view", (req, res) => {
  try {
    const which = req.query.dir === "rw" ? "rw" : "ro"; // knowledge base is read-only by default
    const rel = String(req.query.path || "");
    const abs = safeJoin(sharedBase(which), rel);
    if (!/\.(md|markdown|txt)$/i.test(abs)) {
      return res.redirect("/api/files/raw?dir=" + which + "&path=" + encodeURIComponent(rel));
    }
    const md = fs.readFileSync(abs, "utf8");
    res.type("html").send(mdview.renderPage({ mdText: md, filePathRel: rel, sharedWhich: which }));
  } catch (e) { res.status(400).type("text").send("Cannot view file: " + e.message); }
});
app.delete("/api/files", (req, res) => {
  try {
    const abs = safeJoin(sharedBase("rw"), String(req.query.path || "")); // only rw is deletable
    fs.unlinkSync(abs);
    res.json({ deleted: req.query.path });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// File drop: save an uploaded file into the read-write shared folder so the LLM can read it.
app.post("/api/upload", (req, res) => {
  try {
    const { name, dataUrl } = req.body || {};
    if (!name || !dataUrl) return res.status(400).json({ error: "name and dataUrl are required" });
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(dataUrl));
    if (!m) return res.status(400).json({ error: "expected a base64 data URL" });
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: "file too large (20MB max)" });
    const safe = path.basename(String(name)).replace(/[^\w.\- ]+/g, "_") || "file";
    const rw = (config.shared && config.shared.read_write_dir) || "/LLM_READ_WRITE_FILES";
    const dir = path.join(rw, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buf);
    res.json({ path: "/LLM_READ_WRITE_FILES/uploads/" + safe, bytes: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const sessions = require("./src/sessions");
app.get("/api/sessions", (_req, res) => res.json(sessions.list()));
app.post("/api/sessions", (req, res) => { try { res.json(sessions.save(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post("/api/sessions/import", (req, res) => { try { const d = req.body || {}; res.json(sessions.save({ name: d.name, messages: d.messages })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get("/api/sessions/:id", (req, res) => { try { res.json(sessions.get(req.params.id)); } catch (_) { res.status(404).json({ error: "not found" }); } });
app.get("/api/sessions/:id/export", (req, res) => {
  try { const d = sessions.get(req.params.id); res.setHeader("Content-Disposition", `attachment; filename="${String(d.name || d.id).replace(/[^a-z0-9_-]+/gi, "_")}.json"`); res.json(d); }
  catch (_) { res.status(404).json({ error: "not found" }); }
});
app.delete("/api/sessions/:id", (req, res) => res.json({ deleted: sessions.del(req.params.id) }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
// NOTE: do NOT cache systemPrompt() here. The active prompt lives in Prompts/default_*.prompt and
// can change at runtime (Config → Prompts → Load, or "Save as active"). systemPrompt() reads those
// files live, so we call it per turn — a cached copy would freeze the prompt until an app restart.

// Broadcast scheduler notifications to every connected browser.
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(s); } catch (_) {} } });
}
scheduler.setNotifyCallback((note) => broadcast({ type: "notification", note }));
scheduler.setRunCallback((run) => broadcast({ type: "task_run", run }));
scheduler.setChatCallback((message) => broadcast({ type: "chat_post", message }));
scheduler.setUiEventCallback((type, data) => broadcast({ type, ...data }));   // tools -> UI (e.g. open the Autopilot launcher)
require("./src/planner").setOnChange((plan) => broadcast({ type: "plan", plan }));   // live plan ledger updates
autopilot.setBroadcast(broadcast);   // stream Autopilot tool-activity + status to open clients
autopilot.restore();                 // resume an Autopilot run that was in flight before a restart
scheduler.start();

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    // Interrupt the in-flight request for this connection (Stop button / Escape key).
    if (data.type === "cancel") { if (ws._abort) { try { ws._abort.abort(); } catch (_) {} } return; }
    if (data.type !== "chat") return;

    // "Just stop." — if the user types a bare stop command while something is running,
    // treat it as an interrupt instead of rejecting it with the "still working" error.
    // This is the keyboard-free hard stop: it aborts the LLM AND (via the signal now
    // threaded into tools) kills any in-flight workbench command.
    if (ws._abort) {
      const lastMsg = Array.isArray(data.messages) ? data.messages[data.messages.length - 1] : null;
      const txt = (lastMsg && typeof lastMsg.content === "string" ? lastMsg.content : "").trim();
      if (/^(stop|stop\s*it|just\s*stop|stop\s*everything|halt|abort|cancel|quit\s*it|nevermind|never\s*mind|enough)[\s.!]*$/i.test(txt)) {
        try { ws._abort.abort(); } catch (_) {}
        try { ws.send(JSON.stringify({ type: "reply", text: "⏹ Stopping everything." })); } catch (_) {}
        return;
      }
    }

    const all = Array.isArray(data.messages)
      ? data.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];
    const history = all.slice(-40);   // cap the context sent to the model (unbounded history = cost + latency)
    const messages = [{ role: "system", content: systemPrompt(data.persona) }, ...history];   // read live so prompt switches apply on the next turn (no restart)
    const emit = (ev) => { try { ws.send(JSON.stringify(ev)); } catch (_) {} };

    // One in-flight request per connection: don't overwrite an active AbortController
    // (that would make the first request uncancelable and interleave tokens on the socket).
    if (ws._abort) { emit({ type: "error", error: "I'm still working on your previous message — press Stop (Esc) to interrupt it first." }); return; }

    // Record the new user turn so background tasks can tell whether the user is active.
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (lastUser) chatlog.record("user", lastUser.content);

    const ac = new AbortController(); ws._abort = ac;
    try {
      const reply = await llm.chat({ messages, emit, signal: ac.signal, watchdog: data.watchdog, planMode: data.planMode });
      chatlog.record("assistant", reply);
      emit({ type: "reply", text: reply });
    } catch (e) {
      if (ac.signal.aborted) emit({ type: "reply", text: "⏹ Stopped." });
      else emit({ type: "error", error: e.message });
    } finally { ws._abort = null; }
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`JARVIS app listening on ${PORT}` + (loadError ? `  [CONFIG ERROR: ${loadError}]` : ""));
});
