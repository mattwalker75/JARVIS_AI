"use strict";
// Pure-logic tests for the string-replace edit and the chat URL autolinker. These mirror the
// algorithms shipped in tools.js (editWorkbenchFile/editFile) and app.js (fmt), kept in sync
// by these tests catching drift in behaviour (unique match, $-safety, code/link protection).
let fails = 0;
const check = (l, c) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails++; };

// --- edit logic (from editWorkbenchFile / editFile) ---
function doEdit(content, oldStr, newStr, replaceAll) {
  if (oldStr == null || oldStr === "") throw new Error("old_string required");
  newStr = newStr == null ? "" : String(newStr);
  const occ = content.split(oldStr).length - 1;
  if (occ === 0) throw new Error("not found");
  if (occ > 1 && !replaceAll) throw new Error("ambiguous " + occ);
  if (replaceAll) return content.split(oldStr).join(newStr);
  const i = content.indexOf(oldStr);
  return content.slice(0, i) + newStr + content.slice(i + oldStr.length);
}
const src = "const cy = 0;\nfunction render() { drawWeapon(cy); }\nlet ambient = 0.2;";
check("edit: unique replace", doEdit(src, "let ambient = 0.2;", "let ambient = 0.9;").includes("0.9"));
check("edit: not-found throws", (() => { try { doEdit(src, "nope", "x"); return false; } catch (_) { return true; } })());
check("edit: ambiguous throws", (() => { try { doEdit(src, "cy", "yy"); return false; } catch (_) { return true; } })());
check("edit: replace_all", (doEdit(src, "cy", "yy", true).match(/yy/g) || []).length === 2);
check("edit: delete (empty new)", !doEdit(src, "const cy = 0;\n", "").includes("const cy"));
check("edit: $-safety literal", doEdit(src, "0.2", "$&$1-x").includes("$&$1-x"));

// --- URL autolinker (from app.js fmt) ---
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function linkify(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const prot = [];
  s = s.replace(/<a [^>]*>[\s\S]*?<\/a>|<code>[\s\S]*?<\/code>/g, (m) => { prot.push(m); return " L" + (prot.length - 1) + " "; });
  s = s.replace(/(^|[\s(>])((?:https?:\/\/|www\.)[^\s<)]+[a-zA-Z0-9/#=_&-])/g, (m, pre, url) => pre + '<a href="' + (url.indexOf("http") === 0 ? url : "https://" + url) + '" target="_blank" rel="noopener">' + url + "</a>");
  s = s.replace(/ L(\d+) /g, (m, i) => prot[Number(i)] || "");
  return s;
}
check("link: bare URL clickable", /<a href="http:\/\/localhost:9101"/.test(linkify("open http://localhost:9101 now")));
check("link: markdown link preserved", (linkify("[docs](https://x.io)").match(/<a /g) || []).length === 1);
check("link: URL in code not linked", /<code>curl http:\/\/x<\/code>/.test(linkify("run `curl http://x`")));
check("link: prose 'grade A0' untouched", linkify("grade A0 result") === "grade A0 result");

console.log(fails ? `\nTOOLS-UNIT: ${fails} FAILURE(S)` : "\nTOOLS-UNIT: ALL PASSED");
process.exit(fails ? 1 : 0);
