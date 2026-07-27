"use strict";
// Autopilot controller: completion, time/cycle budget, stuck-detection, hard-stop, graceful
// wrap-up, pause/resume, stop-while-paused, extend, and modify (+ cross-cycle recap and the
// anti-thrash push). The LLM + scheduler are stubbed; the real planner drives progress.
process.env.JARVIS_PLAN_FILE = "/tmp/_jarvis_ap_test.json";
process.env.JARVIS_AUTOPILOT_FILE = "/tmp/_jarvis_ap_run.json";   // don't touch /data during tests
const path = require("path");
const fs = require("fs");
const SRC = path.join(__dirname, "..", "src");
const abs = (m) => require.resolve(path.join(SRC, m));
const planner = require(abs("planner"));

let notes = [];
require.cache[abs("scheduler")] = { id: abs("scheduler"), loaded: true, exports: { pushNotification: (n) => notes.push(n), postToChat: () => {} } };
let llmBehavior = async () => "ok";
require.cache[abs("llm")] = { id: abs("llm"), loaded: true, exports: { chat: (o) => llmBehavior(o) } };
const ap = require(abs("autopilot"));
ap.setBroadcast(() => {});

let fails = 0;
const check = (l, c) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { try { ap.dismiss(); } catch (_) {} fs.rmSync(process.env.JARVIS_PLAN_FILE, { force: true }); fs.rmSync(process.env.JARVIS_AUTOPILOT_FILE, { force: true }); notes = []; require(abs("config")).config.autopilot = {}; };
const waitDone = async (ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (notes.length) return notes[notes.length - 1].message; await sleep(40); } throw new Error("timeout"); };
const slow = () => (o) => new Promise((res, rej) => { if (!planner.get()) planner.create({ objective: "o", steps: ["a", "b", "c"] }); const t = setTimeout(() => res("chunk"), 400); o.signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("ab"); e.name = "AbortError"; rej(e); }); });

(async () => {
  // completion
  reset(); let c = 0;
  llmBehavior = async () => { c++; if (c === 1) planner.create({ objective: "o", steps: ["a", "b"] }); else planner.updateStep({ step: c - 1, status: "done" }); return "r" + c; };
  ap.start({ objective: "Build", minutes: 60, autonomy: "full" });
  check("completion -> finished", /finished/.test(await waitDone()));

  // cycle budget + guarded excludes risky tools
  reset(); require(abs("config")).config.autopilot = { max_cycles: 3 }; c = 0; let lastOpts = null;
  llmBehavior = async (o) => { lastOpts = o; c++; if (c === 1) planner.create({ objective: "o", steps: ["a", "b", "c", "d", "e"] }); else planner.updateStep({ step: c - 1, status: "done" }); return "r"; };
  ap.start({ objective: "Y", minutes: 60, autonomy: "guarded" });
  check("cycle budget -> budget", /budget/.test(await waitDone()));
  check("guarded excludes risky tools", JSON.stringify(lastOpts.excludeTools) === JSON.stringify(ap._RISKY_TOOLS));
  require(abs("config")).config.autopilot = {};

  // stuck
  reset(); c = 0;
  llmBehavior = async () => { c++; if (c === 1) planner.create({ objective: "o", steps: ["a", "b"] }); return "stalling"; };
  ap.start({ objective: "Z", minutes: 60, autonomy: "full" });
  check("no progress -> stuck", /stuck/.test(await waitDone()));
  // ...and after it ends incomplete, the run stays (banner persists) and is resumable
  check("ended run persists + resumable", ap.status().ended === true && ap.status().resumable === true);
  // Continue on the SAME plan (no reset): resume and finish it
  llmBehavior = async () => { planner.get().steps.forEach((st) => planner.updateStep({ step: st.id, status: "done" })); return "done"; };
  notes = []; ap.continueRun({ minutes: 10 });
  check("continue resumes the same plan -> done", /finished/.test(await waitDone()));

  // pause -> resume -> completes
  reset(); llmBehavior = slow();
  ap.start({ objective: "P", minutes: 60, autonomy: "full" });
  await sleep(150); ap.pause(); await sleep(250);
  const s = ap.status();
  check("pause -> paused+active", s.status === "paused" && s.active && s.paused);
  llmBehavior = async () => { planner.get().steps.forEach((st) => planner.updateStep({ step: st.id, status: "done" })); return "fin"; };
  ap.resume();
  check("resume -> finishes", /finished/.test(await waitDone()));

  // stop while paused
  reset(); llmBehavior = slow();
  ap.start({ objective: "SP", minutes: 60, autonomy: "full" });
  await sleep(150); ap.pause(); await sleep(250); ap.requestStop();
  check("stop while paused -> stopped", /stopped/.test(await waitDone()));

  // extend
  reset(); llmBehavior = slow();
  ap.start({ objective: "E", minutes: 10, autonomy: "full" });
  const before = ap.status().minutes; ap.extend({ minutes: 20 });
  check("extend adds time", ap.status().minutes === before + 20);
  ap.requestStop(); await waitDone();

  // modify + cross-cycle recap + anti-thrash
  reset(); let instrs = []; c = 0;
  llmBehavior = async (o) => { instrs.push(o.messages[1].content); c++; if (c === 1) planner.create({ objective: "o", steps: ["a", "b", "c"] }); if (c >= 4) planner.get().steps.forEach((st) => planner.updateStep({ step: st.id, status: "done" })); o.emit({ type: "tool", tool: "read_file" }); return "c" + c; };
  ap.start({ objective: "Original", minutes: 60, autonomy: "full" });
  await sleep(500); ap.modify({ objective: "NEW GOAL" }); await waitDone();
  check("modify -> next cycle told", instrs.some((i) => /objective was just UPDATED to «NEW GOAL»/.test(i)));
  check("cross-cycle recap injected", instrs.some((i) => /Last cycle you reported/.test(i)));
  check("anti-thrash push injected", instrs.some((i) => /STOP re-reading/.test(i)));

  // stale-plan bug: a NEW objective must NOT inherit a leftover plan from a previous task
  reset();
  planner.create({ objective: "OLD DOOM game", steps: ["build engine", "add enemies"] });
  let capt = [];
  llmBehavior = async (o) => { capt.push(o.messages[1].content); if (!planner.get()) planner.create({ objective: "sc", steps: ["a"] }); planner.get().steps.forEach((st) => planner.updateStep({ step: st.id, status: "done" })); return "done"; };
  ap.start({ objective: "Build a SimCity-style game", minutes: 60, autonomy: "full" });
  await waitDone();
  check("new objective starts a fresh plan (no stale DOOM)", capt[0] && /call plan_create/.test(capt[0]) && /SimCity/.test(capt[0]) && !/OLD DOOM/.test(capt[0]));

  // persistence: a 'running' run left on disk resumes on restore()
  reset();
  fs.writeFileSync(process.env.JARVIS_AUTOPILOT_FILE, JSON.stringify({ id: "ap_x", objective: "resume me", autonomy: "full", minutes: 60, deadline: Date.now() + 3600000, maxCycles: 100, cycles: 1, noProgress: 0, errors: 0, status: "running", tokens: 0, cost: 0 }));
  llmBehavior = async () => { if (!planner.get()) planner.create({ objective: "o", steps: ["a"] }); planner.get().steps.forEach((st) => planner.updateStep({ step: st.id, status: "done" })); return "done"; };
  ap.restore();
  check("restore: resumes a persisted running run", /finished/.test(await waitDone()));

  // persistence: a 'paused' run stays paused on restore()
  reset();
  fs.writeFileSync(process.env.JARVIS_AUTOPILOT_FILE, JSON.stringify({ id: "ap_y", objective: "paused one", autonomy: "full", minutes: 60, deadline: Date.now() + 3600000, pausedRemaining: 1800000, maxCycles: 100, cycles: 2, status: "paused", tokens: 0, cost: 0 }));
  ap.restore();
  check("restore: paused run stays paused", ap.status().status === "paused" && ap.status().active);
  ap.requestStop(); await sleep(50);

  fs.rmSync(process.env.JARVIS_AUTOPILOT_FILE, { force: true });
  fs.rmSync(process.env.JARVIS_PLAN_FILE, { force: true });
  console.log(fails ? `\nAUTOPILOT: ${fails} FAILURE(S)` : "\nAUTOPILOT: ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("AUTOPILOT CRASH:", e); process.exit(1); });
