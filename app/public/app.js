"use strict";
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages"), formEl = $("composer"), inputEl = $("input"), stopBtn = $("stop");

// Auto-scroll only when the user is already at the bottom. If they scroll up to read
// while the AI is streaming, stop yanking them back down; re-engage when they return.
let stickBottom = true;
function scrollDown() { if (stickBottom) messagesEl.scrollTop = messagesEl.scrollHeight; }
messagesEl.addEventListener("scroll", () => {
  stickBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  const jb = document.getElementById("jump-bottom"); if (jb) jb.hidden = stickBottom;
});
// Copy button on code blocks (delegated so it survives streaming re-renders).
messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".code-copy");
  if (!btn) return;
  const pre = btn.parentElement.querySelector("pre");
  const txt = pre ? pre.innerText : "";
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
    .then(() => { btn.textContent = "✓"; setTimeout(() => (btn.textContent = "⧉"), 1200); }).catch(() => {});
});
const activityEl = $("activity"), modelBadge = $("model-badge");
const micMode = $("mic-mode"), micState = $("mic-state"), selftestBtn = $("selftest-btn");
const micBtn = $("mic-btn");
const desktop = $("desktop"), desktopLink = $("desktop-link");

const history = [];
// Persist the conversation so a browser refresh doesn't lose it.
const HISTORY_KEY = "jarvis_history";
function saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-100))); } catch (_) {} }
function restoreHistory() {
  let saved; try { saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (_) { saved = []; }
  if (!Array.isArray(saved) || !saved.length) return;
  for (const m of saved) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") { addMessage(m.role, m.content); history.push(m); }
  }
}
let cfg = null, ws = null;
// Ambient (orb) mode state helpers.
let voiceListening = false, ambSpeaking = false;
function amb(s) { if (window.JarvisAmbient && JarvisAmbient.active()) JarvisAmbient.setState(s); }
function ambIdle() { return voiceListening ? "listening" : "idle"; }
// Running per-session token/cost total (accumulated from usage events).
let sessTokens = 0, sessCost = 0;
function updateSessUsage() {
  const el = $("session-usage"); if (!el) return;
  if (!sessTokens) { el.textContent = ""; return; }
  const k = sessTokens >= 1000 ? (sessTokens / 1000).toFixed(1) + "k" : String(sessTokens);
  el.textContent = `session: ${k} tok` + (sessCost > 0 ? ` · ~$${sessCost.toFixed(3)}` : "");
}
function resetSessUsage() { sessTokens = 0; sessCost = 0; updateSessUsage(); }
let workingEl = null, workingTimer = null, workingStart = 0;   // persistent "still working" indicator
let streamBubble = null, streamText = "";   // the assistant bubble being streamed into
let streamThink = null;                      // the <pre> of the live "Thinking" panel, if any
let ttsSpokenLen = 0;                        // chars of the current reply already sent to TTS
// Speak complete sentences AS they stream in (ChatGPT-style), not after the whole reply.
function speakStreaming() {
  if (!window.JarvisVoice || !JarvisVoice.ttsEnabled()) return;
  const pending = streamText.slice(ttsSpokenLen);
  const m = pending.match(/^[\s\S]*[.!?\n]/);   // everything up to the LAST sentence end
  if (m && m[0].trim().length > 1) { JarvisVoice.speak(m[0]); ttsSpokenLen += m[0].length; }
}

// Reasoning models stream their thoughts before the answer. Show them in a collapsible
// panel ABOVE the answer bubble (kept separate so re-rendering the bubble never wipes it).
function ensureThink() {
  if (!streamThink) {
    // Its OWN message row, appended before the answer bubble is created — so thinking
    // always sits ABOVE the answer (not beside it, since .msg is a flex row).
    const wrap = document.createElement("div"); wrap.className = "msg assistant think-msg";
    const det = document.createElement("details");
    det.className = "think"; det.open = true;
    det.innerHTML = '<summary>💭 Thinking…</summary><pre></pre>';
    wrap.appendChild(det);
    messagesEl.appendChild(wrap);
    streamThink = det.querySelector("pre"); streamThink._det = det;
  }
  return streamThink;
}
// Once the real answer starts (or the turn ends), collapse the panel and relabel it.
function finalizeThink() {
  if (streamThink && streamThink._det) {
    streamThink._det.open = false;
    const s = streamThink._det.querySelector("summary"); if (s) s.textContent = "💭 Thoughts";
  }
  streamThink = null;
}
// Coalesce streaming re-renders to one per animation frame — avoids O(n^2) DOM rebuilds
// when tokens arrive faster than the screen refreshes.
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (streamBubble) { renderAssistant(streamBubble, streamText); scrollDown(); }
  });
}

const esc = (s) => (s || "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Render a SAFE subset of markdown the LLM can use to emphasize things:
// **bold**, __underline__, *italic*, `code`, ~~strike~~. HTML is escaped first, so
// only these known tags get injected (no XSS).
// Group consecutive "- "/"* "/"1. " lines into <ul>/<ol>. Runs after inline formatting.
function renderLists(s) {
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`<${list.type}>` + list.items.map((li) => `<li>${li}</li>`).join("") + `</${list.type}>`); list = null; } };
  for (const line of s.split("\n")) {
    const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) { if (!list || list.type !== "ul") { flush(); list = { type: "ul", items: [] }; } list.items.push(ul[1]); }
    else if (ol) { if (!list || list.type !== "ol") { flush(); list = { type: "ol", items: [] }; } list.items.push(ol[1]); }
    else { flush(); out.push(line); }
  }
  flush();
  return out.join("\n");
}
function fmt(s) {
  s = s || "";
  // 1) Pull out fenced code blocks first so their contents aren't touched by other rules
  //    (handles an unterminated fence gracefully while streaming).
  const blocks = [];
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (m, code) => { blocks.push(code.replace(/\n$/, "")); return `\u0000C${blocks.length - 1}\u0000`; });
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*)$/g, (m, code) => { blocks.push(code); return `\u0000C${blocks.length - 1}\u0000`; });
  // 2) Escape, then apply the safe inline + link subset (only known tags get injected).
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<u>$1</u>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = renderLists(s);
  // 3) Restore code blocks (content re-escaped) with a copy button.
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<div class="code-wrap"><button class="code-copy" title="Copy code">⧉</button><pre><code>${esc(blocks[Number(i)] || "")}</code></pre></div>`);
  return s;
}
const IMP = ["attention", "emergency", "info", "success"];
// A message may start with [importance: <level>] to flag how important it is.
function parseImp(text) {
  const m = (text || "").match(/^\s*\[importance:\s*(attention|emergency|info|success)\]\s*/i);
  return m ? { level: m[1].toLowerCase(), text: text.slice(m[0].length) } : { level: null, text: text || "" };
}
function plain(s) { return parseImp(s).text.replace(/[*_~`]/g, ""); } // for TTS
const chatEl = document.querySelector(".chat");
function flashChat(level) {
  if (!chatEl || (level !== "attention" && level !== "emergency")) return;
  chatEl.classList.remove("flash-attention", "flash-emergency");
  void chatEl.offsetWidth; // restart the animation
  chatEl.classList.add("flash-" + level);
  setTimeout(() => chatEl.classList.remove("flash-" + level), 4000);
}
// Render an assistant bubble with markdown + an optional importance border; returns the level.
function renderAssistant(b, text) {
  const { level, text: body } = parseImp(text);
  IMP.forEach((l) => b.classList.remove("imp-" + l));
  let prefix = "";
  if (level) { b.classList.add("imp-" + level); prefix = `<span class="imp-tag">${level}</span>`; }
  b.innerHTML = prefix + fmt(body);
  return level;
}

function addMessage(role, text, cls) {
  const wrap = document.createElement("div"); wrap.className = "msg " + role;
  const b = document.createElement("div"); b.className = "bubble" + (cls ? " " + cls : "");
  if (role === "assistant" && !cls) {            // rich-render normal assistant messages
    const level = renderAssistant(b, text);
    if (level) flashChat(level);
  } else {
    b.innerHTML = esc(text);                       // user / error / notice stay plain
  }
  wrap.appendChild(b);
  if (role === "assistant") {   // hover-to-copy on assistant replies
    const copy = document.createElement("button");
    copy.className = "copy-btn"; copy.title = "Copy"; copy.textContent = "⧉";
    copy.addEventListener("click", () => {
      const txt = b.textContent || "";
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
        .then(() => { copy.textContent = "✓"; setTimeout(() => (copy.textContent = "⧉"), 1200); }).catch(() => {});
    });
    wrap.appendChild(copy);
  }
  messagesEl.appendChild(wrap); scrollDown();
  // Trim old nodes ONLY when the user is at the bottom — never delete the messages they're
  // reading or yank their scroll position while they've scrolled up through history.
  if (stickBottom) { while (messagesEl.children.length > 400) messagesEl.removeChild(messagesEl.firstChild); }
  return b;
}
// Persistent "JARVIS is still working" indicator: animated dots + what it's doing +
// a live elapsed timer. Stays pinned at the bottom of the chat until the reply
// completes (or errors), so you can always tell whether it's still going.
function showWorking(label) {
  if (window.JarvisVoice) JarvisVoice.stopSpeaking();   // new turn — interrupt any prior speech (barge-in)
  ttsSpokenLen = 0;
  amb("thinking");
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
  if (stopBtn) stopBtn.hidden = false;
  scrollDown();
}
function labelWorking(text) {
  if (!workingEl) return;
  const l = workingEl.querySelector(".wlabel"); if (l) l.textContent = text;
}
function pinWorking() { if (workingEl) messagesEl.appendChild(workingEl); } // keep below streamed text
function hideWorking() {
  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
  if (workingEl) { workingEl.remove(); workingEl = null; }
  if (stopBtn) stopBtn.hidden = true;
  if (!ambSpeaking) amb(ambIdle());   // done thinking; orb rests (or listens)
}
// Ask the server to abort the in-flight request (Stop button or Escape key).
function sendCancel() {
  if (window.JarvisVoice) JarvisVoice.stopSpeaking();   // Stop/Esc also silences speech
  if (!workingEl) return;                 // nothing is running
  if (!ws || ws.readyState !== 1) { hideWorking(); finalizeThink(); return; }  // socket gone — just clear the UI
  try { ws.send(JSON.stringify({ type: "cancel" })); } catch (_) {}
  labelWorking("stopping…");
}

function addActivity(tool, input, output) {
  const hint = activityEl.querySelector(".hint"); if (hint) hint.remove();
  const e = document.createElement("div"); e.className = "entry";
  let html = `<span class="tname">${esc(tool)}</span>`;
  if (input !== undefined) html += ` <span class="tin">${esc(typeof input === "string" ? input : JSON.stringify(input))}</span>`;
  if (output !== undefined) html += `<pre>${esc(typeof output === "string" ? output : JSON.stringify(output, null, 2))}</pre>`;
  e.innerHTML = html; activityEl.appendChild(e); activityEl.scrollTop = activityEl.scrollHeight;
  while (activityEl.children.length > 200) activityEl.removeChild(activityEl.firstChild); // cap DOM growth
}

let wsBackoff = 1000, connLost = false;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsBackoff = 1000; if (connLost) { connLost = false; addMessage("assistant", "🔌 Reconnected.", "notice"); } };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };   // let onclose drive the reconnect
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === "tool") { addActivity(d.tool, d.input); labelWorking("running " + d.tool + "…"); pinWorking(); }
    else if (d.type === "tool_result") { addActivity(d.tool + " →" + (d.ms != null ? ` (${d.ms}ms)` : ""), undefined, d.output); labelWorking("working…"); }
    else if (d.type === "usage") {
      addActivity(`↳ ${d.model ? d.model + " · " : ""}${(d.usage && d.usage.total_tokens) || 0} tokens` + (d.cost_usd ? ` · ~$${d.cost_usd}` : ""));
      sessTokens += (d.usage && d.usage.total_tokens) || 0; sessCost += Number(d.cost_usd) || 0; updateSessUsage();
    }
    else if (d.type === "reasoning") {
      const pre = ensureThink();
      pre.textContent += d.text;
      labelWorking("thinking…"); pinWorking();
      scrollDown();
    }
    else if (d.type === "token") {
      finalizeThink();   // the answer is starting — collapse the thinking panel
      if (!streamBubble) { streamBubble = addMessage("assistant", ""); streamText = ""; ttsSpokenLen = 0; labelWorking("responding…"); pinWorking(); }
      streamText += d.text;
      speakStreaming();
      scheduleRender();
    } else if (d.type === "reply") {
      hideWorking(); finalizeThink();
      const t = d.text || "";
      const finalText = streamBubble ? (streamText || t) : t;
      if (streamBubble) { const lvl = renderAssistant(streamBubble, finalText); if (lvl) flashChat(lvl); }
      else addMessage("assistant", finalText);
      history.push({ role: "assistant", content: finalText }); saveHistory();
      if (window.JarvisVoice) {
        // If we streamed sentences already, only speak the leftover tail; else speak it all.
        if (ttsSpokenLen > 0 && streamText) { const rest = streamText.slice(ttsSpokenLen); if (rest.trim()) JarvisVoice.speak(rest); }
        else JarvisVoice.speak(plain(finalText));
      }
      ttsSpokenLen = 0;
      streamBubble = null; streamText = "";
    } else if (d.type === "error") {
      hideWorking(); finalizeThink(); streamBubble = null; streamText = "";
      addMessage("assistant", "Error: " + d.error, "error");
      addRetry();
    } else if (d.type === "notification") {
      showNotification(d.note);
    } else if (d.type === "task_run") {
      addActivity("task ▸ " + (d.run.label || d.run.id) + " (run " + d.run.runs + ")", undefined, d.run.result || "(no output)");
      refreshTasks();
    } else if (d.type === "chat_post") {
      addMessage("assistant", d.message);
      history.push({ role: "assistant", content: d.message }); saveHistory();
      if (window.JarvisVoice) JarvisVoice.speak(plain(d.message));
    }
  };
  ws.onclose = () => {
    // A request in flight when the socket dropped will never get a reply — clear the
    // spinner and streaming state so the UI isn't stuck, and tell the user once.
    if (workingEl || streamBubble || streamThink) {
      hideWorking(); finalizeThink(); streamBubble = null; streamText = "";
      if (!connLost) { connLost = true; addMessage("assistant", "🔌 Connection lost — reconnecting…", "error"); }
    }
    setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);   // exponential backoff, cap 15s
  };
}

// Memory viewer: list the Mem0 long-term memories with delete buttons.
let memItems = [];
async function refreshMemories() {
  const el = $("mem-list"); if (!el) return;
  el.innerHTML = '<div class="hint">Loading…</div>';
  let d; try { d = await (await fetch("/api/memories")).json(); } catch { el.innerHTML = '<div class="hint">Failed to load memories.</div>'; return; }
  if (d.error) { el.innerHTML = '<div class="hint">Memory unavailable: ' + esc(d.error) + '</div>'; return; }
  memItems = d.results || [];
  renderMemories(($("mem-search") && $("mem-search").value) || "");
}
function renderMemories(filter) {
  const el = $("mem-list"); if (!el) return;
  const q = (filter || "").trim().toLowerCase();
  const items = q ? memItems.filter((m) => (m.memory || "").toLowerCase().includes(q)) : memItems;
  if (!items.length) { el.innerHTML = '<div class="hint">' + (memItems.length ? "No matching memories." : "No memories saved yet.") + '</div>'; return; }
  el.innerHTML = "";
  items.forEach((m) => {
    const row = document.createElement("div"); row.className = "mem-item";
    const txt = document.createElement("span"); txt.className = "mem-text"; txt.textContent = m.memory || "";
    const del = document.createElement("button"); del.className = "ghost"; del.textContent = "🗑"; del.title = "Delete this memory";
    del.addEventListener("click", async () => {
      del.disabled = true;
      try { await fetch("/api/memories/" + encodeURIComponent(m.id), { method: "DELETE" }); memItems = memItems.filter((x) => x.id !== m.id); row.remove(); if (!el.children.length) el.innerHTML = '<div class="hint">No memories saved yet.</div>'; }
      catch { del.disabled = false; }
    });
    row.appendChild(txt); row.appendChild(del); el.appendChild(row);
  });
}
const memRefresh = $("mem-refresh");
if (memRefresh) memRefresh.addEventListener("click", refreshMemories);
const memSearch = $("mem-search");
if (memSearch) memSearch.addEventListener("input", () => renderMemories(memSearch.value));

// --- Files tab: browse / download / delete the shared read-write folder ---
function fmtBytes(n) { if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
async function refreshFiles() {
  const el = $("files-list"); if (!el) return;
  el.innerHTML = '<div class="hint">Loading…</div>';
  let d; try { d = await (await fetch("/api/files?dir=rw")).json(); } catch { el.innerHTML = '<div class="hint">Failed to load files.</div>'; return; }
  if (d.error) { el.innerHTML = '<div class="hint">Error: ' + esc(d.error) + '</div>'; return; }
  const files = d.files || [];
  if (!files.length) { el.innerHTML = '<div class="hint">No files yet. JARVIS saves what it makes here; drag a file into the chat to add one.</div>'; return; }
  el.innerHTML = "";
  files.forEach((f) => {
    const enc = encodeURIComponent(f.path);
    const row = document.createElement("div"); row.className = "file-item";
    const link = document.createElement("a"); link.className = "file-name"; link.href = "/api/files/raw?dir=rw&path=" + enc; link.target = "_blank"; link.textContent = f.path; link.title = "Open / preview";
    const meta = document.createElement("span"); meta.className = "file-meta"; meta.textContent = fmtBytes(f.size);
    const dl = document.createElement("a"); dl.className = "ghost file-btn"; dl.href = "/api/files/raw?dir=rw&download=1&path=" + enc; dl.textContent = "⬇"; dl.title = "Download";
    const del = document.createElement("button"); del.className = "ghost file-btn"; del.textContent = "🗑"; del.title = "Delete";
    del.addEventListener("click", async () => { if (!confirm("Delete " + f.path + "?")) return; del.disabled = true; try { await fetch("/api/files?dir=rw&path=" + enc, { method: "DELETE" }); row.remove(); if (!el.children.length) el.innerHTML = '<div class="hint">No files yet.</div>'; } catch { del.disabled = false; } });
    row.append(link, meta, dl, del); el.appendChild(row);
  });
}
const filesRefresh = $("files-refresh"); if (filesRefresh) filesRefresh.addEventListener("click", refreshFiles);

// --- Settings persistence + model switcher ---
function persistSetting(p, value) { fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, value }) }).catch(() => {}); }
async function loadModels() {
  const sel = $("model-select"); if (!sel) return;
  let d; try { d = await (await fetch("/api/models")).json(); } catch { return; }
  const models = d.models || [];
  if (!models.length) { sel.hidden = true; return; }
  sel.innerHTML = "";
  models.forEach((m) => { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); });
  if (d.current) sel.value = d.current;
  sel.hidden = false;
}
function setModel(name) {
  if (!name) return;
  persistSetting((cfg && cfg.model_mode === "multi") ? "llm.models.chat" : "llm.model", name);
  const sel = $("model-select"); if (sel) sel.value = name;
  if (modelBadge) modelBadge.textContent = (cfg && cfg.provider ? cfg.provider + " · " : "") + name;
  addMessage("assistant", "✅ Chat model set to **" + name + "** (saved to config).", "notice");
}
const modelSelect = $("model-select");
if (modelSelect) modelSelect.addEventListener("change", () => setModel(modelSelect.value));

// --- Regenerate the last response ---
function regenerate() {
  if (workingEl) return;
  if (!ws || ws.readyState !== 1) { addMessage("assistant", "Not connected.", "error"); return; }
  if (history.length && history[history.length - 1].role === "assistant") {
    history.pop(); saveHistory();
    const bubbles = messagesEl.querySelectorAll(".msg.assistant:not(.working-msg):not(.think-msg)");
    const last = bubbles[bubbles.length - 1]; if (last) last.remove();
  }
  if (!history.length || history[history.length - 1].role !== "user") { addMessage("assistant", "Nothing to regenerate yet.", "notice"); return; }
  stickBottom = true; showWorking("working…");
  ws.send(JSON.stringify({ type: "chat", messages: history }));
}
const regenBtn = $("regen"); if (regenBtn) regenBtn.addEventListener("click", regenerate);

// --- Slash commands ---
let currentPersona = null;   // optional persona from config.personas, set via /persona
function showSlashHelp() {
  addMessage("assistant", [
    "**Slash commands**",
    "- `/help` — show this menu",
    "- `/new` or `/clear` — start a new conversation",
    "- `/regen` or `/retry` — regenerate the last response",
    "- `/model [name]` — switch the chat model (no name opens the picker)",
    "- `/persona [name|off]` — switch persona (no name lists them)",
    "- `/hints [on|off]` — toggle skill auto-hints (no arg shows the state)",
    "- `/remember <fact>` — save a fact to long-term memory",
    "- `/files`, `/tasks`, `/memory`, `/activity`, `/workbench` — open that side panel",
  ].join("\n"));
}
function handleSlash(text) {
  const parts = text.slice(1).split(/\s+/); const cmd = (parts.shift() || "").toLowerCase(); const arg = parts.join(" ").trim();
  switch (cmd) {
    case "help": case "?": showSlashHelp(); return;
    case "new": case "clear": newSession(); return;
    case "regen": case "retry": regenerate(); return;
    case "model": if (arg) setModel(arg); else { const s = $("model-select"); if (s && !s.hidden) s.focus(); else addMessage("assistant", "No model picker available.", "notice"); } return;
    case "persona": {
      const avail = (cfg && cfg.personas) || [];
      if (!arg) { addMessage("assistant", avail.length ? "Personas: " + avail.map((p) => "`" + p + "`").join(", ") + (currentPersona ? ` (active: **${currentPersona}**)` : " (none active)") + " — `/persona <name>` to switch, `/persona off` to clear." : "No personas defined — add a `personas` block to JARVIS_CONFIG.json."); return; }
      if (arg === "off" || arg === "none") { currentPersona = null; addMessage("assistant", "Persona cleared — using the default prompt.", "notice"); return; }
      if (!avail.includes(arg)) { addMessage("assistant", "Unknown persona `" + arg + "` — available: " + (avail.join(", ") || "(none)"), "notice"); return; }
      currentPersona = arg; addMessage("assistant", "🎭 Persona set to **" + arg + "** for this conversation.", "notice"); return;
    }
    case "hints": {
      if (!arg) { addMessage("assistant", `Skill auto-hints are **${cfg && cfg.skills_autohint === false ? "off" : "on"}**. Use \`/hints on\` or \`/hints off\`.`, "notice"); return; }
      if (arg !== "on" && arg !== "off") { addMessage("assistant", "Usage: `/hints on` or `/hints off`", "notice"); return; }
      const on = arg === "on";
      persistSetting("skills_autohint", on);
      if (cfg) cfg.skills_autohint = on;
      addMessage("assistant", `Skill auto-hints turned **${arg}** (saved).`, "notice"); return;
    }
    case "remember":
      if (!arg) { addMessage("assistant", "Usage: `/remember <fact>`", "notice"); return; }
      fetch("/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: arg }) })
        .then(() => addMessage("assistant", "🧠 Remembered: " + arg, "notice")).catch((e) => addMessage("assistant", "Couldn't save: " + e, "error"));
      return;
    case "files": case "tasks": case "memory": case "activity": case "workbench": {
      const tab = document.querySelector('.tab[data-tab="' + cmd + '"]'); if (tab) tab.click(); return;
    }
    default: addMessage("assistant", "Unknown command `/" + cmd + "` — type `/help` for the list.", "notice");
  }
}

function showNotification(note) {
  const msg = (note && note.message) || "";
  addMessage("assistant", "🔔 " + msg, "notice");
  addNoteEl(note, true);   // add to the Tasks panel's notification history
  refreshTasks();          // a recurring task may have just stopped
  try { if (window.Notification && Notification.permission === "granted") new Notification("JARVIS", { body: msg }); } catch (_) {}
  if (window.JarvisVoice) JarvisVoice.speak(msg); // respects the audio switch
}

// Re-send the current history (which still ends with the failed user turn) without
// duplicating the user message — used by the Retry button after an error.
function resend() {
  if (!ws || ws.readyState !== 1) { addMessage("assistant", "Not connected — reconnecting…", "error"); return; }
  if (!history.length || history[history.length - 1].role !== "user") return;
  showWorking("working…");
  ws.send(JSON.stringify({ type: "chat", messages: history }));
}
function addRetry() {
  if (!history.length || history[history.length - 1].role !== "user") return;
  const wrap = document.createElement("div"); wrap.className = "msg assistant";
  const btn = document.createElement("button"); btn.className = "retry-btn"; btn.textContent = "↻ Retry";
  btn.addEventListener("click", () => { wrap.remove(); resend(); });
  wrap.appendChild(btn); messagesEl.appendChild(wrap); scrollDown();
}

function send(text) {
  text = (text || "").trim(); if (!text) return;
  if (text.startsWith("/")) { inputEl.value = ""; autoGrow(); handleSlash(text); return; }   // slash command
  if (!ws || ws.readyState !== 1) { addMessage("assistant", "Connecting… try again in a moment.", "error"); return; }
  stickBottom = true;                     // a fresh send always snaps to the bottom
  addMessage("user", text); history.push({ role: "user", content: text }); saveHistory();
  inputEl.value = ""; autoGrow(); showWorking("working…");
  ws.send(JSON.stringify({ type: "chat", messages: history, persona: currentPersona || undefined }));
}

// Grow the textarea with its content (up to the CSS max-height, then scroll).
function autoGrow() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px"; }
inputEl.addEventListener("input", autoGrow);

// Enter sends; Shift+Enter inserts a newline (and IME composition is respected).
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(inputEl.value); }
  else if (e.key === "ArrowUp" && inputEl.value === "") {   // recall last message to edit
    const lastU = [...history].reverse().find((m) => m.role === "user");
    if (lastU) { e.preventDefault(); inputEl.value = lastU.content; autoGrow(); }
  }
});

formEl.addEventListener("submit", (e) => { e.preventDefault(); send(inputEl.value); });

// Interrupt in-flight processing: the Stop button, or Escape while it's working.
if (stopBtn) stopBtn.addEventListener("click", sendCancel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && workingEl) { e.preventDefault(); sendCancel(); }
  else if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); inputEl.focus(); }
});

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
  if (t.dataset.tab === "memory") refreshMemories();
  if (t.dataset.tab === "files") refreshFiles();
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
  if (n.id) {
    const x = document.createElement("button"); x.className = "n-dismiss"; x.textContent = "×"; x.title = "Dismiss";
    x.addEventListener("click", async () => {
      try { await fetch("/api/notifications/" + encodeURIComponent(n.id), { method: "DELETE" }); } catch (_) {}
      el.remove(); if (!notesList.querySelector(".note")) notesList.innerHTML = '<div class="hint">No notifications yet.</div>';
    });
    el.appendChild(x);
  }
  if (prepend) notesList.insertBefore(el, notesList.firstChild); else notesList.appendChild(el);
}
const notesClear = $("notes-clear");
if (notesClear) notesClear.addEventListener("click", async () => {
  try { await fetch("/api/notifications/clear", { method: "POST" }); } catch (_) {}
  if (notesList) notesList.innerHTML = '<div class="hint">No notifications yet.</div>';
});
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
const qaAdd = $("qa-add");
if (qaAdd) qaAdd.addEventListener("click", async () => {
  const pEl = $("qa-prompt"), prompt = (pEl.value || "").trim();
  if (!prompt) { pEl.focus(); return; }
  const num = Math.max(1, parseInt($("qa-num").value, 10) || 5);
  const body = { prompt };
  if ($("qa-mode").value === "every") body.every_seconds = num * 60; else body.in_seconds = num * 60;
  try {
    const r = await (await fetch("/api/tasks/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (r.error) { addMessage("assistant", "Couldn't add task: " + r.error, "error"); return; }
    pEl.value = ""; refreshTasks();
  } catch (e) { addMessage("assistant", "Couldn't add task: " + e, "error"); }
});
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
  saveHistory(); resetSessUsage();   // keep persisted copy in sync + reset usage for the loaded convo
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
  saveHistory(); resetSessUsage();   // clear persisted conversation + reset the usage counter
  addMessage("assistant", "New session. JARVIS online — ask me anything.");
}
const newChatBtn = $("new-chat");
if (newChatBtn) newChatBtn.addEventListener("click", newSession);
const jumpBtn = $("jump-bottom");
if (jumpBtn) jumpBtn.addEventListener("click", () => { stickBottom = true; messagesEl.scrollTop = messagesEl.scrollHeight; jumpBtn.hidden = true; });
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
// The wake word is configurable (voice.wake_word in config; defaults to the assistant
// name). Show it in the mic status, nicely capitalized.
function wakeWordLabel() {
  const w = (cfg && cfg.voice && cfg.voice.wake_word) || "jarvis";
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function setMic(state) {
  micState.className = "mic" + (state === "listening" || state === "open" ? " listening" : state === "asleep" ? " awake" : "");
  micState.textContent =
    state === "open" ? "always on" :
    state === "listening" ? "listening…" :
    state === "asleep" ? `say "${wakeWordLabel()}"` :
    state === "unsupported" ? "no mic API" : "voice off";
  if (state === "off" || state === "unsupported") setActiveMode("off");
  // Push-to-talk only makes sense when the mic is Off — Wake/Open already listen.
  if (micBtn) {
    const usable = state === "off" || state === "unsupported";
    micBtn.disabled = !usable;
    micBtn.title = usable ? "Push to talk (tap, then speak)" : "Not needed — the mic is already listening (Wake/Open)";
  }
  voiceListening = (state === "listening" || state === "open");
  if (!ambSpeaking && !workingEl) amb(ambIdle());   // reflect mic state on the orb when idle
}
if (micMode) micMode.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn || !window.JarvisVoice) return;
  setActiveMode(btn.dataset.mode);
  JarvisVoice.setMode(btn.dataset.mode);
  persistSetting("voice.mic_mode", btn.dataset.mode);   // remember the mic mode across reboots
});
if (micBtn) micBtn.addEventListener("click", () => { if (window.JarvisVoice) JarvisVoice.listenOnce(); });

// The "Voice" button toggles spoken replies (text-to-speech). Listening is handled
// separately by the mic-mode control (Off / Wake / Open) + push-to-talk.
const voiceChatBtn = $("voice-chat");
function updateVoiceBtn() {
  if (!voiceChatBtn) return;
  const on = !window.JarvisVoice || JarvisVoice.ttsEnabled();
  voiceChatBtn.classList.toggle("active", !!on);
  voiceChatBtn.textContent = on ? "🔊 Voice" : "🔇 Voice";
  voiceChatBtn.title = on ? "Spoken replies ON (text-to-speech) — click to mute" : "Spoken replies OFF — click to enable";
}
function toggleVoice() {
  if (!window.JarvisVoice) return;
  const on = !JarvisVoice.ttsEnabled();
  JarvisVoice.setTts(on);
  persistSetting("voice.tts", on);
  updateVoiceBtn();
}
if (voiceChatBtn) voiceChatBtn.addEventListener("click", toggleVoice);

// Voice settings popover: pick the spoken voice + speed/pitch (persists to config).
const voiceSettingsBtn = $("voice-settings-btn"), voiceDrop = $("voice-drop");
const ttsEngineSel = $("tts-engine"), ttsVoiceSel = $("tts-voice"), ttsRate = $("tts-rate"), ttsPitch = $("tts-pitch"), ttsTest = $("tts-test");
function curEngine() { return (cfg && cfg.voice && cfg.voice.tts_engine) === "piper" ? "piper" : "browser"; }
// Pitch only applies to the browser engine (Piper has no pitch control) — dim it there.
function updatePitchState() {
  const piper = curEngine() === "piper";
  if (ttsPitch) ttsPitch.disabled = piper;
  const row = ttsPitch && ttsPitch.closest(".vd-row");
  if (row) row.style.opacity = piper ? "0.4" : "";
}
async function populateVoices() {
  if (!ttsVoiceSel) return;
  const cur = (cfg && cfg.voice && cfg.voice.tts_voice) || "";
  if (curEngine() === "piper") {
    ttsVoiceSel.innerHTML = '<option value="">Loading…</option>';
    try {
      const d = await (await fetch("/api/tts/voices")).json();
      const list = d.voices || [];
      if (!list.length) { ttsVoiceSel.innerHTML = '<option value="">(Piper unavailable)</option>'; return; }
      ttsVoiceSel.innerHTML = '<option value="">Auto (default)</option>';
      list.forEach((v) => { const o = document.createElement("option"); o.value = v.id; o.textContent = v.label || v.id; if (v.id === cur) o.selected = true; ttsVoiceSel.appendChild(o); });
    } catch (_) { ttsVoiceSel.innerHTML = '<option value="">(Piper unavailable)</option>'; }
    return;
  }
  // browser engine
  if (!window.speechSynthesis) { ttsVoiceSel.innerHTML = '<option value="">(no browser voices)</option>'; return; }
  const list = window.speechSynthesis.getVoices() || [];
  if (!list.length) return;   // not ready yet — onvoiceschanged will call again
  const sorted = list.slice().sort((a, b) => (/^en/i.test(b.lang) ? 1 : 0) - (/^en/i.test(a.lang) ? 1 : 0) || a.name.localeCompare(b.name));
  ttsVoiceSel.innerHTML = '<option value="">Auto (best match)</option>';
  sorted.forEach((v) => { const o = document.createElement("option"); o.value = v.name; o.textContent = `${v.name} (${v.lang})`; if (v.name === cur) o.selected = true; ttsVoiceSel.appendChild(o); });
}
if (window.speechSynthesis) window.speechSynthesis.addEventListener("voiceschanged", () => { if (curEngine() === "browser") populateVoices(); });
if (voiceSettingsBtn) voiceSettingsBtn.addEventListener("click", (e) => { e.stopPropagation(); voiceDrop.hidden = !voiceDrop.hidden; if (!voiceDrop.hidden) populateVoices(); });
document.addEventListener("click", (e) => { if (voiceDrop && !voiceDrop.hidden && !voiceDrop.contains(e.target) && e.target !== voiceSettingsBtn) voiceDrop.hidden = true; });
// Switching engine: the voice lists differ, so reset the chosen voice to Auto.
if (ttsEngineSel) ttsEngineSel.addEventListener("change", () => {
  const e = ttsEngineSel.value === "piper" ? "piper" : "browser";
  if (cfg && cfg.voice) { cfg.voice.tts_engine = e; cfg.voice.tts_voice = ""; }
  if (window.JarvisVoice) { JarvisVoice.setEngine(e); JarvisVoice.setVoice(""); }
  persistSetting("voice.tts_engine", e);
  persistSetting("voice.tts_voice", "");
  updatePitchState();
  populateVoices();
});
if (ttsVoiceSel) ttsVoiceSel.addEventListener("change", () => {
  if (window.JarvisVoice) { JarvisVoice.setVoice(ttsVoiceSel.value); JarvisVoice.test(); }
  if (cfg && cfg.voice) cfg.voice.tts_voice = ttsVoiceSel.value;
  persistSetting("voice.tts_voice", ttsVoiceSel.value);
});
if (ttsRate) ttsRate.addEventListener("change", () => { if (window.JarvisVoice) JarvisVoice.setRate(ttsRate.value); if (cfg && cfg.voice) cfg.voice.tts_rate = Number(ttsRate.value); persistSetting("voice.tts_rate", Number(ttsRate.value)); });
if (ttsPitch) ttsPitch.addEventListener("change", () => { if (window.JarvisVoice) JarvisVoice.setPitch(ttsPitch.value); if (cfg && cfg.voice) cfg.voice.tts_pitch = Number(ttsPitch.value); persistSetting("voice.tts_pitch", Number(ttsPitch.value)); });
if (ttsTest) ttsTest.addEventListener("click", () => { if (window.JarvisVoice) JarvisVoice.test(); });

// Ambient mode: full-screen hands-free view (expressive face or pulsating orb). Tapping
// the avatar talks / interrupts; the in-overlay button switches face <-> orb and persists.
const ambientBtn = $("ambient-btn");
if (ambientBtn && window.JarvisAmbient) {
  JarvisAmbient.onTap(() => { if (window.JarvisVoice) JarvisVoice.listenOnce(); });   // tap = push-to-talk / barge-in
  JarvisAmbient.onStyleChange((s) => { if (cfg && cfg.voice) cfg.voice.ambient_style = s; persistSetting("voice.ambient_style", s); });
  ambientBtn.addEventListener("click", () => {
    JarvisAmbient.toggle();
    if (JarvisAmbient.active()) {
      // Entering: turn on spoken replies so it can talk back, and reflect current state.
      if (window.JarvisVoice && !JarvisVoice.ttsEnabled()) { JarvisVoice.setTts(true); persistSetting("voice.tts", true); updateVoiceBtn(); }
      amb(workingEl ? "thinking" : ambSpeaking ? "speaking" : ambIdle());
    }
  });
}

let lastVoiceError = "";
function onVoiceError(msg) {
  if (msg === lastVoiceError) return; // avoid spamming the same error
  lastVoiceError = msg;
  addMessage("assistant", "🎤 " + msg, "error");
}

// Drag-drop a file into the chat: upload it to the shared folder, reference it in the input.
async function uploadFile(f) {
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  try {
    const r = await (await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, dataUrl }) })).json();
    if (r.error) { addMessage("assistant", "Upload failed: " + r.error, "error"); return; }
    inputEl.value = (inputEl.value ? inputEl.value + "\n" : "") + `Attached file: ${r.path}`; autoGrow(); inputEl.focus();
    addMessage("assistant", `📎 Uploaded **${f.name}** → \`${r.path}\` — ask me to read or work with it.`);
  } catch (e) { addMessage("assistant", "Upload failed: " + e, "error"); }
}
function setupDropZone() {
  const zone = document.querySelector(".chat") || document.body;
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); zone.classList.add("drag-over"); }
  }));
  ["dragleave", "dragend"].forEach((ev) => zone.addEventListener(ev, (e) => { if (e.target === zone) zone.classList.remove("drag-over"); }));
  zone.addEventListener("drop", async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); zone.classList.remove("drag-over");
    for (const f of [...e.dataTransfer.files]) await uploadFile(f);
  });
}

async function init() {
  try { cfg = await (await fetch("/api/config")).json(); } catch { cfg = {}; }
  if (cfg.error) addMessage("assistant", "Config error: " + cfg.error, "error");
  modelBadge.textContent = (cfg.provider ? cfg.provider + " · " : "") + (cfg.model || "");
  if (cfg.title) { const bt = $("brand-title"); if (bt) bt.textContent = cfg.title; document.title = cfg.title; }
  if (cfg.workbench_url) { desktop.src = cfg.workbench_url; desktopLink.href = cfg.workbench_url; }
  if (window.JarvisVoice && cfg.voice) {
    const ok = JarvisVoice.init(cfg.voice, {
      onUtterance: (t) => send(t), onState: setMic, onError: onVoiceError,
      onSpeak: (speaking) => { ambSpeaking = speaking; amb(speaking ? "speaking" : ambIdle()); },
      onBoundary: () => { if (window.JarvisAmbient) JarvisAmbient.pulse(); },   // browser: per-word pulse
      onLevel: (lvl) => { if (window.JarvisAmbient && JarvisAmbient.active()) JarvisAmbient.setLevel(lvl); }, // piper: real amplitude
    });
    if (!ok) { setMic("unsupported"); onVoiceError(JarvisVoice.supportMessage()); }
    updateVoiceBtn();   // reflect the saved TTS state on the Voice button
    if (window.JarvisAmbient) JarvisAmbient.setStyle(cfg.voice.ambient_style || "face");   // avatar style (face | orb)
    if (ttsEngineSel) ttsEngineSel.value = curEngine();
    if (ttsRate) ttsRate.value = cfg.voice.tts_rate || 1.0;
    if (ttsPitch) ttsPitch.value = cfg.voice.tts_pitch || 1.0;
    updatePitchState();
    populateVoices();
    // Restore the saved mic mode (persisted to config).
    const savedMode = cfg.voice.mic_mode || "off";
    if (ok && savedMode !== "off") { setActiveMode(savedMode); JarvisVoice.setMode(savedMode); }
  }
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (_) {}
  restoreHistory();   // bring back the conversation after a refresh
  refreshTasks(); refreshNotes(); setupDropZone(); loadModels();
  connectWS();
  inputEl.focus();
}
init();
