"use strict";
// JARVIS eval harness — replay fixture cases (data/evals/*.json) through the LIVE
// model + tool loop and assert on cheap signals (reply text, tools used, cost, time).
// Run:  ./JARVIS.sh --eval     (exit 0 = all passed, 1 = a case failed)
//
// A case is JSON: { name, messages:[{role,content}...], tier?, expect:{
//   contains:[...], not_contains:[...], tools_used:[...], max_ms, max_cost_usd, no_error } }
// Files may contain one case or an array of cases. Adapt saved sessions
// (data/sessions/*.json) into cases by copying their `messages` and adding `expect`.
const fs = require("fs");
const path = require("path");
const { systemPrompt } = require("./src/config");
const llm = require("./src/llm");

const EVAL_DIR = process.env.JARVIS_EVAL_DIR || "/data/evals";

async function runCase(c) {
  const messages = [{ role: "system", content: systemPrompt() }, ...(c.messages || [])];
  const toolsUsed = [];
  let model = null, cost = 0;
  const emit = (e) => {
    if (e.type === "tool") toolsUsed.push(e.tool);
    if (e.type === "usage") { model = e.model; if (e.cost_usd != null) cost = e.cost_usd; }
  };
  const started = Date.now();
  let reply = "", error = null;
  try { reply = await llm.chat({ messages, emit, tier: c.tier }); }
  catch (e) { error = e.message; }
  const ms = Date.now() - started;
  const exp = c.expect || {};
  const low = (reply || "").toLowerCase();
  const fails = [];
  if (exp.no_error !== false && error) fails.push("error: " + error);
  for (const s of exp.contains || []) if (!low.includes(String(s).toLowerCase())) fails.push(`missing "${s}"`);
  for (const s of exp.not_contains || []) if (low.includes(String(s).toLowerCase())) fails.push(`unexpected "${s}"`);
  for (const t of exp.tools_used || []) if (!toolsUsed.includes(t)) fails.push(`tool not used: ${t}`);
  if (exp.max_ms && ms > exp.max_ms) fails.push(`too slow: ${ms}ms > ${exp.max_ms}ms`);
  if (exp.max_cost_usd && cost > exp.max_cost_usd) fails.push(`too costly: $${cost} > $${exp.max_cost_usd}`);
  return { name: c.name || "(unnamed)", pass: fails.length === 0, fails, ms, cost, model, tools: toolsUsed };
}

(async () => {
  let files = [];
  try { files = fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith(".json")).sort(); } catch (_) {}
  if (!files.length) { console.log("No eval cases in " + EVAL_DIR + " (add *.json files)."); process.exit(0); }
  const results = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), "utf8")); }
    catch (e) { console.log("skip " + f + ": " + e.message); continue; }
    for (const c of (Array.isArray(data) ? data : [data])) results.push(await runCase(c));
  }
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  (${r.ms}ms · $${r.cost || 0} · ${r.model || "?"}${r.tools.length ? " · tools: " + r.tools.join(",") : ""})`);
    if (!r.pass) console.log("        - " + r.fails.join("\n        - "));
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
