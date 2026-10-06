"use strict";
// Automatic memory + workspace backups. The manual commands (`JARVIS.sh
// --backup-memory` / `--backup-workspace`) only protect you if you remember to run
// them; this runs them on a schedule from INSIDE the app: tar is exec'd in the
// source container (memory sidecar / workbench) and streamed into /data/backups/
// (bind-mounted, so the tarballs land on the host and survive --delete).
//
// Config (JARVIS_CONFIG.json):
//   "backups": { "retain": 10,
//     "auto": { "enabled": false, "every_hours": 24, "keep": 7 } }
//
// Off by default. Checked every 15 minutes against the last-run stamp in
// /data/autobackup.json, so an app restart never causes a missed or double run.
const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const persist = require("./persist");
const log = require("./logger");

const STATE_FILE = process.env.JARVIS_AUTOBACKUP_FILE || "/data/autobackup.json";
const BACKUP_DIR = process.env.JARVIS_AUTOBACKUP_DIR || "/data/backups";
const CHECK_MS = 15 * 60 * 1000;

function cfg() {
  const b = (config.backups && config.backups.auto) || {};
  return {
    enabled: b.enabled === true,
    everyMs: Math.max(1, Number(b.every_hours) || 24) * 3600000,
    keep: Math.max(1, Number(b.keep) || 7),
  };
}

// Exec `cmd` in a container and stream its stdout to a file (docker's multiplexed
// stream is demuxed so the tarball isn't corrupted by frame headers).
// A tar that hangs (a stuck container, a wedged filesystem) must not hold the backup — and the
// in-flight flag below — forever. JARVIS_AUTOBACKUP_TIMEOUT_MS overrides it (tests).
const EXEC_TIMEOUT_MS = Number(process.env.JARVIS_AUTOBACKUP_TIMEOUT_MS) || 10 * 60 * 1000;
function execToFile(containerName, cmd, outFile) {
  const { docker } = require("./tools");
  const container = docker.getContainer(containerName);
  return new Promise((resolve, reject) => {
    let stream = null, out = null, settled = false;
    const finish = (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (err) {
        try { if (stream) stream.destroy(); } catch (_) {}
        try { if (out) out.destroy(); } catch (_) {}   // release the half-written file so it can be removed
        reject(err);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`the backup took longer than ${Math.round(EXEC_TIMEOUT_MS / 60000)} minutes and was stopped`)), EXEC_TIMEOUT_MS);
    container.exec({ Cmd: ["sh", "-c", cmd], AttachStdout: true, AttachStderr: true }, (err, exec) => {
      if (err) return finish(err);
      if (settled) return;
      exec.start({ hijack: true, stdin: false }, (err2, s) => {
        if (err2) return finish(err2);
        stream = s;
        if (settled) { try { stream.destroy(); } catch (_) {} return; }
        out = fs.createWriteStream(outFile, { flags: "wx" });   // never overwrite an existing backup
        let errBuf = "";
        container.modem.demuxStream(stream, out, { write: (c) => { errBuf += c.toString("utf8").slice(0, 500); } });
        stream.on("end", () => out.end());
        stream.on("error", (e) => finish(e));
        out.on("finish", async () => {
          let code = null;
          try { code = (await exec.inspect()).ExitCode; } catch (_) {}
          if (code) return finish(new Error(`exit ${code}: ${errBuf.slice(0, 300)}`));
          finish();
        });
        out.on("error", (e) => finish(e));
      });
    });
  });
}

function prune(prefix, keep) {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".tgz")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
}

// One backup run at a time: the scheduled check and the "Back up now" button (or two clicks)
// would otherwise run two tars into the same folder at once.
let running = false;
async function runBackups() {
  if (running) { const e = new Error("A backup is already running. Wait for it to finish, then try again."); e.status = 409; throw e; }
  running = true;
  try { return await runBackupsOnce(); }
  finally { running = false; }
}
/** A file name in BACKUP_DIR that doesn't exist yet: <prefix><ts>.tgz, else <prefix><ts>-2.tgz, -3 … */
function uniqueFile(prefix, ts) {
  let file = path.join(BACKUP_DIR, `${prefix}${ts}.tgz`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(BACKUP_DIR, `${prefix}${ts}-${n}.tgz`);
  return file;
}
async function runBackupsOnce() {
  const { keep } = cfg();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const wb = (config.workbench && config.workbench.container) || "jarvis-workbench";
  const jobs = [["jarvis-memory-auto-", "jarvis-memory", "tar czf - -C /data ."]];
  const results = [];
  // The workspace is archived from inside the workbench container, so with the workbench
  // turned off (its container is stopped) that half is skipped rather than reported as a failure.
  if (require("./config").workbenchEnabled()) jobs.push(["jarvis-workspace-auto-", wb, "tar czf - -C /LLM_WORKSPACE ."]);
  else results.push("jarvis-workspace skipped (workbench is off)");
  for (const [prefix, containerName, cmd] of jobs) {
    const file = uniqueFile(prefix, ts);
    try {
      await execToFile(containerName, cmd, file);
      const mb = (fs.statSync(file).size / 1048576).toFixed(1);
      prune(prefix, keep);
      results.push(`${prefix.replace(/-auto-$/, "")} ${mb}MB`);
    } catch (e) {
      if (e.code !== "EEXIST") { try { fs.rmSync(file, { force: true }); } catch (_) {} }   // never remove a file this run didn't write
      results.push(`${prefix.replace(/-auto-$/, "")} FAILED (${e.message})`);
      log.warn("backup", `auto-backup of ${containerName} failed: ${e.message}`);
    }
  }
  return results;
}

let timer = null;
async function check() {
  const c = cfg();
  if (!c.enabled) return;
  const st = persist.readJson(STATE_FILE, {}) || {};
  if (st.last && Date.now() - st.last < c.everyMs) return;
  persist.writeJsonAtomic(STATE_FILE, { last: Date.now() });   // stamp first: a crash mid-backup shouldn't hot-loop
  log.info("backup", "running scheduled memory + workspace backups");
  const results = await runBackups();
  const failed = results.some((r) => r.includes("FAILED"));
  try {
    require("./scheduler").pushNotification({
      level: failed ? "warning" : "info", label: "Auto-backup",
      message: `Scheduled backup ${failed ? "had failures" : "completed"}: ${results.join(", ")} → data/backups/`,
    });
  } catch (_) {}
}

function start() {
  if (timer) return;
  timer = setInterval(() => { check().catch((e) => log.warn("backup", "auto-backup check failed: " + e.message)); }, CHECK_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => { check().catch(() => {}); }, 60000);   // first check a minute after boot
}

module.exports = { start, runBackups, check };
