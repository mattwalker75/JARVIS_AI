"use strict";
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const { config, loadError, publicConfig, systemPrompt } = require("./src/config");
const llm = require("./src/llm");
const tools = require("./src/tools");
const scheduler = require("./src/scheduler");

const app = express();
app.use(express.json({ limit: "4mb" }));
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
app.get("/api/tasks", (_req, res) => res.json(scheduler.list()));
app.post("/api/tasks/cancel", (req, res) => res.json(scheduler.cancel((req.body || {}).id)));

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
    if (data.type !== "chat") return;

    const history = Array.isArray(data.messages)
      ? data.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];
    const messages = [{ role: "system", content: SYSTEM }, ...history];
    const emit = (ev) => { try { ws.send(JSON.stringify(ev)); } catch (_) {} };

    try {
      const reply = await llm.chat({ messages, emit });
      emit({ type: "reply", text: reply });
    } catch (e) {
      emit({ type: "error", error: e.message });
    }
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`JARVIS app listening on ${PORT}` + (loadError ? `  [CONFIG ERROR: ${loadError}]` : ""));
});
