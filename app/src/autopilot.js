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

let broadcast = () => {};
function setBroadcast(fn) { broadcast = typeof fn === "function" ? fn : () => {}; }

let run = null;   // the single active run (null when idle)
let ac = null;    // AbortController for the in-flight cycle

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function status() {
  if (!run) return { active: false, status: "idle" };
  return {
    active: run.status === "running" || run.status === "stopping",
    id: run.id, objective: run.objective, autonomy: run.autonomy,
    status: run.status, cycles: run.cycles, minutes: run.minutes,
    seconds_left: Math.max(0, Math.round((run.deadline - nowMs()) / 1000)),
    started_at: run.startedAt,
  };
}
function emitStatus() { try { broadcast({ type: "autopilot", status: status() }); } catch (_) {} }

function start({ objective, minutes, autonomy }) {
  if (run && (run.status === "running" || run.status === "stopping")) throw new Error("an Autopilot run is already active — stop it first");
  objective = String(objective || "").trim();
  if (!objective) throw new Error("Autopilot needs an objective");
  const ap = (config.config && config.config.autopilot) || {};
  const minutesN = Math.max(1, Math.min(Number(minutes) || Number(ap.default_minutes) || 30, 720)); // cap 12h
  const mode = ((autonomy || ap.autonomy || "guarded") === "full") ? "full" : "guarded";
  const maxCycles = Math.max(1, Number(ap.max_cycles) || 100);
  run = {
    id: "ap_" + nowMs().toString(36), objective, autonomy: mode, minutes: minutesN,
    deadline: nowMs() + minutesN * 60000, maxCycles, cycles: 0, noProgress: 0, errors: 0,
    status: "running", startedAt: new Date().toISOString(), wrapUp: false, budgetHit: false, hardStop: false,
  };
  emitStatus();
  loop().catch((e) => finish("error", `crashed: ${e && e.message ? e.message : e}`, null));
  return status();
}

function requestWrapUp() {
  if (run && run.status === "running") { run.wrapUp = true; run.status = "stopping"; emitStatus(); }
  return status();
}
function requestStop() {
  if (run) { run.hardStop = true; run.status = "stopping"; if (ac) { try { ac.abort(); } catch (_) {} } emitStatus(); }
  return status();
}

function finish(state, message, summary) {
  if (!run) return;
  const label = run.objective;
  run.status = state;   // done | budget | stopped | stuck | error
  emitStatus();
  try {
    const sched = require("./scheduler");
    if (summary && summary.trim()) sched.postToChat(summary.trim());
    const level = (state === "error" || state === "stuck") ? "warning" : "info";
    const verb = { done: "finished ✅", budget: "hit its time budget ⏱", stopped: "stopped ⏹", stuck: "got stuck ⚠️", error: "errored ⚠️" }[state] || state;
    sched.pushNotification({ level, label: "Autopilot", message: `Autopilot ${verb}: ${message}\nObjective: ${label}` });
  } catch (_) {}
  run = null; ac = null;
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
    if (!run.wrapUp && (nowMs() >= run.deadline || run.cycles >= run.maxCycles)) { run.wrapUp = true; run.budgetHit = true; run.status = "stopping"; emitStatus(); }

    const before = planner.get();
    const doneBefore = before ? before.steps.filter((s) => s.status === "done").length : 0;
    const guard = guardClause(run.autonomy);

    let instr;
    if (run.wrapUp) {
      instr = `[AUTOPILOT — WRAP UP] Stop starting new work. If a step is nearly done, finish it; otherwise stop now. Then give a concise FINAL SUMMARY: what is complete, what remains, and where the deliverables are. ${run.budgetHit ? "(The time budget was reached.)" : "(The user asked to wrap up for review.)"}`;
    } else if (!before) {
      instr = `[AUTOPILOT] You are running AUTONOMOUSLY — the user is AWAY and cannot answer questions. Objective: «${run.objective}». Start now: call plan_create with a concrete, ordered plan (make reasonable assumptions where anything is unclear and note them — do NOT ask the user or wait), then begin executing it: build, run, and TEST your work, fix failures, refine, and keep the plan ledger up to date with plan_update.${guard}`;
    } else {
      instr = `[AUTOPILOT] Continue AUTONOMOUSLY (the user is away — do not ask questions; make reasonable decisions). Work your active plan: do the next incomplete step(s), test what you build, fix issues, refine, and update the ledger as you go.${guard}`;
    }

    ac = new AbortController();
    const messages = [{ role: "system", content: config.systemPrompt() }, { role: "user", content: instr }];
    // Stream only tool activity/usage to open clients (so the Activity tab + plan banner move
    // live); do NOT pipe tokens into the chat bubble — the final summary is posted to chat.
    const emit = (ev) => { if (ev && (ev.type === "tool" || ev.type === "tool_result" || ev.type === "usage")) { try { broadcast(ev); } catch (_) {} } };

    let reply = "";
    try {
      reply = await llm.chat({ messages, emit, signal: ac.signal, watchdog: false,
        excludeTools: run.autonomy === "guarded" ? RISKY_TOOLS : [] });
    } catch (e) {
      if (!run || run.hardStop || (ac && ac.signal.aborted)) return finish("stopped", `hard-stopped after ${run.cycles} cycle(s).`, null);
      run.errors++;
      if (run.errors >= 3) return finish("error", `repeated errors (last: ${e && e.message ? e.message : e}).`, null);
      await sleep(1500);
      continue;
    }
    run.cycles++;
    emitStatus();

    if (run.wrapUp) return finish(run.budgetHit ? "budget" : "stopped",
      run.budgetHit ? `time budget reached after ${run.cycles} cycle(s).` : `wrapped up after ${run.cycles} cycle(s).`, reply);

    const after = planner.get();
    if (after && after.status === "complete") return finish("done", `objective complete after ${run.cycles} cycle(s).`, reply);
    const doneAfter = after ? after.steps.filter((s) => s.status === "done").length : 0;
    run.noProgress = (after && doneAfter <= doneBefore && before) ? run.noProgress + 1 : 0;
    if (run.noProgress >= 4) return finish("stuck", `no plan progress for ${run.noProgress} cycles — paused for your review.`, reply);

    await sleep(300);
  }
}

module.exports = { start, requestWrapUp, requestStop, status, setBroadcast, _RISKY_TOOLS: RISKY_TOOLS };
