"use strict";
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const { config, loadError, publicConfig, systemPrompt } = require("./src/config");
const llm = require("./src/llm");
const tools = require("./src/tools");
const scheduler = require("./src/scheduler");
const chatlog = require("./src/chatlog");

const app = express();
app.use(express.json({ limit: "25mb" }));   // roomy enough for base64 file uploads
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.get("/api/config", (_req, res) => {
  if (loadError) return res.status(500).json({ error: loadError });
  res.json(publicConfig());
});

// Exercises the LLM's three capabilities without needing a model (offline check).
app.get("/api/selftest", async (_req, res) => {
  const out = {};
  try {
    const r = await tools.searchMemory("self-test connectivity probe", 1);
    out.semantic_memory = { ok: true, stored_memories: (r.results || []).length };
  } catch (e) { out.semantic_memory = { error: e.message }; }
  try { out.workbench = await tools.runShell("whoami; uname -sr; echo '--- shared ---'; ls -1 /READ_ONLY_FILES /READ_WRITE_FILES 2>&1"); }
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
app.post("/api/tasks/add", (req, res) => {
  try { res.json(scheduler.schedule(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Memory viewer: browse + prune the Mem0 long-term memories from the UI.
app.get("/api/memories", async (_req, res) => {
  try { res.json(await tools.execTool("list_memories", {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/memories/:id", async (req, res) => {
  try { res.json(await tools.execTool("delete_memory", { id: req.params.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    const rw = (config.shared && config.shared.read_write_dir) || "/READ_WRITE_FILES";
    const dir = path.join(rw, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buf);
    res.json({ path: "/READ_WRITE_FILES/uploads/" + safe, bytes: buf.length });
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
const SYSTEM = systemPrompt();

// Broadcast scheduler notifications to every connected browser.
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(s); } catch (_) {} } });
}
scheduler.setNotifyCallback((note) => broadcast({ type: "notification", note }));
scheduler.setRunCallback((run) => broadcast({ type: "task_run", run }));
scheduler.setChatCallback((message) => broadcast({ type: "chat_post", message }));
scheduler.start();

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    // Interrupt the in-flight request for this connection (Stop button / Escape key).
    if (data.type === "cancel") { if (ws._abort) { try { ws._abort.abort(); } catch (_) {} } return; }
    if (data.type !== "chat") return;

    const all = Array.isArray(data.messages)
      ? data.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];
    const history = all.slice(-40);   // cap the context sent to the model (unbounded history = cost + latency)
    const messages = [{ role: "system", content: SYSTEM }, ...history];
    const emit = (ev) => { try { ws.send(JSON.stringify(ev)); } catch (_) {} };

    // One in-flight request per connection: don't overwrite an active AbortController
    // (that would make the first request uncancelable and interleave tokens on the socket).
    if (ws._abort) { emit({ type: "error", error: "I'm still working on your previous message — press Stop (Esc) to interrupt it first." }); return; }

    // Record the new user turn so background tasks can tell whether the user is active.
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (lastUser) chatlog.record("user", lastUser.content);

    const ac = new AbortController(); ws._abort = ac;
    try {
      const reply = await llm.chat({ messages, emit, signal: ac.signal });
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
