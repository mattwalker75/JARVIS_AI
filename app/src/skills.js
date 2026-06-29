"use strict";
// Skills are served directly from skills_data.js (no database). The list_skills /
// get_skill tools read this in-memory catalog; edit skills_data.js and reload.
const SKILLS = require("./skills_data");

function list() {
  return SKILLS.map((s) => ({ name: s.name, category: s.category, summary: s.summary }))
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
}

function get(name) {
  const s = SKILLS.find((x) => x.name === name);
  if (!s) throw new Error("no skill named '" + name + "' (use list_skills to see available skills)");
  return { name: s.name, category: s.category, summary: s.summary, details: s.details };
}

module.exports = { list, get };
