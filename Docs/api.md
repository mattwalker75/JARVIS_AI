# API

The app (`:8110`, localhost only) exposes a WebSocket for the live UI and a REST API
for everything else — including `POST /api/chat` for external automation. No auth
(single-user, localhost); don't expose it to a network.

## WebSocket — `/ws`

The browser UI's transport. Send:

```json
{ "type": "chat", "messages": [ {"role":"user","content":"..."} ], "persona": "work" }
{ "type": "cancel" }        // interrupt the in-flight request (Stop / Esc)
```

The server streams events back:

| Event | Meaning |
| --- | --- |
| `{type:"reasoning", text}` | A reasoning-model thinking delta (feeds the Thinking panel). |
| `{type:"token", text}` | An answer content delta. |
| `{type:"tool", tool, input}` / `{type:"tool_result", tool, output, ms}` | A tool call and its result. |
| `{type:"usage", model, usage, cost_usd}` | Token/cost for the turn. |
| `{type:"reply", text}` | Final answer. |
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
| `GET /api/config` | Public config (no secrets): title, provider, model, voice, personas. |
| `GET /api/models` | Available models (from the gateway or Ollama) + current. |
| `POST /api/settings` | Persist an allowlisted setting: `{path, value}` (see [Configuration](configuration.md#settings-the-ui-can-change)). |
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

### Sessions

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sessions` | List saved conversations. |
| `POST /api/sessions` | Save/update `{id?, name, messages}`. |
| `GET /api/sessions/:id` | Load one. |
| `GET /api/sessions/:id/export` | Download as JSON. |
| `POST /api/sessions/import` | Import `{name, messages}`. |
| `DELETE /api/sessions/:id` | Delete. |
