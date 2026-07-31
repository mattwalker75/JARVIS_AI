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
ensures the runtime is up, and prints the URL. The backend is **pluggable**: **Ollama**
and **MLX** (Apple Silicon) today, with vLLM / llama.cpp addable later as new backend blocks
(select with `--backend`).

| Command | What it does |
| --- | --- |
| `start [--backend ollama\|mlx] [--gateway]` | Apply local config, ensure the runtime is up, and print the URL to paste into Config. `--gateway` also **syncs the gateway's model list from the live backend** (see below) and brings up the LiteLLM gateway in front of it. |
| `gateway-sync [--backend ollama\|mlx]` | Regenerate the gateway's auto-managed model list from the selected live backend, then reload the gateway if it's running — without a full `start`. |
| `url [--gateway]` | Just print the endpoint URL (nothing else) — direct to the runtime, or the gateway's URL with `--gateway`. |
| `status` | Show whether the runtime and the gateway (`:4000`) are up. |
| `stop [--gateway]` | Stop the runtime (and the gateway with `--gateway`). |
| `config [--backend ollama\|mlx]` | Print a start-to-finish **setup guide** for that backend — install, models, tuning, and how to point JARVIS at it. Great first stop. |

```bash
# First time? print the setup steps (install link, pull commands, config)
./JARVIS_LOCAL_LLM.sh config

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

**Auto-synced model list.** `litellm/config.yaml` has an auto-managed block (delimited by
`BEGIN/END local routes` markers) that `start --gateway` and `gateway-sync` **regenerate from the
live `--backend`** — Ollama's installed tags, or the MLX servers that are actually up — so the
gateway never advertises models you don't have. Your **cloud routes above the marker are left
untouched.** This is why "List models" in the Config tab, when pointed at the gateway, mirrors your
real local models plus whatever cloud routes you deliberately keep. (For pure-Ollama use you can skip
the gateway entirely and point Config straight at `http://host.docker.internal:11434/v1`, which is
introspected live and needs no config file at all.)

### MLX backend (Apple Silicon)

[MLX](https://github.com/ml-explore/mlx) runs local models natively on the macOS **host** via
`mlx-lm`'s OpenAI-compatible server (it needs Metal, so it can't run inside the containers). It
lives under `mlx/` with its own Python venv:

```bash
source ./ACTIVATE.sh        # 1st run: creates mlx/venv + installs mlx-lm; models cache in mlx/models
                            #          (leave the env with:  source ./DEACTIVATE.sh)
./JARVIS_LOCAL_LLM.sh config --backend mlx                        # full setup guide
./JARVIS_LOCAL_LLM.sh mlx-serve mlx-community/Qwen2.5-7B-Instruct-4bit   # bring a model online (its own port)
./JARVIS_LOCAL_LLM.sh mlx-ls                                      # list running MLX servers
./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway              # discover them → one URL via LiteLLM
./JARVIS_LOCAL_LLM.sh mlx-stop all                               # stop the server process(es)
```

MLX is **discovery-based, like Ollama** — there's no config array. You bring models online with
**`mlx-serve <model>`** (each = its own `mlx_lm.server` process on its own port, so several stay hot at
once), and the script **discovers** the running servers and maps them. Models are Hugging Face
**`mlx-community`** repos (auto-downloaded on first serve). `mlx-serve` records what it started so
**`mlx-up`** can relaunch your set after a reboot. For **multiple** models behind one endpoint use
`--gateway`; for a single model, paste its `http://host.docker.internal:<port>/v1` straight into Config.
`mlx-lm` is text-only — keep **vision** on Ollama (`qwen2.5vl`) for now.

| MLX command | What it does |
| --- | --- |
| `mlx-serve <model> [--port N] [--gateway]` | Start one model as its own server (auto-port), register it; `--gateway` also syncs the gateway. |
| `mlx-stop <model\|port\|all>` | Stop one or all MLX servers. |
| `mlx-ls` | List running MLX servers (model + port). |
| `mlx-up` | Relaunch the registered set (e.g. after a reboot). |
