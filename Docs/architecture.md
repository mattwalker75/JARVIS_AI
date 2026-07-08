# Architecture

JARVIS is a five-container Docker Compose stack (project name `jarvis`), everything
bound to `127.0.0.1` (localhost only).

```
                          your browser  ──ws/http──┐
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ jarvis-app  (:8110)  Node.js orchestrator + static web UI         │
│   • WebSocket chat + REST API                                     │
│   • tool-calling loop (app/src/llm.js)                            │
│   • 48 tools (app/src/tools.js)                                   │
│   • scheduler, sessions, chatlog                                  │
└─┬────────────┬──────────────┬──────────────┬────────────┬────────┘
  │ docker exec │ http          │ http         │ http       │ http
  ▼            ▼               ▼              ▼            ▼
 jarvis-      jarvis-litellm   jarvis-memory  jarvis-piper Ollama (host)
 workbench    (:4000 gateway)  (:8120 Mem0)   (:5000 TTS)  (:11434)
 (:8111)      OpenAI-dialect   semantic mem   offline      local models
 root Linux   → many providers + Chroma store neural voice
```

## The containers

### jarvis-app (`:8110`)
The brain. A Node.js/Express server that:
- serves the web UI (`app/public/`),
- runs the WebSocket chat and the REST API (`app/server.js`),
- executes the **tool-calling loop** (`app/src/llm.js`) against the LLM,
- owns the **scheduler** (`app/src/scheduler.js`), **sessions**
  (`app/src/sessions.js`), **chat log** (`app/src/chatlog.js`), and **config**
  (`app/src/config.js`).

It reaches the workbench through the mounted Docker socket (`docker exec` as root),
and everything else over the internal Docker network.

### jarvis-litellm (`:4000`) — the LLM gateway
A [LiteLLM](https://docs.litellm.ai/) proxy that presents **one OpenAI-compatible
endpoint** and routes each request to the right provider based on the model name.
Configured in `litellm/config.yaml`. This is what makes model/provider mixing a
config change instead of code:

- local models via Ollama on your host (`ollama_chat/…`),
- OpenAI, Anthropic, Gemini (keys exported from config on `--start`).

The app's `llm.base_url` points here by default (`http://jarvis-litellm:4000/v1`).
You can bypass it and talk straight to Ollama or OpenAI by changing that URL.

### jarvis-memory (`:8120`) — semantic memory
A small FastAPI wrapper (`memory/server.py`) around [Mem0](https://github.com/mem0ai/mem0),
storing embedded facts in a local **Chroma** vector store (`data/chroma`, a Docker
volume). The app calls it over HTTP (`/add`, `/search`, `/all`, `/update`,
`/delete`). See [Memory & Scheduling](memory-and-scheduling.md).

### jarvis-workbench (`:8111`) — the workspace
An Ubuntu XFCE desktop (linuxserver **webtop**, noVNC) the LLM operates in as root.
Pre-loaded with a large toolchain (languages, build tools, DB clients, media tools,
Playwright, data/ML libs). The LLM runs commands here via `run_shell`, and a
**Playwright browser daemon** (`app/src/browserd.py`, started on demand) provides the
`browser_*` tools. You can watch it live in the **Workbench** tab.

### jarvis-piper (`:5000`, internal-only) — offline neural voice
A tiny Python HTTP service (`piper/serve.py`) wrapping [Piper](https://github.com/rhasspy/piper),
an on-device neural text-to-speech engine. The engine binary and voice models are baked
into the image at build time (arch auto-detected for arm64/x86_64), so it runs **fully
offline** and the voice is **machine-independent**. Not published to the host — the app
reaches it at `http://jarvis-piper:5000` and proxies the browser through `/api/tts`
(`app/src/tts.js`). Only used when the voice engine is set to **Piper** (browser TTS needs
no container). See [Voice](voice.md#neural-voice-piper).

## How a chat message flows

1. The browser sends `{type:"chat", messages}` over the WebSocket (`/ws`).
2. The app builds the prompt (system prompt + capped history) and calls the model at
   `llm.base_url` (the gateway) using the tier's model (`chat` by default).
3. The model streams back. `reasoning_content` deltas feed the **Thinking** panel;
   `content` deltas stream as the answer (and as speech, if voice is on).
4. If the model emits **tool calls**, the app runs them (in parallel where possible),
   streams each to the **Activity** panel, appends results, and loops.
5. When the model produces a final answer with no tool calls, it's sent as the reply.

The same `chat()` path backs the WebSocket UI, the REST `POST /api/chat`, the
terminal (`--prompt`/`--terminal`), and each scheduled task run.

## Volumes & persistence

| Host path | Container | Purpose |
| --- | --- | --- |
| `./app` | `/usr/src/app` | App source (bind mount — edits apply on app restart) |
| `./JARVIS_CONFIG.json` | `/cfg/JARVIS_CONFIG.json` | Config (read-write so the UI can persist settings) |
| `./JARVIS_SECRETS.json` | `/cfg/JARVIS_SECRETS.json` | Credential vault |
| `./READ_ONLY_FILES` | `/READ_ONLY_FILES` (ro) | Files you share to JARVIS |
| `./READ_WRITE_FILES` | `/READ_WRITE_FILES` | Files exchanged both ways (uploads, deliverables) |
| `./data` | `/data` | `tasks.json`, `chatlog.json`, `sessions/`, `custom_tools/`, `audit.log` |
| `jarvis_memory_data` | `/data/chroma` | Vector store (Docker volume) |
| `jarvis_workbench_work` | `/workspace` | Workbench scratch/build dir (Docker volume) |
| `jarvis_workbench_home` | `/config` | Workbench home (Docker volume) |

Bind mounts (config, secrets, shared folders, `data/`) survive `--delete`; the Docker
**volumes** (memory, workspace, workbench home) are wiped by it — back them up first
(see [CLI](cli.md)).

## Security model

- **Localhost only.** Every port binds to `127.0.0.1`, including the 9101–9150 preview
  range.
- **Root is in a container**, not on your host — but the app mounts the Docker socket
  to drive the workbench, which is effectively host-root-equivalent. This is accepted
  for a single-user local tool; don't expose it to a network.
- **Untrusted content.** The system prompt instructs the model to treat web pages,
  files, and screenshots as data, never instructions, and never to send secrets to
  external tools.
- **Secrets** live in `JARVIS_SECRETS.json` and are exposed to the model only via the
  vault tools. Config write access is limited to an allowlist (see
  [Configuration](configuration.md)); secrets keys can't be written through it.
