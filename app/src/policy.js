"use strict";
// Tool policy shared by every UNATTENDED execution context (Autopilot's guarded mode and
// scheduled/background tasks). Kept in its own dependency-free module so autopilot.js and
// scheduler.js don't each carry a private copy (they used to — with a comment apologizing
// for the duplication).
//
// RISKY_TOOLS: irreversible / external-effect tools withheld from unattended runs — a
// prompt-injected page or email must not be able to exfiltrate (send_email) or destroy
// (delete_memory / delete_secret) on its own. run_shell can't be withheld (building and
// testing need it), so this list is belt-and-braces on top of the safe-mode instruction.
const RISKY_TOOLS = ["send_email", "delete_memory", "set_secret", "delete_secret"];

module.exports = { RISKY_TOOLS };
