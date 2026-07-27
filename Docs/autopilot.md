# Autopilot & the Planner

Two related systems let JARVIS take on multi-step work: the **Planner** (a persistent
task ledger it maintains as it works) and **Autopilot** (an autonomous loop that drives
an objective to completion). Autopilot builds on the Planner.

## The Planner (task ledger)

For any multi-step job, the model keeps a plan — an objective plus an ordered checklist —
via these tools:

| Tool | Purpose |
| --- | --- |
| `plan_create(objective, steps[])` | Start a plan (replaces any existing one). |
| `plan_update(step, status)` | Set a step to `pending` / `active` / `done` / `blocked`. Marking done auto-activates the next step. |
| `plan_add_step(text, after?)` | Add a step discovered mid-task. |
| `plan_show()` | Return the current plan (rarely needed — see below). |
| `plan_clear()` | Close the plan when the objective is complete. |

**Why it matters:** the active plan is re-injected at the **top of every turn**, so the
model always knows the goal and its place and **resumes from the first incomplete step**
after any interruption — a stall, a Stop, or even an app restart. The ledger lives in
`/data/plan.json`, not the in-turn conversation, so it survives.

Because the plan is shown every turn, the model does **not** need to call `plan_show`
just to re-read it. The `plan_create`/`plan_update` guidance is baked into the system
prompt automatically.

**Live in the UI:** a banner above the chat shows the objective, per-step status
(done ✓ / active ▸ / pending ○ / blocked ✕), progress, and notes, updating in real time
as the model calls `plan_update`. Collapse or clear it from the banner. Starting a **New
chat** clears the plan, and starting an Autopilot run with a **new** objective clears any
stale plan so it never inherits a previous task's checklist.

API: `GET /api/plan` (current plan) · `DELETE /api/plan` (clear).

## Autopilot

Give an objective and a time budget; Autopilot drafts a plan and drives it in back-to-back
**build → test → refine → fix** cycles until the objective is complete, the budget is
reached, it gets stuck, or you stop it. It runs **server-side** (like scheduled tasks), so
you can close the tab and walk away — it **notifies you** (in-app + desktop + spoken) with
a summary when it ends, and the run **survives an app restart** (it auto-resumes if it was
running, or re-shows the ended bar so you can continue).

> A run survives an app *auto-restart* (crash recovery), but the deliberate lifecycle
> commands — `./JARVIS.sh --stop`, `--delete`, `--setup`, `--start` — **wipe the saved run
> and plan** so you always come back up to a clean slate.

### Launching

Click **🛫 Autopilot** in the header:

- **Objective** — what to build/do (write it like a mini-spec; it can't ask you questions mid-run).
- **Stop after N min** — the time budget.
- **Autonomy** — `guarded` (default) or `full` (see below).
- **Verbose** — stream the model's live thinking + tokens into the chat so you can watch it work. (The streamed cycle text is shown but not added to your chat history or spoken.)

### The live status bar

While running it shows `state · cycle N · countdown · tokens ~$cost`, plus controls:

| Control | Effect |
| --- | --- |
| **⏸ Pause / ▶ Resume** | Stop starting new cycles (the time budget freezes) and resume later. |
| **+15m** | Extend the time budget (also rescues a run about to stop on the budget). |
| **Modify** | Change the objective mid-run; the next cycle re-checks its plan against it. |
| **Wrap up** | Finish the current step, summarize, and stop for review (graceful). |
| **Stop** | Stop immediately (also kills any in-flight workbench command). If a step is wedged and won't quit, the button becomes **Force stop** — one more click ends the run instantly and kills any preview servers (ports 9101-9150). |

### When it ends

When a run ends **incomplete** (time budget, stuck, or you stopped it), the bar stays
visible in a grey **ended** state and the plan is preserved. From there:

- **▶ Continue** — resume on the **same plan** with a fresh budget, picking up from the first incomplete step (no rebuild).
- **Modify** — change the objective, then Continue.
- **✕ Dismiss** — clear the bar (the plan stays for use in chat).

A completed run ends as **✅ done**; you can dismiss it.

### Autonomy modes

Set the default in config (`autopilot.autonomy`), override per run in the launcher:

- **guarded** (default) — free to build and test in `/workspace`, but it will **not** send
  email, post online, make purchases, or delete/overwrite your files outside `/workspace`
  on its own; those become *blocked* steps for you to handle. It also withholds the
  dedicated risky tools (`send_email`, `delete_memory`, `set_secret`, `delete_secret`).
- **full** — no restrictions.

> Guarded mode is **best-effort**: `run_shell` stays available (Autopilot needs it to
> build), so a determined shell command could still do more than intended. For truly
> sensitive unattended runs, guarded reduces risk but doesn't hard-sandbox.

### Safeguards

- **Time budget + cycle cap** (`autopilot.max_cycles`, default 100) trigger a graceful wrap-up.
- **Stuck detection** pauses and notifies after several cycles with no plan progress.
- **Anti-thrash** nudges the model when it spends cycles only reading/planning without acting.
- **Patient mode** — Autopilot runs with the stream watchdog off, so slow local cold-loads aren't killed.

### API

`POST /api/autopilot/start` `{objective, minutes, autonomy, verbose}` ·
`GET /api/autopilot` (status) · `POST /api/autopilot/{pause,resume,wrapup,stop,extend,modify,continue,dismiss}`.

### Config

```jsonc
"autopilot": {
  "autonomy": "guarded",     // "guarded" | "full"
  "default_minutes": 30,     // time budget prefilled in the launcher
  "max_cycles": 100          // safety cap on build/test iterations
}
```
