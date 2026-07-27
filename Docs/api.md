# API

The app (`:8110`, localhost only) exposes a WebSocket for the live UI and a REST API
for everything else — including `POST /api/chat` for external automation. No auth
(single-user, localhost); don't expose it to a network.

## WebSocket — `/ws`

The browser UI's transport. Send:

```json
{ "type": "chat", "messages": [ {"role":"user","content":"..."} ], "persona": "work",
  "watchdog": true, "planMode": false }
{ "type": "cancel" }        // interrupt the in-flight request (Stop / Esc). A bare "stop"
                            // chat message while busy also interrupts.
```

Per-message flags: `watchdog` (false = patient mode, don't kill a slow stream), `planMode`
(clarify → plan → execute).

The server streams events back:

| Event | Meaning |
| --- | --- |
| `{type:"reasoning", text}` | A reasoning-model thinking delta (feeds the Thinking panel). |
| `{type:"token", text}` | An answer content delta. |
| `{type:"tool", tool, input}` / `{type:"tool_result", tool, output, ms}` | A tool call and its result. |
| `{type:"usage", model, usage, cost_usd}` | Token/cost for the turn (`usage.context_tokens` drives the context meter). |
| `{type:"reply", text, ephemeral?}` | Final answer (`ephemeral` = a verbose Autopilot cycle: shown but not saved to history). |
| `{type:"plan", plan}` | The task ledger changed (drives the plan banner). |
| `{type:"autopilot", status}` | Autopilot status changed (drives the Autopilot bar). |
| `{type:"error", error}` | Error. |
| `{type:"notification"|"task_run"|"chat_post", ...}` | Scheduler/task events. |

One in-flight request per connection; a second `chat` while busy is rejected.

## REST

### Chat

```bash
curl -s localhost:8110/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"what is 17*23?"}'
# => {"reply":"391"}
```

`POST /api/chat` — body: `{ message?, messages?, tier?, persona? }`. Provide `message`
and/or a `messages` history (must end with a user turn). Optional `tier`
(`chat`/`cheap`/`smart`) and `persona`. Returns `{ reply }`. Same brain as the UI —
it can use every tool while answering. Great for cron, Shortcuts, and other machines
(via an SSH tunnel).

### Config, models, settings

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Public config (no secrets): title, provider, model, voice, personas, context window. |
| `GET /api/config/full` · `POST /api/config/full` | Read / write the full config + secrets (Config tab; auto-backs-up). |
| `GET /api/models` | Available models (from the gateway or Ollama) + current. |
| `POST /api/models/probe` | List models from an arbitrary endpoint: `{base_url, api_key}` (for the provider picker). |
| `GET /api/context-window` | Resolve the context-meter ceiling (manual → Ollama num_ctx → gateway `/model/info` → default). |
| `POST /api/settings` | Persist an allowlisted setting: `{path, value}` (see [Configuration](configuration.md#settings-the-ui-can-change)). |
| `GET /api/tts/voices` | Neural (Piper) voices available: `{voices:[{id,label,lang}], default}`. |
| `POST /api/tts` | Synthesize speech (Piper): body `{text, voice?, rate?}` → `audio/wav`. Proxied to `jarvis-piper`. |
| `GET /api/selftest` | Exercise memory/shell/files/internet/desktop/vault without the model. |
| `GET /healthz` | Liveness. |

### Memory

| Endpoint | Purpose |
| --- | --- |
| `GET /api/memories` | List stored memories. |
| `POST /api/memories` | Add one: `{text}`. |
| `DELETE /api/memories/:id` | Delete one. |

### Files

| Endpoint | Purpose |
| --- | --- |
| `GET /api/files?dir=rw|ro` | List files in a shared folder (recursive; sizes + mtimes). |
| `GET /api/files/raw?dir=…&path=…[&download=1]` | Open/preview or download a file (symlink-safe). |
| `DELETE /api/files?dir=rw&path=…` | Delete a file (read-write folder only). |
| `POST /api/upload` | Upload a file: `{name, dataUrl}` (base64). Lands in `/READ_WRITE_FILES/uploads/`. |

### Tasks & notifications

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tasks` | Active scheduled tasks. |
| `POST /api/tasks/add` | Schedule one: `{prompt, in_seconds?/at?/every_seconds?, until?, label?}`. |
| `POST /api/tasks/cancel` | `{id}`. |
| `GET /api/notifications` | Recent notifications. |
| `POST /api/notifications/clear` | Clear all. |
| `DELETE /api/notifications/:id` | Dismiss one. |

### Planner & Autopilot

See [Autopilot & the Planner](autopilot.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/plan` · `DELETE /api/plan` | The active task ledger / clear it. |
| `GET /api/autopilot` | Current Autopilot status (`active`, `paused`, `ended`, `resumable`, cycles, budget, tokens). |
| `POST /api/autopilot/start` | `{objective, minutes, autonomy, verbose}`. |
| `POST /api/autopilot/{pause,resume,wrapup,stop}` | Control an active run. |
| `POST /api/autopilot/extend` · `.../modify` | `{minutes}` / `{objective}`. |
| `POST /api/autopilot/{continue,dismiss}` | Resume an ended run on the same plan / clear the ended bar. |

### Prompts & context

See [Prompts & Context](prompts.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/prompts` | List saved prompt-set names. |
| `GET · POST · DELETE /api/prompts/:name` | Read / write / delete a set's `<name>_master.prompt` + `<name>_system.prompt` (`default`/`stock` protected from delete). |
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
