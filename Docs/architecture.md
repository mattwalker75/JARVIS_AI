# Architecture

JARVIS is a five-container Docker Compose stack (project name `jarvis`), everything
bound to `127.0.0.1` (localhost only). The fifth container, `jarvis-docker-proxy`, is a
**filtered Docker-API proxy** the app uses to reach the workbench (see below) instead of
mounting the raw Docker socket. The LLM itself is **not** in the stack — the app
is a pure OpenAI-dialect client and talks to whatever URL is in `llm.base_url` (see
[LLM serving is external](#llm-serving-is-external)).

```
                          your browser  ──ws/http──┐
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ jarvis-app  (:8110)  Node.js orchestrator + static web UI         │
│   • WebSocket chat + REST API                                     │
│   • tool-calling loop (app/src/llm.js)                            │
│   • 48 tools (app/src/tools.js)                                   │
│   • scheduler, sessions, chatlog                                  │
└─┬────────────┬──────────────┬────────────────┬───────────────────┘
  │ docker exec │ http          │ http           │ OpenAI-dialect http
  ▼            ▼               ▼                ▼  (llm.base_url)
 jarvis-      jarvis-memory   jarvis-piper      LLM endpoint  (EXTERNAL)
 workbench    (:8120 Mem0)    (:5000 TTS)       • a cloud provider, OR
 (:8111)      semantic mem    offline           • a local runtime started by
 root Linux   + Chroma store  neural voice        ./JARVIS_LOCAL_LLM.sh, reached
                                                  over host.docker.internal
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

It runs as a **non-root** user and reaches the workbench with `docker exec` **through the
`jarvis-docker-proxy`** (a filtered Docker API restricted to containers+exec) rather than
mounting the raw `/var/run/docker.sock` — so an app compromise can't drive the host daemon.
Everything else goes over the internal Docker network. (Set `DOCKER_PROXY_HOST=""` and re-add
the socket mount to fall back to the direct-socket behavior.)

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

## LLM serving is external

The model is **not** part of the core stack. `jarvis-app` is a pure OpenAI-dialect
client — it POSTs to whatever URL is in `llm.base_url` and neither knows nor cares
where the model runs. That URL is either:

- **a cloud provider** — e.g. `https://api.openai.com/v1` (empty `base_url` falls back
  to OpenAI). Nothing else to run.
- **a local runtime on your host** — managed by the optional **`JARVIS_LOCAL_LLM.sh`**
  helper (**Ollama** and **MLX** today; vLLM / llama.cpp are pluggable backends for later). It
  ensures the runtime is up and **prints the endpoint URL to paste into Config → Endpoint URL**.
  The app reaches host runtimes over `host.docker.internal` (`jarvis-app` sets
  `extra_hosts: host.docker.internal:host-gateway`).

For multi-model routing across providers behind one endpoint, `JARVIS_LOCAL_LLM.sh
--gateway` can front the runtime with a **LiteLLM gateway** — now a standalone stack in
`litellm/docker-compose.yml` (project `jarvis-llm`, port `:4000`), no longer part of the
core `docker-compose.yml`. See [CLI → `JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime)
and [Configuration → `llm`](configuration.md#llm).

## How a chat message flows

1. The browser sends `{type:"chat", messages}` over the WebSocket (`/ws`).
2. The app builds the prompt (system prompt + capped history) and calls the model at
   `llm.base_url` (the external LLM endpoint) using the tier's model (`chat` by default).
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
| `./config/JARVIS_CONFIG.json` | `/cfg/JARVIS_CONFIG.json` | Config (read-write so the UI can persist settings) |
| `./config/JARVIS_SECRETS.json` | `/cfg/JARVIS_SECRETS.json` | Credential vault |
| `./LLM_READ_ONLY_FILES` | `/LLM_READ_ONLY_FILES` (ro) | Files you share to JARVIS |
| `./LLM_READ_WRITE_FILES` | `/LLM_READ_WRITE_FILES` | Files exchanged both ways (uploads, deliverables) |
| `./data` | `/data` | `tasks.json`, `chatlog.json`, `sessions/`, `custom_tools/`, `audit.log`, `plan.json` (task ledger), `autopilot.json` (run state) |
| `./Prompts` | `/Prompts` | Active + saved master/system prompt files (see [Prompts](prompts.md)) |
| `./Logs` | `/logs` | Debug logs (per-day, rotated by size + retention) |
| `jarvis_memory_data` | `/data/chroma` | Vector store (Docker volume) |
| `./LLM_WORKSPACE` | `/LLM_WORKSPACE` | The AI's working/build area — a **host bind mount** (visible on your Mac, so you can watch active work); also mounted into the app so file tools can reach it |
| `jarvis_workbench_home` | `/config` | Workbench home (Docker volume) |

Bind mounts (config, secrets, shared folders, `data/`, and **`LLM_WORKSPACE`**) survive
`--delete`; the Docker **volumes** (memory, workbench home) are wiped by it — back them up
first (see [CLI](cli.md)). Note `LLM_WORKSPACE` is now a host folder, so the AI's working
files persist through a `--delete`.

To reset **just the workbench OS** (after the LLM has installed a pile of packages) without
touching any data, `./JARVIS.sh --reset-workbench` recreates that one container from its clean
image — the runtime-installed packages live in the container's writable layer, so recreating wipes
them while the `/LLM_WORKSPACE` bind mount (a host folder) and the home **volume** (and every other container) are kept. See [CLI](cli.md#reset-the-dev-workbench).

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
