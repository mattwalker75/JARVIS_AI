# API

The app (`:8110`, this computer only unless network access is switched on) exposes a
WebSocket for the live UI and a REST API for everything else — including `POST /api/chat`
for external automation. By default there is no login; with one on (Config → Access &
users) every route below except `/healthz` and `/api/auth/me|setup|login|logout` answers
**401** until you sign in, and the WebSocket handshake is refused with 401. A scripted client
signs in with `POST /api/auth/login` and sends the `jarvis_session` cookie it gets back.

If `config/JARVIS_CONFIG.json` can't be parsed, the app **fails closed**: every `/api` route
(and `/view`) answers **503** `{error}` with a plain sentence naming the problem, the WebSocket
handshake is refused with 503, and nothing is written — except `GET /api/auth/me`, which reports
`{ status: "config_error", error }` so the page can show why.

Request bodies are JSON, up to about **34 MB** (room for a 20 MB upload once base64-encoded). A
body that is too large answers **413** `{error}`; one that isn't valid JSON answers **400** `{error}`.

Every REST request is validated against a **localhost `Host`/`Origin` allowlist**, which
blocks CSRF and DNS-rebinding from websites you visit: the `Host` must be an allowed name, and
an `Origin`, when sent, must be too. The WebSocket handshake checks the **`Origin`** only: a
browser (which always sends one) must come from an allowed name — and, from another device, from
the very page host it is connecting to; a client that sends no `Origin` (a script) is let through
to the login check. Plain `curl`/scripts on the same machine pass automatically. If you front
JARVIS with a proxy or tunnel under a different hostname, add that name to
`security.allowed_hosts` in `JARVIS_CONFIG.json` or the app answers 403.

## Login and users

| Method & path | Purpose |
| --- | --- |
| `GET /api/auth/me` | `{ status: "disabled" \| "not_initialized" \| "unauthenticated" \| "authenticated", loginName? }` — or `{ status: "config_error", error }` while the config file can't be read. |
| `POST /api/auth/setup` | `{ loginName, password }` — create the first login (only when no password file exists) and sign in. |
| `POST /api/auth/login` / `logout` | `{ loginName, password }` / — . Rate-limited (below). |
| `POST /api/auth/password` | `{ currentPassword, newPassword }` — change your own password. Rate-limited (below). |
| `GET /api/access` | `{ auth, login_enabled, session_hours, password_file, password_file_on_host, network: { allow, published, restart_needed, urls } }` (`password_file_on_host` = the same file as a path next to `JARVIS.sh`, e.g. `data/.password`) |
| `POST /api/access/login` | `{ enabled: true }` turns the login on; `{ enabled: false, confirm: "DISABLE" }` turns it off and removes every user. |
| `GET /api/users` | `[{ name, isYou }]` |
| `POST /api/users` | `{ loginName, password }` — add a user. |
| `PUT /api/users/:name/password` | `{ password }` — reset ANOTHER user's password. |
| `DELETE /api/users/:name` | `{ confirm: "DELETE" }` — remove another user. |

**Rate limit** (setup, login and password change): only **failed** attempts count — at most
10 per address + login name in 5 minutes, and 50 per address across all names. Past that the
route answers **429** `{error}`; a successful sign-in doesn't use up the allowance.

`POST /api/config/full` never changes `security.login_enabled` or `security.password_file`,
whatever it is sent.

## WebSocket — `/ws`

The browser UI's transport. Send:

```json
{ "type": "chat", "chatId": "abc123", "messages": [ {"role":"user","content":"..."} ],
  "persona": "work", "watchdog": true, "planMode": false }
{ "type": "cancel" }        // interrupt the in-flight request (Stop / Esc). A bare "stop"
                            // chat message while busy also interrupts (one "⏹ Stopped." reply).
```

Per-message fields: `chatId` (the chat tab — it scopes that tab's plan ledger to
`chat_<chatId>`, and is echoed on the turn's events), `watchdog` (false = patient mode, don't kill
a slow stream), `planMode` (clarify → plan → execute).

The sign-in is re-checked on **every** `chat` message: if the user was removed, their password
changed, or the session ended, the server sends `{type:"error", error:"Your sign-in has ended…"}`
and closes the socket with code **4401**. Closing the socket (tab closed, network dropped) stops
the running turn and its tools.

The server streams events back. Every event produced by a chat turn carries that message's
`chatId` (when one was sent), so a reply still streaming after you switch tabs lands in its own
conversation. Broadcasts (plan, Autopilot, scheduler, `tool_stream`, `open_autopilot`) go to every
open tab and carry no `chatId`.

| Event | Meaning |
| --- | --- |
| `{type:"reasoning", text}` | A reasoning-model thinking delta (feeds the Thinking panel). |
| `{type:"token", text}` | An answer content delta. |
| `{type:"tool", tool, input}` / `{type:"tool_result", tool, output, ms}` | A tool call and its result. |
| `{type:"tool_media", tool, image}` | The actual screenshot / image a vision tool looked at (a data URL; skipped for very large images). |
| `{type:"tool_stream", id, tool, chunk}` | Live output of a long-running `run_shell` command (broadcast every ~0.7 s; the full output still arrives in `tool_result`). |
| `{type:"failover", from, to, reason}` | The primary model failed hard; the rest of the turn runs on the failover model. |
| `{type:"usage", model, usage, cost_usd}` | Token/cost for the turn (`usage.context_tokens` drives the context meter). |
| `{type:"reply", text, ephemeral?}` | Final answer (`ephemeral` = a verbose Autopilot cycle: shown but not saved to history). A stopped turn answers `"⏹ Stopped."`. |
| `{type:"busy", text}` | A `chat` arrived while this connection's previous turn is still running; the running turn carries on. |
| `{type:"plan", plan, key}` | A task ledger changed (drives the plan banner); `key` says which (`chat_<id>`, `autopilot`, `default`). |
| `{type:"open_autopilot", objective, minutes, autonomy}` | The model offers an Autopilot run — open the launcher pre-filled. |
| `{type:"autopilot", status}` | Autopilot status changed (drives the Autopilot bar). |
| `{type:"error", error}` | Error. |
| `{type:"notification"\|"task_run"\|"chat_post", ...}` | Scheduler/task events. |

One in-flight request per connection; a second `chat` while busy gets a `busy` event (not an error).

## REST

### Chat

```bash
curl -s localhost:8110/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"what is 17*23?"}'
# => {"reply":"391"}
```

`POST /api/chat` — body: `{ message?, messages?, tier?, persona?, chatId? }`. Provide `message`
and/or a `messages` history (must end with a user turn). Optional `tier`
(`chat`/`cheap`/`smart`/`vision`), `persona`, and `chatId` (gives the conversation its own plan
ledger, `chat_<chatId>`; without it the `default` ledger is used). Returns `{ reply }`. Same brain
as the UI — it can use every tool while answering. If the caller disconnects (Ctrl-C, a timeout)
the turn — tools included — is stopped. Great for cron, Shortcuts, and other machines
(via an SSH tunnel).

### Config, models, settings

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Public config (no secrets): title, provider, model, voice, personas, context window. |
| `GET /api/config/full` · `POST /api/config/full` | Read / write the full config + secrets (Config tab; backs each file up first). `GET` returns `{config, secrets, config_error, secrets_error, version}`. `POST` takes `{config?, secrets?, version}`: if either file changed since that `version` was read, it answers **409** `{error, code: "stale"}` and saves nothing; otherwise it saves and returns the new `version`. Refused (503) while the config file can't be read. When the save flips `workbench.enabled`, the workbench container is stopped / started and the reply carries `workbench: { enabled, container, action, note, changed }`. |
| `GET /api/models` | Available models from the configured endpoint (asked with the saved API key) + current. |
| `POST /api/models/probe` | List models from an arbitrary endpoint: `{base_url, api_key}` (for the provider picker). |
| `GET /api/context-window` | Resolve the context-meter ceiling: `llm.context_window` → `ollama.context_length` (only when talking straight to Ollama: provider `ollama`/`local` or a `:11434` URL) → the endpoint's `/model/info` (anything else) → 32768. |
| `POST /api/settings` | Persist an allowlisted setting: `{path, value}` — the value's type is checked (see [Configuration](configuration.md#settings-the-ui-can-change)). |
| `GET /api/tts/voices` | Neural (Piper) voices available: `{voices:[{id,label,lang}], default}`. |
| `POST /api/tts` | Synthesize speech (Piper): body `{text, voice?, rate?}` → `audio/wav`. Proxied to `jarvis-piper`. |
| `POST /api/stt` | Local speech-to-text: `{dataUrl, language?}` (base64 audio; `;codecs=…` parameters allowed) → `{text, language, duration_s}` — transcribed by whisper in the workbench (used by the "local" STT engine). One at a time (409 while one runs). |
| `POST /api/tools/reload` | Hot-reload custom tools + MCP servers (also runs automatically on config save). Returns `{builtin, custom, mcp, total}`. |
| `GET /api/selftest` | Exercise memory/shell/files/internet/desktop/vault without the model. With the workbench turned off, `workbench` and `desktop` come back as `{ skipped }`. |
| `GET /api/workbench` | `{ enabled, container }` — whether the workbench is switched on (`workbench.enabled`) and what its container is doing: `running`, `stopped`, `missing` (never created) or `unknown` (Docker not reachable). |
| `GET /healthz` | Liveness. |

### Memory

| Endpoint | Purpose |
| --- | --- |
| `GET /api/memories` | List stored memories. |
| `POST /api/memories` | Add one: `{text}`. |
| `DELETE /api/memories/:id` | Delete one. |
| `PUT /api/memories/:id` | Edit one in place: `{text}` (keeps its id). |
| `POST /api/memories/consolidate` | LLM-merge near-duplicates + resolve contradictions across the store (smart tier; unknown ids dropped, >50%-deletion plans refused). |
| `POST /api/backup/run` | Back up the memory volume + `/LLM_WORKSPACE` to `data/backups/` now (the auto-backup engine). One run at a time — **409** "A backup is already running…" otherwise; each part times out after 10 minutes. |

### Files

| Endpoint | Purpose |
| --- | --- |
| `GET /api/files?dir=rw\|ro` | List files in a shared folder (recursive; sizes + mtimes). |
| `GET /api/files/raw?dir=…&path=…[&download=1]` | Open/preview or download a file (symlink-safe). |
| `GET /view?dir=…&path=…` | Open a Markdown/text file **rendered** in a browser tab (`#anchor` scrolls to a section); other types fall through to the raw file API. |
| `DELETE /api/files?dir=rw&path=…` | Delete a file (read-write folder only). |
| `POST /api/upload` | Upload a file: `{name, dataUrl}` (base64, 20 MB max; parameters such as `;charset=…` allowed). Lands in `/LLM_READ_WRITE_FILES/uploads/` and never overwrites: a second `report.pdf` is saved as `report-1.pdf`, and so on (the reply's `path` says which). Names like `.` / `..` are refused. |

### Tasks & notifications

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tasks` | Active scheduled tasks (including paused). |
| `POST /api/tasks/add` | Schedule one: `{prompt, in_seconds?/at?/every_seconds?, until?, label?}`. |
| `POST /api/tasks/update` | Edit in place (`{id, prompt?, label?, every_seconds?, until?, …}`) or pause/resume (`{id, paused: true\|false}`). |
| `GET /api/tasks/history?id=&limit=` | Recent runs (newest first) from the run-history log — the 📜 view. |
| `POST /api/tasks/cancel` | `{id}`. |
| `GET /api/notifications` | Recent notifications. |
| `POST /api/notifications/clear` | Clear all. |
| `DELETE /api/notifications/:id` | Dismiss one. |

### Planner & Autopilot

See [Autopilot & the Planner](autopilot.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/plan?key=` · `DELETE /api/plan?key=` | A conversation's task ledger / clear it (keys: `chat_<id>`, `autopilot`, `default`). |
| `GET /api/autopilot` | Current Autopilot status (`active`, `paused`, `ended`, `resumable`, cycles, budget, tokens). |
| `GET /api/autopilot/history` | Per-cycle summaries of the current (or ended-but-undismissed) run — the bar's 📜 view. |
| `POST /api/autopilot/clarify` | Pre-flight: `{objective}` → `{ready, questions, questionsText}` — the model's clarifying questions as an array (one per item) plus the original numbered text, or `ready: true` with an empty list to launch as-is. |
| `POST /api/autopilot/start` | `{objective, minutes, autonomy, verbose}`. |
| `POST /api/autopilot/{pause,resume,wrapup,stop}` | Control an active run. |
| `POST /api/autopilot/forcestop` | Forced stop: end the run **now**, abort the in-flight step, and kill any preview servers it started (9101–9150). |
| `POST /api/autopilot/extend` · `.../modify` | `{minutes}` / `{objective}`. |
| `POST /api/autopilot/{continue,dismiss}` | Resume an ended run on the same plan / clear the ended bar. |

### Prompts & context

See [Prompts & Context](prompts.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/prompts` | List saved prompt-set names + which one is currently **active** (content-matches the live `default_*` files). |
| `GET · POST · DELETE /api/prompts/:name` | Read / write / delete a set's `<name>_master.prompt` + `<name>_system.prompt`. `default` and `stock` can't be deleted and `stock` can't be overwritten (names compared ignoring case). |
| `POST /api/summarize` | Summarize a conversation (`{messages}`) for compaction. |

### Sessions

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sessions` | List saved conversations. |
| `POST /api/sessions` | Save/update `{id?, name, messages}`. |
| `GET /api/sessions/:id` | Load one. |
| `GET /api/sessions/:id/export` | Download as JSON. |
| `POST /api/sessions/import` | Import `{name, messages}`. |
| `DELETE /api/sessions/:id` | Delete. |
