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
// it to build/test — so guarded mode is best-effort, backed by the instruction. The list is
// shared with the scheduler via ./policy.
const { RISKY_TOOLS } = require("./policy");
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
  const maxCost = Math.max(0, Number(ap.max_cost_usd) || 0);   // 0 = no cost ceiling (time/cycles still apply)
  try { planner.clear("autopilot"); } catch (_) {}   // a NEW objective starts fresh — never inherit a stale plan from a previous task
  run = {
    id: "ap_" + nowMs().toString(36), objective, autonomy: mode, minutes: minutesN,
    deadline: nowMs() + minutesN * 60000, maxCycles, maxCost, cycles: 0, noProgress: 0, errors: 0,
    status: "running", startedAt: new Date().toISOString(), wrapUp: false, budgetHit: false, hardStop: false,
    pauseRequested: false, objectiveChanged: false, lastSummary: "", idleWork: 0, tokens: 0, cost: 0, verbose: !!verbose,
  };
  emitStatus();
  startLoop();
  return status();
}

// Each loop gets a token; only the loop holding the CURRENT token may act. A force-stop (or a
// new loop) bumps it, so a cycle still unwinding from a force-stopped run can never keep going
// alongside the next run.
let loopToken = 0;
function startLoop() {
  const token = ++loopToken;
  loop(token).catch((e) => { if (token === loopToken) finish("error", `crashed: ${e && e.message ? e.message : e}`, null); });
}

function requestWrapUp() {
  if (!run) return status();
  if (run.status === "running") { run.wrapUp = true; run.status = "stopping"; emitStatus(); }
  else if (run.status === "paused") { run.wrapUp = true; run.status = "running"; emitStatus(); startLoop(); }  // resume to run the final wrap-up cycle
  return status();
}
function requestStop() {
  if (!run || run.ended) return status();   // nothing to stop (an ended run must not flip back to "stopping")
  if (run.status === "paused") finish("stopped", `stopped while paused after ${run.cycles} cycle(s).`, null);
  else { run.hardStop = true; run.pauseRequested = false; run.status = "stopping"; if (ac) { try { ac.abort(); } catch (_) {} } emitStatus(); }   // Stop beats a pending pause
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
  loopToken++;   // orphan the running loop: whatever its cycle returns, it exits without acting
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
  if (run && !run.ended) {   // extending an ENDED run would bump counters without resuming — use continueRun instead
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
    ? " SAFE MODE: do NOT take irreversible EXTERNAL actions on your own — no sending email/messages, posting online, purchases, or deleting/overwriting the user's files outside /LLM_WORKSPACE. If a step truly needs one, mark it blocked (plan_update status=blocked with a note) and continue with the rest; the user will handle it. Building and testing in /LLM_WORKSPACE is unrestricted."
    : " FULL AUTONOMY: take whatever actions the objective genuinely requires.";
}

async function loop(token) {
  const llm = require("./llm");
  const me = run;   // THIS loop's run — a later start/continue gets its own loop (and token)
  // Still the live loop? A force-stop, a dismiss, or a new run/Continue bumps the token, and
  // an orphaned loop (its cycle still unwinding) must then exit without touching anything.
  const alive = () => token === loopToken && run === me && !!me && !me.ended;
  while (alive()) {
    if (me.hardStop) return finish("stopped", `hard-stopped after ${me.cycles} cycle(s).`, null);
    if (me.pauseRequested) { me.status = "paused"; me.pauseRequested = false; ac = null; emitStatus(); return; }  // keep run alive
    if (!me.wrapUp && (nowMs() >= me.deadline || me.cycles >= me.maxCycles || (me.maxCost && me.cost >= me.maxCost))) { me.wrapUp = true; me.budgetHit = true; me.status = "stopping"; emitStatus(); }

    const before = planner.get("autopilot");
    const doneBefore = before ? before.steps.filter((s) => s.status === "done").length : 0;
    const guard = guardClause(me.autonomy);
    // Cross-cycle continuity (fixes the observed "re-read the same file every cycle" loop):
    const recap = me.lastSummary ? ` Last cycle you reported: "${me.lastSummary.slice(0, 400)}". Continue FROM there — do NOT re-read files or re-plan things you already did unless they changed.` : "";
    // Anti-thrash: if recent cycles only read/planned without writing code, push hard to act.
    const pushWrite = me.idleWork >= 2 ? " ⚠ You have spent multiple cycles only READING/PLANNING without changing any files. STOP re-reading. " + (config.workbenchEnabled() ? "Make the concrete code change NOW with write_workbench_file (or run_shell), then run/test it" : "Make the concrete change NOW with write_file / edit_file") + " — do not just describe what you'll do." : "";
    const objChange = me.objectiveChanged ? ` NOTE: the objective was just UPDATED to «${me.objective}». Re-check your plan against it and adjust steps (add/remove) before continuing.` : "";
    // Don't re-serve an app that's already running from an earlier cycle (a big source of wasted steps).
    const servedNote = me.servedPort ? ` A preview server is ALREADY running on http://localhost:${me.servedPort} from an earlier cycle — do NOT call serve_app for it again; only re-open/screenshot it if you actually changed the files it serves.` : "";
    // Converge: as soon as the work verifies, mark it complete and stop re-checking a working result.
    const doneNudge = " IMPORTANT: the MOMENT every plan step is finished and your latest test/verification passed, call plan_update to mark the remaining steps done and give a one-line final summary — do NOT keep re-serving, re-screenshotting, or re-verifying a result that already works. If it works, you are DONE.";

    let instr;
    if (me.wrapUp) {
      instr = `[AUTOPILOT — WRAP UP] Stop starting new work. If a step is nearly done, finish it; otherwise stop now. Then give a concise FINAL SUMMARY: what is complete, what remains, and where the deliverables are. ${me.budgetHit ? "(The time budget was reached.)" : "(The user asked to wrap up for review.)"}`;
    } else if (!before) {
      instr = `[AUTOPILOT] You are running AUTONOMOUSLY — the user is AWAY and cannot answer questions. Objective: «${me.objective}». Start now: call plan_create with a concrete, ordered plan (make reasonable assumptions where anything is unclear and note them — do NOT ask the user or wait), then begin executing it: build, run, and TEST your work, fix failures, refine, and keep the plan ledger up to date with plan_update.${guard}`;
    } else {
      instr = `[AUTOPILOT] Continue AUTONOMOUSLY (the user is away — do not ask questions; make reasonable decisions). Work your active plan: do the next incomplete step(s), test what you build, fix issues, refine, and update the ledger as you go.${objChange}${recap}${servedNote}${pushWrite}${doneNudge}${guard}`;
    }
    me.objectiveChanged = false;

    const myAc = new AbortController();
    ac = myAc;
    const messages = [{ role: "system", content: config.systemPrompt() }, { role: "user", content: instr }];
    try { broadcast({ type: "tool", tool: `🛫 Autopilot — cycle ${me.cycles + 1}${me.wrapUp ? " (wrap-up)" : ""}`, input: me.objective }); } catch (_) {}   // cycle marker in Activity
    // Stream tool activity/usage to open clients; also detect whether this cycle actually
    // WROTE anything (vs. just reading/planning) to drive the anti-thrash push above,
    // and tally tokens/cost across the whole run.
    let didWork = false;
    const emit = (ev) => {
      if (!ev || !alive()) return;   // an orphaned cycle's late events must not reach the new run
      if (ev.type === "tool" && ev.tool && !NONPRODUCTIVE_TOOLS.has(ev.tool)) didWork = true;
      // Remember a live preview server so LATER cycles don't waste steps re-serving the same app.
      if (ev.type === "tool_result" && ev.tool === "serve_app" && ev.output) {
        const m = String(ev.output).match(/localhost:(\d{4,5})/);
        if (m) me.servedPort = m[1];
      }
      if (ev.type === "usage") { me.tokens += (ev.usage && ev.usage.total_tokens) || 0; me.cost += Number(ev.cost_usd) || 0; }
      // Always stream tool activity + usage (and media previews); in VERBOSE mode also
      // stream the model's live thinking + tokens to the chat so you can watch it work.
      const base = ev.type === "tool" || ev.type === "tool_result" || ev.type === "usage" || ev.type === "tool_media" || ev.type === "failover";
      const think = me.verbose && (ev.type === "reasoning" || ev.type === "token");
      if (base || think) { try { broadcast(ev); } catch (_) {} }
    };

    // Smart routing (llm.smart_routing, default on): the PLANNING cycle (no plan yet)
    // and the WRAP-UP cycle carry the run's judgment-heavy work — route them to the
    // smart tier. With no smart tier configured, modelFor falls back to chat (no-op).
    const smartRouting = !(config.config && config.config.llm && config.config.llm.smart_routing === false);
    const tier = smartRouting && (!before || me.wrapUp) ? "smart" : "chat";
    let reply = "";
    try {
      reply = await llm.chat({ messages, emit, signal: myAc.signal, watchdog: false, tier, planKey: "autopilot",
        excludeTools: me.autonomy === "guarded" ? RISKY_TOOLS : [] });
    } catch (e) {
      if (!alive()) return;   // force-stopped or replaced while this cycle ran — exit quietly
      // Stop wins over a pause that was still pending (Pause, then Stop before the cycle unwound).
      if (me.hardStop) return finish("stopped", `hard-stopped after ${me.cycles} cycle(s).`, null);
      if (me.pauseRequested) { me.status = "paused"; me.pauseRequested = false; ac = null; emitStatus(); return; }  // paused mid-cycle
      if (myAc.signal.aborted) return finish("stopped", `hard-stopped after ${me.cycles} cycle(s).`, null);
      me.errors++;
      if (me.errors >= 3) return finish("error", `repeated errors (last: ${e && e.message ? e.message : e}).`, null);
      await sleep(1500);
      continue;
    }
    if (!alive()) return;   // a force-stop ended (or a new run replaced) this run while the cycle was in flight — drop its result silently
    // Retry-on-empty: a cycle where the model returned NOTHING is a wasted cycle — retry it (up to
    // twice) without counting it, rather than recording a blank summary and burning the budget.
    if ((reply || "").includes("I wasn't able to produce a response") && (me.emptyStreak || 0) < 2) {
      me.emptyStreak = (me.emptyStreak || 0) + 1;
      try { broadcast({ type: "tool", tool: "↻ Autopilot — empty response, retrying", input: "" }); } catch (_) {}
      await sleep(1000);
      continue;   // does NOT increment cycles or idleWork
    }
    me.emptyStreak = 0;
    me.cycles++;
    me.errors = 0;   // a successful cycle clears the transient-error counter (don't let sporadic errors accumulate across a long run)
    me.lastSummary = (reply || "").replace(/\s+/g, " ").trim();
    me.idleWork = didWork ? 0 : me.idleWork + 1;
    // Cycle history: what each cycle reported, browsable from the bar's 📜 button
    // (GET /api/autopilot/history). Persisted with the run, capped so a 12-hour run
    // can't bloat the state file.
    me.history = me.history || [];
    me.history.push({ cycle: me.cycles, at: new Date().toISOString(), wrapUp: !!me.wrapUp, didWork, summary: me.lastSummary.slice(0, 600) });
    if (me.history.length > 200) me.history = me.history.slice(-200);
    // Verbose: finalize this cycle's streamed thinking as an (ephemeral) chat message so cycles
    // are separated. ephemeral = shown but not added to your chat's model-context history.
    if (me.verbose && reply && reply.trim()) { try { broadcast({ type: "reply", text: reply, ephemeral: true }); } catch (_) {} }
    emitStatus();

    // Prefer reporting genuine completion even if the budget was also reached this cycle.
    const after = planner.get("autopilot");
    if (after && after.status === "complete") return finish("done", `objective complete after ${me.cycles} cycle(s).`, reply);
    if (me.wrapUp) return finish(me.budgetHit ? "budget" : "stopped",
      me.budgetHit ? `time budget reached after ${me.cycles} cycle(s).` : `wrapped up after ${me.cycles} cycle(s).`, reply);
    const doneAfter = after ? after.steps.filter((s) => s.status === "done").length : 0;
    me.noProgress = (after && doneAfter <= doneBefore && before) ? me.noProgress + 1 : 0;
    if (me.noProgress >= 5) return finish("stuck", `no plan progress for ${me.noProgress} cycles — paused for your review.`, reply);

    await sleep(300);
  }
}

// Per-cycle summaries of the current (or ended-but-undismissed) run.
function history() {
  if (!run) return { objective: null, cycles: [] };
  return { objective: run.objective, status: run.status, cycles: run.history || [] };
}

module.exports = { start, requestWrapUp, requestStop, forceStop, pause, resume, modify, extend, continueRun, dismiss, status, history, setBroadcast, restore, _RISKY_TOOLS: RISKY_TOOLS };
