# Architecture

JARVIS is a six-container Docker Compose stack (project name `jarvis`): `jarvis-app`,
`jarvis-memory`, `jarvis-piper`, `jarvis-docker-proxy`, and two optional ones —
`jarvis-workbench` and `jarvis-searxng`. Published ports bind to `127.0.0.1` (this computer
only), except the app's own port while network access is on (see [Security model](#security-model)).
`jarvis-docker-proxy` is a **filtered Docker-API proxy** the app uses to reach the workbench
(see below) instead of mounting the raw Docker socket. The LLM itself is **not** in the stack — the app
is a pure OpenAI-dialect client and talks to whatever URL is in `llm.base_url` (see
[LLM serving is external](#llm-serving-is-external)).

```
                          your browser  ──ws/http──┐
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ jarvis-app  (:8110)  Node.js orchestrator + static web UI         │
│   • WebSocket chat + REST API                                     │
│   • tool-calling loop (app/src/llm.js)                            │
│   • 63 built-in tools (app/src/tools.js — see tools.md)           │
│   • scheduler, sessions, chatlog                                  │
└─┬────────────┬──────────────┬────────────────┬───────────────────┘
  │ docker exec │ http          │ http           │ OpenAI-dialect http
  ▼            ▼               ▼                ▼  (llm.base_url)
 jarvis-      jarvis-memory   jarvis-piper      LLM endpoint  (EXTERNAL)
 workbench    (internal Mem0) (:5000 TTS)       • a cloud provider, OR
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
Everything else goes over the internal Docker networks (see [Networks](#networks)). It runs
under a tiny init (`init: true`) and shuts down cleanly on a stop signal (saving the chat log
first), so `--stop` / `--reload` don't wait for Docker's 10-second kill. Its time zone (`TZ`) is
this computer's, passed in by `./JARVIS.sh`. (Set `DOCKER_PROXY_HOST=""` and re-add
the socket mount to fall back to the direct-socket behavior.)

### jarvis-memory (internal-only) — semantic memory
A small FastAPI wrapper (`memory/server.py`) around [Mem0](https://github.com/mem0ai/mem0),
storing embedded facts in a local **Chroma** vector store (`data/chroma`, a Docker
volume). The app calls it over the internal Docker network at `http://jarvis-memory:8000`
(`/add`, `/search`, `/all`, `/update`, `/delete`). **No host port is published** — the
store has no auth, so exposing it would let any local process read or rewrite the
memories; `JARVIS.sh` health-checks it via `docker exec` instead. See
[Memory & Scheduling](memory-and-scheduling.md).

### jarvis-workbench (`:8111`) — the workspace
An Ubuntu XFCE desktop (linuxserver **webtop**, noVNC) the LLM operates in as root.
Pre-loaded with a large toolchain (languages, build tools, DB clients, media tools,
Playwright, data/ML libs). The LLM runs commands here via `run_shell`, and a
**Playwright browser daemon** (`app/src/browserd.py`, started on demand) provides the
`browser_*` tools. You can watch it live in the **Workbench** tab.

**The workbench is optional.** Its compose service sits under the `workbench` profile, which
`./JARVIS.sh` adds unless `workbench.enabled` is `false` (Config → Workbench & shared
folders). With it off the container is not built or started, the app withholds every tool
that runs inside it (`WORKBENCH_TOOLS` in `app/src/tools.js` → `activeToolDefs()`), tells the
model so in the system prompt, and hides the Workbench tab. Nothing else depends on the
workbench, so the rest of the stack runs unchanged. See
[Configuration](configuration.md#running-without-the-workbench-workbenchenabled).

### jarvis-docker-proxy (internal-only)
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) in front of the host's
Docker socket, allowing only the container + exec calls the app needs to drive the workbench.
On the `backend` network only — the workbench can't reach it.

### jarvis-searxng (internal-only, optional)
The self-hosted [SearXNG](https://docs.searxng.org/) metasearch engine behind `web_search`,
started only when `search.provider` is `"searxng"` (compose profile `search`). See
[Configuration → `search`](configuration.md#search-optional).

### jarvis-piper (`:5000`, internal-only) — offline neural voice
A tiny Python HTTP service (`piper/serve.py`) wrapping [Piper](https://github.com/rhasspy/piper),
an on-device neural text-to-speech engine. The engine binary and voice models are baked
into the image at build time (arch auto-detected for arm64/x86_64), so it runs **fully
offline** and the voice is **machine-independent**. Not published to the host — the app
reaches it at `http://jarvis-piper:5000` and proxies the browser through `/api/tts`
(`app/src/tts.js`). Only used when the voice engine is set to **Piper** (browser TTS needs
no container). See [Voice](voice.md#neural-voice-piper).

## Networks

The stack uses two private Docker networks, so the root shell the model drives can't reach the
sensitive services:

| Network | Members | Why |
| --- | --- | --- |
| `backend` | `jarvis-app`, `jarvis-docker-proxy`, `jarvis-memory`, `jarvis-piper`, `jarvis-searxng` | The app's sidecars. |
| `workbench` | `jarvis-app`, `jarvis-workbench` | The app reaches the workbench's preview ports (9101–9150) by name. |

`jarvis-app` is the only container on both. The workbench — where the LLM has a root shell — sits
on `workbench` alone, so it **cannot reach the Docker API proxy** (which can create and exec into
containers) **or the memory store** (which has no auth). It still has outbound internet.

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

1. The browser sends `{type:"chat", chatId, messages}` over the WebSocket (`/ws`); the
   sign-in is checked again for every message.
2. The app builds the prompt (system prompt + capped history) and calls the model at
   `llm.base_url` (the external LLM endpoint) using the tier's model (`chat` by default).
3. The model streams back. `reasoning_content` deltas feed the **Thinking** panel;
   `content` deltas stream as the answer (and as speech, if voice is on).
4. If the model emits **tool calls**, the app runs them (in parallel where possible),
   streams each to the **Activity** panel, appends results, and loops.
5. When the model produces a final answer with no tool calls, it's sent as the reply.
   Every event of the turn carries its `chatId`, so it lands in the right chat tab. Stop, or
   closing the tab, aborts the turn and its tools.

The same `chat()` path backs the WebSocket UI, the REST `POST /api/chat`, the
terminal (`--prompt`/`--terminal`), and each scheduled task run.

## Volumes & persistence

| Host path | Container | Purpose |
| --- | --- | --- |
| `./app` | `/usr/src/app` | App source (bind mount — edits apply on app restart) |
| `./config/JARVIS_CONFIG.json` | `/cfg/JARVIS_CONFIG.json` | Config (read-write so the UI can persist settings; owner-only on the host) |
| `./config/JARVIS_SECRETS.json` | `/cfg/JARVIS_SECRETS.json` | Credential vault (owner-only on the host) |
| `./LLM_READ_ONLY_FILES` | `/LLM_READ_ONLY_FILES` (ro) | Files you share to JARVIS |
| `./LLM_READ_WRITE_FILES` | `/LLM_READ_WRITE_FILES` | Files exchanged both ways (uploads, deliverables) |
| `./data` | `/data` | `tasks.json`, `chatlog.json`, `sessions/`, `custom_tools/`, `audit.log`, `plans/<key>.json` (task ledgers — one per chat tab, plus `autopilot` and `default`; an old single `plan.json` is migrated), `autopilot.json` (run state), config/secrets backups (pruned to `backups.retain`, default 10) |
| `./Prompts` | `/Prompts` | Active + saved master/system prompt files (see [Prompts](prompts.md)) |
| `./Logs` | `/logs` | Debug logs (per-day, rotated by size + retention) |
| `jarvis_memory_data` | `/data/chroma` | Vector store (Docker volume) |
| `./LLM_WORKSPACE` | `/LLM_WORKSPACE` | The AI's working/build area — a **host bind mount** (visible on your Mac, so you can watch active work); also mounted into the app so file tools can reach it |
| `jarvis_workbench_home` | `/config` | Workbench home (Docker volume) |

Bind mounts (config, secrets, shared folders, `data/`, and **`LLM_WORKSPACE`**) survive
`--delete`; the Docker **volumes** (memory, workbench home) are wiped by it — back them up
first (see [CLI](cli.md)). Note `LLM_WORKSPACE` is now a host folder, so the AI's working
files persist through a `--delete`. Backups made by `./JARVIS.sh` land in `backups/`
(owner-only, and not tracked by git).

To reset **just the workbench OS** (after the LLM has installed a pile of packages) without
touching any data, `./JARVIS.sh --reset-workbench` recreates that one container from its clean
image — the runtime-installed packages live in the container's writable layer, so recreating wipes
them while the `/LLM_WORKSPACE` bind mount (a host folder) and the home **volume** (and every other container) are kept. See [CLI](cli.md#reset-the-dev-workbench).

## Security model

- **Localhost only by default.** Every published port binds to `127.0.0.1`, including the
  9101–9150 preview range (memory and piper aren't published at all). *Allow other devices on
  my network* (Config → Access & users, applied by `./JARVIS.sh --reload`) publishes **only the
  chat UI's port** on every interface; the workbench desktop and previews never leave this
  computer.
- **Optional login** (`app/src/auth.js`, no dependencies): several users, one shared JARVIS.
  Salted scrypt hashes in `data/.password`; a signed session cookie (per-boot key) checked on
  every `/api` route, `/view`, the WebSocket handshake and every chat message on an open
  socket (a removed user or changed password ends it). Failed sign-ins are rate-limited per
  address + login name. If the config file can't be read the app **fails closed** — every API
  answers 503 until it's fixed, so a broken file can't switch the login off. The terminal client runs inside the
  app container on its own loopback, which compose marks as trusted (`JARVIS_TRUST_LOOPBACK`).
- **Cross-site request guard.** The REST API validates the `Host` header (and `Origin`, when
  sent) against localhost names; the WebSocket handshake validates `Origin` (browsers always
  send it; a no-`Origin` client such as a script skips this check and still faces the login).
  So a malicious website can't fire requests at `127.0.0.1:8110` (CSRF) or reach it via DNS
  rebinding. Fronting
  JARVIS with a proxy/tunnel under another hostname? Add it to
  `security.allowed_hosts` in `JARVIS_CONFIG.json`.
- **Root is in a container**, not on your host — and the app reaches the Docker daemon
  only through the filtered `jarvis-docker-proxy` (containers + exec), never the raw
  socket. The workbench is on its own network, so the root shell can't reach that proxy or
  the memory store. Still: every signed-in user has the whole of JARVIS — never open it to a network
  without the login on, and only on a network you trust.
- **Untrusted content.** The system prompt instructs the model to treat web pages,
  files, and screenshots as data, never instructions, and never to send secrets to
  external tools.
- **Secrets** live in `JARVIS_SECRETS.json` and are exposed to the model only via the
  vault tools; every `get_secret` read is surfaced as a 🔑 notice in the chat
  (`secret_access_notice`, default on). The UI's quick settings (`POST /api/settings`) are
  limited to an allowlist with type checks — no keys or secrets. The Config tab's full editor
  (`POST /api/config/full`) can rewrite both files, secrets included (any signed-in user
  can), and refuses a save if a file changed since the tab loaded it. Secrets are redacted
  from the debug logs. See [Configuration](configuration.md#settings-the-ui-can-change).
