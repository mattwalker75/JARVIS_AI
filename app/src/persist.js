"use strict";
// Small persistence helpers used by scheduler/chatlog/sessions. The key guarantee is
// ATOMIC writes: write to a temp file then rename (rename is atomic on the same
// filesystem), so a crash mid-write can never leave a truncated/corrupt JSON file that
// would make the app silently boot with empty state.
const fs = require("fs");
const path = require("path");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, obj, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  fs.renameSync(tmp, file); // atomic swap
}

module.exports = { readJson, writeJsonAtomic };
