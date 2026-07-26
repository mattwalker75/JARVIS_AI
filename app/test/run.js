"use strict";
// Test runner: executes every *.test.js in this directory as its own process (so their
// module stubs stay isolated) and reports a summary. Run with:  node app/test/run.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
const env = { ...process.env, JARVIS_CONFIG_FILE: process.env.JARVIS_CONFIG_FILE || path.join(dir, "..", "..", "JARVIS_CONFIG.json") };

let failed = 0;
for (const f of files) {
  console.log("\n=== " + f + " ===");
  try { execFileSync("node", [path.join(dir, f)], { stdio: "inherit", env }); }
  catch (_) { failed++; }
}
console.log(failed ? `\n${failed} of ${files.length} SUITE(S) FAILED` : `\n✅ ALL ${files.length} SUITES PASSED`);
process.exit(failed ? 1 : 0);
