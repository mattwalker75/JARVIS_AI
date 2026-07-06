"use strict";
// Saved conversations ("sessions"). Each is a JSON file under data/sessions so it
// can be exported, version-controlled, or moved around. Used to continue where
// you left off and to iterate on the model/prompt against a fixed conversation.
const fs = require("fs");
const path = require("path");
const persist = require("./persist");

const DIR = process.env.JARVIS_SESSIONS_DIR || "/data/sessions";

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }
function genId() { return "s" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }
function fileFor(id) { return path.join(DIR, path.basename(String(id)) + ".json"); }

function sanitize(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function save({ id, name, messages }) {
  ensure();
  const sid = id ? path.basename(String(id)) : genId();
  const now = Date.now();
  let created = now;
  const fp = fileFor(sid);
  if (fs.existsSync(fp)) { try { created = JSON.parse(fs.readFileSync(fp, "utf8")).created_at || now; } catch (_) {} }
  const doc = {
    id: sid,
    name: name || ("Session " + new Date(now).toLocaleString()),
    created_at: created, updated_at: now,
    messages: sanitize(messages),
  };
  persist.writeJsonAtomic(fp, doc, true);
  return { id: sid, name: doc.name, updated_at: doc.updated_at, count: doc.messages.length };
}

function list() {
  ensure();
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); return { id: d.id, name: d.name, updated_at: d.updated_at, count: (d.messages || []).length }; } catch (_) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.updated_at - a.updated_at);
}

function get(id) { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); }
function del(id) { const fp = fileFor(id); if (fs.existsSync(fp)) { fs.unlinkSync(fp); return true; } return false; }

module.exports = { save, list, get, del };
