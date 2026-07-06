"use strict";
// Task scheduler for JARVIS. Tasks are persisted to a JSON file (survives app
// restarts) and executed by the long-running server process, which polls for due
// tasks and runs each through the same tool-calling LLM loop. Supports one-shot
// (in_seconds / at) and recurring (every_seconds, with a natural-language `until`
// stop condition) tasks, plus user notifications.
//
// State is kept IN MEMORY as the single source of truth and persisted atomically
// (debounced), so concurrent mutations (the tick loop vs. tool-driven
// schedule/cancel/notify) never clobber each other via file read-modify-write races.
const persist = require("./persist");

const FILE = process.env.JARVIS_TASKS_FILE || "/data/tasks.json";
const MAX_CONCURRENT = 3; // how many scheduled tasks may run at once
let notifyCb = null, runCb = null, chatCb = null;

const state = (() => {
  const d = persist.readJson(FILE, {}) || {};
  return { tasks: Array.isArray(d.tasks) ? d.tasks : [], notifications: Array.isArray(d.notifications) ? d.notifications : [] };
})();

let saveTimer = null;
function save() {
  if (saveTimer) return;                     // debounce bursts of mutations
  saveTimer = setTimeout(() => { saveTimer = null; try { persist.writeJsonAtomic(FILE, state); } catch (_) {} }, 150);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { persist.writeJsonAtomic(FILE, state); } catch (_) {}
}
// Flush pending writes on shutdown so the last mutations aren't lost.
process.on("SIGTERM", saveNow); process.on("SIGINT", saveNow); process.on("beforeExit", saveNow);

function genId(p) { return (p || "t") + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }

function schedule(args) {
  const { prompt, in_seconds, at, every_seconds, until, label } = args || {};
  if (!prompt) throw new Error("prompt is required");
  const now = Date.now();
  let runAt;
  if (typeof every_seconds === "number" && every_seconds > 0) runAt = now + every_seconds * 1000;
  else if (typeof in_seconds === "number") runAt = now + Math.max(0, in_seconds) * 1000;
  else if (at) { const t = Date.parse(at); if (isNaN(t)) throw new Error("could not parse 'at' time: " + at); runAt = t; }
  else throw new Error("provide one of: in_seconds, at (ISO datetime), or every_seconds");
  const task = {
    id: genId("t"), label: label || "", prompt, type: every_seconds ? "recurring" : "once",
    run_at: runAt, every_seconds: every_seconds || null, until: until || null,
    status: "pending", created_at: now, runs: 0, last_run: null, last_result: null,
  };
  state.tasks.push(task); save();
  return { id: task.id, type: task.type, next_run: new Date(runAt).toISOString(), every_seconds: task.every_seconds, until: task.until || undefined };
}

function list() {
  return state.tasks.filter((t) => t.status === "pending" || t.status === "running").map((t) => ({
    id: t.id, label: t.label, type: t.type, prompt: (t.prompt || "").slice(0, 140),
    next_run: new Date(t.run_at).toISOString(), every_seconds: t.every_seconds, until: t.until, status: t.status, runs: t.runs,
    last_run: t.last_run ? new Date(t.last_run).toISOString() : null,
    last_result: (t.last_result || "").slice(0, 400),
  }));
}

function cancel(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return { id, cancelled: false, error: "not found" };
  t.status = "cancelled"; save();
  return { id, cancelled: true };
}

// Update an EXISTING task in place (so it keeps running) instead of cancel+recreate.
function update(args) {
  const { id } = args || {};
  if (!id) throw new Error("id is required (get it from list_tasks)");
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return { id, updated: false, error: "not found" };
  if (t.status === "cancelled" || t.status === "done") return { id, updated: false, error: `task is ${t.status}, not active — schedule a new one instead` };
  if (typeof args.prompt === "string" && args.prompt.trim()) t.prompt = args.prompt;
  if (typeof args.label === "string") t.label = args.label;
  if ("until" in args) t.until = args.until || null;
  if (typeof args.every_seconds === "number" && args.every_seconds > 0) { t.every_seconds = args.every_seconds; t.type = "recurring"; }
  // Optional re-timing of the next run; otherwise the existing schedule is kept.
  if (typeof args.in_seconds === "number") t.run_at = Date.now() + Math.max(0, args.in_seconds) * 1000;
  else if (args.at) { const tt = Date.parse(args.at); if (isNaN(tt)) throw new Error("could not parse 'at' time: " + args.at); t.run_at = tt; }
  if (t.status !== "running") t.status = "pending"; // keep it active (don't disturb an in-flight run)
  save();
  return { id, updated: true, type: t.type, label: t.label, prompt: (t.prompt || "").slice(0, 140), every_seconds: t.every_seconds, until: t.until, next_run: new Date(t.run_at).toISOString() };
}

function pushNotification(n) {
  const note = { id: genId("n"), at: Date.now(), level: (n && n.level) || "info", message: (n && n.message) || "", task_id: (n && n.task_id) || null, label: (n && n.label) || null };
  state.notifications.push(note);
  if (state.notifications.length > 300) state.notifications = state.notifications.slice(-300);
  save();
  if (notifyCb) { try { notifyCb(note); } catch (_) {} }
  // Best-effort toast on the watchable workbench desktop (needs libnotify-bin).
  try {
    const safe = String(note.message || "").replace(/[\\$`"]/g, "").slice(0, 300);
    require("./tools").runShell(`notify-send "JARVIS" "${safe}" 2>/dev/null || true`).catch(() => {});
  } catch (_) {}
  return { notified: true, id: note.id };
}
function recentNotifications(limit) { return state.notifications.slice(-(limit || 50)); }
function clearNotifications() { state.notifications = []; saveNow(); return { cleared: true }; }
function dismissNotification(id) {
  const before = state.notifications.length;
  state.notifications = state.notifications.filter((n) => n.id !== id);
  saveNow();
  return { dismissed: before !== state.notifications.length };
}
function setNotifyCallback(cb) { notifyCb = cb; }
function setRunCallback(cb) { runCb = cb; }
function setChatCallback(cb) { chatCb = cb; }
// Post a message into the user's live chat conversation window.
function postToChat(message) {
  const m = String(message == null ? "" : message);
  if (chatCb) { try { chatCb(m); } catch (_) {} }
  try { require("./chatlog").record("task", m); } catch (_) {}
  return { posted: true };
}

async function runTask(task) {
  const llm = require("./llm");
  const isRecurring = task.type === "recurring";
  const name = require("./config").assistantName();
  let sys = `You are ${name} performing a SCHEDULED background task. Use your tools to do it. This is ONE execution of an already-scheduled task — do NOT create, schedule, modify, or cancel any tasks (the repetition is handled for you by the scheduler). Just perform the task's action this once. Phrases like "every 5 minutes" describe the schedule that already exists; they are NOT an instruction to schedule anything. `;
  if (isRecurring) {
    sys += `This runs on a repeating schedule. STOP CONDITION: ${task.until || "(only when the user cancels)"}. ` +
      "Check whether the stop condition is met. If it IS met, call notify_user with the important details — that will stop the recurring task. " +
      "If it is NOT met, do NOT call notify_user; just end with a one-line status.";
  } else {
    sys += "When finished, call notify_user with a concise summary of the result so the user is informed.";
  }
  sys += " Based on what you find, take whatever actions are appropriate using your tools. OUTPUT DESTINATIONS — send results wherever the task asks (default to what the user's instructions say): post_to_chat(message) writes a message straight into the user's LIVE CHAT conversation window (use this whenever the task should show its output in the chat / talk to the user); notify_user(message) is a passive alert/badge (and it STOPS a recurring task, so only use it as the stop signal or for one-shots); append_log/write_file to /READ_WRITE_FILES is a persistent file/log. You can combine them (e.g. log to a file AND post_to_chat). If the user asked for the result in the conversation, you MUST call post_to_chat — do not just put it in your final text (that goes only to the task record, not the chat).";
  sys += " SEEING THE CONVERSATION: this run has no chat history in context, but you can call read_recent_chat to look at recent messages — use roles:[\"user\"] to check whether the user has replied lately (to decide whether to escalate/deescalate an unanswered prompt), and review your own recent role:\"task\" posts to avoid repeating yourself.";
  sys += " HONESTY IS CRITICAL: report only what your tools actually returned. If a tool errors or returns empty/no data, say so plainly and do NOT invent values or claim success. Always VERIFY side effects — after writing to a file, read it back to confirm the new content is there. If this task LOGS to a file on a schedule, use append_log(path, message) so every entry has the SAME format (uniform timestamp, one line, never run together) — do not hand-format timestamps or vary the wording between runs. (append_log writes to the read-write shared folder; for the workbench /workspace use run_shell with `>>`, and write_file overwrites unless you pass append=true.)";
  let notified = false, hadError = false;
  const toolStats = {};
  const data = { ok: 0, empty: 0 }; // did data-producing tools actually return content?
  const emit = (ev) => {
    if (ev.type === "tool") {
      if (ev.tool === "notify_user") notified = true;
      toolStats[ev.tool] = toolStats[ev.tool] || { ok: 0, err: 0 };
    } else if (ev.type === "tool_result") {
      const st = (toolStats[ev.tool] = toolStats[ev.tool] || { ok: 0, err: 0 });
      const errored = typeof ev.output === "string" && /"error"\s*:/.test(ev.output);
      errored ? st.err++ : st.ok++;
      if (!errored && (ev.tool === "run_shell" || ev.tool === "fetch_url" || ev.tool === "web_search")) {
        let empty = false;
        try {
          const o = JSON.parse(ev.output);
          const body = o.output != null ? o.output : (o.content != null ? o.content : null);
          if (typeof body === "string" && body.trim() === "") empty = true;
          if (Array.isArray(o.results) && o.results.length === 0) empty = true;
        } catch (_) {}
        empty ? data.empty++ : data.ok++;
      }
    }
  };
  let result = "";
  try {
    result = await llm.chat({ messages: [{ role: "system", content: sys }, { role: "user", content: task.prompt }], emit, tier: "cheap", excludeTools: ["schedule_task", "update_task", "cancel_task"] });
  } catch (e) {
    hadError = true;
    result = "error: " + e.message;
    pushNotification({ task_id: task.id, label: task.label, level: "error", message: `Scheduled task failed: ${e.message}` });
  }
  // Ground-truth note appended to the result so a fabricated "success" is visible:
  // it shows which tools ACTUALLY ran (✓ ok / ✗ errored), or that none did.
  const usedTools = Object.entries(toolStats)
    .map(([n, s]) => `${n}${s.err ? "✗" : "✓"}${(s.ok + s.err) > 1 ? "×" + (s.ok + s.err) : ""}`).join(", ");
  // "no effective result": the run accomplished nothing useful — no tools ran, every
  // tool errored, or data-producing tools returned empty (e.g. a dead API / wrong cmd).
  const totalCalls = Object.values(toolStats).reduce((n, s) => n + s.ok + s.err, 0);
  const totalOk = Object.values(toolStats).reduce((n, s) => n + s.ok, 0);
  const noEffect = !hadError && !notified &&
    (totalCalls === 0 || totalOk === 0 || (data.ok === 0 && data.empty > 0));
  result = (result || "") + "\n[tools: " + (usedTools || "none — text-only reply, nothing was actually done") + (noEffect ? " | ⚠ no effective result" : "") + "]";

  const t = state.tasks.find((x) => x.id === task.id);
  if (!t || t.status === "cancelled") { return; } // user cancelled mid-run
  t.runs++; t.last_run = Date.now(); t.last_result = (result || "").slice(0, 2000);
  // Alert the user when a RECURRING task runs but does nothing useful — once, until it
  // recovers (a one-shot already notifies on completion with the ⚠ in its result, so
  // the standalone warning is only needed for recurring tasks that otherwise stay quiet).
  if (noEffect && isRecurring) {
    if (!t.warned_ineffective) {
      t.warned_ineffective = true;
      pushNotification({ task_id: t.id, label: t.label, level: "warning", message: `Recurring task${t.label ? ` "${t.label}"` : ""} ran but produced NO effective result (no successful action/data). It may be misconfigured — a dead API, wrong command, or nothing to do. Check the task.` });
    }
  } else if (!noEffect && t.warned_ineffective) {
    t.warned_ineffective = false; // recovered
  }
  // Report every run (even when no notification fires) so it's visible.
  if (runCb) { try { runCb({ id: t.id, label: t.label, type: t.type, ran_at: t.last_run, runs: t.runs, result: (result || "").slice(0, 1200), notified, flag: noEffect ? "no-effect" : null }); } catch (_) {} }
  if (!isRecurring) {
    t.status = "done";
    if (!notified) pushNotification({ task_id: t.id, label: t.label, level: noEffect ? "warning" : "info", message: `Scheduled task ${noEffect ? "ran but produced NO effective result" : "done"}${t.label ? ` (${t.label})` : ""}:\n${t.last_result}` });
  } else if (notified) {
    t.status = "done"; // condition met -> stop the recurring task
  } else {
    // Advance from the SCHEDULED slot (not `now`) so the cadence doesn't drift after a
    // slow run; if we fell multiple periods behind, collapse the misses into one next run.
    const step = t.every_seconds * 1000;
    t.run_at = (t.run_at || Date.now()) + step;
    while (t.run_at <= Date.now()) t.run_at += step;
    t.status = "pending";
    if (t.runs >= 5000) { t.status = "done"; pushNotification({ task_id: t.id, label: t.label, level: "info", message: `Recurring task${t.label ? ` "${t.label}"` : ""} hit its 5000-run safety cap and was stopped.` }); }
  }
  save();
}

// The set of task ids currently executing, so the tick loop never double-launches a
// task that's still running (runs are fire-and-forget so a slow one can't block others).
const inflight = new Set();
function tick() {
  const now = Date.now();
  const due = state.tasks.filter((t) => t.status === "pending" && t.run_at <= now);
  for (const t of due) {
    if (inflight.size >= MAX_CONCURRENT) break;   // rest wait for the next tick
    if (inflight.has(t.id)) continue;
    t.status = "running"; inflight.add(t.id); save();
    runTask(t)
      .catch(() => {})
      .finally(() => {
        inflight.delete(t.id);
        // Safety net: if runTask left it stuck "running" (unexpected throw), requeue it.
        if (t.status === "running") { t.status = "pending"; save(); }
      });
  }
}
function start() {
  // Crash recovery: any task left "running" from a previous process was interrupted —
  // requeue it as pending so it runs again on the next tick.
  let recovered = 0;
  for (const t of state.tasks) { if (t.status === "running") { t.status = "pending"; recovered++; } }
  if (recovered) saveNow();
  const h = setInterval(tick, 5000);
  if (h.unref) h.unref();
}

module.exports = { schedule, update, list, cancel, pushNotification, recentNotifications, clearNotifications, dismissNotification, postToChat, setNotifyCallback, setRunCallback, setChatCallback, start };
