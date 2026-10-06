# CLI — `JARVIS.sh`

The control script wraps `docker compose` and adds lifecycle, scripting, backup, and
diagnostic commands. Run from the repo root. Lifecycle flags can be chained
(e.g. `./JARVIS.sh --setup --start`).

## Lifecycle

| Command | What it does |
| --- | --- |
| `-c`, `--check` | Verify the Docker daemon is running (it doesn't check the config). |
| `-b`, `--setup` | Build the app / memory / workbench images (the workbench image is skipped while the workbench is turned off — `workbench.enabled: false`). First workbench build is large (several minutes). The workbench's base image comes from `workbench.base_image` in the config (pin a digest there for reproducible rebuilds). Creates `config/JARVIS_CONFIG.json` / `config/JARVIS_SECRETS.json` from their templates if they're missing (see below). |
| `-u`, `--start` | Start the whole stack; prints the URLs. With the workbench turned off, everything but the workbench starts (and a workbench still running from before is stopped). The SearXNG search container starts too when `search.provider` is `searxng`. |
| `-r`, `--reload` | Re-read `JARVIS_CONFIG.json` + secrets (restarts the app only; memory/workbench stay up — so a change to the **memory** settings, e.g. its embedding key, needs `docker restart jarvis-memory` or `--stop --start`). If "Allow other devices on my network" changed, the app container is re-created so its port is opened (or closed) to the network — this works even if the app was stopped. Starts the SearXNG search container when `search.provider` is now `searxng`. Also applies the workbench switch: stops the workbench container when it is turned off, starts it (creating it if needed) when it is on. A reload signs everyone out. Model-agnostic — it no longer touches Ollama or provider keys (that moved to [`JARVIS_LOCAL_LLM.sh`](#jarvis_local_llmsh--local-model-runtime)). |
| `--update` | `git pull --ff-only`, show the incoming commits, **rebuild only the images whose sources changed**, and restart. The app image is rebuilt only when `app/package.json`, `app/package-lock.json`, `app/Dockerfile` or `app/.dockerignore` changed (and then its installed packages are renewed too); other app-code changes need just the restart, because the source is bind-mounted. Memory / piper / workbench are rebuilt when their folders changed. |
| `-i`, `--status` | Show what's running + app health. A workbench that is turned off is shown as *off*, not as a failure. |
| `-x`, `--stop` | Stop the stack (keeps all data). Like `--start`, it clears the saved Autopilot run and the default plan (`data/plans/autopilot.json`, `data/plans/default.json`) so the next start is a clean slate; each chat tab's own plan stays. |
| `-d`, `--delete` | Remove containers, networks, and the **data volumes** (semantic memory + workbench home). Bind mounts survive — including config, the shared folders, and **`LLM_WORKSPACE`** (the AI's working files persist on your Mac). If memory is online, it first **asks whether to back it up** before wiping. |
| `-f`, `--force` | Skip interactive confirmations — `--delete`'s "back up memory first?" prompt (e.g. `--stop --delete --force`) and the "Continue? [y/N]" of `--restore-memory` / `--restore-workspace`. |
| `-h`, `--help` | Full help. |

**Config files.** `--setup`, `--start` and `--reload` create `config/JARVIS_CONFIG.json` and
`config/JARVIS_SECRETS.json` from their `_template.json` copies when either is missing (Docker
would otherwise make an empty *folder* with that name), and set both files — plus the config's
automatic backup copies — to **owner-only** (readable by your user account only), since they
hold keys and passwords.

**Time zone.** `JARVIS.sh` passes this computer's time zone into the containers (read from
`/etc/localtime`; set `TZ` yourself to override), so reminders and "what time is it" use your
local time.

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

Commands inside `--terminal`:

| Command | What it does |
| --- | --- |
| `/sessions` | List saved conversations. |
| `/save [name]` | Save this conversation (again under the same id once saved). |
| `/load <id>` | Load a saved conversation and continue it. |
| `/reset` | Clear the conversation history. |
| `/tasks` | List active scheduled tasks, with each one's last result. |
| `/notes` (or `/notifications`) | Show the 10 most recent notifications. |
| `/exit` (or `/quit`) | Leave the terminal chat. |

New notifications (e.g. from scheduled tasks) also appear in the terminal on their own,
marked 🔔.

Scheduling works from the terminal too: a task you ask for in `--terminal` or `--prompt`
("remind me at 5pm …") is saved to `data/tasks.json` and the running server picks it up
and runs it, just like one scheduled from the browser.

Edits to the active prompt files apply on your next message, even in a `--terminal`
session that is already open — the system prompt is rebuilt every turn. (Other config
changes reach the terminal chat when you start a new one.)

> For programmatic access from other scripts/machines, prefer the REST endpoint
> `POST /api/chat` — see [API](api.md).

## Diagnostics

| Command | What it does |
| --- | --- |
| `-e`, `--eval` | Replay `data/evals/*.json` through the live model + tool loop and report pass/fail. A regression check after changes — see [Evals](evals.md). |
| `--probe-context` | Measure the current model's usable context window (needle-in-a-haystack). Works for local and remote models. |

## Backup & restore

Backups are written to `backups/`, readable by your user account only. They hold personal
data, so `backups/` is **not tracked by git** (never committed). The semantic memory lives in a
Docker volume (wiped by `--delete`), so back it up if you care about it. `LLM_WORKSPACE` is a
**host bind mount** (`./LLM_WORKSPACE`), so it survives `--delete` — but you can still snapshot it below.

| Command | What it does |
| --- | --- |
| `--backup-memory` | Tarball the Chroma vector store to `backups/`. |
| `--backup-workspace` | Tarball the workbench `/LLM_WORKSPACE` to `backups/`. |
| `--restore-memory --from <file>` | Restore memory from a backup (replaces current). |
| `--restore-memory --fresh` | Reset to a **fresh, empty** memory (destroys all stored memories). |
| `--restore-workspace --from <file>` | Restore `/LLM_WORKSPACE` from a backup (replaces current, hidden dot-files included). |
| `--restore-workspace --fresh` | Reset `/LLM_WORKSPACE` to **empty**. |

The restore commands are careful by design:

- You must say which one you mean — `--from <file>` **or** `--fresh`. A bare
  `--restore-memory` (or a `--from` with no file name) is refused instead of wiping anything.
- With `--from`, the backup is checked first (it must exist and be a readable `.tgz`); a bad
  file is refused and **nothing is changed**.
- They ask **"Continue? [y/N]"** before replacing or wiping anything. `-f` / `--force` skips the
  question; without a terminal to ask on (a script) and no `--force`, the answer is **no**.
- The backup is unpacked into a temporary folder first, and the old contents are swapped out
  only once that worked — a failed restore leaves your current data as it was.

> The memory service itself is **internal-only** (no host port); these commands work
> through `docker exec` and the Docker volume, so nothing needs to be exposed.

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
- **Kept:** `/LLM_WORKSPACE` build files and the workbench home (desktop + any browser logins).
- **Untouched:** the app, memory, config, and `LLM_READ_WRITE_FILES` — nothing else restarts.

For a deeper reset: also wipe `/LLM_WORKSPACE` with `--restore-workspace --fresh`, or rebuild the
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

# Nuke and rebuild (wipes the memory + the workbench home; LLM_WORKSPACE is kept)
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
| `start [--backend ollama\|mlx] [--gateway]` | Apply local config, ensure the runtime is up, and print the URL to paste into Config. `--gateway` also **syncs the gateway's model list from the live backend** (see below) and brings up the LiteLLM gateway in front of it. If the runtime (or the gateway) doesn't come up, it says so and exits with an error instead of printing a URL. |
| `gateway-sync [--backend ollama\|mlx]` | Regenerate the gateway's auto-managed model list from the selected live backend, then reload the gateway if it's running — without a full `start`. |
| `url [--gateway]` | Just print the endpoint URL (nothing else) — direct to the runtime, or the gateway's URL with `--gateway`. |
| `status` | Show whether Ollama, any running MLX servers, and the gateway (`:4000`) are up. |
| `stop [--backend ollama\|mlx] [--gateway]` | With no `--backend`, stops **every** local runtime that's running: it **quits Ollama** (which also stops the embedding model the memory service uses, if that runs on Ollama) and stops **every MLX server on this computer**, even ones this script didn't start. `--backend` stops just that one. The gateway's local routes are cleared; `--gateway` also stops the gateway. |
| `config [--backend ollama\|mlx]` | Print a start-to-finish **setup guide** for that backend — install, models, tuning, and how to point JARVIS at it. Great first stop. |
| `list-models [--backend ollama\|mlx] [--details] [--json]` | **Inventory of what you've DOWNLOADED** — the question `status` and `mlx-ls` can't answer (they only report what's *live*). No `--backend` lists both runtimes. The default view is deliberately lean: name, size on disk, and state (serving / ready / downloaded / incomplete), plus warnings you shouldn't miss. **`--details`** adds what KIND of model each one is — architecture, dense vs MoE, quantization, context window, instruct-vs-base, tool-calling and vision — read from metadata already on disk (no network, no model load). `--json` always returns the full record. |
| `delete-model <model> [--backend ollama\|mlx] [--yes]` | Delete a downloaded model to reclaim disk. **Exact name only** (no patterns), refuses while an **MLX** model is serving (an Ollama model is deleted even if loaded), shows the space reclaimed and confirms first (`--yes` skips the prompt, never the safety checks). Ollama deletes go through the daemon; MLX repos through the Hugging Face cache, and the model is dropped from the serve registry so `mlx-up` can't resurrect it. |

```bash
# First time? print the setup steps (install link, pull commands, config)
./JARVIS_LOCAL_LLM.sh config

# Running a local model
./JARVIS_LOCAL_LLM.sh start          # → prints e.g. http://host.docker.internal:11434/v1
# paste that into Config → Endpoint URL, set your model to the Ollama tag (e.g. qwen3:8b)

# With the LiteLLM gateway (one endpoint, multi-model routing across providers)
./JARVIS_LOCAL_LLM.sh start --gateway   # → prints http://host.docker.internal:4000/v1

# What have I actually got on disk? (both runtimes; add --backend to narrow)
./JARVIS_LOCAL_LLM.sh list-models
./JARVIS_LOCAL_LLM.sh delete-model qwen3:8b     # reclaim the space (confirms first)
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
./JARVIS_LOCAL_LLM.sh list-models --backend mlx                   # list DOWNLOADED models (+ what's serving)
./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway              # discover them → one URL via LiteLLM
./JARVIS_LOCAL_LLM.sh mlx-stop all                               # stop the server process(es)
```

MLX is **discovery-based, like Ollama** — there's no config array. You bring models online with
**`mlx-serve <model>`** (each = its own `mlx_lm.server` process on its own port, so several stay hot at
once), and the script **discovers** the running servers and maps them. MLX servers listen on
**this computer only** (`127.0.0.1` — they have no login); Docker Desktop on a Mac still reaches
them via `host.docker.internal`. Set `MLX_HOST=0.0.0.0` before `mlx-serve` to open one to your network on purpose. Models are Hugging Face
**`mlx-community`** repos (auto-downloaded on first serve). `mlx-serve` records what it started so
**`mlx-up`** can relaunch your set after a reboot. For **multiple** models behind one endpoint use
`--gateway`; for a single model, paste its `http://host.docker.internal:<port>/v1` straight into Config.
**Two runtimes.** `mlx-lm` serves **text** models; **vision-language** models (`image-text-to-text`)
are implemented in **`mlx-vlm`**, which covers many more architectures — a number of recent models
run only there. `mlx-serve` reads each model's `config.json` and starts the right server
automatically — a vision model (its config has a `vision_config` section) goes to `mlx-vlm`
whenever `mlx-vlm` supports it, since `mlx-lm` would serve it text-only (override with `--runtime lm|vlm`), and `list-models --details` names the runtime per
model. Install when needed: `./mlx/venv/bin/pip install mlx-vlm`. Note mlx-vlm has **no
`default_model` alias** — Config → Model must be the exact repo id you served.

| MLX command | What it does |
| --- | --- |
| `mlx-serve <model> [--port N] [--runtime lm\|vlm] [--gateway]` | Start one model as its own server (auto-port; `--port` must be 1–65535) and wait up to 3 minutes for it to answer. It is added to the registry (`mlx/serving.json`, used by `mlx-up`) once it answers — or after the 3-minute wait, which is reported as a **failure** (exit code non-zero; big models may still be loading — see its log in `mlx/`). `--runtime` forces `mlx-lm` or `mlx-vlm`. Only one model per command. `--gateway` also syncs the gateway (only when the server came up). |
| `mlx-stop <model\|port\|all>` | Stop one or all MLX servers (it stops only the process *listening* on the model's port, never a program connected to it). |
| `mlx-ls` | List running MLX servers (model + port). |
| `mlx-up` | Relaunch the registered set (e.g. after a reboot). |
