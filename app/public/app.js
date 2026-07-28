"use strict";
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages"), formEl = $("composer"), inputEl = $("input"), stopBtn = $("stop");
const statusEl = $("jarvis-status");   // always-visible working/idle pill in the header
// Per-message mode flags (set by the topbar toggles, wired near the bottom).
let chatWatchdog = localStorage.getItem("jarvis.watchdog") !== "0";   // default ON (kill stalled streams)
let chatPlan = localStorage.getItem("jarvis.plan") === "1";           // default OFF (plan-first mode)
function sendChatWS(extra) {
  ws.send(JSON.stringify({ type: "chat", watchdog: chatWatchdog, planMode: chatPlan, ...extra }));
}

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
const micMode = $("mic-mode"), micState = $("mic-state");
const micBtn = $("mic-btn");
const desktop = $("desktop"), desktopLink = $("desktop-link");
// Re-establish the embedded desktop connection. Opening the desktop in a new tab (or
// backgrounding this tab) can leave the iframe's VNC socket frozen; reloading the iframe
// gets a fresh connection so the desktop works "here" again.
function reloadDesktop() {
  if (!cfg || !cfg.workbench_url || !desktop) return;
  desktop.src = "about:blank";
  setTimeout(() => { desktop.src = cfg.workbench_url; }, 60);
}
const desktopReload = $("desktop-reload");
if (desktopReload) desktopReload.addEventListener("click", reloadDesktop);
// When you come back to the JARVIS tab with the Workbench panel open, auto-reconnect —
// this is exactly the "opened it in a new tab and now the embedded one is dead" case.
document.addEventListener("visibilitychange", () => {
  const wb = $("panel-workbench");
  if (!document.hidden && wb && wb.classList.contains("active")) reloadDesktop();
});

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
let ctxWindow = 32768;   // context-window ceiling (from config); the meter is context_tokens / this
function updateContextMeter(tok) {
  const m = $("ctx-meter"), fill = $("ctx-fill"), label = $("ctx-label"); if (!m) return;
  tok = Math.max(0, Math.round(tok || 0));                     // always show — 0% is valid
  const pct = Math.min(100, Math.round((tok / ctxWindow) * 100));
  m.hidden = false;
  fill.style.width = pct + "%";
  m.classList.toggle("warn", pct >= 60 && pct < 85);
  m.classList.toggle("high", pct >= 85);
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
  label.textContent = `${pct}% · ${k(tok)}/${k(ctxWindow)}`;
  m.title = `Context window: ${pct}% used (${tok.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens). A fresh chat resets it.`;
  const sb = $("ctx-summarize"); if (sb) sb.hidden = pct < 60;   // offer "Summarize & continue" once it's getting full
}
// Summarize the conversation and REPLACE the sent context with that summary, so the window
// actually shrinks (a pure "please summarize" wouldn't free anything) and we keep going.
async function summarizeAndContinue() {
  const btn = $("ctx-summarize");
  if (history.length < 2) return;
  if (btn) { btn.disabled = true; btn.textContent = "…summarizing"; }
  try {
    const d = await (await fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }) })).json();
    if (d.error || !d.summary) { addMessage("assistant", "Couldn't summarize: " + (d.error || "empty result"), "error"); return; }
    messagesEl.innerHTML = "";                       // replace the transcript with the compact summary
    history.length = 0;
    const msg = { role: "assistant", content: "📋 **Context compacted to continue.** Summary of the conversation so far:\n\n" + d.summary };
    history.push(msg); saveHistory();
    addMessage(msg.role, msg.content);
    const m = $("ctx-meter"); if (m) m.classList.remove("warn", "high");   // meter recomputes on the next turn
    if (btn) btn.hidden = true;
  } catch (e) { addMessage("assistant", "Summarize failed: " + e.message, "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "🗜 Summarize"; } }
}
(function () { const b = document.getElementById("ctx-summarize"); if (b) b.addEventListener("click", summarizeAndContinue); })();
// Rough estimate so the meter shows a sensible value on load/refresh before the first turn's
// exact usage arrives (0 on a fresh chat; ~4 chars/token + the fixed system+tools prefix otherwise).
function estimateContextTokens() { return history.length ? Math.round(history.reduce((n, m) => n + ((m.content || "").length), 0) / 4) + 8000 : 0; }
function refreshContextMeter() { updateContextMeter(estimateContextTokens()); }
let workingEl = null, workingTimer = null, workingStart = 0;   // persistent "still working" indicator
let lastActivityAt = 0, stalled = false;                       // stall detection: when the model goes quiet
let STALL_MS = 25000;                                          // no streamed progress for this long ⇒ "seems stuck" (configurable: ui.stall_seconds)
// Update the always-visible header pill. state: "idle" | "working" | "stalled".
function setStatus(state, text) {
  if (!statusEl) return;
  statusEl.className = "jstatus " + state;
  const t = statusEl.querySelector(".jstext");
  if (t) t.textContent = text || (state === "idle" ? "Idle" : state === "stalled" ? "Stalled?" : "Working");
}
// Any streamed progress event resets the stall clock and confirms JARVIS is alive.
function markActivity() {
  lastActivityAt = Date.now();
  if (stalled) { stalled = false; if (workingEl) { const b = workingEl.querySelector(".bubble"); if (b) b.classList.remove("stalled"); } }
  if (workingEl) setStatus("working", "Working");
}
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
  // Auto-link BARE URLs (e.g. a http://localhost:9101 the model posts) so they are clickable.
  // Protect existing <a>/<code> spans first so we do not double-link or link inside code.
  {
    const prot = [];
    s = s.replace(/<a [^>]*>[\s\S]*?<\/a>|<code>[\s\S]*?<\/code>/g, function (m) { prot.push(m); return "\u0000L" + (prot.length - 1) + "\u0000"; });
    s = s.replace(/(^|[\s(>])((?:https?:\/\/|www\.)[^\s<)]+[a-zA-Z0-9\/#=_&-])/g, function (m, pre, url) { return pre + '<a href="' + (url.indexOf("http") === 0 ? url : "https://" + url) + '" target="_blank" rel="noopener">' + url + "</a>"; });
    s = s.replace(/\u0000L(\d+)\u0000/g, function (m, i) { return prot[Number(i)] || ""; });
  }
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
    workingEl = w; workingStart = Date.now(); lastActivityAt = Date.now(); stalled = false;
    workingTimer = setInterval(() => {
      if (!workingEl) return;
      const t = workingEl.querySelector(".wtime");
      if (t) t.textContent = Math.round((Date.now() - workingStart) / 1000) + "s";
      // Stall detection: no streamed progress for STALL_MS ⇒ warn it may be stuck (Esc to stop).
      if (!stalled && Date.now() - lastActivityAt > STALL_MS) {
        stalled = true;
        const b = workingEl.querySelector(".bubble"); if (b) b.classList.add("stalled");
        const l = workingEl.querySelector(".wlabel"); if (l) l.textContent = "still working — model is slow (press Esc to stop)";
        setStatus("stalled", "Stalled?");
      }
    }, 1000);
  }
  if (label != null) { const l = workingEl.querySelector(".wlabel"); if (l) l.textContent = label; }
  messagesEl.appendChild(workingEl);                 // keep it pinned to the bottom
  if (stopBtn) stopBtn.hidden = false;
  setStatus("working", "Working");
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
  stalled = false;
  setStatus("idle", "Idle");
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
  if (typeof drawer !== "undefined" && drawer) drawer.notifyActivity();   // badge the toggle if the drawer is closed
}

let wsBackoff = 1000, connLost = false;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsBackoff = 1000; if (connLost) { connLost = false; addMessage("assistant", "🔌 Reconnected.", "notice"); } };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };   // let onclose drive the reconnect
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    // Any of these events means the model is actively producing output — reset the stall clock.
    if (["tool", "tool_result", "usage", "reasoning", "token"].includes(d.type)) markActivity();
    if (d.type === "tool") { addActivity(d.tool, d.input); labelWorking("running " + d.tool + "…"); pinWorking(); }
    else if (d.type === "tool_result") { addActivity(d.tool + " →" + (d.ms != null ? ` (${d.ms}ms)` : ""), undefined, d.output); labelWorking("working…"); }
    else if (d.type === "usage") {
      addActivity(`↳ ${d.model ? d.model + " · " : ""}${(d.usage && d.usage.total_tokens) || 0} tokens` + (d.cost_usd ? ` · ~$${d.cost_usd}` : ""));
      sessTokens += (d.usage && d.usage.total_tokens) || 0; sessCost += Number(d.cost_usd) || 0; updateSessUsage();
      if (d.usage && d.usage.context_tokens) updateContextMeter(d.usage.context_tokens);
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
      // ephemeral = a verbose Autopilot cycle: show it, but don't add it to the chat's
      // model-context history (would bloat/confuse your next chat turn) and don't speak it.
      if (!d.ephemeral) {
        history.push({ role: "assistant", content: finalText }); saveHistory();
        if (window.JarvisVoice) {
          if (ttsSpokenLen > 0 && streamText) { const rest = streamText.slice(ttsSpokenLen); if (rest.trim()) JarvisVoice.speak(rest); }
          else JarvisVoice.speak(plain(finalText));
        }
      }
      ttsSpokenLen = 0;
      streamBubble = null; streamText = "";
    } else if (d.type === "error") {
      hideWorking(); finalizeThink(); streamBubble = null; streamText = "";
      addMessage("assistant", "Error: " + d.error, "error");
      addRetry();
    } else if (d.type === "plan") {
      renderPlan(d.plan);
    } else if (d.type === "autopilot") {
      renderAutopilot(d.status);
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
  sendChatWS({ messages: history });
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
  sendChatWS({ messages: history });
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
  sendChatWS({ messages: history, persona: currentPersona || undefined });
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


document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
  t.classList.add("active"); $("panel-" + t.dataset.tab).classList.add("active");
  if (drawer && !drawer.isOpen()) drawer.open();   // picking a tab reveals the drawer if it was closed
  if (t.dataset.tab === "tasks") { refreshTasks(); refreshNotes(); }
  if (t.dataset.tab === "memory") refreshMemories();
  if (t.dataset.tab === "files") refreshFiles();
  if (t.dataset.tab === "config") loadConfig();
}));

// --- Persistent PLAN ledger banner -------------------------------------------
const PB_ICON = { done: "✓", active: "▸", pending: "○", blocked: "✕" };
function renderPlan(plan) {
  const banner = $("plan-banner"); if (!banner) return;
  if (!plan || plan.status !== "active" || !Array.isArray(plan.steps) || !plan.steps.length) { banner.hidden = true; return; }
  banner.hidden = false;
  const obj = $("pb-obj"); if (obj) { obj.textContent = plan.objective || ""; obj.title = plan.objective || ""; }
  const done = plan.steps.filter((s) => s.status === "done").length;
  const prog = $("pb-prog"); if (prog) prog.textContent = done + "/" + plan.steps.length;
  const list = $("pb-steps");
  if (list) {
    list.innerHTML = "";
    for (const s of plan.steps) {
      const li = document.createElement("li");
      li.className = "pb-step " + (s.status || "pending");
      li.innerHTML = `<span class="pb-ico">${PB_ICON[s.status] || "○"}</span>` +
        `<span class="pb-txt">${esc(s.text || "")}` + (s.note ? ` <span class="pb-note">— ${esc(s.note)}</span>` : "") + `</span>`;
      list.appendChild(li);
    }
  }
  if (drawer) drawer.notifyActivity && drawer.notifyActivity();
}
(function initPlanBanner() {
  const banner = $("plan-banner"); if (!banner) return;
  if (localStorage.getItem("jarvis.plan.collapsed") === "1") banner.classList.add("collapsed");
  const col = $("pb-collapse"), clr = $("pb-clear");
  if (col) col.addEventListener("click", () => {
    banner.classList.toggle("collapsed");
    localStorage.setItem("jarvis.plan.collapsed", banner.classList.contains("collapsed") ? "1" : "0");
  });
  if (clr) clr.addEventListener("click", async () => {
    if (!confirm("Clear the current plan?")) return;
    try { await fetch("/api/plan", { method: "DELETE" }); } catch (_) {}
    banner.hidden = true;
  });
})();

// --- Autopilot: launch + live status bar -------------------------------------
let apTick = null;
let apLastStatus = null;   // latest run status, so the Stop button can escalate to a forced stop
function fmtLeft(s) { s = Math.max(0, s | 0); const m = Math.floor(s / 60), ss = s % 60; return m > 0 ? `${m}m ${ss}s` : `${ss}s`; }
const AP_ENDED_LABEL = { done: "✅ done", budget: "⏱ time budget reached", stopped: "⏹ stopped", stuck: "⚠️ stuck", error: "⚠️ errored" };
function renderAutopilot(st) {
  const bar = $("autopilot-bar"); if (!bar) return;
  if (!st || (!st.active && !st.ended)) { bar.hidden = true; if (apTick) { clearInterval(apTick); apTick = null; } return; }
  bar.hidden = false;
  apLastStatus = st.status || null;
  const paused = !!st.paused, stopping = st.status === "stopping" || st.status === "pausing", ended = !!st.ended;
  bar.classList.toggle("paused", paused || stopping);
  bar.classList.toggle("ended", ended);
  const state = $("ap-state"); if (state) state.textContent = ended ? (AP_ENDED_LABEL[st.status] || st.status) : (st.status === "pausing" ? "pausing…" : st.status === "stopping" ? "stopping…" : st.status);
  const obj = $("ap-barobj"); if (obj) { obj.textContent = st.objective || ""; obj.title = st.objective || ""; }
  const pauseBtn = $("ap-pause"); if (pauseBtn) { pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause"; pauseBtn.dataset.act = paused ? "resume" : "pause"; }
  // Show the right control set: active runs get pause/extend/wrapup/stop; an ended run gets
  // continue (if resumable) / dismiss. Modify is available in both.
  const show = (id, on) => { const b = $(id); if (b) b.hidden = !on; };
  show("ap-pause", !ended); show("ap-extend", !ended); show("ap-wrapup", !ended); show("ap-stop", !ended);
  show("ap-continue", ended && st.resumable); show("ap-dismiss", ended);
  const stopBtn = $("ap-stop"); if (stopBtn) { stopBtn.textContent = stopping ? "Force stop" : "Stop"; stopBtn.title = stopping ? "Still stopping — click for a FORCED stop (aborts the current step now)" : "Stop immediately"; }
  let secs = Number(st.seconds_left) || 0;
  const tokBit = st.tokens ? ` · ${st.tokens >= 1000 ? (st.tokens / 1000).toFixed(1) + "k" : st.tokens} tok` + (st.cost_usd ? ` ~$${st.cost_usd}` : "") : "";
  const paint = () => { const m = $("ap-meta"); if (m) m.textContent = ended ? `${st.cycles || 0} cycles${tokBit}` : `cycle ${st.cycles || 0} · ${fmtLeft(secs)}${paused ? " left (paused)" : " left"}${tokBit}`; };
  paint();
  if (apTick) { clearInterval(apTick); apTick = null; }
  if (st.status === "running") apTick = setInterval(() => { secs = Math.max(0, secs - 1); paint(); }, 1000);  // freeze while paused/stopping/ended
}
(function initAutopilot() {
  const btn = $("autopilot-btn"), drop = $("ap-drop");
  const openLauncher = () => { const c = $("ap-clarify-panel"); if (c) c.hidden = true; clar = null; drop.hidden = false; $("ap-objective").focus(); };
  const closeLauncher = () => { drop.hidden = true; };
  if (btn && drop) {
    btn.addEventListener("click", (e) => { e.stopPropagation(); if (drop.hidden) openLauncher(); else closeLauncher(); });
    // Modal behavior: click the dimmed backdrop (the overlay itself, not the card) to close.
    drop.addEventListener("mousedown", (e) => { if (e.target === drop) closeLauncher(); });
    const closeBtn = $("ap-close"); if (closeBtn) closeBtn.addEventListener("click", closeLauncher);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drop.hidden) closeLauncher(); });
  }
  // Actually launch the autonomous run with the given (possibly clarified) objective.
  async function launchAutopilot(objective) {
    const minutes = Number($("ap-minutes").value) || 30;
    const autonomy = $("ap-autonomy").value || "guarded";
    const verbose = !!($("ap-verbose") && $("ap-verbose").checked);
    try {
      const st = await (await fetch("/api/autopilot/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objective, minutes, autonomy, verbose }) })).json();
      if (st.error) { addMessage("assistant", "Autopilot: " + st.error, "error"); return false; }
      if (drop) drop.hidden = true;
      const clr = $("ap-clarify-panel"); if (clr) clr.hidden = true;
      renderAutopilot(st);
      addMessage("assistant", `🛫 Autopilot started (${autonomy}, up to ${minutes} min) — working on: ${objective.split("\n")[0]}`, "notice");
      return true;
    } catch (e) { addMessage("assistant", "Autopilot failed to start: " + e.message, "error"); return false; }
  }
  // --- Clarify wizard: ask one question at a time, collect an answer for each, then launch. ---
  let clar = null;   // { objective, questions:[], answers:[], i }
  function showClarQuestion() {
    const n = clar.questions.length, i = clar.i;
    $("ap-q-progress").textContent = `Question ${i + 1} of ${n}`;
    $("ap-q-text").textContent = clar.questions[i];
    $("ap-answers").value = clar.answers[i] || "";
    $("ap-q-back").hidden = i === 0;
    $("ap-q-next").textContent = (i === n - 1) ? "🛫 Build it" : "Next →";
    $("ap-answers").focus();
  }
  async function finishClar() {
    const lines = clar.questions.map((q, k) => `${k + 1}. ${q}\n   → ${(clar.answers[k] || "").trim() || "(no preference — use your best judgment)"}`).join("\n");
    const enriched = clar.objective + "\n\n--- Clarifications (I asked these before starting) ---\n" + lines;
    const c = clar; clar = null;
    $("ap-q-next").disabled = true;
    await launchAutopilot(enriched);
    $("ap-q-next").disabled = false;
    if (clar === null) { /* launched (or failed) — panel hidden by launchAutopilot on success */ }
    return c;
  }
  const start = $("ap-start");
  if (start) start.addEventListener("click", async () => {
    const objective = ($("ap-objective").value || "").trim();
    if (!objective) { $("ap-objective").focus(); return; }
    const clarify = !!($("ap-clarify") && $("ap-clarify").checked);
    if (!clarify) { start.disabled = true; await launchAutopilot(objective); start.disabled = false; return; }
    // Pre-flight: let the model review the request and ask questions before it plans/builds.
    start.disabled = true; const lbl = start.textContent; start.textContent = "…reviewing your request";
    try {
      const d = await (await fetch("/api/autopilot/clarify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objective }) })).json();
      if (d.error) { addMessage("assistant", "Clarify failed: " + d.error, "error"); return; }
      const qs = Array.isArray(d.questions) ? d.questions.filter(q => (q || "").trim()) : [];
      if (d.ready || !qs.length) { await launchAutopilot(objective); return; }   // nothing to ask -> just go
      clar = { objective, questions: qs, answers: [], i: 0 };
      $("ap-clarify-panel").hidden = false;
      showClarQuestion();
    } catch (e) { addMessage("assistant", "Clarify failed: " + e.message, "error"); }
    finally { start.disabled = false; start.textContent = lbl; }
  });
  const qNext = $("ap-q-next");
  if (qNext) qNext.addEventListener("click", async () => {
    if (!clar) return;
    clar.answers[clar.i] = ($("ap-answers").value || "").trim();
    if (clar.i < clar.questions.length - 1) { clar.i++; showClarQuestion(); }
    else await finishClar();
  });
  const qBack = $("ap-q-back");
  if (qBack) qBack.addEventListener("click", () => {
    if (!clar || clar.i === 0) return;
    clar.answers[clar.i] = ($("ap-answers").value || "").trim();
    clar.i--; showClarQuestion();
  });
  // Enter submits the current question (Shift+Enter = newline in the answer).
  const qAns = $("ap-answers");
  if (qAns) qAns.addEventListener("keydown", (e) => { if (clar && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); qNext.click(); } });
  const clarifySkip = $("ap-clarify-skip");
  if (clarifySkip) clarifySkip.addEventListener("click", async () => {
    if (!clar) return;
    clar.answers[clar.i] = ($("ap-answers").value || "").trim();   // keep whatever's been answered so far
    const answered = clar.answers.some(a => (a || "").trim());
    clar.questions = clar.questions.slice(0, clar.i + 1);          // drop the unshown ones
    if (answered) { await finishClar(); }                          // fold in partial answers
    else { const o = clar.objective; clar = null; await launchAutopilot(o); }   // nothing answered -> raw objective
  });
  const apPost = async (path, body) => { try { renderAutopilot(await (await fetch("/api/autopilot/" + path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })).json()); } catch (_) {} };
  const wrap = $("ap-wrapup"), stop = $("ap-stop"), pauseB = $("ap-pause"), extendB = $("ap-extend"), modifyB = $("ap-modify"), continueB = $("ap-continue"), dismissB = $("ap-dismiss");
  if (wrap) wrap.addEventListener("click", () => apPost("wrapup"));
  if (stop) stop.addEventListener("click", () => {
    if (apLastStatus === "stopping") {
      // A stop is already pending but the current step hasn't quit — offer the forced stop.
      if (confirm("Autopilot is still finishing its current step and hasn't stopped yet.\n\nPerform a FORCED stop? This aborts the running step immediately and kills any preview servers it started (ports 9101-9150).")) apPost("forcestop");
    } else {
      if (confirm("Stop Autopilot? It aborts the current step and stops. (If it doesn't stop, click Stop again for a forced stop.)")) apPost("stop");
    }
  });
  if (pauseB) pauseB.addEventListener("click", () => apPost(pauseB.dataset.act === "resume" ? "resume" : "pause"));
  if (extendB) extendB.addEventListener("click", () => apPost("extend", { minutes: 15 }));
  if (continueB) continueB.addEventListener("click", () => apPost("continue", { minutes: 15 }));   // resume the SAME plan with a fresh budget
  if (dismissB) dismissB.addEventListener("click", () => apPost("dismiss"));
  // Modify: open a floating window prefilled with the current objective (no more prompt() box).
  const modModal = $("ap-modify-modal"), modObj = $("ap-modify-obj");
  const closeModify = () => { if (modModal) modModal.hidden = true; };
  if (modifyB && modModal && modObj) {
    modifyB.addEventListener("click", () => {
      modObj.value = ($("ap-barobj").textContent || "").trim();
      modModal.hidden = false; modObj.focus();
    });
    modModal.addEventListener("mousedown", (e) => { if (e.target === modModal) closeModify(); });
    const mClose = $("ap-modify-close"), mCancel = $("ap-modify-cancel"), mSave = $("ap-modify-save");
    if (mClose) mClose.addEventListener("click", closeModify);
    if (mCancel) mCancel.addEventListener("click", closeModify);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modModal.hidden) closeModify(); });
    const doSave = () => {
      const cur = ($("ap-barobj").textContent || "").trim();
      const next = (modObj.value || "").trim();
      if (next && next !== cur) apPost("modify", { objective: next });
      closeModify();
    };
    if (mSave) mSave.addEventListener("click", doSave);
    modObj.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); } });
  }
})();

// --- Mode toggles: stream watchdog + plan mode -------------------------------
(function initModeToggles() {
  const wd = $("watchdog-toggle"), pl = $("plan-toggle");
  function paint() {
    if (wd) {
      wd.classList.toggle("mode-on", chatWatchdog);
      wd.title = chatWatchdog
        ? "Stream watchdog ON — a stalled model is stopped after the idle timeout. Best for chat and quick tasks. Click to turn OFF for long coding runs."
        : "Stream watchdog OFF — patient mode: JARVIS keeps waiting through slow local generations (press Stop/Esc to interrupt). Best for long coding tasks. Click to turn ON.";
    }
    if (pl) {
      pl.classList.toggle("mode-on", chatPlan);
      pl.title = chatPlan
        ? "Plan mode ON — JARVIS asks any clarifying questions, lays out a high-level plan, then executes step by step. Click to turn OFF."
        : "Plan mode OFF. Click to turn ON — JARVIS will clarify and plan the work before executing.";
    }
  }
  if (wd) wd.addEventListener("click", () => { chatWatchdog = !chatWatchdog; localStorage.setItem("jarvis.watchdog", chatWatchdog ? "1" : "0"); paint(); });
  if (pl) pl.addEventListener("click", () => { chatPlan = !chatPlan; localStorage.setItem("jarvis.plan", chatPlan ? "1" : "0"); paint(); });
  paint();
})();

// --- Resizable / collapsible side drawer -------------------------------------
// Closed (chat full-width), or open at any width you drag it to. Double-click the
// grip to cycle preset sizes (peek / half / full). Width + open state persist.
const drawer = (() => {
  const layout = document.querySelector(".layout");
  const handle = $("drawer-handle"), dot = $("drawer-dot");
  if (!layout || !handle) return null;
  const MIN = 300, CLOSE_AT = 190, LSW = "jarvis.drawer.w", LSO = "jarvis.drawer.open";
  const maxW = () => Math.round(window.innerWidth * 0.72);
  const clamp = (w) => Math.max(MIN, Math.min(maxW(), Math.round(w)));
  let width = clamp(parseInt(localStorage.getItem(LSW) || "480", 10) || 480);
  let open = localStorage.getItem(LSO) !== "0";
  function apply() {
    layout.style.setProperty("--drawer-w", width + "px");
    layout.classList.toggle("drawer-collapsed", !open);
    if (open && dot) dot.hidden = true;   // opening clears the "activity while hidden" badge
  }
  function setWidth(w, save) { width = clamp(w); if (save) localStorage.setItem(LSW, String(width)); apply(); }
  function setOpen(o) { open = !!o; localStorage.setItem(LSO, open ? "1" : "0"); apply(); }
  // The handle stays attached to the drawer's left edge. Click = toggle open/close.
  // Drag = live resize; drag past the right edge closes it, drag out from the edge opens it.
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX; let moved = false;
    layout.classList.add("resizing");
    document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize";
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) > 4) moved = true;
      if (!moved) return;
      const raw = window.innerWidth - ev.clientX;   // desired drawer width under the cursor
      if (raw < CLOSE_AT) { if (open) setOpen(false); }
      else { if (!open) setOpen(true); setWidth(raw, false); }
    };
    const up = () => {
      layout.classList.remove("resizing");
      document.body.style.userSelect = ""; document.body.style.cursor = "";
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (!moved) setOpen(!open);                       // click → toggle
      else if (open) localStorage.setItem(LSW, String(width));   // persist the dragged width
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  window.addEventListener("resize", () => setWidth(width, false));   // keep within new bounds
  apply();
  return {
    isOpen: () => open,
    open: () => setOpen(true),
    toggle: () => setOpen(!open),
    notifyActivity: () => { if (!open && dot) dot.hidden = false; },   // badge the handle when work happens while closed
  };
})();

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
  saveHistory(); resetSessUsage(); refreshContextMeter();   // reset usage + show the loaded convo's context estimate
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
  saveHistory(); resetSessUsage(); refreshContextMeter();   // clear conversation, reset usage, meter -> 0%
  try { fetch("/api/plan", { method: "DELETE" }); } catch (_) {} renderPlan(null);   // a fresh chat starts with no active plan (don't inherit a stale one)
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
  if (Number(cfg.stall_seconds) > 0) STALL_MS = Number(cfg.stall_seconds) * 1000;   // "model is slow" warning delay
  if (Number(cfg.context_window) > 0) ctxWindow = Number(cfg.context_window);        // context-meter ceiling (immediate)
  try { const d = await (await fetch("/api/context-window")).json(); if (Number(d.context_window) > 0) ctxWindow = Number(d.context_window); } catch (_) {}   // refine: manual override / auto-detect (Ollama num_ctx / model)
  try { renderPlan(await (await fetch("/api/plan")).json()); } catch (_) {}          // restore the active plan ledger
  if (cfg.autopilot) {                                                                // prefill Autopilot launcher defaults
    const mi = $("ap-minutes"); if (mi && cfg.autopilot.default_minutes) mi.value = cfg.autopilot.default_minutes;
    const au = $("ap-autonomy"); if (au && cfg.autopilot.autonomy) au.value = cfg.autopilot.autonomy;
  }
  try { renderAutopilot(await (await fetch("/api/autopilot")).json()); } catch (_) {}  // reflect an in-progress run
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
  refreshContextMeter();   // always show the meter (0% on a fresh chat; an estimate after a refresh)
  refreshTasks(); refreshNotes(); setupDropZone(); loadModels();
  connectWS();
  inputEl.focus();
}
init();

// ===== Config tab: full JARVIS_CONFIG.json + JARVIS_SECRETS.json editor =====
// Hybrid editor: friendly fields and the raw JSON stay in sync (JSON is canonical at
// save). Saving writes both files (server validates + auto-backs-up); applying the
// change is a separate `./JARVIS.sh --reload`.
let cfgObj = {}, secretsObj = { secrets: {} };

// Declarative map of structured field -> config path -> type.
const CFG_FIELDS = [
  ["cfg-provider", "llm.provider", "str"],
  ["cfg-base-url", "llm.base_url", "str"],
  ["cfg-api-key", "llm.api_key", "str"],
  ["cfg-model-mode", "llm.model_mode", "str"],
  ["cfg-model", "llm.model", "str"],
  ["cfg-tier-chat", "llm.models.chat", "str"],
  ["cfg-tier-cheap", "llm.models.cheap", "str"],
  ["cfg-tier-smart", "llm.models.smart", "str"],
  ["cfg-tier-vision", "llm.models.vision", "str"],
  ["cfg-temperature", "llm.temperature", "num"],
  ["cfg-max-tokens", "llm.max_tokens", "num"],
  ["cfg-context-window", "llm.context_window", "num"],
  ["cfg-completion-checks", "llm.completion_checks", "num"],
  ["cfg-idle-timeout", "llm.idle_timeout_ms", "num"],
  ["cfg-idle-watchdog", "llm.idle_watchdog", "bool"],
  ["cfg-stall-seconds", "ui.stall_seconds", "num"],
  ["cfg-ollama-manage", "ollama.manage", "bool"],
  ["cfg-ollama-ctx", "ollama.context_length", "num"],
  ["cfg-ollama-keep", "ollama.keep_alive", "str"],
  ["cfg-ollama-par", "ollama.num_parallel", "num"],
  ["cfg-ollama-maxl", "ollama.max_loaded_models", "num"],
  ["cfg-assistant-name", "assistant_name", "str"],
  ["cfg-tts-engine", "voice.tts_engine", "str"],
  ["cfg-mic-mode", "voice.mic_mode", "str"],
  ["cfg-voice-enabled", "voice.enabled", "bool"],
  ["cfg-skills-autohint", "skills_autohint", "bool"],
  ["cfg-log-level", "logging.level", "num"],
];

// The model fields are real <select> dropdowns (native <datalist> was unreliable). "List models"
// fills these; each keeps its currently-configured value even if it isn't in the fetched list,
// plus a "✎ Custom…" escape hatch for a model the endpoint didn't return.
const MODEL_SELECT_IDS = ["cfg-model", "cfg-tier-chat", "cfg-tier-cheap", "cfg-tier-smart", "cfg-tier-vision"];
const MODEL_CUSTOM = "__custom__";
let modelOptions = [];   // last result from "List models"
function renderModelSelect(sel, current) {
  current = current == null ? "" : String(current);
  sel.innerHTML = "";
  const add = (val, label) => { const o = document.createElement("option"); o.value = val; o.textContent = label != null ? label : val; sel.appendChild(o); };
  add("", "— none —");
  const seen = new Set();
  const all = current && !modelOptions.includes(current) ? [current, ...modelOptions] : modelOptions;
  for (const m of all) { if (m && !seen.has(m)) { seen.add(m); add(m); } }
  add(MODEL_CUSTOM, "✎ Custom…");
  sel.value = current;
}
// Type a model the endpoint didn't list; inject it and keep it selected.
function onModelSelectChange(e) {
  const sel = e.target;
  if (sel.value !== MODEL_CUSTOM) return;
  const name = (prompt("Enter a model name (as the provider expects it):", "") || "").trim();
  if (name) { if (!modelOptions.includes(name)) modelOptions.push(name); renderModelSelect(sel, name); }
  else { renderModelSelect(sel, ""); }
  collectStructured(); renderRawConfig();
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, val) {
  const parts = dotted.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object" || o[parts[i]] == null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
}

function populateStructured() {
  for (const [id, path, type] of CFG_FIELDS) {
    const el = $(id); if (!el) continue;
    const v = getPath(cfgObj, path);
    if (MODEL_SELECT_IDS.includes(id)) { renderModelSelect(el, v); continue; }   // <select> needs the option to exist
    if (type === "bool") el.checked = v !== false && v != null ? !!v : (v === true);
    else el.value = v == null ? "" : v;
  }
  // sensible default for the two booleans when the key is absent
  if (getPath(cfgObj, "voice.enabled") === undefined) $("cfg-voice-enabled").checked = true;
  if (getPath(cfgObj, "skills_autohint") === undefined) $("cfg-skills-autohint").checked = true;
  if (getPath(cfgObj, "ollama.manage") === undefined) $("cfg-ollama-manage").checked = true;
}

function collectStructured() {
  for (const [id, path, type] of CFG_FIELDS) {
    const el = $(id); if (!el) continue;
    let val;
    if (type === "bool") val = el.checked;
    else if (type === "num") val = el.value === "" ? undefined : Number(el.value);
    else if (el.value === "" || el.value === MODEL_CUSTOM) val = undefined;   // sentinel/blank -> unset
    else val = el.value;
    setPath(cfgObj, path, val);
  }
}
function renderRawConfig() { $("cfg-json").value = JSON.stringify(cfgObj, null, 2); $("cfg-json-err").textContent = ""; }
function renderRawSecrets() { $("cfg-secrets").value = JSON.stringify(secretsObj, null, 2); $("cfg-secrets-err").textContent = ""; }

// Provider presets: pick one to fill the endpoint URL + reveal the right fields. All are
// OpenAI-compatible (/chat/completions + /models), which is what the app speaks.
const PROVIDERS = [
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", key: true },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", key: true },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", key: true },
  { id: "together", label: "Together AI", url: "https://api.together.xyz/v1", key: true },
  { id: "mistral", label: "Mistral", url: "https://api.mistral.ai/v1", key: true },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1", key: true },
  { id: "xai", label: "xAI (Grok)", url: "https://api.x.ai/v1", key: true },
  { id: "perplexity", label: "Perplexity", url: "https://api.perplexity.ai", key: true },
  { id: "gemini", label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", key: true },
  { id: "ollama", label: "Ollama (local)", url: "http://host.docker.internal:11434/v1", key: false },
  { id: "litellm", label: "LiteLLM gateway (this stack)", url: "http://jarvis-litellm:4000/v1", key: false },
  { id: "generic", label: "Generic (custom OpenAI-compatible)", url: "", key: "optional" },
];
function populateProviderSelect(current) {
  const sel = $("cfg-provider"); if (!sel) return;
  sel.innerHTML = "";
  for (const p of PROVIDERS) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
  if (current && !PROVIDERS.some((p) => p.id === current)) { const o = document.createElement("option"); o.value = current; o.textContent = current; sel.appendChild(o); }
}
// Show/hide fields for the selected provider (no value changes) — the "dynamic windows".
function syncProviderUI() {
  const p = PROVIDERS.find((x) => x.id === ($("cfg-provider") || {}).value);
  const showKey = !p || p.key !== false;                 // hide the key for keyless local endpoints
  const keyRow = $("cfg-row-apikey"); if (keyRow) keyRow.style.display = showKey ? "" : "none";
  const local = p && (p.id === "ollama" || p.id === "litellm");
  const oll = $("cfg-sec-ollama"); if (oll) oll.style.display = local ? "" : "none";  // host tuning only when using local Ollama
  syncModelMode();
}
// Show ONLY the single-model field OR the multi-tier grid, per the selected model mode.
function syncModelMode() {
  const mode = ($("cfg-model-mode") || {}).value || "single";
  const single = $("cfg-single-block"), multi = $("cfg-multi-block");
  if (single) single.style.display = mode === "single" ? "" : "none";
  if (multi) multi.style.display = mode === "multi" ? "" : "none";
}
// User picked a provider → fill the endpoint URL (presets) and refresh the UI.
function onProviderChange() {
  const p = PROVIDERS.find((x) => x.id === $("cfg-provider").value);
  if (p && p.id !== "generic" && p.url) $("cfg-base-url").value = p.url;
  syncProviderUI();
  collectStructured(); renderRawConfig();
  const st = $("cfg-models-status"); if (st) st.textContent = "";
}
// Query the entered endpoint for its models and load them into the model pickers' datalist.
async function listConfigModels() {
  const st = $("cfg-models-status"), btn = $("cfg-list-models");
  const base_url = ($("cfg-base-url").value || "").trim();
  const api_key = ($("cfg-api-key") ? $("cfg-api-key").value : "").trim();
  if (!base_url) { if (st) st.textContent = "Enter an endpoint URL first."; return; }
  if (btn) btn.disabled = true; if (st) st.textContent = "Listing…";
  try {
    const d = await (await fetch("/api/models/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_url, api_key }) })).json();
    modelOptions = (d.models || []).slice();
    // Fill every model dropdown, preserving each field's current selection.
    MODEL_SELECT_IDS.forEach((id) => { const sel = $(id); if (sel) renderModelSelect(sel, sel.value === MODEL_CUSTOM ? "" : sel.value); });
    if (st) st.textContent = modelOptions.length ? `${modelOptions.length} models loaded — open any model dropdown to pick one` : ("No models" + (d.error ? " — " + d.error : ""));
  } catch (e) { if (st) st.textContent = "Failed: " + e.message; }
  finally { if (btn) btn.disabled = false; }
}

// --- prompt library: active = /Prompts/default_{master,system}.prompt; saved sets = <name>_* ---
const pMaster = () => $("cfg-master-prompt"), pSystem = () => $("cfg-system-prompt");
async function loadActivePrompts() {   // fill the editor from the active (default) set
  try { const d = await (await fetch("/api/prompts/default")).json(); if (pMaster()) pMaster().value = d.master || ""; if (pSystem()) pSystem().value = d.system || ""; } catch (_) {}
}
async function renderPromptPresets() {   // list saved set names (excludes 'default')
  const sel = $("cfg-prompt-preset"); if (!sel) return;
  const cur = sel.value;
  let list = [];
  try { const d = await (await fetch("/api/prompts")).json(); list = d.prompts || []; } catch (_) {}
  sel.innerHTML = '<option value="">— saved prompt sets —</option>';
  list.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
  if (cur && list.includes(cur)) sel.value = cur;
}
(function initPromptLibrary() {
  const sel = $("cfg-prompt-preset");
  const saveActiveB = $("cfg-prompt-saveactive"), saveAsB = $("cfg-prompt-save"), loadB = $("cfg-prompt-load"), delB = $("cfg-prompt-del");
  const toast = (msg, ok) => { const r = $("cfg-result"); if (r) { r.className = "cfg-result " + (ok ? "ok" : "err"); r.textContent = msg; } };
  const body = () => JSON.stringify({ master: pMaster() ? pMaster().value : "", system: pSystem() ? pSystem().value : "" });
  const put = (name) => fetch("/api/prompts/" + encodeURIComponent(name), { method: "POST", headers: { "Content-Type": "application/json" }, body: body() }).then((r) => r.json());
  if (saveActiveB) saveActiveB.addEventListener("click", async () => {
    try { const d = await put("default"); if (d.error) return toast("Save failed: " + d.error, false); toast("Saved as ACTIVE — applies on the next turn (Prompts/default_*.prompt).", true); }
    catch (e) { toast("Save failed: " + e.message, false); }
  });
  if (saveAsB) saveAsB.addEventListener("click", async () => {
    const name = (prompt("Save this prompt set as (name):", "") || "").trim();
    if (!name || name.toLowerCase() === "default") return;
    try { const d = await put(name); if (d.error) return toast("Save failed: " + d.error, false); await renderPromptPresets(); if (sel) sel.value = name; toast(`Saved set "${name}" (Prompts/${name}_master.prompt + ${name}_system.prompt).`, true); }
    catch (e) { toast("Save failed: " + e.message, false); }
  });
  if (loadB) loadB.addEventListener("click", async () => {
    const name = sel && sel.value; if (!name) return;
    try { const p = await (await fetch("/api/prompts/" + encodeURIComponent(name))).json(); if (p.error) return toast("Load failed: " + p.error, false); if (pMaster()) pMaster().value = p.master || ""; if (pSystem()) pSystem().value = p.system || ""; toast(`Loaded "${name}" into the editor. Click “Save as active” to use it.`, true); }
    catch (e) { toast("Load failed: " + e.message, false); }
  });
  if (delB) delB.addEventListener("click", async () => {
    const name = sel && sel.value; if (!name) return;
    if (!confirm(`Delete the saved set "${name}" (both files)?`)) return;
    try { await fetch("/api/prompts/" + encodeURIComponent(name), { method: "DELETE" }); await renderPromptPresets(); toast(`Deleted "${name}".`, true); }
    catch (e) { toast("Delete failed: " + e.message, false); }
  });
})();

async function loadConfig() {
  const result = $("cfg-result"); if (result) result.textContent = "";
  let d;
  try { d = await (await fetch("/api/config/full")).json(); }
  catch (e) { $("cfg-json-err").textContent = "Failed to load config: " + e.message; return; }
  if (d.config_error) { $("cfg-json-err").textContent = "Config file error: " + d.config_error; }
  cfgObj = d.config && typeof d.config === "object" ? d.config : {};
  secretsObj = d.secrets && typeof d.secrets === "object" ? d.secrets : { secrets: {} };
  populateProviderSelect(getPath(cfgObj, "llm.provider"));
  populateStructured();
  syncProviderUI();
  renderPromptPresets();   // list saved prompt sets
  loadActivePrompts();     // fill the master/system editor from the active (default) set
  renderRawConfig();
  renderRawSecrets();
}

async function saveConfig() {
  const result = $("cfg-result");
  let config, secrets;
  try { config = JSON.parse($("cfg-json").value); }
  catch (e) { $("cfg-json-err").textContent = "Invalid JSON — fix before saving: " + e.message; return; }
  try { secrets = JSON.parse($("cfg-secrets").value); }
  catch (e) { $("cfg-secrets-err").textContent = "Invalid JSON — fix before saving: " + e.message; return; }
  const btn = $("cfg-save"); btn.disabled = true;
  try {
    const r = await fetch("/api/config/full", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, secrets }),
    });
    const d = await r.json();
    if (!r.ok) { result.className = "cfg-result err"; result.textContent = "Save failed: " + (d.error || r.status); return; }
    cfgObj = config; secretsObj = secrets; populateStructured();
    result.className = "cfg-result ok";
    const nb = (d.backups || []).length;
    result.innerHTML = "✅ Saved " + (d.saved || []).join(" + ") +
      (nb ? " (backed up " + nb + " file" + (nb > 1 ? "s" : "") + ")" : "") +
      ". Now run <code>./JARVIS.sh --reload</code> to apply (restarts the app" +
      (config.ollama && config.ollama.manage !== false ? " + Ollama" : "") + ").";
  } catch (e) {
    result.className = "cfg-result err"; result.textContent = "Save failed: " + e.message;
  } finally { btn.disabled = false; }
}

// Wiring
CFG_FIELDS.forEach(([id]) => { const el = $(id); if (el) el.addEventListener("change", () => { collectStructured(); renderRawConfig(); }); });
(() => { const s = $("cfg-provider"); if (s) s.addEventListener("change", onProviderChange); })();
(() => { const b = $("cfg-list-models"); if (b) b.addEventListener("click", listConfigModels); })();
(() => { const m = $("cfg-model-mode"); if (m) m.addEventListener("change", syncModelMode); })();
MODEL_SELECT_IDS.forEach((id) => { const s = $(id); if (s) s.addEventListener("change", onModelSelectChange); });
// Show/hide the API key so it can be read and edited (it's stored/sent in the clear anyway).
(() => {
  const btn = $("cfg-api-key-toggle"), inp = $("cfg-api-key");
  if (btn && inp) btn.addEventListener("click", () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "🙈 Hide" : "👁 Show";
  });
})();
(() => {
  const raw = $("cfg-json"); if (raw) raw.addEventListener("blur", () => {
    try { cfgObj = JSON.parse(raw.value); populateProviderSelect(getPath(cfgObj, "llm.provider")); populateStructured(); syncProviderUI(); $("cfg-json-err").textContent = ""; }
    catch (e) { $("cfg-json-err").textContent = "Invalid JSON: " + e.message; }
  });
  const sraw = $("cfg-secrets"); if (sraw) sraw.addEventListener("blur", () => {
    try { secretsObj = JSON.parse(sraw.value); $("cfg-secrets-err").textContent = ""; }
    catch (e) { $("cfg-secrets-err").textContent = "Invalid JSON: " + e.message; }
  });
  const reveal = $("cfg-secrets-reveal"); if (reveal) reveal.addEventListener("click", (e) => {
    e.preventDefault();
    const t = $("cfg-secrets"); const masked = t.classList.toggle("cfg-masked");
    reveal.textContent = masked ? "👁 Reveal" : "🙈 Hide";
  });
  const save = $("cfg-save"); if (save) save.addEventListener("click", saveConfig);
  const rel = $("cfg-reload-from-disk"); if (rel) rel.addEventListener("click", loadConfig);
})();
