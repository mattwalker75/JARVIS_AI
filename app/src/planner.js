"use strict";
// Persistent task ledger: the current multi-step objective + its checklist. It survives
// turn boundaries, stalls, and app restarts (written to /data/plan.json), so JARVIS never
// "forgets what it was working on" — the ledger is re-injected into context every turn and
// work resumes from the first incomplete step instead of restarting. One active plan at a
// time (single-user assistant). The model drives it through the plan_* tools.
const persist = require("./persist");
const FILE = process.env.JARVIS_PLAN_FILE || "/data/plan.json";

let onChange = null;
function setOnChange(cb) { onChange = cb; }

function load() { return persist.readJson(FILE, null); }
function save(plan) {
  persist.writeJsonAtomic(FILE, plan, true);
  if (onChange) { try { onChange(plan); } catch (_) {} }
  return plan;
}
function now() { return new Date().toISOString(); }
function genId() { return "plan_" + Date.now().toString(36); }

const STATUSES = ["pending", "active", "done", "blocked"];

function normSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s, i) => {
      if (typeof s === "string") return { id: i + 1, text: s.trim(), status: "pending", note: "" };
      return { id: i + 1, text: String(s.text || s.step || "").trim(), status: STATUSES.includes(s.status) ? s.status : "pending", note: s.note || "" };
    })
    .filter((s) => s.text);
}
function planStatus(steps) {
  if (!steps.length) return "active";
  return steps.every((s) => s.status === "done") ? "complete" : "active";
}
function findStepIdx(plan, step) {
  const n = Number(step);
  if (Number.isFinite(n)) {
    const byId = plan.steps.findIndex((s) => s.id === n);
    if (byId >= 0) return byId;
    if (n >= 1 && n <= plan.steps.length) return n - 1;   // fall back to 1-based position
  }
  return -1;
}

function create({ objective, steps }) {
  if (!objective || !String(objective).trim()) throw new Error("plan_create needs an 'objective'");
  const st = normSteps(steps);
  if (!st.length) throw new Error("plan_create needs a non-empty 'steps' array of short step descriptions");
  if (st[0].status === "pending") st[0].status = "active";   // start on step 1
  return save({ id: genId(), objective: String(objective).trim(), steps: st, status: "active", created_at: now(), updated_at: now() });
}

function updateStep({ step, status, note }) {
  const plan = load();
  if (!plan) throw new Error("no active plan — call plan_create first");
  const idx = findStepIdx(plan, step);
  if (idx < 0) throw new Error(`no step ${step} in the plan (it has ${plan.steps.length} step(s))`);
  if (status != null) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
    plan.steps[idx].status = status;
  }
  if (note != null) plan.steps[idx].note = String(note);
  if (status === "done") {                                   // auto-advance to the next pending step
    const next = plan.steps.find((s) => s.status === "pending");
    if (next) next.status = "active";
  }
  plan.status = planStatus(plan.steps);
  plan.updated_at = now();
  return save(plan);
}

function addStep({ text, after }) {
  const plan = load();
  if (!plan) throw new Error("no active plan — call plan_create first");
  if (!text || !String(text).trim()) throw new Error("plan_add_step needs 'text'");
  const id = plan.steps.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const entry = { id, text: String(text).trim(), status: "pending", note: "" };
  const at = findStepIdx(plan, after);
  if (at >= 0) plan.steps.splice(at + 1, 0, entry); else plan.steps.push(entry);
  plan.status = planStatus(plan.steps);
  plan.updated_at = now();
  return save(plan);
}

function clear() { save(null); return { cleared: true }; }
function get() { return load(); }

// Compact ledger string injected into context each turn — the anti-"forgetting" core.
function contextNote() {
  const plan = load();
  if (!plan || plan.status !== "active") return null;
  const icon = { done: "x", active: "→", pending: " ", blocked: "!" };
  const lines = plan.steps.map((s) => ` ${s.id}. [${icon[s.status] || " "}] ${s.text}${s.note ? "  — " + s.note : ""}`);
  const cur = plan.steps.find((s) => s.status === "active") || plan.steps.find((s) => s.status !== "done");
  return `ACTIVE PLAN — "${plan.objective}"\n${lines.join("\n")}\n` +
    (cur ? `Resume from step ${cur.id}. ` : "") +
    "Keep this ledger current: call plan_update(step, status) as you finish each step (status: done | active | blocked). Do NOT redo completed steps, and do NOT call plan_show — this plan is already shown to you every turn. When every step is done, give your final summary.";
}

module.exports = { create, updateStep, addStep, clear, get, contextNote, setOnChange };
