# CLI — `JARVIS.sh`

The control script wraps `docker compose` and adds lifecycle, scripting, backup, and
diagnostic commands. Run from the repo root. Lifecycle flags can be chained
(e.g. `./JARVIS.sh --setup --start`).

## Lifecycle

| Command | What it does |
| --- | --- |
| `-c`, `--check` | Verify Docker is running and the config is valid. |
| `-b`, `--setup` | Build the app / memory / workbench images. First workbench build is large (several minutes). |
| `-u`, `--start` | Start the whole stack; prints the URLs. |
| `-r`, `--reload` | Re-read `JARVIS_CONFIG.json` + secrets (restarts the app only; memory/workbench stay up). Model-agnostic — it no longer touches Ollama or provider keys (that moved to [`JARVIS_LOCAL_LLM.sh`](#jarvis_local_llmsh--local-model-runtime)). |
| `-i`, `--status` | Show what's running + app health. |
| `-x`, `--stop` | Stop the stack (keeps all data). |
| `-d`, `--delete` | Remove containers, network, and **all data volumes** (semantic memory + `/workspace` + workbench home). Bind mounts survive. |
| `-h`, `--help` | Full help. |

## Scripting (no browser)

| Command | What it does |
| --- | --- |
| `-t`, `--terminal` | Interactive chat in the terminal. |
| `-p`, `--prompt "..."` | One-shot prompt → answer on **stdout** (tool activity goes to stderr). |

Pipe data in — stdin is appended to the prompt:

```bash
cat app.log       | ./JARVIS.sh --prompt "analyze this log and list the issues"
git diff          | ./JARVIS.sh --prompt "review this diff for bugs"
./JARVIS.sh --prompt "summarize this" < report.txt
```

Both reuse the same tool-calling loop as the UI, so JARVIS can use memory, the shell,
the internet, and files while answering.

In `--terminal` you can also manage saved conversations: `/sessions`, `/save [name]`,
`/load <id>`, `/reset`, `/exit`.

> For programmatic access from other scripts/machines, prefer the REST endpoint
> `POST /api/chat` — see [API](api.md).

## Diagnostics

| Command | What it does |
| --- | --- |
| `-e`, `--eval` | Replay `data/evals/*.json` through the live model + tool loop and report pass/fail. A regression check after changes. |
| `--probe-context` | Measure the current model's usable context window (needle-in-a-haystack). Works for local and remote models. |

## Backup & restore

Backups are written to `backups/`. The semantic memory and `/workspace` live in Docker
volumes (wiped by `--delete`), so back them up if you care about them.

| Command | What it does |
| --- | --- |
| `--backup-memory` | Tarball the Chroma vector store to `backups/`. |
| `--backup-workspace` | Tarball the workbench `/workspace` to `backups/`. |
| `--restore-memory --from <file>` | Restore memory from a backup (replaces current). |
| `--restore-workspace --from <file>` | Restore `/workspace` from a backup. |

```bash
./JARVIS.sh --backup-memory
./JARVIS.sh --restore-memory --from backups/jarvis-memory-20260702-224412.tgz
```

### Reset the dev workbench

`--reset-workbench` is the escape hatch for when the LLM has installed a pile of packages or made
a mess of the system. It recreates **only** the workbench container from its clean built image, so
every runtime `apt`/`pip` install and system tweak is wiped:

```bash
./JARVIS.sh --reset-workbench
```

- **Wiped:** everything the LLM installed/changed at runtime (the container's OS layer).
- **Kept:** `/workspace` build files and the workbench home (desktop + any browser logins).
- **Untouched:** the app, memory, config, and `READ_WRITE_FILES` — nothing else restarts.

For a deeper reset: also wipe `/workspace` with `--restore-workspace --fresh`, or rebuild the
workbench **image** with `--setup`.

## Typical sessions

```bash
# First run
./JARVIS.sh --check --setup --start

# Everyday
./JARVIS.sh --start
./JARVIS.sh --stop

# After editing JARVIS_CONFIG.json
./JARVIS.sh --reload

# Nuke and rebuild (wipes memory + workspace)
./JARVIS.sh --stop --delete
./JARVIS.sh --setup --start
```

---

## `JARVIS_LOCAL_LLM.sh` — local model runtime

JARVIS core no longer hosts models. `JARVIS.sh` is now model-agnostic: it doesn't
manage Ollama or export provider keys. If you run a **local** model, this optional
helper manages the runtime and prints the endpoint URL to paste into **Config →
Endpoint URL**. **Cloud users don't need it** — point `llm.base_url` straight at the
provider and skip this entirely.

It applies your local Ollama settings from the `ollama.*` block of `JARVIS_CONFIG.json`
(context length, keep-alive, parallelism — see [Configuration](configuration.md#ollama-optional)),
ensures the runtime is up, and prints the URL. The backend is **pluggable**: Ollama
today, with MLX / vLLM / llama.cpp addable later as new backend blocks.

| Command | What it does |
| --- | --- |
| `start [--backend ollama] [--gateway]` | Apply local config, ensure the runtime is up, and print the URL to paste into Config. `--gateway` also brings up the LiteLLM gateway in front of it. |
| `url [--gateway]` | Just print the endpoint URL (nothing else) — direct to the runtime, or the gateway's URL with `--gateway`. |
| `status` | Show whether the runtime (`:11434`) and the gateway (`:4000`) are up. |
| `stop [--gateway]` | Stop the runtime (and the gateway with `--gateway`). |

```bash
# Running a local model
./JARVIS_LOCAL_LLM.sh start          # → prints e.g. http://host.docker.internal:11434/v1
# paste that into Config → Endpoint URL, set your model to the Ollama tag (e.g. qwen3:8b)

# With the LiteLLM gateway (one endpoint, multi-model routing across providers)
./JARVIS_LOCAL_LLM.sh start --gateway   # → prints http://host.docker.internal:4000/v1
```

The **`--gateway`** option fronts the runtime with the LiteLLM gateway, which lives in
its own standalone `litellm/docker-compose.yml` (started by this script, **not** by
`JARVIS.sh`). It gives you one OpenAI-compatible endpoint with multi-model/provider
routing (config in `litellm/config.yaml`); provider keys (`llm.anthropic_api_key`,
`llm.gemini_api_key`, …) are exported into the gateway from `JARVIS_CONFIG.json`. Without
`--gateway`, JARVIS talks straight to the runtime.
