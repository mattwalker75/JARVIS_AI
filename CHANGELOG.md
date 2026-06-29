# Changelog

All notable changes to JARVIS are tracked here.

This project follows a Keep a Changelog-style format. Keep the `[Unreleased]`
section current with concise notes about user-facing, operational,
infrastructure, security, documentation, or test-policy changes.

## [Unreleased]

### Added
- 2026-06-27: Initial JARVIS AI enablement stack. A multi-container application
  (docker compose, localhost only): `jarvis-app` (Node.js backend + JavaScript
  frontend), `jarvis-db` (MySQL 8 the LLM uses as memory with full admin), and
  `jarvis-workbench` (Ubuntu XFCE desktop via noVNC that the LLM works in as
  root and the user can watch).
- 2026-06-27: Flexible model backend — any OpenAI-compatible `/chat/completions`
  endpoint (OpenAI or local models via Ollama), plus a built-in `mock` provider
  for offline testing. Configured in `JARVIS_CONFIG.json`
  (`JARVIS_CONFIG_template.json` is the committed reference).
- 2026-06-27: LLM tool-calling with three capability families — `sql` (full-admin
  memory database), `run_shell` (root command in the workbench), and shared-file
  tools (`read_file`/`write_file`/`list_dir`, scoped to a read-only and a
  read-write shared folder). Tool calls stream to an Activity panel so the user
  can watch what the LLM does; the workbench desktop is embedded in the UI.
- 2026-06-27: Browser-native voice (Web Speech API) with a dynamic on/off switch,
  a "Jarvis" wake word, an inactivity timeout that returns to sleep, a
  "Jarvis stop listening" command, and text-to-speech replies (Chrome/Safari).
- 2026-06-27: `JARVIS.sh` control script (expands the ByOwnerOS RUN_LOCAL_DEV.sh
  pattern): `--check`, `--setup`, `--start`, `--status`, `--stop`, `--delete`,
  plus `--backup-db` and `--deploy-db [--from <file>]` (restore a backup or reset
  to a fresh database).
- 2026-06-27: `/api/selftest` endpoint that exercises the memory DB, workbench
  shell, and shared folders without needing a model.

- 2026-06-28: Granted the LLM open internet access via two new tools, `fetch_url`
  (read any URL/API; HTML stripped to text) and `web_search` (DuckDuckGo). Access
  is not allow-listed. Added an internet check to `/api/selftest`.
- 2026-06-28: Turned the workbench into a custom image (`workbench/Dockerfile`,
  built on linuxserver webtop) pre-loaded with a vast CLI toolchain — languages
  (Python, Node.js, Go, Java, Ruby, PHP, Perl, Lua, C/C++/clang), build tools,
  networking/research utilities, database clients, data/text/sysadmin tools, and
  media/docs — so the LLM can work out of the box (still root + apt for more).
  `JARVIS.sh --setup` now builds the workbench image; the container and image both
  have internet access.
- 2026-06-28: Improved voice reliability — explicit `getUserMedia` microphone
  permission request (so the OS/browser prompt actually appears), surfaced
  recognition errors instead of failing silently, added a push-to-talk mic button,
  and improved TTS voice selection.

- 2026-06-28: Added desktop control (computer use): a `screenshot` tool whose
  image is fed back to the vision model, plus `open_url`/`open_app`, `click`,
  `double_click`, `right_click`, `move_mouse`, `type_text`, `press_key`, and
  `scroll` (via xdotool) to drive the real Chromium browser and GUI apps on the
  watchable desktop. `run_shell` now presets `DISPLAY=:1`. Needs a vision-capable
  model for visual control.
- 2026-06-28: Added a credential vault (`JARVIS_SECRETS.json`, gitignored;
  `JARVIS_SECRETS_template.json` is the reference) with `list_secrets`/`get_secret`
  tools so JARVIS can log in to the user's OWN accounts. Policy: JARVIS operates
  accounts the user already owns; it does not create accounts or bypass sign-up
  CAPTCHAs/phone verification.

- 2026-06-28: The credential vault is now writable by JARVIS — added `set_secret`
  (create/update, partial fields) and `delete_secret` tools, persisted to the
  (plaintext, gitignored) `JARVIS_SECRETS.json`.
- 2026-06-28: Added `JARVIS.sh --reload` (`-r`) to re-read all config files
  (`JARVIS_CONFIG.json` + `JARVIS_SECRETS.json`) by restarting only the app; the
  database and workbench keep running. `/api/selftest` now reports the loaded
  secret count.

- 2026-06-28: Added a command-line interface (`app/cli.js`) and two JARVIS.sh
  commands: `--terminal` (`-t`) for an interactive text chat in the terminal (no
  browser), and `--prompt <text>` (`-p`) for a one-shot request whose answer
  prints to stdout. `--prompt` reads piped stdin, e.g.
  `cat app.log | ./JARVIS.sh --prompt "analyze this log"`. Both reuse the web
  app's tool-calling loop; tool activity goes to stderr. Expanded `--help` with
  example workflows.

- 2026-06-28: Added task scheduling. New tools `schedule_task` (one-shot via
  `in_seconds`/`at`, or recurring via `every_seconds` with a natural-language
  `until` stop condition), `list_tasks`, `cancel_task`, and `notify_user`. A
  scheduler in the app persists tasks to `data/tasks.json`, runs due tasks through
  the tool-calling loop, stops recurring tasks when the condition is met, and
  broadcasts notifications to the browser (in-app 🔔 + desktop Notification, spoken
  if audio is on) with a `/api/notifications` endpoint. The current date/time is
  now injected into every model turn so it can compute schedule times.
- 2026-06-28: Added a Tasks tab to the web UI (view active scheduled tasks, cancel
  with a click, and a notification history), backed by `GET /api/tasks` and
  `POST /api/tasks/cancel`. Notifications also fire a best-effort desktop toast on
  the workbench via `notify-send` (added `libnotify-bin` to the workbench image).

- 2026-06-28: Rewrote the system prompt into a tool-selection guide (which tool for
  which job) plus common multi-tool workflows, and synced it to the local config
  and the template, so the model reliably picks the right tool per task.
- 2026-06-28: Added a skills knowledge base — a `skills` table seeded into the
  memory database on app startup (idempotent, from `app/src/skills_data.js`) with
  detailed per-capability and workflow playbooks, plus `list_skills`/`get_skill`
  tools the LLM reads on demand. The LLM's own working memory remains
  self-managed (no predefined schema). Also made the CLI exit cleanly after a
  one-shot `--prompt` that opens DB pools.

- 2026-06-28: Added saveable conversation sessions. Save/load/export/import/delete
  conversations via a Sessions menu in the web UI (loads in place to continue where
  you left off) and `/sessions`, `/save [name]`, `/load <id>` in the terminal.
  Backed by `/api/sessions` endpoints and JSON files under `data/sessions/`. Useful
  for resuming work and for iterating on the model/prompt against a fixed transcript.

- 2026-06-28: Added an `assistant_name` config option that sets the AI's name in
  one place: its identity in the system prompt (via the `{assistant_name}`
  placeholder), the displayed title/page title, and the voice wake word + stop
  phrase (which now derive from the name, e.g. say "Friday" to wake an assistant
  named Friday). Voice `wake_word`/`stop_phrase` become optional overrides.

- 2026-06-28: Made scheduled task activity visible. Each run now broadcasts a
  `task_run` event (shown in the web Activity panel) and the Tasks tab shows each
  task's last run + last result. The terminal (`--terminal`) gained a live
  notification feed plus `/tasks` and `/notes` commands. Clarified that scheduled
  tasks run server-side, so their output surfaces in the web UI / via these feeds
  (not in the one-off process that scheduled them).
- 2026-06-28: Added a `post_to_chat` tool so a task (or the assistant) can post a
  message directly into the user's live chat conversation window — distinct from a
  `notify_user` alert. Scheduled tasks run the full toolset and are instructed to
  take whatever actions the outcome warrants (e.g. post to chat, notify, run shell,
  update the DB). Verified end-to-end: a scheduled task posted into the chat over
  the WebSocket.

- 2026-06-28: Fixed file writes not appearing on the host. The shared folders are
  now `READ_ONLY_FILES/` and `READ_WRITE_FILES/` (host), mounted to `/READ_ONLY_FILES`
  and `/READ_WRITE_FILES` in the app and workbench, with `config.shared` aligned to
  those container paths. Previously `config.shared` pointed at un-mounted host paths,
  so `write_file` wrote inside the container (invisible on the host). Also: file
  tools now accept a bare/relative filename (resolved under the read-write folder),
  and the model is told the exact shared-folder paths each turn.

- 2026-06-28: Added a document/image creation toolchain to the workbench base
  image (`workbench/Dockerfile`): Python `fpdf2`, `reportlab`, `python-docx`,
  `python-pptx`, `openpyxl`, `pillow`, `matplotlib`, `markdown` (plus the existing
  pandoc, imagemagick, and chromium). JARVIS can now create PDF, DOCX, PPTX, XLSX,
  ODT/EPUB/RTF, and images out of the box; a clean rebuild bakes them into the
  base. (PDF via fpdf2/reportlab, or Markdown->HTML->`chromium --headless
  --print-to-pdf`; `wkhtmltopdf` is no longer in Ubuntu's repos so it was dropped.) Added a `create-documents` skill and strengthened the system
  prompt so the model knows it is root with internet and must NOT falsely claim it
  cannot install packages (it can, via run_shell). Bumped `max_tool_iterations`
  8 -> 12 for multi-step document tasks.

- 2026-06-28: Streamed model output. The OpenAI-compatible call now uses
  `stream: true`; `llm.js` parses the SSE stream, emits `{type:"token"}` deltas
  over the WebSocket (assembling streamed tool-call deltas across the loop), and
  the web UI types the reply into the assistant bubble live. Falls back to a
  single message for the mock provider / non-streamed paths.
- 2026-06-28: Fixed the model fumbling SQL (guessing nonexistent `key`/`value`
  columns, missing backticks). A live snapshot of the memory database schema
  (tables + columns, via `tools.schemaSummary()`) is now injected into every turn,
  the multi-line composer aside, so the model uses real names; the `memory` skill
  also tells it to DESCRIBE first and backtick reserved-word identifiers.
- 2026-06-28: Chat input is now a multi-line textarea — Enter sends, Shift+Enter
  inserts a newline, and the box auto-grows. Added a "Data & persistence" section
  to `JARVIS.sh --help` documenting where sessions/tasks/files/backups live on the
  host (and that they survive `--delete`).

- 2026-06-28: Added semantic long-term memory (Mem0). New `jarvis-memory` sidecar
  container wraps the Mem0 OSS library over a local Chroma vector store (extraction +
  embeddings via the configured OpenAI key). New tools `add_memory`, `search_memory`,
  `list_memories`, `delete_memory` let the LLM store and recall facts BY MEANING
  rather than exact SQL. MySQL is retained for structured/tabular data + skills. Wired
  into the system prompt, the `memory` skill, `/api/selftest`, and `JARVIS.sh`
  (build/status/help). Config: new `mem0` block (`url`, `user_id`).
- 2026-06-28: Hardened the agent loop. Independent tool calls now run concurrently
  (`Promise.allSettled`), the LLM API call retries transient 429/5xx + network errors
  with exponential backoff + jitter (read-only tools retry too; mutating tools never
  do), a no-progress guard nudges the model when it repeats a tool call, and per-turn
  token usage + an estimated cost are captured (`stream_options.include_usage`) and
  surfaced in the Activity panel (with per-tool timing).
- 2026-06-28: Security hardening (proportionate for a single-user local tool): an
  append-only action audit log (`data/audit.log`, one JSON line per tool call, secrets
  redacted); an SSRF guard on `fetch_url` that refuses private/loopback/link-local
  addresses (blocks cloud-metadata + internal-service access); a symlink-escape fix in
  the shared-file sandbox (`fs.realpathSync` before the path check); and prompt-injection
  hardening in the system prompt (treat fetched/searched/file content as untrusted data,
  never exfiltrate secrets).

- 2026-06-28: Multi-model support via a LiteLLM gateway. New `jarvis-litellm`
  container exposes ONE OpenAI-compatible endpoint (`litellm/config.yaml`) that routes
  to many providers (OpenAI, Anthropic Claude, Google Gemini, Ollama/local). The app's
  `base_url` now points at the gateway; switch models by setting `llm.model` to a
  `model_name` from the config (e.g. `claude-sonnet-4-6`, `gemini-2.5-flash`,
  `ollama-llama3`) — no code change. `JARVIS.sh` exports provider keys from
  `JARVIS_CONFIG.json` (`llm.api_key`/`anthropic_api_key`/`gemini_api_key`) to the
  gateway and shows it in status; the template documents adding keys.
- 2026-06-28: Upgraded the workbench from a computer-use desktop into a full
  research → development → local-testing sandbox (`workbench/Dockerfile`): added
  GitHub CLI (`gh`), `uv` (fast Python envs), Playwright + Chromium/Firefox for
  reliable headless browser automation (preferred over pixel computer-use for
  scraping/testing), and a data/ML stack (pandas, polars, duckdb, numpy, scipy,
  scikit-learn, pyarrow, sqlalchemy, jupyterlab). Added a persistent `/workspace`
  (named volume `jarvis_workbench_work`) that survives rebuilds and is now the default
  working directory for `run_shell`. New `browser-automation` skill; the system prompt
  and `workbench-shell` skill document the new tooling.

- 2026-06-28: Added configurable per-task model tiers. `llm.models` maps tiers
  (`chat`, `cheap`, `vision`, `smart`) to ANY model the gateway knows (any provider).
  `llm.js` routes per call: a vision-capable model auto-selected when the context
  contains images, the `chat` tier otherwise; background scheduled tasks use `cheap`.
  The routed model + token cost are emitted to the Activity panel. Falls back to
  `llm.model` if `models` is omitted.
- 2026-06-28: Added an evaluation harness. `app/eval.js` replays fixture cases
  (`data/evals/*.json`) through the live model + tool loop and asserts on cheap
  signals (reply `contains`/`not_contains`, `tools_used`, `max_ms`, `max_cost_usd`),
  printing pass/fail with per-case time, cost, model, and tools, and exiting non-zero
  on failure. Run via `JARVIS.sh --eval` (`-e`); ships example cases. Adapt saved
  sessions into cases by copying their `messages` and adding an `expect` block.

- 2026-06-28: Removed the MySQL database (jarvis-db) — the stack is now 4 containers.
  Mem0 owns memory; structured/tabular data uses DuckDB/SQLite in the workbench
  `/workspace`. The `sql` tool, schema injection, and DB skills-seeding are gone;
  skills are served directly from `skills_data.js` (no DB). Removed the `memory`
  config block, `db/` usage, `memory_db` self-test, and `mysql2` usage. System prompt
  + `memory` skill repoint structured data to `duckdb /workspace/data.db`.
- 2026-06-28: Replaced the MySQL backup/restore with semantic-memory backup/restore.
  `JARVIS.sh --backup-memory` tars the Mem0 vector store (jarvis-memory `/data`) to
  `backups/jarvis-memory-<ts>.tgz`; `--restore-memory --from <file>` restores it
  (stops the service, swaps the volume contents, restarts), and `--restore-memory`
  with no `--from` resets to an empty memory. Round-trip verified.

- 2026-06-28: Made scheduled tasks more reliable + honest. The task runner now
  (1) instructs the model to report only what tools actually returned — never invent
  data or claim success — and to VERIFY side effects (read a file back after writing);
  (2) appends a ground-truth note to every run's result showing which tools actually
  ran (e.g. `[tools: run_shell✓]` or `[tools: none — text-only reply, nothing was
  actually done]`), so a fabricated "success" is visible at a glance. Added an
  `append=true` option to `write_file` (it overwrote before) with guidance to use
  run_shell `>>` for the workbench `/workspace`, and sharpened the `schedule_task`
  description: the prompt is executed by the model THROUGH its tools (not as literal
  code), so it must be a concrete, self-contained, verifiable instruction.

- 2026-06-28: Added consistent log output. New `append_log(path, message, fields?)`
  tool where the CODE owns the format — a uniform ISO-8601 UTC timestamp, the message
  collapsed to exactly one line, optional structured `fields` rendered as `k=v`, and a
  guaranteed trailing newline — so recurring logging tasks no longer drift in format or
  run entries together. Also fixed `write_file` append to always start a new entry on
  its own line (insert a separator newline when the file doesn't end in one). The
  system prompt, the scheduled-task runner, and the files skill now steer recurring
  logs to `append_log`.

- 2026-06-28: Fixed "updating a task stops it." Added an `update_task` tool that
  edits an existing task IN PLACE (prompt/interval/until/label/next-run) so it keeps
  running; the system prompt + scheduling skill now tell the model to use it instead
  of cancel+reschedule (the previous behavior, which stopped the original task). The
  scheduler runs in the background server process and handles tasks concurrently with
  chats — the issue was the missing update path, not multitasking.
- 2026-06-28: User-facing output now defaults to the shared folder. The system prompt
  (new OUTPUT LOCATION principle) and skills instruct the model to automatically save
  anything it produces FOR the user (files, programs, reports, data) into
  /READ_WRITE_FILES, using the workbench /workspace only for scratch/build/temp work
  and running commands.
- 2026-06-28: Added web-app preview. New `serve_app(command, port, cwd?)` tool runs a
  server in the workbench on a host-exposed preview port (9101-9150, published in
  docker-compose, well clear of the other container ports), verifies it's reachable
  (bound to 0.0.0.0), and returns
  http://localhost:<port> for the user to open in their own browser to test a web app
  before receiving the code. New `web-preview` skill + system-prompt guidance.

- 2026-06-28: Added an "analyze before acting" step to the system prompt. For each
  request the model first analyzes what's actually being asked and what success looks
  like, and if anything material is unclear/missing/assumption-dependent it asks a
  single concise batch of clarifying questions BEFORE proceeding; clear requests run
  immediately (stating any assumptions) so simple asks aren't stalled. Verified: an
  ambiguous "build me a dashboard" produced focused clarifying questions instead of
  guessing.

### Notes
- The LLM intentionally has root in the workbench container, open internet access,
  and computer-use control of the desktop; structured data lives in workbench
  DuckDB/SQLite files under /workspace.
- `config.shared` paths are paths INSIDE the container; the host location is set by
  the docker-compose bind mount. Keep the two aligned.
  The stack binds to localhost only; secrets live in the gitignored
  `JARVIS_CONFIG.json` / `JARVIS_SECRETS.json`.
