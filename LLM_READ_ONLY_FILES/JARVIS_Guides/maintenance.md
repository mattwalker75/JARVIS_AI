# Maintenance (start/stop, reset, backups)

All run from the project folder with **`./JARVIS.sh`** (run `./JARVIS.sh --help` for the full list).

## Start / stop

```
./JARVIS.sh --start        # bring the stack up; prints the URLs
./JARVIS.sh --stop         # stop it (keeps your data)
./JARVIS.sh --status       # what's running
./JARVIS.sh --reload       # restart just the app to re-read config files
```
Chat UI is at http://localhost:8110/ ; the workbench desktop at http://localhost:8111/.

## Reset the dev workbench (when the LLM installs too much / breaks it)

```
./JARVIS.sh --reset-workbench
```
Deletes & rebuilds ONLY the workbench container (the Linux the LLM works in) from its clean image —
wipes every apt/pip package and system tweak it installed at runtime. **Keeps** your `/LLM_WORKSPACE`
build files and browser logins, and leaves the app, memory, config, and LLM_READ_WRITE_FILES untouched.

- Also rebuild the **image** (e.g. after a Dockerfile change): `./JARVIS.sh --setup`
- Also wipe **/LLM_WORKSPACE** (the LLM's build files): `./JARVIS.sh --restore-workspace --fresh`

## Backups

```
./JARVIS.sh --backup-memory       # semantic memory -> backups/
./JARVIS.sh --backup-workspace    # the LLM's /LLM_WORKSPACE -> backups/
./JARVIS.sh --restore-memory --from <file>
./JARVIS.sh --restore-workspace --from <file>
```

## Full teardown

```
./JARVIS.sh --stop --delete       # removes containers + the Docker volumes (memory + workbench home)
                                  #   LLM_WORKSPACE is a host folder now, so it (+ your files) survive
./JARVIS.sh --setup --start       # rebuild + start fresh
```
Your `config/`, secrets, and the shared folders survive `--delete` (they're on disk, not volumes).

> Config, secrets, and their templates live in the **`config/`** folder. Local-LLM runtimes
> (Ollama/MLX) are managed separately by `./JARVIS_LOCAL_LLM.sh`, not `JARVIS.sh`.
