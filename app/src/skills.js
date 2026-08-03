"use strict";
// Skills are served directly from skills_data.js (no database). The list_skills /
// get_skill tools read this in-memory catalog; edit skills_data.js and reload.
const SKILLS = require("./skills_data");
const { activePromptName } = require("./config");

// A skill with a `prompts` list is a SPECIALTY skill — only surfaced when one of those
// prompt sets is the active one (e.g. the survival KB skill under the "survivalist" prompt).
// Skills without `prompts` are global and always available.
function inScope(s, active) { return !s.prompts || (active && s.prompts.includes(active)); }

function list() {
  const active = activePromptName();
  return SKILLS.filter((s) => inScope(s, active))
    .map((s) => ({ name: s.name, category: s.category, summary: s.summary }))
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
}

function get(name) {
  const s = SKILLS.find((x) => x.name === name);
  if (!s) throw new Error("no skill named '" + name + "' (use list_skills to see available skills)");
  return { name: s.name, category: s.category, summary: s.summary, details: s.details };
}

// Auto-hint triggers: keywords in the user's message that suggest a skill is relevant.
// Kept here (not in skills_data.js) so the catalog stays clean. Skills with no entry
// are never auto-hinted (e.g. behavioral ones like error-recovery).
const TRIGGERS = {
  "browser": /\b(browser|web ?site|web ?page|click|fill|form|log ?in|sign ?in|sign ?up|navigate|scrape|checkout|add to cart|hacker news|amazon|reddit|youtube)\b/i,
  "vision": /\b(screenshot|see the|look at|what'?s on (the|my) screen|this image|the image|photo|picture|ocr|read the (label|text) (in|on))\b/i,
  "email": /\b(e-?mail|inbox|unread|imap|smtp|send (me )?(a |an )?(message|mail|email)|reply to|my mail)\b/i,
  "documents": /\b(pdf|docx|word doc|read (the |this |my )?(document|report)|epub|extract (the )?text|resume|contract)\b/i,
  "data-analysis": /\b(analy[sz]e|dataset|\.csv|csv|data ?frame|pandas|duckdb|chart|plot|graph|statistics|correlat|aggregate|pivot|trend|sales data)\b/i,
  "memory": /\b(remember|recall|do you (know|remember)|what'?s my|my name is|my preference|forget (that|about)|remind me who)\b/i,
  "scheduling": /\b(schedule|every (\d+|few|couple) (second|minute|hour|day)|remind me|recurring|monitor|watch (for|the)|keep checking|alert me (when|if))\b/i,
  "task-authoring": /\b(recurring task|scheduled task|background task|task that (runs|checks|posts))\b/i,
  "credentials": /\b(password|my login|credential|my account|save (my|the) (login|password)|vault)\b/i,
  "workbench-shell": /\b(run (a |the )?(command|script|program)|install (a |the )?(package|tool)|compile|apt-?get|pip install)\b/i,
  "create-documents": /\b(create (a |an )?(pdf|doc|document|report|word|excel|spreadsheet|powerpoint|slide|deck)|generate (a |an )?(pdf|doc|report)|make me (a |an )?(pdf|report|chart))\b/i,
  "web-preview": /\b(build (me )?(a |an )?(app|web ?app|web ?site|page|demo|tool|dashboard)|prototype|serve (it|the app)|preview)\b/i,
  "internet": /\b(search (the web|online|for)|look up|google (it|the)|find (info|information|out) (on|about)|latest news|current price|what'?s the latest)\b/i,
  "desktop-control": /\b(desktop app|gui app|non-?browser app|application window|xfce)\b/i,
  "app-integration": /\b(add (a )?(note|record|entry|content|data) (to|in)|update (the )?(note|content|record)|my_business_manager|the (app|application|program) I (uploaded|installed|created)|inside (the|your) app|backed by (real )?files|the app'?s (data|notes|database))\b/i,
  "survival-knowledge-base": /\b(survival|survive|survivalist|emergency|disaster|evacuat|shelter|shelter.?in.?place|purif|distill|tourniquet|first ?aid|bleeding|wildfire|tornado|hurricane|flood|earthquake|blizzard|frostbite|hypothermia|heat ?stroke|forag|prepared(ness)?|prepper|bug.?out|off.?grid|grid.?down|blackout|power ?outage|no power|snakebite|drinkable water|boil(ing)? water|well water|pond|lake water|rain ?water|water from (the )?air|condensation|ration(ing)?|can(ned)? food|spoiled food|food storage|siphon|fuel|gasoline|diesel|generator|propane|storm radio|ham radio|scanner|noaa|frequenc(y|ies)|signal for help|sanitation|latrine|cat.?hole|human waste|sewage|dead body|corpse|human remains|body disposal|ammo|ammunition|firearm|rifle|pistol|shotgun|self.?defen|defend (the|our|my)|looter|intruder|home defen|compass|navigat|get(ting)? lost|topo(graphic)? map|road map|street map|map of (the|my|our) area|shtf|wrol|doomsday|apocalyp)\b/i,
};

// Return a one-line hint pointing at up to 2 relevant skills, or null. Called once per
// user turn by the tool loop when config.skills_autohint is on.
function hint(text) {
  if (!text || typeof text !== "string") return null;
  const active = activePromptName();
  const matched = [];
  for (const s of SKILLS) {
    if (!inScope(s, active)) continue;   // don't hint a specialty skill outside its prompt
    const re = TRIGGERS[s.name];
    if (re && re.test(text)) matched.push(s.name);
  }
  if (!matched.length) return null;
  const top = matched.slice(0, 2).map((n) => `'${n}'`).join(", ");
  return `Skill hint: get_skill(${top}) has a proven step-by-step playbook for this kind of task — read it before you start (skip only if the request is trivial).`;
}

module.exports = { list, get, hint };
