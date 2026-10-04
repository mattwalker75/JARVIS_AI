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
function execToFile(containerName, cmd, outFile) {
  const { docker } = require("./tools");
  const container = docker.getContainer(containerName);
  return new Promise((resolve, reject) => {
    container.exec({ Cmd: ["sh", "-c", cmd], AttachStdout: true, AttachStderr: true }, (err, exec) => {
      if (err) return reject(err);
      exec.start({ hijack: true, stdin: false }, (err2, stream) => {
        if (err2) return reject(err2);
        const out = fs.createWriteStream(outFile);
        let errBuf = "";
        container.modem.demuxStream(stream, out, { write: (c) => { errBuf += c.toString("utf8").slice(0, 500); } });
        stream.on("end", () => out.end());
        stream.on("error", reject);
        out.on("finish", async () => {
          let code = null;
          try { code = (await exec.inspect()).ExitCode; } catch (_) {}
          if (code) return reject(new Error(`exit ${code}: ${errBuf.slice(0, 300)}`));
          resolve();
        });
        out.on("error", reject);
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

async function runBackups() {
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
    const file = path.join(BACKUP_DIR, `${prefix}${ts}.tgz`);
    try {
      await execToFile(containerName, cmd, file);
      const mb = (fs.statSync(file).size / 1048576).toFixed(1);
      prune(prefix, keep);
      results.push(`${prefix.replace(/-auto-$/, "")} ${mb}MB`);
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch (_) {}
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
