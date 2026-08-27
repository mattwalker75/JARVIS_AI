#!/usr/bin/env node
"use strict";
// Regenerate Docs/tools.md from the LIVE tool definitions in app/src/tools.js, so the
// tools doc can never drift from the code (the old hand-written page said "~48 tools"
// while the code had 57). Run from the repo root:
//
//   node app/scripts/gen-tools-md.js
//
// Works on the host (no container needed): the config path is forced to a nonexistent
// file so no real config influences the output, and custom tools / MCP servers aren't
// loadable there — so the result is exactly the BUILT-IN toolset, with each tool's real
// name, signature, and the exact description the model sees. Re-run after adding or
// changing a tool and commit the diff.
process.env.JARVIS_CONFIG_FILE = "/nonexistent-doc-generation";
const fs = require("fs");
const path = require("path");

// tools.js requires dockerode at module level, but doc generation never talks to Docker —
// stub it so the script runs on the host even when app/node_modules is absent/partial
// (the real install lives in the container's anonymous volume).
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "dockerode") return function DockerStub() {};
  return origLoad.call(this, request, ...rest);
};

const { toolDefs } = require(path.join(__dirname, "..", "src", "tools"));

// Family grouping for the doc. A tool missing from every list still appears (in a
// trailing "Uncategorized" section) so nothing can silently vanish from the docs —
// add new tools to the right family here when you add them to tools.js.
const FAMILIES = [
  ["Memory (semantic long-term)",
    ["add_memory", "update_memory", "search_memory", "list_memories", "delete_memory"]],
  ["Workbench (root Linux shell)",
    ["run_shell", "write_workbench_file", "edit_workbench_file", "serve_app"]],
  ["Files (shared folders)",
    ["list_dir", "read_file", "read_document", "write_file", "edit_file", "append_log"]],
  ["Internet",
    ["fetch_url", "web_search"]],
  ["Browser (deterministic web control)",
    ["browser_goto", "browser_snapshot", "browser_click", "browser_fill", "browser_extract", "browser_console"]],
  ["Planning (task ledger) & Autopilot",
    ["plan_create", "plan_update", "plan_add_step", "plan_show", "plan_clear", "open_autopilot"]],
  ["Vision & desktop (computer use)",
    ["screenshot", "analyze_image", "ui_actions", "open_url", "open_app", "click", "double_click",
     "right_click", "move_mouse", "type_text", "press_key", "scroll"]],
  ["Email (the user's own account)",
    ["check_email", "read_email", "send_email"]],
  ["Scheduling & notifications",
    ["schedule_task", "list_tasks", "update_task", "cancel_task", "notify_user", "post_to_chat", "read_recent_chat"]],
  ["Credential vault",
    ["list_secrets", "get_secret", "set_secret", "delete_secret"]],
  ["Skills (playbook knowledge base)",
    ["list_skills", "get_skill"]],
];

const byName = new Map();
for (const d of toolDefs) {
  const f = d && d.function;
  if (f && f.name) byName.set(f.name, f);
}

function signature(f) {
  const props = (f.parameters && f.parameters.properties) || {};
  const required = new Set((f.parameters && f.parameters.required) || []);
  const parts = Object.keys(props).map((p) => (required.has(p) ? p : p + "?"));
  return `${f.name}(${parts.join(", ")})`;
}

function paramLines(f) {
  const props = (f.parameters && f.parameters.properties) || {};
  const required = new Set((f.parameters && f.parameters.required) || []);
  return Object.entries(props).map(([name, p]) => {
    const bits = [p.type || "any"];
    if (required.has(name)) bits.push("required");
    const desc = (p.description || "").trim();
    return `- \`${name}\` (${bits.join(", ")})${desc ? " — " + desc : ""}`;
  });
}

const out = [];
out.push("# Tools");
out.push("");
out.push("<!-- AUTO-GENERATED — do not edit by hand. Regenerate with:  node app/scripts/gen-tools-md.js -->");
out.push("");
out.push("The LLM calls tools to do real work. Every tool's schema (name, description,");
out.push("parameters) is sent to the model each turn; for deeper guidance the model consults");
out.push("[skills](extending.md#skills). Tools are defined and dispatched in `app/src/tools.js`");
out.push("(plus `app/src/email.js`, `app/src/mcp.js`, and the browser daemon");
out.push("`app/src/browserd.py`).");
out.push("");
out.push(`There are **${byName.size} built-in tools**, grouped by family below. The descriptions are`);
out.push("the exact text the model sees. [Custom tools](extending.md#custom-tools) and");
out.push("[MCP servers](extending.md#mcp-servers) add more at runtime (MCP tools appear as");
out.push("`mcp_<server>_<tool>`).");
out.push("");

const seen = new Set();
for (const [family, names] of FAMILIES) {
  const present = names.filter((n) => byName.has(n));
  if (!present.length) continue;
  out.push(`## ${family}`);
  out.push("");
  for (const n of present) {
    seen.add(n);
    const f = byName.get(n);
    out.push(`### \`${signature(f)}\``);
    out.push("");
    out.push((f.description || "").trim());
    const params = paramLines(f);
    if (params.length) { out.push(""); out.push(...params); }
    out.push("");
  }
}

const missing = [...byName.keys()].filter((n) => !seen.has(n));
if (missing.length) {
  out.push("## Uncategorized");
  out.push("");
  out.push("New tools not yet assigned a family in `app/scripts/gen-tools-md.js`:");
  out.push("");
  for (const n of missing) {
    const f = byName.get(n);
    out.push(`### \`${signature(f)}\``);
    out.push("");
    out.push((f.description || "").trim());
    out.push("");
  }
}

out.push("---");
out.push("");
out.push("Vault policy: JARVIS operates accounts **you already own**; it does not create");
out.push("accounts or bypass CAPTCHA / phone verification. See [Extending](extending.md) for");
out.push("adding custom tools, MCP servers, and email setup.");
out.push("");

const dest = path.join(__dirname, "..", "..", "Docs", "tools.md");
fs.writeFileSync(dest, out.join("\n"));
console.log(`wrote ${dest} — ${byName.size} tools across ${FAMILIES.length} families` +
  (missing.length ? ` (⚠ ${missing.length} uncategorized: ${missing.join(", ")})` : ""));
