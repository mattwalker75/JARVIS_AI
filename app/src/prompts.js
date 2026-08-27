"use strict";
// Single home for the prompt-set FILE logic — previously duplicated between config.js
// (reading the active files + activePromptName) and server.js (the /api/prompts routes).
//
// A prompt SET is two editable files in /Prompts:
//   <name>_master.prompt   identity / mission (short, stable)
//   <name>_system.prompt   detailed operating instructions
// The ACTIVE prompt is the "default" set (default_master/default_system) — read live
// every turn, so edits apply on the next turn without a restart. "stock" is the
// protected copy of the original defaults.
const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = process.env.JARVIS_PROMPTS_DIR || "/Prompts";

// Validate a user-supplied set name (route param → filename; no separators/traversal).
function safeName(n) { n = String(n || "").trim(); return /^[\w.\- ]{1,80}$/.test(n) ? n : null; }

// Read one part of a set. Returns null when the file is absent — callers that need a
// string default use `|| ""`; config.js uses the null to fall back to the config values.
function readPart(name, part) {
  try { return fs.readFileSync(path.join(PROMPTS_DIR, `${name}_${part}.prompt`), "utf8"); }
  catch (_) { return null; }
}

function writeSet(name, master, system) {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROMPTS_DIR, `${name}_master.prompt`), String(master || ""));
  fs.writeFileSync(path.join(PROMPTS_DIR, `${name}_system.prompt`), String(system || ""));
}

function deleteSet(name) {
  for (const part of ["master", "system"]) {
    fs.rmSync(path.join(PROMPTS_DIR, `${name}_${part}.prompt`), { force: true });
  }
}

// Unique saved-set names (excluding the live "default" slot).
function listSetNames() {
  try {
    return [...new Set(fs.readdirSync(PROMPTS_DIR)
      .map((f) => (f.match(/^(.+)_(?:master|system)\.prompt$/) || [])[1])
      .filter(Boolean))]
      .filter((n) => n !== "default")
      .sort();
  } catch (_) { return []; }
}

const norm = (s) => String(s || "").replace(/\r\n/g, "\n").trim();

// Which SAVED set's content equals the active default_* files — i.e. the name of the
// prompt in use. null = the active default is a custom/hand-edited one. Read live
// (small files), so it reflects the current prompt without a restart.
function activePromptName() {
  const dm = norm(readPart("default", "master")), ds = norm(readPart("default", "system"));
  for (const n of listSetNames()) {
    if (norm(readPart(n, "master")) === dm && norm(readPart(n, "system")) === ds) return n;
  }
  return null;
}

module.exports = { PROMPTS_DIR, safeName, readPart, writeSet, deleteSet, listSetNames, activePromptName };
