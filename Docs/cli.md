# CLI — `JARVIS.sh`

The control script wraps `docker compose` and adds lifecycle, scripting, backup, and
diagnostic commands. Run from the repo root. Lifecycle flags can be chained
(e.g. `./JARVIS.sh --setup --start`).

## Lifecycle

| Command | What it does |
| --- | --- |
| `-c`, `--check` | Verify Docker is running and the config is valid. |
| `-b`, `--setup` | Build the app / memory / workbench images and pull the gateway image. First workbench build is large (several minutes). |
| `-u`, `--start` | Start the whole stack; prints the URLs. |
| `-r`, `--reload` | Re-read `JARVIS_CONFIG.json` + secrets (restarts the app only; memory/workbench/gateway stay up). |
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
