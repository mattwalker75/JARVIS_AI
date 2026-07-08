# JARVIS

A personal, local **AI framework**: a private web app around an LLM that has real
capabilities — persistent semantic **memory**, a **root Linux workbench**, a real
**web browser** it drives, **desktop/computer use**, **email**, **file** exchange,
open **internet** access, a **task scheduler**, and hands-free **voice**. Everything
runs on your machine and binds to **localhost only**.

The model backend is flexible: a built-in **LiteLLM gateway** fans out to local
models (via **Ollama**) and/or cloud providers (OpenAI, Anthropic, Gemini), and you
can mix them per task (e.g. a fast local model for chat, a bigger one for hard
reasoning, a vision model for screenshots).

> ⚠️ **Powerful by design.** JARVIS runs arbitrary root commands in its workbench
> container, drives a browser, and can use your saved accounts. That's intentional.
> The stack is **localhost-only**, root is **inside a container** (not your host),
> and keys live in the gitignored `JARVIS_CONFIG.json`. Run it on a machine you trust.

## The stack

Five containers (`docker compose`, project `jarvis`, all bound to `127.0.0.1`):

| Container | Role | Port |
| --- | --- | --- |
| `jarvis-app` | Node.js orchestrator + web UI (chat, tool-calling, voice) | 8110 |
| `jarvis-memory` | Semantic long-term memory ([Mem0](https://github.com/mem0ai/mem0) + Chroma) | 8120 |
| `jarvis-litellm` | LLM gateway — one endpoint, many providers | 4000 |
| `jarvis-workbench` | Ubuntu XFCE desktop the LLM works in as root (noVNC) | 8111 |
| `jarvis-piper` | Offline neural text-to-speech ([Piper](https://github.com/rhasspy/piper)) | internal |

The app drives the workbench through the Docker socket (`docker exec`), reaches
memory + the gateway over the internal network, and shares two host folders
(`READ_ONLY_FILES/` → you-to-JARVIS, `READ_WRITE_FILES/` ↔ both ways).

## Quick start

```bash
cp JARVIS_CONFIG_template.json JARVIS_CONFIG.json   # then edit: pick a model + add a key
./JARVIS.sh --check      # verify Docker is running
./JARVIS.sh --setup      # build images (the workbench is large — first build takes a while)
./JARVIS.sh --start      # start everything; prints the URLs
```

- **Chat UI:** <http://localhost:8110/>
- **Workbench desktop:** <http://localhost:8111/>
- **Health / self-test:** `curl http://localhost:8110/api/selftest`

Running fully local? Install [Ollama](https://ollama.com) on your host, pull a model
(`ollama pull qwen3-next:80b`), and JARVIS talks to it through the gateway — no cloud
key required (except for internet research and package installs).

## What it can do

- **Chat** with rich markdown, a live "thinking" panel for reasoning models, and
  spoken replies.
- **Remember** facts about you across conversations (semantic memory you can browse
  and prune in the UI).
- **Run anything** in a root Linux workbench (2000+ preinstalled tools; installs more
  on demand).
- **Use the web** — read pages/APIs, search, and drive a real browser by DOM
  selectors (not pixel guessing).
- **See** — analyze screenshots and image files with a vision model.
- **Do email** — read and send from your own account.
- **Read documents** — extract text from PDF/DOCX/EPUB.
- **Schedule** one-shot and recurring tasks that notify you.
- **Talk** — hands-free voice conversation that streams speech as it answers.

## Extending it

JARVIS is built to grow without editing core code:

- **Custom tools** — drop a JS file in `data/custom_tools/` and restart.
- **MCP servers** — add external tool servers in config; they register automatically.
- **Personas** — define alternate system prompts and switch per conversation.
- **Models/providers** — add a line to `litellm/config.yaml`; use it by name.
- **Skills** — on-demand how-to playbooks the model reads before hard tasks.
- **REST API** — `POST /api/chat` for scripts, cron, and other machines.

## Documentation

Detailed docs live in **[`Docs/`](Docs/README.md)**:

| Doc | Contents |
| --- | --- |
| [Architecture](Docs/architecture.md) | Containers, data flow, the gateway, volumes, security model |
| [Configuration](Docs/configuration.md) | Full `JARVIS_CONFIG.json` reference |
| [Tools](Docs/tools.md) | Every tool the LLM can call, by family |
| [Web UI](Docs/web-ui.md) | Tabs, slash commands, model switcher, files, drag-drop |
| [Voice](Docs/voice.md) | Voice modes, streaming TTS, barge-in |
| [Memory & Scheduling](Docs/memory-and-scheduling.md) | Semantic memory + scheduled tasks |
| [CLI](Docs/cli.md) | `JARVIS.sh` command reference |
| [API](Docs/api.md) | HTTP + WebSocket endpoints |
| [Extending](Docs/extending.md) | Custom tools, MCP, personas, models, skills |

## Languages

- **JavaScript** frontend (`app/public/`) and **Node.js** backend (`app/server.js`, `app/src/`)
- **Python** for the memory sidecar (`memory/`) and the browser daemon (`app/src/browserd.py`)
- **Bash** control script (`JARVIS.sh`)

See [`CHANGELOG.md`](CHANGELOG.md) for the full development history.
