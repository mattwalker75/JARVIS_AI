# JARVIS

A personal, local **AI framework**: a private web app around an LLM that has real
capabilities — persistent semantic **memory**, a **root Linux workbench**, a real
**web browser** it drives, **desktop/computer use**, **email**, **file** exchange,
open **internet** access, a **task scheduler**, and hands-free **voice**. Everything
runs on your machine and binds to **localhost only**.

The model backend is flexible: JARVIS is a pure OpenAI-dialect client that talks to
whatever endpoint you point it at — a **cloud provider** (OpenAI, Anthropic, Gemini, …),
or a **local runtime** you start with the optional `./JARVIS_LOCAL_LLM.sh` helper (**Ollama**
and **MLX** today; vLLM / llama.cpp later). An optional **LiteLLM gateway** can front several
providers behind one endpoint so you can mix them per task (a fast local model for chat, a
bigger one for hard reasoning, a vision model for screenshots).

> ⚠️ **Powerful by design.** JARVIS runs arbitrary root commands in its workbench
> container, drives a browser, and can use your saved accounts. That's intentional.
> The stack is **localhost-only**, root is **inside a container** (not your host),
> and keys live in the gitignored `JARVIS_CONFIG.json`. Run it on a machine you trust.

## The stack

Four containers (`docker compose`, project `jarvis`, all bound to `127.0.0.1`):

| Container | Role | Port |
| --- | --- | --- |
| `jarvis-app` | Node.js orchestrator + web UI (chat, tool-calling, voice) | 8110 |
| `jarvis-memory` | Semantic long-term memory ([Mem0](https://github.com/mem0ai/mem0) + Chroma) | 8120 |
| `jarvis-workbench` | Ubuntu XFCE desktop the LLM works in as root (noVNC) | 8111 |
| `jarvis-piper` | Offline neural text-to-speech ([Piper](https://github.com/rhasspy/piper)) | internal |

The **LLM is not in the stack** — the app talks OpenAI-dialect to whatever `llm.base_url`
points at (a cloud provider, or a local runtime you start with `./JARVIS_LOCAL_LLM.sh`,
reached over `host.docker.internal`). The optional LiteLLM gateway now lives in its own
`litellm/docker-compose.yml`, started by that helper.

The app drives the workbench through the Docker socket (`docker exec`), reaches
memory over the internal network, and shares two host folders
(`READ_ONLY_FILES/` → you-to-JARVIS, `READ_WRITE_FILES/` ↔ both ways).

## Quick start

```bash
cp config/JARVIS_CONFIG_template.json config/JARVIS_CONFIG.json   # then edit: pick a model + add a key
./JARVIS.sh --check      # verify Docker is running
./JARVIS.sh --setup      # build images (the workbench is large — first build takes a while)
./JARVIS.sh --start      # start everything; prints the URLs
```

- **Chat UI:** <http://localhost:8110/>
- **Workbench desktop:** <http://localhost:8111/>
- **Health / self-test:** `curl http://localhost:8110/api/selftest`

Running fully local? Install [Ollama](https://ollama.com) on your host, pull a model
(`ollama pull qwen3-next:80b`), then run `./JARVIS_LOCAL_LLM.sh start` and **paste the URL
it prints into Config → Endpoint URL** — no cloud key required (except for internet
research and package installs). Add `--gateway` to front it with LiteLLM for multi-model
routing. See [CLI](Docs/cli.md#jarvis_local_llmsh--local-model-runtime).

## What it can do

- **Chat** with rich markdown, clickable links, a live "thinking" panel for reasoning
  models, and spoken replies.
- **Plan & execute multi-step work** — for anything non-trivial it keeps a persistent
  **task ledger** (objective + checklist) shown live above the chat, so it resumes
  correctly after any interruption instead of forgetting where it was.
- **Autopilot** — give it an objective and a time budget and it works **autonomously**
  (build → test → refine → fix) until done, the budget's up, or it gets stuck. It runs
  server-side (close the tab and walk away), notifies you when finished, and you can
  **pause / resume / modify / extend / continue** it from the status bar. A verbose
  switch streams its thinking to the chat so you can watch it work — and JARVIS can even
  **offer** to run a suitable job on Autopilot, opening the launcher pre-filled for you to Start.
- **Remember** facts about you across conversations (semantic memory you can browse
  and prune in the UI).
- **Run anything** in a root Linux workbench (2000+ preinstalled tools; installs more
  on demand). Targeted `edit_*` tools change files without risky whole-file rewrites.
- **Use the web** — read pages/APIs, search, and drive a real browser by DOM
  selectors (not pixel guessing), including reading a page's **JS console** to debug
  a running web app.
- **See** — analyze screenshots and image files with a vision model.
- **Do email** — read and send from your own account.
- **Read documents** — extract text from PDF/DOCX/EPUB.
- **Schedule** one-shot and recurring tasks that notify you.
- **Talk** — hands-free voice conversation that streams speech as it answers.
- **Shape its identity** — an editable **prompt library** (master + system prompts) with
  ready-made personas (coder, researcher, investment, pentester, and ~35 more) you can
  load and switch between.
- **Manage context** — a live context-window meter with one-click **Summarize & continue**
  to compact a long conversation and keep going.

## Extending it

JARVIS is built to grow without editing core code:

- **Prompts** — edit the master + system prompt in the Config tab, or drop
  `<name>_master.prompt` / `<name>_system.prompt` files in `Prompts/`; the tooling
  instructions are appended automatically.
- **Providers** — pick a provider (OpenAI, Groq, OpenRouter, Ollama, …) in the Config
  tab, paste a key, and **List models** to choose one — or add a line to
  `litellm/config.yaml` and use it by name. The tier pickers group models by capability
  from a curated, editable `models.json` (see `MODELS.md` for the reference).
- **Custom tools** — drop a JS file in `data/custom_tools/` and restart.
- **MCP servers** — add external tool servers in config; they register automatically.
- **Skills** — on-demand how-to playbooks the model reads before hard tasks.
- **REST API** — `POST /api/chat` for scripts, cron, and other machines.

## Documentation

Detailed docs live in **[`Docs/`](Docs/README.md)**:

| Doc | Contents |
| --- | --- |
| [Architecture](Docs/architecture.md) | Containers, data flow, external LLM serving, volumes, security model |
| [Configuration](Docs/configuration.md) | Full `JARVIS_CONFIG.json` reference |
| [Local models](Docs/local-llm.md) | Running models locally — Ollama vs MLX, setup + how to use |
| [Tools](Docs/tools.md) | Every tool the LLM can call, by family |
| [Autopilot & Planner](Docs/autopilot.md) | The task ledger and autonomous objective loops |
| [Prompts & Context](Docs/prompts.md) | Master/system prompt library + the context-window meter |
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
