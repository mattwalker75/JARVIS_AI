# Using Autopilot

Autopilot gives JARVIS an **objective** and a **time budget**, then it works **autonomously** —
build → test → refine → fix — until it's done, the time runs out, or it gets stuck. It runs
server-side, so you can close the tab and walk away; it notifies you when it ends.

## Start a run

1. Click **🛫 Autopilot** in the header (a floating window opens).
2. **Objective** — describe the whole task like a mini-spec (it can't ask you questions mid-run).
3. **Stop after N min** — the time budget.
4. **Autonomy** — `guarded` (default; won't send email / post / spend / delete your files on its
   own) or `full`.
5. **Verbose** (optional) — stream its live thinking into the chat so you can watch.
6. It first asks a few **clarifying questions** (one at a time) so it builds the right thing; answer
   them, then it plans and starts. (You can uncheck "Ask me clarifying questions first.")

JARVIS may also **offer** to run a big task on Autopilot on its own — say yes and it opens the
launcher pre-filled.

## While it runs

A status bar shows the cycle, countdown, and tokens, with controls:
- **⏸ Pause / ▶ Resume**, **+15m** (extend), **Modify** (change the objective), **Wrap up**
  (finish current step + summarize), **Stop**.
- If **Stop** doesn't take (a step is wedged), the button becomes **Force stop** — click again to
  kill it immediately.
- The header pill turns **cyan "Autopilot"** while it's working.

## When it ends

If it ends incomplete (budget / stuck / stopped), the bar stays and you can **▶ Continue** on the
same plan (no rebuild), **Modify**, or **✕ Dismiss**. A finished run shows **✅ done**.

## Tips

- Write a clear objective and say **where to save** the output (deliverables go to
  `/READ_WRITE_FILES`).
- Guarded mode is best for unattended runs.
- The live **Plan** ledger (banner above the chat) shows each step's status — use the drawer handle
  at its bottom to show/hide the steps.
