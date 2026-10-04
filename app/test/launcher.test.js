"use strict";
// ./JARVIS.sh and the optional workbench (workbench.enabled): what the launcher asks Docker
// to do when the workbench is on, off, running or not. Runs the REAL script from a scratch
// copy of the repo layout, with a FAKE `docker` (and `curl`) first on PATH that records every
// call and keeps a tiny "is the workbench running" state — so no Docker is needed and
// nothing real is touched. Needs bash + python3 (the script reads the config with python3).
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-launcher-"));
const bin = path.join(tmp, "bin"), root = path.join(tmp, "repo");
fs.mkdirSync(bin); fs.mkdirSync(path.join(root, "config"), { recursive: true }); fs.mkdirSync(path.join(root, "data"));
fs.copyFileSync(path.join(REPO, "JARVIS.sh"), path.join(root, "JARVIS.sh"));
fs.copyFileSync(path.join(REPO, "docker-compose.yml"), path.join(root, "docker-compose.yml"));
const LOG = path.join(tmp, "docker.log"), STATE = path.join(tmp, "state");
const exe = (name, body) => { fs.writeFileSync(path.join(bin, name), body); fs.chmodSync(path.join(bin, name), 0o755); };
// state file: one word per line — "wb-running", "wb-image"
exe("docker", `#!/usr/bin/env bash
echo "$*" >> "${LOG}"
has() { grep -qx "$1" "${STATE}" 2>/dev/null; }
set_on() { has "$1" || echo "$1" >> "${STATE}"; }
set_off() { grep -vx "$1" "${STATE}" > "${STATE}.n" 2>/dev/null; mv "${STATE}.n" "${STATE}"; }
case "$1" in
  info|version) exit 0 ;;
  inspect) case "$*" in *jarvis-workbench*) has wb-running && echo true || echo false ;; *) echo true ;; esac; exit 0 ;;
  image) has wb-image && exit 0 || exit 1 ;;
  port) echo "127.0.0.1:8110"; exit 0 ;;
  stop) case "$*" in *jarvis-workbench*) set_off wb-running ;; esac; exit 0 ;;
  exec) exit 0 ;;
  compose)
    case "$*" in
      *"--profile workbench"*" up -d"*) set_on wb-running; set_on wb-image ;;
      *" rm -sf jarvis-workbench"*) set_off wb-running ;;
      *" stop"*|*" down "*) set_off wb-running ;;
    esac
    exit 0 ;;
esac
exit 0
`);
exe("curl", `#!/usr/bin/env bash\nprintf 200\n`);

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "  ✓ " : "  ✗ ") + label + (!cond && detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); if (!cond) failures++; };
function setup({ enabled, running, image = true }) {
  const wb = { container: "jarvis-workbench", desktop_url: "http://localhost:8111", base_image: "" };
  if (enabled !== undefined) wb.enabled = enabled;
  fs.writeFileSync(path.join(root, "config", "JARVIS_CONFIG.json"), JSON.stringify({ llm: { provider: "mock" }, workbench: wb, search: { provider: "duckduckgo" } }, null, 2));
  fs.writeFileSync(STATE, [running ? "wb-running" : "", image ? "wb-image" : ""].filter(Boolean).join("\n") + "\n");
  fs.writeFileSync(LOG, "");
}
function run(...flags) {
  const r = spawnSync("bash", [path.join(root, "JARVIS.sh"), ...flags], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: "utf8", timeout: 60000 });
  const calls = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || ""), calls, compose: calls.filter((c) => c.startsWith("compose ")).map((c) => c.replace(/^compose -f \S+ /, "")) };
}
const wbRunning = () => fs.readFileSync(STATE, "utf8").split("\n").includes("wb-running");
const any = (list, re) => list.some((c) => re.test(c));

// ---- --setup
setup({ enabled: undefined, running: false });
let r = run("--setup");
check("setup, no key in the config: the workbench image is built", r.rc === 0 && any(r.compose, /^--profile workbench build .*jarvis-workbench/), r.compose);
setup({ enabled: false, running: false });
r = run("--setup");
check("setup, workbench off: its image is skipped", r.rc === 0 && any(r.compose, /^build jarvis-app jarvis-memory jarvis-piper$/) && !any(r.compose, /jarvis-workbench/), r.compose);
check("…and the script says why", /workbench is turned off/i.test(r.out), r.out.slice(-300));

// ---- --start
setup({ enabled: true, running: false });
r = run("--start");
check("start, workbench on: the stack comes up with the workbench profile", r.rc === 0 && any(r.compose, /^--profile workbench up -d$/) && wbRunning(), r.compose);
check("…and prints the desktop URL", /Workbench desktop:.*localhost:8111/.test(r.out));
setup({ enabled: false, running: false });
r = run("--start");
check("start, workbench off: the stack comes up WITHOUT the workbench", r.rc === 0 && any(r.compose, /^up -d$/) && !any(r.compose, /workbench/) && !wbRunning(), r.compose);
check("…says the workbench is off, and prints no desktop URL", /Workbench:.*off/.test(r.out) && !/Workbench desktop:/.test(r.out), r.out.slice(-600));
setup({ enabled: false, running: true });
r = run("--start");
check("start, off but still running from before: it is stopped", r.rc === 0 && any(r.calls, /^stop jarvis-workbench$/) && !wbRunning(), r.calls);

// ---- --reload (how a Config-tab change is applied from the terminal)
setup({ enabled: false, running: true });
r = run("--reload");
check("reload, switched off: the workbench container is stopped", r.rc === 0 && any(r.calls, /^stop jarvis-workbench$/) && !wbRunning(), r.calls);
check("…the app is restarted as usual", any(r.compose, /^restart jarvis-app$/), r.compose);
setup({ enabled: true, running: false });
r = run("--reload");
check("reload, switched on: the workbench container is started", r.rc === 0 && any(r.compose, /^--profile workbench up -d jarvis-workbench$/) && wbRunning(), r.compose);
check("…with no build warning when the image exists", !/has not been built yet/.test(r.out));
setup({ enabled: true, running: false, image: false });
r = run("--reload");
check("reload, switched on, image never built: warns that it will build", r.rc === 0 && /has not been built yet/.test(r.out) && wbRunning(), r.out.slice(-400));
setup({ enabled: true, running: true });
r = run("--reload");
check("reload, on and already running: the workbench is left alone", r.rc === 0 && !any(r.calls, /^stop /) && !any(r.compose, /up -d jarvis-workbench/) && wbRunning(), r.calls);
setup({ enabled: false, running: false });
r = run("--reload");
check("reload, off and already stopped: nothing to do", r.rc === 0 && !any(r.calls, /^stop /) && !any(r.compose, /workbench/), r.calls);

// ---- --status
setup({ enabled: false, running: false });
r = run("--status");
check("status, off: shown as off, not as a failure", r.rc === 0 && /workbench\s+\(jarvis-workbench\): off/.test(r.out), r.out.slice(0, 500));
setup({ enabled: false, running: true });
r = run("--status");
check("status, off but still running: says to reload", /running, but turned off in the config/.test(r.out) && /--reload/.test(r.out), r.out.slice(0, 500));
setup({ enabled: true, running: true });
r = run("--status");
check("status, on: running", /workbench\s+\(jarvis-workbench\):.*running/.test(r.out) && !/turned off/.test(r.out), r.out.slice(0, 500));
check("status lists the optional containers too", any(r.compose, /^--profile search --profile workbench ps$/), r.compose);

// ---- --stop / --delete always cover the workbench, whatever the switch says
setup({ enabled: false, running: true });
r = run("--stop");
check("stop, workbench off but running: it is stopped with the rest", r.rc === 0 && any(r.compose, /^--profile search --profile workbench stop$/) && !wbRunning(), r.compose);
setup({ enabled: false, running: true });
r = run("--delete", "--force");
check("delete covers the workbench container and its volume", r.rc === 0 && any(r.compose, /^--profile search --profile workbench down -v --remove-orphans$/), r.compose);

// ---- --reset-workbench
setup({ enabled: false, running: false });
r = run("--reset-workbench");
check("reset-workbench, off: refused with a plain reason", r.rc !== 0 && /turned off/.test(r.out) && !any(r.compose, /rm -sf|up -d/), r.out.slice(-300));
setup({ enabled: true, running: true });
r = run("--reset-workbench");
check("reset-workbench, on: the container is re-created", r.rc === 0 && any(r.compose, /^--profile workbench rm -sf jarvis-workbench$/) && any(r.compose, /^--profile workbench up -d jarvis-workbench$/) && wbRunning(), r.compose);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(failures ? `\nLAUNCHER: ${failures} FAILURE(S)` : "\nLAUNCHER: ALL PASSED");
process.exit(failures ? 1 : 0);
