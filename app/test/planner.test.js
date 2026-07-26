"use strict";
// Planner ledger: create, auto-advance, the exact per-turn context note, persistence across
// a simulated restart, dynamic step insertion, completion, and bad-step errors.
process.env.JARVIS_PLAN_FILE = "/tmp/_jarvis_plan_test.json";
const path = require("path");
const fs = require("fs");
const P = path.join(__dirname, "..", "src", "planner");
const planner = require(P);
let fails = 0;
const check = (l, c) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails++; };
fs.rmSync(process.env.JARVIS_PLAN_FILE, { force: true });

let pl = planner.create({ objective: "Build a gallery app", steps: ["research", "download images", "build viewer", "serve + test"] });
check("create: step 1 active", pl.steps[0].status === "active");

pl = planner.updateStep({ step: 1, status: "done", note: "chose Lightbox" });
check("update: step 1 done + step 2 auto-active", pl.steps[0].status === "done" && pl.steps[1].status === "active");

const note = planner.contextNote();
check("contextNote resumes from step 2", /Resume from step 2/.test(note));
check("contextNote discourages plan_show", /do NOT call plan_show/.test(note));

delete require.cache[require.resolve(P)];
const p2 = require(P);
check("persistence: reloads active step 2", p2.get().steps.find((s) => s.status === "active").id === 2);

p2.addStep({ text: "fix aspect-ratio bug", after: 3 });
[2, 3, 4, 5].forEach((n) => p2.updateStep({ step: n, status: "done" }));
check("completion: all done -> complete", p2.get().status === "complete");
check("completed plan not injected", p2.contextNote() === null);

let threw = false;
try { p2.updateStep({ step: 99, status: "done" }); } catch (_) { threw = true; }
check("bad step rejected", threw);

fs.rmSync(process.env.JARVIS_PLAN_FILE, { force: true });
console.log(fails ? `\nPLANNER: ${fails} FAILURE(S)` : "\nPLANNER: ALL PASSED");
process.exit(fails ? 1 : 0);
