"use strict";
// Task scheduler for JARVIS. Tasks are persisted to a JSON file (survives app
// restarts) and executed by the long-running server process, which polls for due
// tasks and runs each through the same tool-calling LLM loop. Supports one-shot
// (in_seconds / at) and recurring (every_seconds, with a natural-language `until`
// stop condition) tasks, plus user notifications.
const fs = require("fs");
const path = require("path");

const FILE = process.env.JARVIS_TASKS_FILE || "/data/tasks.json";
let notifyCb = null;
let runCb = null;
let chatCb = null;

function read() {
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); return { tasks: d.tasks || [], notifications: d.notifications || [] }; }
  catch (_) { return { tasks: [], notifications: [] }; }
}
function write(state) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
  catch (_) {}
}
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
  const s = read();
  const task = {
    id: genId("t"), label: label || "", prompt, type: every_seconds ? "recurring" : "once",
    run_at: runAt, every_seconds: every_seconds || null, until: until || null,
    status: "pending", created_at: now, runs: 0, last_run: null, last_result: null,
  };
  s.tasks.push(task); write(s);
  return { id: task.id, type: task.type, next_run: new Date(runAt).toISOString(), every_seconds: task.every_seconds, until: task.until || undefined };
}

function list() {
  return read().tasks.filter((t) => t.status === "pending" || t.status === "running").map((t) => ({
    id: t.id, label: t.label, type: t.type, prompt: (t.prompt || "").slice(0, 140),
    next_run: new Date(t.run_at).toISOString(), every_seconds: t.every_seconds, until: t.until, status: t.status, runs: t.runs,
    last_run: t.last_run ? new Date(t.last_run).toISOString() : null,
    last_result: (t.last_result || "").slice(0, 400),
  }));
}

function cancel(id) {
  const s = read();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return { id, cancelled: false, error: "not found" };
  t.status = "cancelled"; write(s);
  return { id, cancelled: true };
}

// Update an EXISTING task in place (so it keeps running) instead of cancel+recreate.
function update(args) {
  const { id } = args || {};
  if (!id) throw new Error("id is required (get it from list_tasks)");
  const s = read();
  const t = s.tasks.find((x) => x.id === id);
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
  write(s);
  return { id, updated: true, type: t.type, label: t.label, prompt: (t.prompt || "").slice(0, 140), every_seconds: t.every_seconds, until: t.until, next_run: new Date(t.run_at).toISOString() };
}

function pushNotification(n) {
  const s = read();
  const note = { id: genId("n"), at: Date.now(), level: (n && n.level) || "info", message: (n && n.message) || "", task_id: (n && n.task_id) || null, label: (n && n.label) || null };
  s.notifications.push(note);
  if (s.notifications.length > 300) s.notifications = s.notifications.slice(-300);
  write(s);
  if (notifyCb) { try { notifyCb(note); } catch (_) {} }
  // Best-effort toast on the watchable workbench desktop (needs libnotify-bin).
  try {
    const safe = String(note.message || "").replace(/[\\$`"]/g, "").slice(0, 300);
    require("./tools").runShell(`notify-send "JARVIS" "${safe}" 2>/dev/null || true`).catch(() => {});
  } catch (_) {}
  return { notified: true, id: note.id };
}
function recentNotifications(limit) { return read().notifications.slice(-(limit || 50)); }
function setNotifyCallback(cb) { notifyCb = cb; }
function setRunCallback(cb) { runCb = cb; }
function setChatCallback(cb) { chatCb = cb; }
// Post a message into the user's live chat conversation window.
function postToChat(message) {
  const m = String(message == null ? "" : message);
  if (chatCb) { try { chatCb(m); } catch (_) {} }
  return { posted: true };
}

async function runTask(task) {
  const llm = require("./llm");
  const isRecurring = task.type === "recurring";
  const name = require("./config").assistantName();
  let sys = `You are ${name} performing a SCHEDULED background task. Use your tools to do it. `;
  if (isRecurring) {
    sys += `This runs on a repeating schedule. STOP CONDITION: ${task.until || "(only when the user cancels)"}. ` +
      "Check whether the stop condition is met. If it IS met, call notify_user with the important details — that will stop the recurring task. " +
      "If it is NOT met, do NOT call notify_user; just end with a one-line status.";
  } else {
    sys += "When finished, call notify_user with a concise summary of the result so the user is informed.";
  }
  sys += " Based on what you find, take whatever actions are appropriate using your tools. OUTPUT DESTINATIONS — send results wherever the task asks (default to what the user's instructions say): post_to_chat(message) writes a message straight into the user's LIVE CHAT conversation window (use this whenever the task should show its output in the chat / talk to the user); notify_user(message) is a passive alert/badge (and it STOPS a recurring task, so only use it as the stop signal or for one-shots); append_log/write_file to /READ_WRITE_FILES is a persistent file/log. You can combine them (e.g. log to a file AND post_to_chat). If the user asked for the result in the conversation, you MUST call post_to_chat — do not just put it in your final text (that goes only to the task record, not the chat).";
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
    result = await llm.chat({ messages: [{ role: "system", content: sys }, { role: "user", content: task.prompt }], emit, tier: "cheap" });
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

  const s = read();
  const t = s.tasks.find((x) => x.id === task.id);
  if (!t || t.status === "cancelled") { return; } // user cancelled mid-run
  t.runs++; t.last_run = Date.now(); t.last_result = (result || "").slice(0, 2000);
  // Alert the user when a RECURRING task runs but does nothing useful — once, until it
  // recovers (a one-shot already notifies on completion with the ⚠ in its result, so
  // the standalone warning is only needed for recurring tasks that otherwise stay quiet).
  if (noEffect && isRecurring) {
    if (!t.warned_ineffective) {
      t.warned_ineffective = true;
      pushNotification({ task_id: t.id, label: t.label, level: "warn", message: `Recurring task${t.label ? ` "${t.label}"` : ""} ran but produced NO effective result (no successful action/data). It may be misconfigured — a dead API, wrong command, or nothing to do. Check the task.` });
    }
  } else if (!noEffect && t.warned_ineffective) {
    t.warned_ineffective = false; // recovered
  }
  // Report every run (even when no notification fires) so it's visible.
  if (runCb) { try { runCb({ id: t.id, label: t.label, type: t.type, ran_at: t.last_run, runs: t.runs, result: (result || "").slice(0, 1200), notified, flag: noEffect ? "no-effect" : null }); } catch (_) {} }
  if (!isRecurring) {
    t.status = "done";
    write(s);
    if (!notified) pushNotification({ task_id: t.id, label: t.label, level: noEffect ? "warn" : "info", message: `Scheduled task ${noEffect ? "ran but produced NO effective result" : "done"}${t.label ? ` (${t.label})` : ""}:\n${t.last_result}` });
  } else if (notified) {
    t.status = "done"; // condition met -> stop the recurring task
    write(s);
  } else {
    t.status = "pending"; t.run_at = Date.now() + t.every_seconds * 1000; // schedule next run
    if (t.runs >= 5000) t.status = "done"; // safety cap
    write(s);
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = read();
    const now = Date.now();
    let changed = false;
    for (const t of s.tasks) {
      if (t.status === "pending" && t.run_at <= now) { t.status = "running"; changed = true; }
    }
    if (changed) write(s);
    const due = read().tasks.filter((t) => t.status === "running");
    for (const t of due) { await runTask(t); }
  } catch (_) {} finally { ticking = false; }
}
function start() { setInterval(tick, 8000); }

module.exports = { schedule, update, list, cancel, pushNotification, recentNotifications, postToChat, setNotifyCallback, setRunCallback, setChatCallback, start };
