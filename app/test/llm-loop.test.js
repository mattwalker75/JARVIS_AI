"use strict";
// Deterministic tests for the llm.js tool loop guardrails. We stub the LLM transport
// (global.fetch -> a scripted SSE stream) and tools.execTool (records calls, canned result),
// so we can assert the loop's behaviour without a model or the workbench:
//   - tool-call-written-as-TEXT is salvaged and executed
//   - the follow-through nudge fires when the model narrates an action but doesn't act
//   - the completion loop re-verifies "done" before accepting
//   - the repeat-tool guard fires on the same call 3x
const path = require("path");
// Stub 'dockerode' so this runs on the host (it's only installed in the app container).
// execTool is stubbed below anyway, so the workbench is never actually touched.
const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "dockerode" ? "dockerode-stub" : _resolve.call(this, req, ...a); };
require.cache["dockerode-stub"] = { id: "dockerode-stub", loaded: true, exports: function Docker() { return { getContainer: () => ({}) }; } };
const SRC = path.join(__dirname, "..", "src");
const config = require(path.join(SRC, "config"));
const tools = require(path.join(SRC, "tools"));

// --- fake OpenAI-compatible streaming transport -----------------------------
function sse(turn) {
  const L = [];
  const push = (o) => L.push("data: " + JSON.stringify(o));
  if (turn.content) push({ choices: [{ delta: { content: turn.content }, finish_reason: null }] });
  (turn.tool_calls || []).forEach((t, i) => push({ choices: [{ delta: { tool_calls: [{ index: i, id: t.id || "c" + i, function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }] }, finish_reason: null }] }));
  push({ choices: [{ delta: {}, finish_reason: turn.finish || "stop" }] });
  push({ usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } });
  L.push("data: [DONE]");
  return L.join("\n") + "\n";
}
function fakeResp(body) {
  const bytes = new TextEncoder().encode(body); let sent = false;
  const stream = new ReadableStream({ pull(c) { if (!sent) { c.enqueue(bytes); sent = true; } else c.close(); } });
  return { ok: true, status: 200, body: stream, text: async () => body };
}

let turns = [], turnIdx = 0, seenMessages = [], toolCalls = [];
global.fetch = async (_url, opts) => {
  try { seenMessages.push(JSON.parse(opts.body).messages); } catch (_) {}
  const t = turns[turnIdx++] || { content: "(no more turns)", finish: "stop" };
  return fakeResp(sse(t));
};
tools.execTool = async (name, args) => { toolCalls.push({ name, args }); return { ok: true, note: "stubbed " + name }; };

const llm = require(path.join(SRC, "llm"));

// --- helpers ----------------------------------------------------------------
function reset(script, completionChecks) {
  turns = script; turnIdx = 0; seenMessages = []; toolCalls = [];
  config.config.llm = config.config.llm || {};
  config.config.llm.completion_checks = completionChecks;
}
const injected = (re) => seenMessages.some((msgs) => msgs.some((m) => m.role === "user" && re.test(m.content || "")));
let failures = 0;
function check(label, cond) { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) failures++; }

(async () => {
  const sys = [{ role: "system", content: "sys" }];

  // 1) tool-call-as-TEXT is salvaged + executed
  reset([
    { content: "Let me run it:\n<tool_call>run_shell\n<parameter=command>\necho hi\n</parameter>\n</tool_call>", finish: "stop" },
    { content: "All done — output was hi.", finish: "stop" },
  ], 0);
  let reply = await llm.chat({ messages: [...sys, { role: "user", content: "run echo hi" }], emit: () => {} });
  check("1 salvage: run_shell executed", toolCalls.some((c) => c.name === "run_shell" && c.args.command === "echo hi"));
  check("1 salvage: correction injected", injected(/wrote the tool call\(s\) as TEXT|written as TEXT/i));
  check("1 salvage: final answer accepted", /All done/.test(reply));

  // 2) follow-through nudge on narrated-but-no-action
  reset([
    { content: "Let me check the files.", finish: "stop" },
    { content: "Here is the answer.", finish: "stop" },
  ], 0);
  reply = await llm.chat({ messages: [...sys, { role: "user", content: "what's there?" }], emit: () => {} });
  check("2 follow-through: nudge injected", injected(/described an action.*did not call any tool/i));
  check("2 follow-through: final answer accepted", /Here is the answer/.test(reply));

  // 3) completion loop re-verifies 'done'
  reset([
    { tool_calls: [{ name: "run_shell", args: { command: "make" } }], finish: "tool_calls" },
    { content: "I'm done.", finish: "stop" },
    { content: "Confirmed — everything is complete.", finish: "stop" },
  ], 1);
  reply = await llm.chat({ messages: [...sys, { role: "user", content: "build it" }], emit: () => {} });
  check("3 completion: check injected", injected(/Before you finish/i));
  check("3 completion: final answer accepted", /Confirmed/.test(reply));

  // 4) repeat-tool guard on identical call 3x
  reset([
    { tool_calls: [{ name: "run_shell", args: { command: "ls" } }], finish: "tool_calls" },
    { tool_calls: [{ name: "run_shell", args: { command: "ls" } }], finish: "tool_calls" },
    { tool_calls: [{ name: "run_shell", args: { command: "ls" } }], finish: "tool_calls" },
    { content: "OK, stopping.", finish: "stop" },
  ], 0);
  reply = await llm.chat({ messages: [...sys, { role: "user", content: "list" }], emit: () => {} });
  check("4 repeat-guard: nudge injected", injected(/same tool call 3 times/i));
  check("4 repeat-guard: final answer accepted", /stopping/.test(reply));

  console.log(failures ? `\nLLM-LOOP: ${failures} FAILURE(S)` : "\nLLM-LOOP: ALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("LLM-LOOP CRASH:", e); process.exit(1); });
