"use strict";
// Autopilot: run a large objective AUTONOMOUSLY, unattended. You give an objective + a time
// budget; JARVIS drafts a plan (the Planner ledger) and then drives it in back-to-back
// cycles — build → test → refine → fix — until the objective is complete, the time budget
// is reached, it gets stuck, or you stop it. It runs SERVER-SIDE (like scheduled tasks), so
// you can close the tab and walk away; it notifies you when it finishes. The Planner ledger
// is the memory that lets each cycle resume correctly.
const config = require("./config");
const planner = require("./planner");

// In "guarded" autonomy we also withhold the dedicated irreversible/external tools (belt +
// braces on top of the safe-mode instruction). run_shell can't be withheld — Autopilot needs
// it to build/test — so guarded mode is best-effort, backed by the instruction.
const RISKY_TOOLS = ["send_email", "delete_memory", "set_secret", "delete_secret"];
// A cycle counts as "productive" (resets the anti-thrash counter) if it calls ANY tool other
// than these read-only / bookkeeping ones — so research (web_search/fetch/browser), serving,
// editing, etc. all count as progress, not just file writes.
const NONPRODUCTIVE_TOOLS = new Set(["read_file", "list_dir", "read_document", "search_memory", "list_memories", "list_secrets", "list_tasks", "plan_show", "plan_update", "plan_create", "plan_add_step", "plan_clear"]);
const persist = require("./persist");
const FILE = process.env.JARVIS_AUTOPILOT_FILE || "/data/autopilot.json";

let broadcast = () => {};
function setBroadcast(fn) { broadcast = typeof fn === "function" ? fn : () => {}; }

let run = null;   // the single active run (null when idle)
let ac = null;    // AbortController for the in-flight cycle

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Persist the run so a long unattended session survives an app restart/crash and auto-resumes
// (the marquee "kick it off and walk away" promise — otherwise the in-memory loop dies silently).
function save() { try { if (run) persist.writeJsonAtomic(FILE, run, true); else require("fs").rmSync(FILE, { force: true }); } catch (_) {} }

const ENDED_STATES = ["done", "budget", "stopped", "stuck", "error"];
function status() {
  if (!run) return { active: false, status: "idle" };
  const ended = ENDED_STATES.includes(run.status);
  return {
    active: ["running", "stopping", "pausing", "paused"].includes(run.status),
    paused: run.status === "paused" || run.status === "pausing",
    ended,
    resumable: ended && run.status !== "done",   // finished incomplete -> can Continue on the existing plan
    id: run.id, objective: run.objective, autonomy: run.autonomy,
    status: run.status, cycles: run.cycles, minutes: run.minutes,
    seconds_left: ended ? 0 : (run.status === "paused" ? Math.round((run.pausedRemaining || 0) / 1000) : Math.max(0, Math.round((run.deadline - nowMs()) / 1000))),
    tokens: run.tokens || 0, cost_usd: +(run.cost || 0).toFixed(4),
    started_at: run.startedAt,
  };
}
function emitStatus() { save(); try { broadcast({ type: "autopilot", status: status() }); } catch (_) {} }

// Called once on server startup — resume a run that was in flight, or re-show a run that had
// ENDED (so its banner + plan are still there to Continue/Modify after a restart).
function restore() {
  if (run) return;
  let saved; try { saved = persist.readJson(FILE, null); } catch (_) { saved = null; }
  if (!saved || !saved.status) return;
  run = saved; ac = null;
  if (ENDED_STATES.includes(run.status)) { run.ended = true; emitStatus(); return; }   // keep the ended banner; don't resume the loop
  if (run.status === "paused") { emitStatus(); return; }   // stay paused; the user resumes
  run.pauseRequested = false; run.status = "running";       // was running/pausing/stopping -> continue
  emitStatus();
  startLoop();
}

function start({ objective, minutes, autonomy, verbose }) {
  if (run && !run.ended) throw new Error("an Autopilot run is already active (running or paused) — stop it first");   // an ENDED run can be replaced by a new objective
  objective = String(objective || "").trim();
  if (!objective) throw new Error("Autopilot needs an objective");
  const ap = (config.config && config.config.autopilot) || {};
  const minutesN = Math.max(1, Math.min(Number(minutes) || Number(ap.default_minutes) || 30, 720)); // cap 12h
  const mode = ((autonomy || ap.autonomy || "guarded") === "full") ? "full" : "guarded";
  const maxCycles = Math.max(1, Number(ap.max_cycles) || 100);
  try { planner.clear(); } catch (_) {}   // a NEW objective starts fresh — never inherit a stale plan from a previous task
  run = {
    id: "ap_" + nowMs().toString(36), objective, autonomy: mode, minutes: minutesN,
    deadline: nowMs() + minutesN * 60000, maxCycles, cycles: 0, noProgress: 0, errors: 0,
    status: "running", startedAt: new Date().toISOString(), wrapUp: false, budgetHit: false, hardStop: false,
    pauseRequested: false, objectiveChanged: false, lastSummary: "", idleWork: 0, tokens: 0, cost: 0, verbose: !!verbose,
  };
  emitStatus();
  startLoop();
  return status();
}

function startLoop() { loop().catch((e) => finish("error", `crashed: ${e && e.message ? e.message : e}`, null)); }

function requestWrapUp() {
  if (!run) return status();
  if (run.status === "running") { run.wrapUp = true; run.status = "stopping"; emitStatus(); }
  else if (run.status === "paused") { run.wrapUp = true; run.status = "running"; emitStatus(); startLoop(); }  // resume to run the final wrap-up cycle
  return status();
}
function requestStop() {
  if (!run) return status();
  if (run.status === "paused") finish("stopped", `stopped while paused after ${run.cycles} cycle(s).`, null);
  else { run.hardStop = true; run.status = "stopping"; if (ac) { try { ac.abort(); } catch (_) {} } emitStatus(); }
  return status();
}
// Forced stop: don't wait for the current cycle to unwind. End the run NOW (bar flips to the
// ended state immediately), abort the in-flight call, and kill anything the run left running in
// the workbench (preview servers on the 9101-9150 range). Used when a plain Stop is wedged on a
// step that won't quit. The loop's post-cycle guard makes the orphaned cycle a no-op.
function forceStop() {
  if (!run) return status();
  if (run.ended) return status();
  run.hardStop = true;
  if (ac) { try { ac.abort(); } catch (_) {} }
  ac = null;
  try { require("./tools").killWorkbenchJobs(); } catch (_) {}   // fire-and-forget cleanup
  finish("stopped", `force-stopped after ${run.cycles} cycle(s).`, null);
  return status();
}
// Pause: stop starting new cycles but keep the run alive so it can be resumed. Aborts the
// in-flight cycle for responsiveness (the plan ledger + workbench files are the memory, so
// nothing is lost — resume re-cycles from where the ledger stands).
function pause() {
  if (run && run.status === "running") {
    run.pauseRequested = true; run.status = "pausing";
    run.pausedRemaining = Math.max(0, run.deadline - nowMs());   // freeze the time budget while paused
    if (ac) { try { ac.abort(); } catch (_) {} }
    emitStatus();
  }
  return status();
}
function resume() {
  if (run && run.status === "paused") {
    run.deadline = nowMs() + (run.pausedRemaining || run.minutes * 60000);   // restore the frozen budget
    run.pausedRemaining = 0; run.status = "running"; run.pauseRequested = false;
    emitStatus(); startLoop();
  }
  return status();
}
// Modify the objective mid-run — the next cycle is told to re-check its plan against it.
function modify({ objective }) {
  if (run && objective && String(objective).trim()) { run.objective = String(objective).trim(); run.objectiveChanged = true; emitStatus(); }
  return status();
}
// Extend the time budget (and rescue a run that was about to stop on the budget).
function extend({ minutes }) {
  if (run) {
    const add = Math.max(1, Math.min(Number(minutes) || 15, 720));
    run.deadline += add * 60000; run.minutes += add;
    if (run.budgetHit) { run.budgetHit = false; run.wrapUp = false; if (run.status === "stopping" && !run.hardStop) run.status = "running"; }
    emitStatus();
  }
  return status();
}

function finish(state, message, summary) {
  if (!run || run.ended) return;   // idempotent: a force-stop may end the run before the orphaned cycle unwinds
  const label = run.objective;
  run.status = state;   // done | budget | stopped | stuck | error
  run.ended = true; run.lastMessage = message; ac = null;
  emitStatus();   // KEEP the run (banner persists in the ended state; the plan is untouched so you can Continue/Modify)
  try {
    const sched = require("./scheduler");
    if (summary && summary.trim()) sched.postToChat(summary.trim());
    const level = (state === "error" || state === "stuck") ? "warning" : "info";
    const verb = { done: "finished ✅", budget: "hit its time budget ⏱", stopped: "stopped ⏹", stuck: "got stuck ⚠️", error: "errored ⚠️" }[state] || state;
    const tail = state !== "done" ? " (Continue it from the Autopilot bar to keep going on the same plan.)" : "";
    sched.pushNotification({ level, label: "Autopilot", message: `Autopilot ${verb}: ${message}\nObjective: ${label}${tail}` });
  } catch (_) {}
}

// Continue an ENDED-but-incomplete run on the SAME plan (no rebuild): fresh budget, reset the
// stuck/error counters, resume the loop. The model picks up from the plan's first incomplete step.
function continueRun({ minutes } = {}) {
  if (!run || !run.ended || run.status === "done") return status();
  const add = Math.max(1, Math.min(Number(minutes) || run.minutes || 15, 720));
  run.deadline = nowMs() + add * 60000; run.minutes = add;
  run.noProgress = 0; run.errors = 0; run.idleWork = 0;
  run.wrapUp = false; run.budgetHit = false; run.hardStop = false; run.pauseRequested = false;
  run.ended = false; run.status = "running";
  emitStatus(); startLoop();
  return status();
}
// Dismiss an ended run (clear the banner). Leaves the plan in place so you can still use it in chat.
function dismiss() {
  if (run && run.ended) { run = null; ac = null; try { require("fs").rmSync(FILE, { force: true }); } catch (_) {} try { broadcast({ type: "autopilot", status: { active: false, status: "idle" } }); } catch (_) {} }
  return status();
}

function guardClause(mode) {
  return mode === "guarded"
    ? " SAFE MODE: do NOT take irreversible EXTERNAL actions on your own — no sending email/messages, posting online, purchases, or deleting/overwriting the user's files outside /workspace. If a step truly needs one, mark it blocked (plan_update status=blocked with a note) and continue with the rest; the user will handle it. Building and testing in /workspace is unrestricted."
    : " FULL AUTONOMY: take whatever actions the objective genuinely requires.";
}

async function loop() {
  const llm = require("./llm");
  while (run) {
    if (run.hardStop) return finish("stopped", `hard-stopped after ${run.cycles} cycle(s).`, null);
    if (run.pauseRequested) { run.status = "paused"; run.pauseRequested = false; ac = null; emitStatus(); return; }  // keep run alive
    if (!run.wrapUp && (nowMs() >= run.deadline || run.cycles >= run.maxCycles)) { run.wrapUp = true; run.budgetHit = true; run.status = "stopping"; emitStatus(); }

    const before = planner.get();
    const doneBefore = before ? before.steps.filter((s) => s.status === "done").length : 0;
    const guard = guardClause(run.autonomy);
    // Cross-cycle continuity (fixes the observed "re-read the same file every cycle" loop):
    const recap = run.lastSummary ? ` Last cycle you reported: "${run.lastSummary.slice(0, 400)}". Continue FROM there — do NOT re-read files or re-plan things you already did unless they changed.` : "";
    // Anti-thrash: if recent cycles only read/planned without writing code, push hard to act.
    const pushWrite = run.idleWork >= 2 ? " ⚠ You have spent multiple cycles only READING/PLANNING without changing any files. STOP re-reading. Make the concrete code change NOW with write_workbench_file (or run_shell), then run/test it — do not just describe what you'll do." : "";
    const objChange = run.objectiveChanged ? ` NOTE: the objective was just UPDATED to «${run.objective}». Re-check your plan against it and adjust steps (add/remove) before continuing.` : "";

    let instr;
    if (run.wrapUp) {
      instr = `[AUTOPILOT — WRAP UP] Stop starting new work. If a step is nearly done, finish it; otherwise stop now. Then give a concise FINAL SUMMARY: what is complete, what remains, and where the deliverables are. ${run.budgetHit ? "(The time budget was reached.)" : "(The user asked to wrap up for review.)"}`;
    } else if (!before) {
      instr = `[AUTOPILOT] You are running AUTONOMOUSLY — the user is AWAY and cannot answer questions. Objective: «${run.objective}». Start now: call plan_create with a concrete, ordered plan (make reasonable assumptions where anything is unclear and note them — do NOT ask the user or wait), then begin executing it: build, run, and TEST your work, fix failures, refine, and keep the plan ledger up to date with plan_update.${guard}`;
    } else {
      instr = `[AUTOPILOT] Continue AUTONOMOUSLY (the user is away — do not ask questions; make reasonable decisions). Work your active plan: do the next incomplete step(s), test what you build, fix issues, refine, and update the ledger as you go.${objChange}${recap}${pushWrite}${guard}`;
    }
    run.objectiveChanged = false;

    ac = new AbortController();
    const messages = [{ role: "system", content: config.systemPrompt() }, { role: "user", content: instr }];
    try { broadcast({ type: "tool", tool: `🛫 Autopilot — cycle ${run.cycles + 1}${run.wrapUp ? " (wrap-up)" : ""}`, input: run.objective }); } catch (_) {}   // cycle marker in Activity
    // Stream tool activity/usage to open clients; also detect whether this cycle actually
    // WROTE anything (vs. just reading/planning) to drive the anti-thrash push above,
    // and tally tokens/cost across the whole run.
    let didWork = false;
    const emit = (ev) => {
      if (!ev) return;
      if (ev.type === "tool" && ev.tool && !NONPRODUCTIVE_TOOLS.has(ev.tool)) didWork = true;
      if (ev.type === "usage") { run.tokens += (ev.usage && ev.usage.total_tokens) || 0; run.cost += Number(ev.cost_usd) || 0; }
      // Always stream tool activity + usage; in VERBOSE mode also stream the model's live
      // thinking + tokens to the chat so you can watch what it's doing.
      const base = ev.type === "tool" || ev.type === "tool_result" || ev.type === "usage";
      const think = run.verbose && (ev.type === "reasoning" || ev.type === "token");
      if (base || think) { try { broadcast(ev); } catch (_) {} }
    };

    let reply = "";
    try {
      reply = await llm.chat({ messages, emit, signal: ac.signal, watchdog: false,
        excludeTools: run.autonomy === "guarded" ? RISKY_TOOLS : [] });
    } catch (e) {
      if (run && run.pauseRequested) { run.status = "paused"; run.pauseRequested = false; ac = null; emitStatus(); return; }  // paused mid-cycle
      if (!run || run.hardStop || (ac && ac.signal.aborted)) return finish("stopped", `hard-stopped after ${run.cycles} cycle(s).`, null);
      run.errors++;
      if (run.errors >= 3) return finish("error", `repeated errors (last: ${e && e.message ? e.message : e}).`, null);
      await sleep(1500);
      continue;
    }
    if (!run || run.ended) return;   // a force-stop ended the run while this cycle was in flight — drop its result silently
    run.cycles++;
    run.errors = 0;   // a successful cycle clears the transient-error counter (don't let sporadic errors accumulate across a long run)
    run.lastSummary = (reply || "").replace(/\s+/g, " ").trim();
    run.idleWork = didWork ? 0 : run.idleWork + 1;
    // Verbose: finalize this cycle's streamed thinking as an (ephemeral) chat message so cycles
    // are separated. ephemeral = shown but not added to your chat's model-context history.
    if (run.verbose && reply && reply.trim()) { try { broadcast({ type: "reply", text: reply, ephemeral: true }); } catch (_) {} }
    emitStatus();

    // Prefer reporting genuine completion even if the budget was also reached this cycle.
    const after = planner.get();
    if (after && after.status === "complete") return finish("done", `objective complete after ${run.cycles} cycle(s).`, reply);
    if (run.wrapUp) return finish(run.budgetHit ? "budget" : "stopped",
      run.budgetHit ? `time budget reached after ${run.cycles} cycle(s).` : `wrapped up after ${run.cycles} cycle(s).`, reply);
    const doneAfter = after ? after.steps.filter((s) => s.status === "done").length : 0;
    run.noProgress = (after && doneAfter <= doneBefore && before) ? run.noProgress + 1 : 0;
    if (run.noProgress >= 5) return finish("stuck", `no plan progress for ${run.noProgress} cycles — paused for your review.`, reply);

    await sleep(300);
  }
}

module.exports = { start, requestWrapUp, requestStop, forceStop, pause, resume, modify, extend, continueRun, dismiss, status, setBroadcast, restore, _RISKY_TOOLS: RISKY_TOOLS };
