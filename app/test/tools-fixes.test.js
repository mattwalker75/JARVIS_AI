"use strict";
// Fixes in tools.js / scheduler.js / autopilot.js / planner.js / mcp.js, in-process.
// No Docker and no model: 'dockerode' is replaced by a fake whose "workbench" runs each
// command with the local bash (so base64 writes/reads really happen on disk), and the LLM is
// a scripted stub. Everything lives in a temp dir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { PassThrough } = require("stream");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fixes-")));
process.env.JARVIS_AUDIT_FILE = path.join(tmp, "audit.log");
process.env.JARVIS_PLAN_FILE = path.join(tmp, "plan.json");
process.env.JARVIS_PLANS_DIR = path.join(tmp, "plans");
process.env.JARVIS_TASKS_FILE = path.join(tmp, "tasks.json");
process.env.JARVIS_TASK_RUNS_FILE = path.join(tmp, "task_runs.jsonl");
process.env.JARVIS_AUTOPILOT_FILE = path.join(tmp, "autopilot.json");
process.env.JARVIS_SECRETS_FILE = path.join(tmp, "secrets.json");
process.env.JARVIS_BACKUP_DIR = tmp;
process.env.JARVIS_LOG_DIR = tmp;
process.env.JARVIS_PROMPTS_DIR = path.join(tmp, "prompts");

// --- fake workbench: dockerode stub that runs the command locally --------------------
const execs = [];   // every script the "workbench" was asked to run
const ARG_MAX = 131072;   // Linux MAX_ARG_STRLEN — one bash argument can't be longer
const container = {
  exec: async (opts) => {
    const script = opts.Cmd[opts.Cmd.length - 1];
    execs.push(script);
    let exitCode = null;
    return {
      start: async () => {
        const stream = new PassThrough();
        if (Buffer.byteLength(script) > ARG_MAX) {
          setImmediate(() => { exitCode = 126; stream.end("bash: Argument list too long\n"); });
          return stream;
        }
        const child = spawn("bash", ["-c", script], { cwd: tmp });
        child.stdout.on("data", (d) => stream.write(d));
        child.stderr.on("data", (d) => stream.write(d));
        child.on("close", (code) => { exitCode = code; stream.end(); });
        return stream;
      },
      inspect: async () => ({ ExitCode: exitCode }),
    };
  },
  modem: { demuxStream: (stream, out) => stream.on("data", (d) => out.write(d)) },
};
const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "dockerode" ? "dockerode-stub" : _resolve.call(this, req, ...a); };
require.cache["dockerode-stub"] = { id: "dockerode-stub", loaded: true, exports: function Docker() { return { getContainer: () => container }; } };

// --- scripted LLM ---------------------------------------------------------------------
const SRC = path.join(__dirname, "..", "src");
const abs = (m) => require.resolve(path.join(SRC, m));
let llmBehavior = async () => "ok";
require.cache[abs("llm")] = { id: abs("llm"), loaded: true, exports: { chat: (o) => llmBehavior(o) } };

const cfgMod = require(abs("config"));
const config = cfgMod.config;
const ro = path.join(tmp, "ro"), rw = path.join(tmp, "rw"), outside = path.join(tmp, "outside");
for (const d of [ro, rw, outside]) fs.mkdirSync(d, { recursive: true });
config.shared = { read_only_dir: ro, read_write_dir: rw };
config.workbench = { ...(config.workbench || {}), enabled: true };
config.mcp = { servers: [] };

const tools = require(abs("tools"));
const scheduler = require(abs("scheduler"));
const planner = require(abs("planner"));
const mcp = require(abs("mcp"));

let fails = 0;
const check = (l, c, detail) => { console.log((c ? "  ✓ " : "  ✗ ") + l + (!c && detail ? " — " + detail : "")); if (!c) fails++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(40); } return false; };
const run = (name, args, ctx) => tools.execTool(name, args, undefined, ctx);

(async () => {
  // ---- 1. edit_workbench_file never reads the APP's own files ----
  {
    const secret = path.join(outside, "JARVIS_CONFIG.json");
    fs.writeFileSync(secret, '{"api_key":"sk-app-side"}');
    const inside = path.join(rw, "page.html");
    fs.writeFileSync(inside, "<p>hello</p>");
    execs.length = 0;
    const r = await run("edit_workbench_file", { path: inside, old_string: "hello", new_string: "hi" });
    check("1: a file in the shared folders is read app-side (no workbench read)", r.replacements === 1 && !execs.some((s) => s.includes("@@B64@@")));
    check("1: …and written back correctly", fs.readFileSync(inside, "utf8") === "<p>hi</p>");
    execs.length = 0;
    await run("edit_workbench_file", { path: secret, old_string: "sk-app-side", new_string: "sk-x" });
    check("1: a path outside the shared folders is read INSIDE the workbench", execs.some((s) => s.includes("@@B64@@")));
    fs.writeFileSync(secret, '{"api_key":"sk-app-side"}');
    const link = path.join(rw, "sneaky.json");
    fs.symlinkSync(secret, link);
    execs.length = 0;
    await run("edit_workbench_file", { path: link, old_string: "sk-app-side", new_string: "sk-y" });
    check("1: a symlink in a shared folder pointing outside is read in the workbench, not app-side", execs.some((s) => s.includes("@@B64@@")));
    // big file read through the workbench is not clipped/corrupted
    const bigOut = path.join(outside, "big.txt");
    const bigText = Array.from({ length: 6000 }, (_, i) => `line ${i} ✓`).join("\n");
    fs.writeFileSync(bigOut, bigText);
    await run("edit_workbench_file", { path: bigOut, old_string: "line 5999 ✓", new_string: "LAST" });
    check("1: a large file read via the workbench round-trips intact", fs.readFileSync(bigOut, "utf8") === bigText.replace("line 5999 ✓", "LAST"));
    const e = await rejects(run("edit_workbench_file", { path: path.join(outside, "nope.txt"), old_string: "a", new_string: "b" }));
    check("1: a missing file gives a plain error", /cannot read .*no such file/.test(e || ""), e);
  }

  // ---- 2. excluded tools are refused at run time ----
  {
    const e = await rejects(run("set_secret", { name: "x", password: "p" }, { excludeTools: ["set_secret"] }));
    check("2: an excluded tool is refused", e === "set_secret is not available in this run", e);
    check("2: …and did nothing", !cfgMod.getSecrets().x);
    const ok = await run("list_secrets", {}, { excludeTools: ["set_secret"] });
    check("2: other tools still run", Array.isArray(ok));
    // delegate: the sub-agent inherits the exclusions, and its usage reaches the parent emit (12)
    let subOpts = null; const parentEvents = [];
    llmBehavior = async (o) => { subOpts = o; o.emit({ type: "usage", model: "m", usage: { total_tokens: 42, context_tokens: 9000 }, cost_usd: 0.01 }); return "report"; };
    const r = await run("delegate", { task: "do a thing" }, { excludeTools: ["send_email"], emit: (ev) => parentEvents.push(ev) });
    check("2: delegate passes the caller's exclusions to the sub-agent", r.report === "report" && subOpts.excludeTools.includes("send_email") && subOpts.excludeTools.includes("delegate"));
    const u = parentEvents.find((ev) => ev.type === "usage");
    check("12: sub-agent usage is forwarded to the parent emit (without its context size)", u && u.usage.total_tokens === 42 && u.usage.context_tokens === undefined && /^sub▸/.test(u.model));
  }

  // ---- 3. no symlink escape for paths that don't exist yet ----
  {
    fs.symlinkSync(outside, path.join(rw, "escape"));
    let e = await rejects(run("write_file", { path: "escape/newdir/file.txt", content: "x" }));
    check("3: writing through a link to a new subfolder is refused", /must be under|only allowed under/.test(e || ""), e);
    check("3: …and nothing was created outside", !fs.existsSync(path.join(outside, "newdir")));
    fs.symlinkSync(path.join(outside, "ghost.txt"), path.join(rw, "dangling"));
    e = await rejects(run("write_file", { path: "dangling", content: "x" }));
    check("3: writing through a link to a missing file is refused", /doesn't exist — not following it/.test(e || ""), e);
    check("3: …and the target wasn't created", !fs.existsSync(path.join(outside, "ghost.txt")));
    const w = await run("write_file", { path: "a/b/c/new.txt", content: "fine" });
    check("3: a normal nested write still works", fs.readFileSync(path.join(rw, "a/b/c/new.txt"), "utf8") === "fine" && w.written);
  }

  // ---- 6. big workbench writes go in chunks ----
  {
    const target = path.join(outside, "huge.js");
    const content = "// " + "x".repeat(300 * 1024) + "\nconsole.log('é');\n";
    execs.length = 0;
    const r = await run("write_workbench_file", { path: target, content });
    check("6: a 300 KB file is written intact", fs.readFileSync(target, "utf8") === content && r.bytes === Buffer.byteLength(content));
    check("6: …in several commands, each under the argument limit", execs.length > 2 && execs.every((s) => Buffer.byteLength(s) < ARG_MAX));
    check("6: …and no temp part file is left behind", !fs.readdirSync(outside).some((f) => f.includes("jarvis-part")));
    fs.chmodSync(target, 0o755);
    await run("edit_workbench_file", { path: target, old_string: "console.log('é');", new_string: "console.log('done');" });
    check("6: editing a big file works and keeps its permissions", fs.readFileSync(target, "utf8").endsWith("console.log('done');\n") && (fs.statSync(target).mode & 0o111) !== 0);
  }

  // ---- 17. read_file / edit_file refuse files over 20 MB ----
  {
    const huge = path.join(rw, "huge.log");
    fs.writeFileSync(huge, "x"); fs.truncateSync(huge, 21 * 1024 * 1024);
    let e = await rejects(run("read_file", { path: "huge.log" }));
    check("17: read_file refuses a 21 MB file plainly", /too big to read .*20 MB/.test(e || ""), e);
    e = await rejects(run("edit_file", { path: "huge.log", old_string: "x", new_string: "y" }));
    check("17: edit_file refuses it too", /too big to edit/.test(e || ""), e);
  }

  // ---- 10. set_secret takes the email fields ----
  {
    await run("set_secret", { name: "email", username: "u@x.com", password: "pw", imap_host: "imap.x.com", imap_port: 143, smtp_host: "smtp.x.com", smtp_port: 587, from: "Me <u@x.com>" });
    const s = cfgMod.getSecrets().email;
    check("10: set_secret stores imap/smtp host+port and from", s.imap_host === "imap.x.com" && s.imap_port === 143 && s.smtp_host === "smtp.x.com" && s.smtp_port === 587 && s.from === "Me <u@x.com>");
    const def = tools.toolDefs.find((t) => t.function.name === "set_secret").function.parameters.properties;
    check("10: …and its schema lists them", ["imap_host", "imap_port", "smtp_host", "smtp_port", "from"].every((k) => def[k]));
  }

  // ---- 15. browser: no replay after a timeout ----
  {
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
    execs.length = 0;
    const e = await rejects(run("browser_click", { target: "e3" }));
    check("15: a timed-out browser click is not sent again and the daemon not restarted", calls === 1 && execs.length === 0 && /may or may not have happened/.test(e || ""), e);
    global.fetch = realFetch;
  }

  // ---- 19. planner auto-advance ----
  {
    const K = "fixes";
    planner.create({ objective: "o", steps: ["a", "b", "c", "d"] }, K);
    let p = planner.updateStep({ step: 3, status: "done" }, K);
    check("19: finishing a later step keeps the active step (no second active)", p.steps[0].status === "active" && p.steps[3].status === "pending" && p.steps.filter((s) => s.status === "active").length === 1);
    p = planner.updateStep({ step: 1, status: "done" }, K);
    check("19: finishing the active step activates the next pending one AFTER it", p.steps[1].status === "active" && p.steps[3].status === "pending");
    p = planner.updateStep({ step: 2, status: "done" }, K);
    check("19: …skipping steps already done", p.steps[3].status === "active");
    planner.clear(K);
  }

  // ---- 16 + 11. MCP: re-initialize on 404, no duplicate tools from overlapping inits ----
  {
    let inits = 0, sessionN = 0, expired = false;
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const m = JSON.parse(body || "{}");
        const sid = req.headers["mcp-session-id"];
        if (m.method === "initialize") { inits++; sessionN++; res.setHeader("mcp-session-id", "s" + sessionN); }
        else if (expired && sid === "s" + (sessionN)) { expired = false; res.statusCode = 404; return res.end("session not found"); }
        if (!m.id) { res.statusCode = 202; return res.end(); }
        res.setHeader("content-type", "application/json");
        const result = m.method === "tools/list" ? { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] }
          : m.method === "tools/call" ? { content: [{ type: "text", text: "pong" }] } : {};
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise((r) => srv.listen(18261, "127.0.0.1", r));
    config.mcp = { servers: [{ name: "t", url: "http://127.0.0.1:18261/mcp" }] };
    const [a, b] = await Promise.all([mcp.init(), mcp.reload()]);
    check("11: overlapping MCP init + reload publish the tools once", a === null && Array.isArray(b) && b.length === 1, JSON.stringify([a && a.length, b && b.length]));
    const before = inits;
    expired = true;
    const r = await mcp.call("mcp_t_echo", {});
    check("16: a 404 for an expired session re-initializes and retries once", r.result === "pong" && inits === before + 1);
    srv.close(); config.mcp = { servers: [] };
  }

  // ---- scheduler (5, 9, 13, 14) ----
  config.workbench.enabled = false;   // keep notify-send out of it
  const notes = [];
  scheduler.setNotifyCallback((n) => notes.push(n));
  {
    const at = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const r = scheduler.schedule({ prompt: "p5", every_seconds: 60, at });
    check("5: every_seconds + at → the first run is at", r.next_run === new Date(Date.parse(at)).toISOString() && r.type === "recurring");
    scheduler.cancel(r.id);
  }
  // 9: a task scheduled by ANOTHER process (the CLI) is picked up, not overwritten
  {
    const childCode = `const s = require(${JSON.stringify(abs("scheduler"))}); s.schedule({ prompt: "from-cli", in_seconds: 0, label: "cli" }); process.exit(0);`;
    execFileSync(process.execPath, ["-e", childCode], { env: process.env });
    scheduler.pushNotification({ message: "server-side mutation" });   // server saves right after
    await sleep(400);
    check("9: the server sees the CLI's task", scheduler.list().some((t) => t.prompt === "from-cli"));
    const onDisk = JSON.parse(fs.readFileSync(process.env.JARVIS_TASKS_FILE, "utf8"));
    check("9: …and its own save keeps it in tasks.json", onDisk.tasks.some((t) => t.prompt === "from-cli"));
  }
  const ran = [];
  let retimeTo = null;
  llmBehavior = async (o) => {
    const prompt = o.messages[1].content; ran.push(prompt);
    if (prompt === "p13") { scheduler.update({ id: retimeTo.id, in_seconds: 100 }); return "ok"; }
    if (prompt === "p14") throw new Error("model unreachable");
    return "fine";
  };
  scheduler.start();
  check("9: the CLI's task actually runs", await until(() => ran.includes("from-cli"), 8000));
  {
    retimeTo = scheduler.schedule({ prompt: "p13", every_seconds: 3600, in_seconds: 0 });
    const t14 = scheduler.schedule({ prompt: "p14", in_seconds: 0, label: "fails" });
    await until(() => ran.includes("p13") && ran.includes("p14"), 8000);
    await until(() => !scheduler.list().some((t) => t.id === retimeTo.id && t.status === "running"), 4000);
    await sleep(300);
    const t = scheduler.list().find((x) => x.id === retimeTo.id);
    const dt = Date.parse(t.next_run) - Date.now();
    check("13: a run_at changed while the task ran is kept (not advanced by the interval)", dt > 80000 && dt < 101000, String(dt));
    const mine = notes.filter((n) => n.task_id === t14.id);
    check("14: a failed one-shot sends only the error notice", mine.length === 1 && mine[0].level === "error", JSON.stringify(mine.map((n) => n.message)));
  }

  // ---- autopilot (7, 8) ----
  const ap = require(abs("autopilot"));
  ap.setBroadcast(() => {});
  const apNotes = () => notes.filter((n) => n.label === "Autopilot");
  // 7: a force-stopped run's wedged cycle must not keep going alongside the next run
  {
    let activeB = 0, maxActiveB = 0; const calls = [];
    let releaseA;
    llmBehavior = (o) => {
      const obj = /«(.*?)»/.exec(o.messages[1].content); calls.push(obj ? obj[1] : "?");
      if (calls.length === 1) return new Promise((res) => { releaseA = () => res("A done"); });   // ignores abort (wedged)
      activeB++; maxActiveB = Math.max(maxActiveB, activeB);
      return new Promise((res, rej) => { const t = setTimeout(() => { activeB--; res("B cycle"); }, 300); o.signal.addEventListener("abort", () => { clearTimeout(t); activeB--; rej(new Error("aborted")); }); });
    };
    ap.start({ objective: "RUN-A", minutes: 60, autonomy: "full" });
    await sleep(100);
    ap.forceStop();
    ap.start({ objective: "RUN-B", minutes: 60, autonomy: "full" });
    await sleep(100);
    releaseA();
    await sleep(900);
    check("7: the force-stopped loop exits — the new run never has two cycles at once", maxActiveB === 1, `maxActiveB=${maxActiveB}`);
    check("7: …and it never starts another cycle of its own", calls.filter((c) => c === "RUN-A").length === 1 && ap.status().objective === "RUN-B" && ap.status().cycles >= 1, JSON.stringify(calls));
    ap.forceStop(); ap.dismiss();
  }
  // 8: Stop while a Pause is still pending → stopped (not paused)
  {
    notes.length = 0;
    llmBehavior = (o) => new Promise((res, rej) => { o.signal.addEventListener("abort", () => setTimeout(() => rej(new Error("aborted")), 150)); });
    ap.start({ objective: "PS", minutes: 60, autonomy: "full" });
    await sleep(100);
    ap.pause();
    ap.requestStop();
    await until(() => apNotes().length > 0, 3000);
    check("8: Stop during a pending pause ends the run as stopped", ap.status().status === "stopped" && /stopped/.test((apNotes()[0] || {}).message || ""), ap.status().status);
    ap.dismiss();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\nTOOLS-FIXES: ${fails} FAILURE(S)` : "\nTOOLS-FIXES: ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("TOOLS-FIXES CRASH:", e); process.exit(1); });
