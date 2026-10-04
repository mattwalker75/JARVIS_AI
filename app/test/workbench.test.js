"use strict";
// The optional Linux workbench (workbench.enabled — Config → Workbench & shared folders),
// in-process: with it off the workbench tools are withheld from the model and refused if
// called anyway, the system prompt says so, the workbench skills disappear, and the page is
// told to hide the Workbench tab. No Docker, no model: 'dockerode' and the LLM transport are
// stubbed. (The container stop/start and the HTTP routes are in workbench-server.test.js.)
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wb-unit-"));
process.env.JARVIS_AUDIT_FILE = path.join(tmp, "audit.log");
process.env.JARVIS_PLAN_FILE = path.join(tmp, "plan.json");
process.env.JARVIS_TASKS_FILE = path.join(tmp, "tasks.json");
process.env.JARVIS_LOG_DIR = tmp;
process.env.JARVIS_PROMPTS_DIR = path.join(tmp, "prompts");   // none saved → the config's own prompt is used

const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "dockerode" ? "dockerode-stub" : _resolve.call(this, req, ...a); };
let dockerTouched = 0;
require.cache["dockerode-stub"] = { id: "dockerode-stub", loaded: true, exports: function Docker() { return { getContainer: () => { dockerTouched++; return {}; } }; } };

const SRC = path.join(__dirname, "..", "src");
const cfgMod = require(path.join(SRC, "config"));
const tools = require(path.join(SRC, "tools"));
const skills = require(path.join(SRC, "skills"));
const config = cfgMod.config;

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "  ✓ " : "  ✗ ") + label + (!cond && detail ? " — " + detail : "")); if (!cond) failures++; };
const names = (defs) => defs.map((t) => t.function.name);
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };
const setEnabled = (v) => { config.workbench = config.workbench || {}; if (v === undefined) delete config.workbench.enabled; else config.workbench.enabled = v; };

// --- a scripted OpenAI-compatible transport that records the tools each request offers ---
let offered = [];
function sse(text) {
  return ["data: " + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }),
    "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: " + JSON.stringify({ usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } }), "data: [DONE]"].join("\n") + "\n";
}
global.fetch = async (_url, opts) => {
  try { offered.push((JSON.parse(opts.body).tools || []).map((t) => t.function.name)); } catch (_) { offered.push([]); }
  const bytes = new TextEncoder().encode(sse("Hello.")); let sent = false;
  return { ok: true, status: 200, text: async () => "", body: new ReadableStream({ pull(c) { if (!sent) { c.enqueue(bytes); sent = true; } else c.close(); } }) };
};
const llm = require(path.join(SRC, "llm"));
config.llm = { ...(config.llm || {}), provider: "openai", base_url: "http://transport.invalid/v1", api_key: "test", model: "test-model", completion_checks: 0 };
config.skills_autohint = false;
config.memory_auto_recall = false;
async function toolsOfferedToTheModel() {
  offered = [];
  await llm.chat({ messages: [{ role: "system", content: cfgMod.systemPrompt() }, { role: "user", content: "hello there" }], emit: () => {} });
  return offered[0] || [];
}

(async () => {
  const all = names(tools.toolDefs);
  const WB = [...tools.WORKBENCH_TOOLS];
  const KEPT = ["add_memory", "search_memory", "web_search", "fetch_url", "list_dir", "read_file", "write_file", "edit_file", "analyze_image", "check_email", "send_email", "schedule_task", "plan_create", "get_secret", "list_skills", "delegate"];

  // ---- the list itself
  check("every workbench tool is a real built-in tool", WB.every((n) => all.includes(n)), WB.filter((n) => !all.includes(n)).join(", "));
  check("the tools kept without a workbench all exist", KEPT.every((n) => all.includes(n)), KEPT.filter((n) => !all.includes(n)).join(", "));
  check("nothing kept is also on the workbench list", !KEPT.some((n) => tools.WORKBENCH_TOOLS.has(n)));

  // ---- on (the default)
  setEnabled(undefined);
  check("no workbench.enabled key = on", cfgMod.workbenchEnabled() === true);
  check("on: every tool is offered", tools.activeToolDefs().length === tools.toolDefs.length);
  check("on: the page is told the workbench is on", cfgMod.publicConfig().workbench_enabled === true);
  check("on: the system prompt carries the workbench coding rules", /WORKBENCH CODING/.test(cfgMod.systemPrompt()) && !/NO WORKBENCH/.test(cfgMod.systemPrompt()));
  check("on: workbench skills are listed", skills.list().some((s) => s.name === "browser") && skills.list().some((s) => s.name === "workbench-shell"));
  check("on: a browser request is hinted at the browser skill", /browser/.test(skills.hint("please log in to the website and click the checkout button") || ""));
  let sent = await toolsOfferedToTheModel();
  check("on: the model is offered run_shell and the browser tools", sent.includes("run_shell") && sent.includes("browser_goto") && sent.includes("serve_app"), sent.length + " tools");
  setEnabled(true);
  check("enabled: true = on", cfgMod.workbenchEnabled() === true);
  config.voice = { ...(config.voice || {}), stt_engine: "local" };
  check("on: local speech input stays available", cfgMod.publicConfig().voice.stt_engine === "local");

  // ---- off
  setEnabled(false);
  const before = dockerTouched;
  check("enabled: false = off", cfgMod.workbenchEnabled() === false);
  const active = names(tools.activeToolDefs());
  check("off: no workbench tool is offered", !active.some((n) => tools.WORKBENCH_TOOLS.has(n)), active.filter((n) => tools.WORKBENCH_TOOLS.has(n)).join(", "));
  check("off: exactly the workbench tools were removed", active.length === all.length - WB.length);
  check("off: memory, web, files, email, tasks, plans, vault stay", KEPT.every((n) => active.includes(n)), KEPT.filter((n) => !active.includes(n)).join(", "));
  sent = await toolsOfferedToTheModel();
  check("off: the request to the model carries none of them", sent.length > 0 && !sent.some((n) => tools.WORKBENCH_TOOLS.has(n)), sent.filter((n) => tools.WORKBENCH_TOOLS.has(n)).join(", "));
  check("off: …and still carries the rest", KEPT.filter((n) => n !== "delegate").every((n) => sent.includes(n)), KEPT.filter((n) => !sent.includes(n)).join(", "));
  const sp = cfgMod.systemPrompt();
  check("off: the system prompt says there is no workbench", /NO WORKBENCH/.test(sp) && /Config tab/.test(sp));
  check("off: …and drops the workbench coding rules", !/WORKBENCH CODING/.test(sp));
  check("off: the page is told to hide the Workbench tab", cfgMod.publicConfig().workbench_enabled === false);
  check("off: local speech input falls back to the browser engine", cfgMod.publicConfig().voice.stt_engine === "browser");

  let msg = await rejects(tools.execTool("run_shell", { command: "echo hi" }));
  check("off: run_shell is refused with a plain reason", !!msg && /turned off/.test(msg) && /Config/.test(msg), msg);
  msg = await rejects(tools.execTool("browser_goto", { url: "https://example.com" }));
  check("off: browser_goto is refused", !!msg && /turned off/.test(msg), msg);
  msg = await rejects(tools.execTool("screenshot", {}));
  check("off: screenshot is refused", !!msg && /turned off/.test(msg), msg);
  msg = await rejects(tools.execTool("read_document", { path: "/LLM_READ_WRITE_FILES/a.pdf" }));
  check("off: read_document is refused and points at read_file", !!msg && /turned off/.test(msg) && /read_file/.test(msg), msg);
  msg = await rejects(tools.runShell("echo hi"));
  check("off: the shell itself refuses (self-test, notifier, backups)", !!msg && /turned off/.test(msg), msg);
  check("off: stopping Autopilot's workbench jobs is a quiet no-op", (await rejects(tools.killWorkbenchJobs())) === null);
  check("off: none of that reached Docker", dockerTouched === before, `${dockerTouched - before} call(s)`);

  const listed = (await tools.execTool("list_skills", {})).map((s) => s.name);
  check("off: workbench skills are not listed", ![...skills.WORKBENCH_SKILLS].some((n) => listed.includes(n)), listed.filter((n) => skills.WORKBENCH_SKILLS.has(n)).join(", "));
  check("off: the other skills still are", ["memory", "internet", "email", "scheduling", "credentials"].every((n) => listed.includes(n)), listed.join(", "));
  msg = await rejects(tools.execTool("get_skill", { name: "browser" }));
  check("off: get_skill on a workbench skill explains why", !!msg && /turned off/.test(msg), msg);
  check("off: a non-workbench skill still opens", !!(await tools.execTool("get_skill", { name: "memory" })).details);
  check("off: no hint toward a workbench skill", !/browser|workbench-shell|web-preview/.test(skills.hint("please log in to the website, run the script and build me an app") || ""));
  check("off: other hints still work", /email/.test(skills.hint("check my inbox for unread email") || ""));

  // ---- back on
  setEnabled(true);
  check("back on: every tool is offered again", tools.activeToolDefs().length === tools.toolDefs.length);
  sent = await toolsOfferedToTheModel();
  check("back on: the model gets run_shell again", sent.includes("run_shell"));
  check("back on: the coding rules return", /WORKBENCH CODING/.test(cfgMod.systemPrompt()));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(failures ? `\nWORKBENCH: ${failures} FAILURE(S)` : "\nWORKBENCH: ALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("workbench test crashed:", e); process.exit(1); });
