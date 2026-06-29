"use strict";
// JARVIS command-line interface. Runs the same tool-calling LLM loop as the web
// app. Invoked via `docker exec` from JARVIS.sh.
//
//   node cli.js --interactive        interactive terminal chat (keeps history)
//   node cli.js --prompt <text>      one-shot; also reads piped stdin
//
// The final answer goes to stdout (pipe-friendly); tool activity goes to stderr.
const readline = require("readline");
const llm = require("./src/llm");
const { systemPrompt } = require("./src/config");
const sessions = require("./src/sessions");

const SYSTEM = systemPrompt();

function truncate(s, n = 160) { s = s || ""; return s.length > n ? s.slice(0, n) + "…" : s; }
function toolEmit(ev) {
  if (ev.type === "tool") process.stderr.write(`  [tool] ${ev.tool} ${truncate(JSON.stringify(ev.input))}\n`);
  else if (ev.type === "tool_result") process.stderr.write(`  [ -> ] ${ev.tool} ${truncate(typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output))}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function runOnce(prompt, piped) {
  let content = prompt || "";
  if (piped && piped.trim()) content += "\n\n--- piped input below ---\n" + piped;
  if (!content.trim()) { process.stderr.write("Nothing to do: no prompt and no piped input.\n"); process.exit(2); }
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content }];
  try {
    const reply = await llm.chat({ messages, emit: toolEmit });
    // Exit explicitly once stdout is flushed (open DB/socket pools would otherwise keep us alive).
    process.stdout.write((reply || "") + "\n", () => process.exit(0));
  } catch (e) {
    process.stderr.write("JARVIS error: " + e.message + "\n");
    process.exit(1);
  }
}

async function interactive() {
  const history = [];
  let currentId = null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  process.stdout.write('JARVIS terminal. Type a message and press Enter.\n  /exit  /reset  /sessions  /save [name]  /load <id>  /tasks  /notes\n');
  rl.prompt();
  // Live feed: surface scheduled-task notifications as they arrive in the server.
  let lastNoteId = null, seeded = false;
  const poll = setInterval(async () => {
    try {
      const ns = await (await fetch("http://localhost:80/api/notifications")).json();
      if (!seeded) { lastNoteId = ns.length ? ns[ns.length - 1].id : null; seeded = true; return; }
      const idx = lastNoteId ? ns.findIndex((n) => n.id === lastNoteId) : -1;
      const fresh = idx >= 0 ? ns.slice(idx + 1) : (lastNoteId ? [] : ns);
      if (fresh.length) {
        fresh.forEach((n) => process.stdout.write(`\n🔔 ${n.message}\n`));
        lastNoteId = ns[ns.length - 1].id;
        rl.prompt(true);
      }
    } catch (_) {}
  }, 5000);
  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") return rl.close();
    if (text === "/reset") { history.length = 0; currentId = null; process.stdout.write("(history cleared)\n"); return rl.prompt(); }
    if (text === "/sessions") {
      const ls = sessions.list();
      process.stdout.write(ls.length ? ls.map((s) => `  ${s.id}  ${s.name}  (${s.count} msgs)`).join("\n") + "\n" : "(no saved sessions)\n");
      return rl.prompt();
    }
    if (text === "/save" || text.startsWith("/save ")) {
      const name = text.slice(5).trim() || undefined;
      const r = sessions.save({ id: currentId, name, messages: history }); currentId = r.id;
      process.stdout.write(`(saved ${r.id}: ${r.name})\n`); return rl.prompt();
    }
    if (text.startsWith("/load ")) {
      try { const d = sessions.get(text.slice(6).trim()); history.length = 0; (d.messages || []).forEach((m) => history.push({ role: m.role, content: m.content })); currentId = d.id;
        process.stdout.write(`(loaded ${d.id}: ${d.name}, ${d.messages.length} messages — continuing)\n`); }
      catch (e) { process.stdout.write("load failed: " + e.message + "\n"); }
      return rl.prompt();
    }
    if (text === "/tasks") {
      try {
        const ts = await (await fetch("http://localhost:80/api/tasks")).json();
        process.stdout.write(ts.length
          ? ts.map((t) => `  ${t.id} [${t.type}] ${t.label || t.prompt} (runs ${t.runs})` + (t.last_result ? `\n     last: ${String(t.last_result).replace(/\n/g, " ").slice(0, 200)}` : "")).join("\n") + "\n"
          : "(no active tasks)\n");
      } catch (e) { process.stdout.write("could not fetch tasks: " + e.message + "\n"); }
      return rl.prompt();
    }
    if (text === "/notes" || text === "/notifications") {
      try {
        const ns = await (await fetch("http://localhost:80/api/notifications")).json();
        const recent = ns.slice(-10);
        process.stdout.write(recent.length
          ? recent.map((n) => `  [${new Date(n.at).toLocaleTimeString()}] ${String(n.message).replace(/\n/g, " ")}`).join("\n") + "\n"
          : "(no notifications yet)\n");
      } catch (e) { process.stdout.write("could not fetch notifications: " + e.message + "\n"); }
      return rl.prompt();
    }
    if (!text) return rl.prompt();
    rl.pause();
    history.push({ role: "user", content: text });
    try {
      const reply = await llm.chat({ messages: [{ role: "system", content: SYSTEM }, ...history], emit: toolEmit });
      process.stdout.write("\nJARVIS> " + (reply || "") + "\n\n");
      history.push({ role: "assistant", content: reply || "" });
    } catch (e) {
      process.stderr.write("JARVIS error: " + e.message + "\n");
    }
    rl.resume();
    rl.prompt();
  });
  rl.on("close", () => { clearInterval(poll); process.stdout.write("Goodbye.\n"); process.exit(0); });
}

const args = process.argv.slice(2);
if (args[0] === "--interactive") {
  interactive();
} else if (args[0] === "--prompt") {
  const prompt = args.slice(1).join(" ");
  readStdin().then((piped) => runOnce(prompt, piped));
} else {
  process.stderr.write("usage: node cli.js --interactive | --prompt <text>\n");
  process.exit(2);
}
