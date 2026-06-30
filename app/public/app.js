"use strict";
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages"), formEl = $("composer"), inputEl = $("input");
const activityEl = $("activity"), modelBadge = $("model-badge");
const micMode = $("mic-mode"), micState = $("mic-state"), selftestBtn = $("selftest-btn");
const micBtn = $("mic-btn");
const audioToggle = $("audio-toggle"), audioIc = $("audio-ic");
const desktop = $("desktop"), desktopLink = $("desktop-link");

const history = [];
let cfg = null, ws = null;
let workingEl = null, workingTimer = null, workingStart = 0;   // persistent "still working" indicator
let streamBubble = null, streamText = "";   // the assistant bubble being streamed into

const esc = (s) => (s || "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function addMessage(role, text, cls) {
  const wrap = document.createElement("div"); wrap.className = "msg " + role;
  const b = document.createElement("div"); b.className = "bubble" + (cls ? " " + cls : "");
  b.innerHTML = esc(text); wrap.appendChild(b);
  messagesEl.appendChild(wrap); messagesEl.scrollTop = messagesEl.scrollHeight; return b;
}
// Persistent "JARVIS is still working" indicator: animated dots + what it's doing +
// a live elapsed timer. Stays pinned at the bottom of the chat until the reply
// completes (or errors), so you can always tell whether it's still going.
function showWorking(label) {
  if (!workingEl) {
    const w = document.createElement("div"); w.className = "msg assistant working-msg";
    w.innerHTML = '<div class="bubble working"><span class="dots"><span></span><span></span><span></span></span>' +
      '<span class="wlabel"></span><span class="wtime"></span></div>';
    messagesEl.appendChild(w);
    workingEl = w; workingStart = Date.now();
    workingTimer = setInterval(() => {
      const t = workingEl && workingEl.querySelector(".wtime");
      if (t) t.textContent = Math.round((Date.now() - workingStart) / 1000) + "s";
    }, 1000);
  }
  if (label != null) { const l = workingEl.querySelector(".wlabel"); if (l) l.textContent = label; }
  messagesEl.appendChild(workingEl);                 // keep it pinned to the bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function labelWorking(text) {
  if (!workingEl) return;
  const l = workingEl.querySelector(".wlabel"); if (l) l.textContent = text;
}
function pinWorking() { if (workingEl) messagesEl.appendChild(workingEl); } // keep below streamed text
function hideWorking() {
  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
  if (workingEl) { workingEl.remove(); workingEl = null; }
}

function addActivity(tool, input, output) {
  const hint = activityEl.querySelector(".hint"); if (hint) hint.remove();
  const e = document.createElement("div"); e.className = "entry";
  let html = `<span class="tname">${esc(tool)}</span>`;
  if (input !== undefined) html += ` <span class="tin">${esc(typeof input === "string" ? input : JSON.stringify(input))}</span>`;
  if (output !== undefined) html += `<pre>${esc(typeof output === "string" ? output : JSON.stringify(output, null, 2))}</pre>`;
  e.innerHTML = html; activityEl.appendChild(e); activityEl.scrollTop = activityEl.scrollHeight;
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === "tool") { addActivity(d.tool, d.input); labelWorking("running " + d.tool + "…"); pinWorking(); }
    else if (d.type === "tool_result") { addActivity(d.tool + " →" + (d.ms != null ? ` (${d.ms}ms)` : ""), undefined, d.output); labelWorking("working…"); }
    else if (d.type === "usage") addActivity(`↳ ${d.model ? d.model + " · " : ""}${(d.usage && d.usage.total_tokens) || 0} tokens` + (d.cost_usd ? ` · ~$${d.cost_usd}` : ""));
    else if (d.type === "token") {
      if (!streamBubble) { streamBubble = addMessage("assistant", ""); streamText = ""; labelWorking("responding…"); pinWorking(); }
      streamText += d.text;
      streamBubble.innerHTML = esc(streamText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (d.type === "reply") {
      hideWorking();
      const t = d.text || "";
      const finalText = streamBubble ? (streamText || t) : t;
      if (streamBubble) streamBubble.innerHTML = esc(finalText);
      else addMessage("assistant", finalText);
      history.push({ role: "assistant", content: finalText });
      if (window.JarvisVoice) JarvisVoice.speak(t || finalText);
      streamBubble = null; streamText = "";
    } else if (d.type === "error") {
      hideWorking(); streamBubble = null; streamText = "";
      addMessage("assistant", "Error: " + d.error, "error");
    } else if (d.type === "notification") {
      showNotification(d.note);
    } else if (d.type === "task_run") {
      addActivity("task ▸ " + (d.run.label || d.run.id) + " (run " + d.run.runs + ")", undefined, d.run.result || "(no output)");
      refreshTasks();
    } else if (d.type === "chat_post") {
      addMessage("assistant", d.message);
      history.push({ role: "assistant", content: d.message });
      if (window.JarvisVoice) JarvisVoice.speak(d.message);
    }
  };
  ws.onclose = () => setTimeout(connectWS, 1500);
}

function showNotification(note) {
  const msg = (note && note.message) || "";
  addMessage("assistant", "🔔 " + msg, "notice");
  addNoteEl(note, true);   // add to the Tasks panel's notification history
  refreshTasks();          // a recurring task may have just stopped
  try { if (window.Notification && Notification.permission === "granted") new Notification("JARVIS", { body: msg }); } catch (_) {}
  if (window.JarvisVoice) JarvisVoice.speak(msg); // respects the audio switch
}

function send(text) {
  text = (text || "").trim(); if (!text) return;
  if (!ws || ws.readyState !== 1) { addMessage("assistant", "Connecting… try again in a moment.", "error"); return; }
  addMessage("user", text); history.push({ role: "user", content: text });
  inputEl.value = ""; autoGrow(); showWorking("working…");
  ws.send(JSON.stringify({ type: "chat", messages: history }));
}

// Grow the textarea with its content (up to the CSS max-height, then scroll).
function autoGrow() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px"; }
inputEl.addEventListener("input", autoGrow);

// Enter sends; Shift+Enter inserts a newline (and IME composition is respected).
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(inputEl.value); }
});

formEl.addEventListener("submit", (e) => { e.preventDefault(); send(inputEl.value); });

selftestBtn.addEventListener("click", async () => {
  addActivity("selftest", "running…");
  try { const r = await fetch("/api/selftest"); addActivity("selftest →", undefined, await r.json()); }
  catch (e) { addActivity("selftest →", undefined, { error: String(e) }); }
});

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
  t.classList.add("active"); $("panel-" + t.dataset.tab).classList.add("active");
  if (t.dataset.tab === "tasks") { refreshTasks(); refreshNotes(); }
}));

// --- Tasks panel ---
const tasksList = $("tasks-list"), notesList = $("notes-list"), tasksRefresh = $("tasks-refresh");
function fmtWhen(iso) { try { return new Date(iso).toLocaleString(); } catch { return iso; } }

async function refreshTasks() {
  if (!tasksList) return;
  let tasks = [];
  try { tasks = await (await fetch("/api/tasks")).json(); } catch { return; }
  if (!tasks.length) { tasksList.innerHTML = '<div class="hint">No scheduled tasks.</div>'; return; }
  tasksList.innerHTML = "";
  tasks.forEach((t) => {
    const recurring = t.type === "recurring";
    const el = document.createElement("div"); el.className = "task";
    el.innerHTML =
      `<div class="t-top"><span class="t-label">${esc(t.label || t.prompt.slice(0, 40))}</span>` +
      `<span><span class="badge ${recurring ? "recurring" : ""}">${recurring ? "every " + Math.round(t.every_seconds / 60) + "m" : "once"}</span> ` +
      `<button class="cancel" data-id="${esc(t.id)}">cancel</button></span></div>` +
      `<div class="t-meta">next: ${esc(fmtWhen(t.next_run))}${t.last_run ? " · last run: " + esc(fmtWhen(t.last_run)) : ""}${t.until ? " · until: " + esc(t.until) : ""} · runs: ${t.runs}</div>` +
      `<div class="t-prompt">${esc(t.prompt)}</div>` +
      (t.last_result ? `<div class="t-result">↳ ${esc(t.last_result)}</div>` : "");
    tasksList.appendChild(el);
  });
}
function addNoteEl(n, prepend) {
  if (!notesList) return;
  const hint = notesList.querySelector(".hint"); if (hint) hint.remove();
  const el = document.createElement("div"); el.className = "note" + (n.level === "error" ? " error" : "");
  el.innerHTML = `<div class="n-time">${esc(new Date(n.at).toLocaleString())}</div><div class="n-msg">${esc(n.message || "")}</div>`;
  if (prepend) notesList.insertBefore(el, notesList.firstChild); else notesList.appendChild(el);
}
async function refreshNotes() {
  if (!notesList) return;
  let notes = [];
  try { notes = await (await fetch("/api/notifications")).json(); } catch { return; }
  if (!notes.length) { notesList.innerHTML = '<div class="hint">No notifications yet.</div>'; return; }
  notesList.innerHTML = "";
  notes.slice().reverse().forEach((n) => addNoteEl(n));
}
if (tasksList) tasksList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.cancel"); if (!btn) return;
  try { await fetch("/api/tasks/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: btn.dataset.id }) }); } catch {}
  refreshTasks();
});
if (tasksRefresh) tasksRefresh.addEventListener("click", () => { refreshTasks(); refreshNotes(); });
setInterval(() => { if ($("panel-tasks") && $("panel-tasks").classList.contains("active")) refreshTasks(); }, 15000);

// --- Sessions (save / load / export / import conversations) ---
const sessionsBtn = $("sessions-btn"), sessionsDrop = $("sessions-drop"), sessionsItems = $("sessions-items");
const sessionSaveBtn = $("session-save"), sessionNewBtn = $("session-new"), sessionImport = $("session-import"), sessionCurrentEl = $("session-current");
let currentSession = { id: null, name: null };

function renderCurrent() { if (sessionCurrentEl) sessionCurrentEl.textContent = currentSession.id ? "Current: " + currentSession.name : "Current: (unsaved)"; }
async function refreshSessions() {
  if (!sessionsItems) return;
  let items = [];
  try { items = await (await fetch("/api/sessions")).json(); } catch { return; }
  if (!items.length) { sessionsItems.innerHTML = '<div class="hint">No saved sessions.</div>'; return; }
  sessionsItems.innerHTML = "";
  items.forEach((s) => {
    const el = document.createElement("div"); el.className = "session-item";
    el.innerHTML =
      `<span class="s-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="s-meta">${s.count}</span>` +
      `<button class="load" data-act="load" data-id="${esc(s.id)}">load</button>` +
      `<button data-act="export" data-id="${esc(s.id)}" title="export">⤓</button>` +
      `<button data-act="del" data-id="${esc(s.id)}" title="delete">✕</button>`;
    sessionsItems.appendChild(el);
  });
}
function loadConversation(messages) {
  messagesEl.innerHTML = ""; history.length = 0;
  (messages || []).forEach((m) => { addMessage(m.role, m.content); history.push({ role: m.role, content: m.content }); });
}
async function saveCurrent() {
  const name = prompt("Save conversation as:", currentSession.name || "Session " + new Date().toLocaleString());
  if (name === null) return;
  try {
    const r = await (await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: currentSession.id, name, messages: history }) })).json();
    currentSession = { id: r.id, name: r.name }; renderCurrent(); refreshSessions();
  } catch (e) { alert("save failed: " + e); }
}
function newSession() {
  messagesEl.innerHTML = ""; history.length = 0; currentSession = { id: null, name: null }; renderCurrent();
  addMessage("assistant", "New session. JARVIS online — ask me anything.");
}
async function loadSession(id) {
  try {
    const d = await (await fetch("/api/sessions/" + encodeURIComponent(id))).json();
    loadConversation(d.messages); currentSession = { id: d.id, name: d.name }; renderCurrent();
    if (sessionsDrop) sessionsDrop.hidden = true;
  } catch (e) { alert("load failed: " + e); }
}
if (sessionsBtn) sessionsBtn.addEventListener("click", (e) => { e.stopPropagation(); sessionsDrop.hidden = !sessionsDrop.hidden; if (!sessionsDrop.hidden) { refreshSessions(); renderCurrent(); } });
document.addEventListener("click", (e) => { if (sessionsDrop && !sessionsDrop.hidden && !sessionsDrop.contains(e.target) && e.target !== sessionsBtn) sessionsDrop.hidden = true; });
if (sessionSaveBtn) sessionSaveBtn.addEventListener("click", saveCurrent);
if (sessionNewBtn) sessionNewBtn.addEventListener("click", newSession);
if (sessionsItems) sessionsItems.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const id = btn.dataset.id, act = btn.dataset.act;
  if (act === "load") loadSession(id);
  else if (act === "export") location.href = "/api/sessions/" + encodeURIComponent(id) + "/export";
  else if (act === "del") { try { await fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" }); } catch {} if (currentSession.id === id) { currentSession = { id: null, name: null }; renderCurrent(); } refreshSessions(); }
});
if (sessionImport) sessionImport.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    const r = await (await fetch("/api/sessions/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: d.name, messages: d.messages }) })).json();
    await refreshSessions(); loadSession(r.id);
  } catch (err) { alert("import failed: " + err); }
  e.target.value = "";
});

function setActiveMode(m) {
  if (!micMode) return;
  micMode.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
}
function setMic(state) {
  micState.className = "mic" + (state === "listening" || state === "open" ? " listening" : state === "asleep" ? " awake" : "");
  micState.textContent =
    state === "open" ? "always on" :
    state === "listening" ? "listening…" :
    state === "asleep" ? 'say "Jarvis"' :
    state === "unsupported" ? "no mic API" : "voice off";
  if (state === "off" || state === "unsupported") setActiveMode("off");
}
if (micMode) micMode.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn || !window.JarvisVoice) return;
  setActiveMode(btn.dataset.mode);
  JarvisVoice.setMode(btn.dataset.mode);
});
if (micBtn) micBtn.addEventListener("click", () => { if (window.JarvisVoice) JarvisVoice.listenOnce(); });

function applyAudio() {
  const on = audioToggle.checked;
  if (window.JarvisVoice) JarvisVoice.setTts(on);
  if (audioIc) { audioIc.textContent = on ? "🔊" : "🔇"; audioIc.title = on ? "Audio on (spoken replies)" : "Audio muted"; }
}
if (audioToggle) audioToggle.addEventListener("change", applyAudio);

let lastVoiceError = "";
function onVoiceError(msg) {
  if (msg === lastVoiceError) return; // avoid spamming the same error
  lastVoiceError = msg;
  addMessage("assistant", "🎤 " + msg, "error");
}

async function init() {
  try { cfg = await (await fetch("/api/config")).json(); } catch { cfg = {}; }
  if (cfg.error) addMessage("assistant", "Config error: " + cfg.error, "error");
  modelBadge.textContent = (cfg.provider ? cfg.provider + " · " : "") + (cfg.model || "");
  if (cfg.title) { const bt = $("brand-title"); if (bt) bt.textContent = cfg.title; document.title = cfg.title; }
  if (cfg.workbench_url) { desktop.src = cfg.workbench_url; desktopLink.href = cfg.workbench_url; }
  if (window.JarvisVoice && cfg.voice) {
    const ok = JarvisVoice.init(cfg.voice, { onUtterance: (t) => send(t), onState: setMic, onError: onVoiceError });
    if (!ok) { setMic("unsupported"); onVoiceError(JarvisVoice.supportMessage()); }
    if (audioToggle) { audioToggle.checked = cfg.voice.tts !== false; applyAudio(); }
  }
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (_) {}
  refreshTasks(); refreshNotes();
  connectWS();
  inputEl.focus();
}
init();
