# Changelog

All notable changes to JARVIS are tracked here.

This project follows a Keep a Changelog-style format. Keep the `[Unreleased]`
section current with concise notes about user-facing, operational,
infrastructure, security, documentation, or test-policy changes.

## [Unreleased]

### Fixed
- 2026-07-30: **Header model badge refreshes on Config "Save all".** The top-of-UI model badge was
  set only at page load and on the quick model dropdown, so after switching models in the Config tab
  it kept showing the old value (e.g. a stale `openai · gpt-5` after moving to a local Ollama model)
  until a manual browser refresh. Saving the config now re-reads `/api/config` and updates the badge
  immediately. In multi-model mode it shows the **chat-tier** model (always present), matching what
  the server reports via `publicConfig()`'s `modelFor("chat")`. The underlying config was never wrong
  — this was display-only. (`app/public/app.js`.)

### Added
- 2026-07-30: **Gateway model list auto-syncs from the live backend (no more stale entries).**
  `./JARVIS_LOCAL_LLM.sh start --gateway` now **regenerates the local-model routes in
  `litellm/config.yaml` from whatever `--backend` selects** before starting the gateway, and a new
  **`gateway-sync [--backend ollama|mlx]`** subcommand does the same on demand (then reloads a running
  gateway). The selected backend owns an auto-managed block delimited by `BEGIN/END local routes`
  markers: **Ollama** contributes one route per installed tag (from its live `/v1/models`, embeddings
  skipped, all → `:11434`); **MLX** probes each `mlx.models` server's port and contributes a route only
  for the ones actually answering (each → its own port). **`stop` empties the managed block** (the
  runtime is gone, so the gateway shouldn't keep advertising it) and reloads a still-running gateway to
  reflect that. **Cloud routes above the marker are never touched** — those stay hand-maintained. This
  fixes the confusion where the gateway advertised `claude-sonnet`/`gemini`/`gpt` (and was missing
  freshly-pulled Ollama models) because its list was a hand-edited file that drifted from reality. New
  backend hook `<backend>_gateway_routes`; gateway now starts with `--force-recreate` so a freshly-synced
  config is always re-read. The shipped `litellm/config.yaml` now contains **no cloud routes** — the
  gateway is for local models, and cloud models are reached directly in single mode, so the gateway's
  model list is purely local (a documented one-liner shows how to add a cloud route for the rare mixed
  local+cloud multi-mode case). If the last local models are stopped, the gateway is taken down rather
  than reloaded to an empty model list. (`JARVIS_LOCAL_LLM.sh`, `litellm/config.yaml`,
  `Docs/local-llm.md`, `Docs/cli.md`.)

### Changed
- 2026-07-30: **Model dropdowns show only available models.** The Config model `<select>`s (chat/
  cheap/smart/vision tiers, single or multi mode) now list only the models actually returned by
  "List models" for the current endpoint, instead of also injecting the saved value when it isn't
  available (which surfaced stale entries like a leftover `gpt-4o-mini` after switching to a local
  runtime). A configured value is still shown before any list has been fetched so it isn't lost on
  load; once a list exists an unavailable value drops to blank so you re-pick from what's really
  there. The **✎ Custom…** option remains for typing a model that doesn't appear in the list.
  (`app/public/app.js`.)

### Added
- 2026-07-30: **`/ro` and `/rw` slash commands.** Tell JARVIS to reference the shared folders:
  `/ro [request]` works with `READ_ONLY_FILES`, `/rw [request]` with `READ_WRITE_FILES` (no request
  lists the folder). Complements `/guide`. (`app/public/app.js`, folder READMEs.)

- 2026-07-30: **Self-help guides — ask JARVIS how to use/configure itself.** A shipped set of
  task guides in `READ_ONLY_FILES/JARVIS_Guides/` (switching models, local models via Ollama/MLX,
  Autopilot, maintenance, a glossary) that JARVIS reads at runtime. The system prompt now tells it
  to consult these for "how do I… / what is…" questions about JARVIS instead of answering from
  general knowledge, and a new **`/guide [topic]`** slash command forces it (no topic lists them).
  Also fixed the stale `READ_ONLY_FILES/README.txt` (it referenced old `/shared_ro` paths) and added
  a matching `READ_WRITE_FILES/README.txt`; `.gitignore` now tracks the READMEs + guides and drops
  dead `shared_rw` rules. (`READ_ONLY_FILES/`, `READ_WRITE_FILES/README.txt`,
  `Prompts/default_system.prompt`, `app/public/app.js`, `.gitignore`.)

- 2026-07-28: **Config tab: friendly MLX models editor.** A new "MLX models" section with add/remove
  rows (name / model / port) instead of hand-editing the `mlx.models` JSON — links to the
  `mlx-community` HF org, notes the `mlx/models/` cache, and reminds you to run
  `./JARVIS_LOCAL_LLM.sh start --backend mlx` to apply (the UI can't launch host processes). Edits
  sync live with the raw-JSON editor. (`app/public/{index.html,app.js,style.css}`.)

- 2026-07-28: **MLX backend — local models on Apple Silicon.** `JARVIS_LOCAL_LLM.sh` gained a
  `--backend mlx` implementation alongside Ollama (dispatch is now backend-generic:
  `<backend>_apply_config/_ensure_running/_url/_status/_stop/_hint/_config_help`). MLX runs on the
  macOS **host** via `mlx-lm`'s OpenAI-compatible server in a dedicated venv under `mlx/`:
  - **`ACTIVATE.sh` / `DEACTIVATE.sh`** (source them) — create the venv + install `mlx-lm` on first
    run, and point model downloads at `mlx/models/` (`HF_HOME`).
  - **Multi-model:** a new `mlx.models` config array (`{name, model, port}`) — each entry gets its
    own `mlx_lm.server` process on its port; `start --backend mlx` launches them all, `stop` kills
    them, `status` lists them. Front several with `--gateway` for one endpoint.
  - **`config --backend mlx`** prints a full setup guide (install/activate, `mlx-community` models,
    the config block, start/stop, tool-calling + vision caveats).
  - `mlx/venv`, `mlx/models`, `mlx/*.log` are gitignored. Smoke-tested end-to-end (server serves an
    OpenAI completion). Verified with `mlx-lm 0.31` / `mlx 0.32` on macOS arm64.
  (`JARVIS_LOCAL_LLM.sh`, `ACTIVATE.sh`, `DEACTIVATE.sh`, `config/JARVIS_CONFIG_template.json`,
  `.gitignore`, `Docs/{cli,configuration}.md`.)

- 2026-07-28: **`./JARVIS_LOCAL_LLM.sh config` — a backend setup guide.** Prints start-to-finish
  steps for the local runtime: where to install it (`https://ollama.com/download/mac`), which
  models to `ollama pull`, the `ollama.*` tuning keys (and the note that you can edit them in the
  JARVIS UI but must re-run `start` to apply), how to point JARVIS at the printed URL, and the
  multi-tier `max_loaded_models` tip. `config --backend ollama` (default `ollama`).
  (`JARVIS_LOCAL_LLM.sh`, `Docs/cli.md`.)

### Changed
- 2026-07-28: **Config files moved to `config/`.** `JARVIS_CONFIG.json`, `JARVIS_SECRETS.json`, and
  their `*_template.json` now live in `config/` instead of the repo root — so the `JARVIS_*.sh`
  scripts aren't buried among JSON in an `ls`. Updated the compose host mounts, both scripts'
  paths, `.gitignore`, the `cp` quick-start in README/`configuration.md`, the architecture volume
  table, and the `TEMPLATES/_generate.py` generator (which also had its now-stale in-stack gateway
  host `jarvis-litellm:4000` → `host.docker.internal:4000` in the example configs fixed). Container
  paths (`/cfg/…`) are unchanged, so app code needed no edits. **Existing installs:** move your
  `JARVIS_CONFIG.json` + `JARVIS_SECRETS.json` into `config/` before the next `--start`.

### Added
- 2026-07-28: **`./JARVIS.sh --reset-workbench` — reset the dev OS.** An escape hatch for when the
  LLM installs a pile of packages or messes up the workbench: it recreates ONLY the workbench
  container from its clean built image (fresh writable layer → every runtime apt/pip install and
  system tweak wiped). Keeps `/workspace` build files + the workbench home (desktop / browser
  logins), and leaves the app, memory, config, and `READ_WRITE_FILES` completely untouched.
  (`JARVIS.sh`, `Docs/cli.md`.)

### Changed
- 2026-07-28: **Config "Save all" applies live — no restart.** Saving from the Config tab already
  mutated the in-memory config in place, but the UI still told you to run `./JARVIS.sh --reload`.
  Corrected the messaging: ordinary settings (endpoint / model / tiers / temperature / max_tokens /
  completion_checks / prompts / log level …) take effect on the **next message** with no restart.
  A restart is only flagged for the memory service's embedding key and container-level settings
  (ports). `POST /api/config/full` now returns `applied_live: true`. (`app/server.js`,
  `app/public/{app.js,index.html,style.css}`.)

- 2026-07-28: **LLM hosting extracted out of JARVIS core.** JARVIS is now a pure OpenAI-dialect
  *client* — it talks to whatever URL is in `llm.base_url` and no longer knows or cares where the
  model lives. Local model management moved to a new, optional **`JARVIS_LOCAL_LLM.sh`** (pluggable
  backend — Ollama today, MLX/vLLM/llama.cpp later; each implements `apply_config`/`ensure_running`/
  `url`/`stop`). It applies the local configs, ensures the runtime is up, and **prints the endpoint
  URL to paste into Config → Endpoint URL** — Ollama direct, or an optional LiteLLM gateway it can
  front (`--gateway`).
  - `JARVIS.sh` no longer manages Ollama or exports provider keys (`apply_ollama_settings` +
    `export_provider_keys` removed); `--setup/--start/--reload` are model-agnostic.
  - The **LiteLLM gateway left the core stack** — removed from `docker-compose.yml` and moved to a
    standalone `litellm/docker-compose.yml` that `JARVIS_LOCAL_LLM.sh --gateway` runs. `jarvis-app`
    gains `extra_hosts: host.docker.internal:host-gateway` so it can reach host runtimes.
  - Config template: `llm.base_url` now defaults empty (code falls back to OpenAI); `ollama.*` is
    re-documented as read by `JARVIS_LOCAL_LLM.sh`, not JARVIS core.
  - **Migration (existing local users):** run `./JARVIS_LOCAL_LLM.sh start --gateway`, copy the
    printed URL, paste into Config → Endpoint URL. Cloud users are unaffected — `base_url` is already
    a cloud URL. (`JARVIS_LOCAL_LLM.sh`, `JARVIS.sh`, `docker-compose.yml`, `litellm/`,
    `JARVIS_CONFIG_template.json`.)

### Fixed
- 2026-07-28: **Forgiving file-write tools (from the GPT-4.1 build review).** Two friction points a
  real Autopilot build kept hitting: (1) `write_workbench_file` / `edit_workbench_file` now accept a
  **relative path** (resolved under `/workspace`) instead of erroring with "path must be absolute" —
  a `toWorkbenchPath` helper normalizes it. (2) `write_file` given a **directory** path now returns
  an actionable error ("… is a directory — include a filename, e.g. …/index.html") instead of a raw
  `EISDIR`. Both let any model self-correct instantly rather than burning retries. (`app/src/tools.js`.)

### Added
- 2026-07-28: **Config calls out that multi-model is mainly for local models.** The Model-mode
  dropdown now labels `single — one model (best for cloud)` / `multi — mainly for LOCAL models`,
  with a hint: cloud models are multimodal so one model does chat+vision (use single); multi is
  for local setups that stitch specialized models together (or cloud cost-tiers). (`app/public/index.html`.)

- 2026-07-28: **Model tier pickers group by capability (curated `models.json`).** In multi-model
  mode the chat/cheap/smart/vision dropdowns now put the models that fit each tier in a
  "★ …recommended" group on top, the rest under "Other models", and drop non-chat models
  (embeddings/tts/whisper/dall-e/transcribe) entirely — so the **vision tier surfaces vision
  models**, smart surfaces reasoning models, etc. Categorization is driven by a **user-maintained
  `app/public/models.json`** (matched by longest name-prefix, so `gpt-4.1` also matches
  `gpt-4.1-2025-04-14`); anything not listed falls back to a name heuristic. Edit the file + refresh
  to keep it current as providers ship models. (`app/public/{models.json,app.js}`.)

- 2026-07-28: **Header pill shows "Autopilot".** The always-visible status pill used to only read
  Idle/Working — and since Autopilot runs on a separate server-side loop, it read "Idle" even while
  a run was actively building. It now shows a distinct cyan **Autopilot** state whenever a run is
  actively working (running/stopping/pausing), falling back to Idle when it ends or pauses. A live
  chat request still shows "Working" and takes visual priority. (`app/public/{app.js,style.css}`.)

- 2026-07-28: **The model can offer to run a job on Autopilot.** New `open_autopilot` tool: for a
  large multi-step task the user could walk away from (including follow-up improvements after
  finishing something), JARVIS now offers "want me to run this on Autopilot so you can step away?"
  — and on yes, opens the Autopilot launcher **pre-filled** with a self-contained objective (plus
  suggested time budget + autonomy). The user confirms the settings and presses Start; the model
  never auto-starts a run. This also gives follow-up plans a proper home instead of silently
  re-planning into the ledger. Wired via a generic `scheduler.emitUiEvent` → WebSocket → the
  launcher. (`app/src/{tools.js,scheduler.js}`, `app/server.js`, `app/public/app.js`,
  `Prompts/default_system.prompt`.)

### Fixed
- 2026-07-28: **Model pickers now populate reliably.** The model fields (single + the four
  chat/cheap/smart/vision tiers) were `<input list=datalist>` — native datalists don't reliably
  drop down, so the multi-mode tier pickers looked empty. Replaced them with real `<select>`
  dropdowns that **List models** fills; each keeps its currently-configured value even if the
  endpoint didn't return it, plus a **✎ Custom…** option to enter a model by hand.
  (`app/public/{index.html,app.js}`.)

### Changed
- 2026-07-28: **Config tab: clearer model setup.** (1) The **API key** field now has a **Show/Hide**
  toggle so you can read and edit the stored key. (2) **List models** falls back to the saved
  config key + endpoint when the form fields are blank, so it works as long as a key is configured.
  (3) **Model mode** now shows ONLY the relevant fields — `single` reveals just the single-model
  input, `multi` reveals just the chat/cheap/smart/vision tier grid (toggled on load and on change).
  (`app/public/{index.html,app.js,style.css}`, `app/server.js` models/probe fallback.)

- 2026-07-28: **Tuning from the two-day log review.** Interactive turns were hitting the tool-step
  ceiling 41× (terminal "Stopped after the maximum number of tool steps"), and `completion_checks=2`
  was driving repetitive "verify everything" recitations + a repetition loop. Fixes:
  `llm.max_tool_iterations` 15 → **22** (fewer mid-task truncations), `llm.completion_checks` 2 → **1**
  (less over-verification), and `fetch_url` default timeout 30 → **45 s with one automatic retry on
  timeout** (timeouts were ~1/3 of fetches). New **`app-integration` skill** (+auto-hint) for working
  with an installed app's own data directory instead of writing into `/workspace` where the app
  can't see it — the notes-only-say-"Markdown" / wrong-location class of bug.
  (`JARVIS_CONFIG*.json`, `app/src/{tools.js,skills.js,skills_data.js}`.)

- 2026-07-27: **Less robotic replies on simple turns.** The active system prompt
  (`Prompts/default_system.prompt`) now scopes the "restate the goal / verify completion"
  ritual to substantial (multi-step, tool-using, or hard-to-reverse) work. Simple or
  conversational turns are told to answer directly — no "Re-reading your request…" opener, no
  numbered re-verification of the request, no "Job done — nothing left to do" epilogue — and to
  match reply length to the ask. Log review showed the model prefacing even one-line chit-chat
  with the full completion ritual. (`stock_system.prompt` left pristine as the backup; read live,
  no restart needed.)

### Fixed
- 2026-07-27: **Autopilot converges instead of burning cycles re-verifying.** Log review showed
  runs repeatedly exhausting the per-cycle tool-step cap without ever declaring "done" — each
  cycle restarted the whole serve→browse→screenshot→verify arc from scratch. Three fixes in
  `autopilot.js`: (1) it now remembers a **live preview server** (port captured from `serve_app`)
  and tells later cycles NOT to re-serve it; (2) an explicit **"if it works, you are DONE"** nudge
  so a passing verification marks the plan complete and exits rather than looping to the step cap;
  (3) **retry-on-empty** — a cycle where the model returns nothing is retried (up to twice) without
  being counted, instead of wasting a cycle. Covered by new tests. (`app/src/autopilot.js`,
  `app/test/autopilot.test.js`.)

### Changed
- 2026-07-27: **Autopilot launcher + Modify are now floating modals.** Starting a run opens a
  centered floating window (dimmed backdrop, ✕/Esc/backdrop-click to close, roomier objective
  box) instead of a cramped header dropdown, and **Modify** opens its own floating window
  prefilled with the current objective (Save / Cancel, Cmd/Ctrl+Enter to save) instead of a
  browser `prompt()`. (`app/public/{index.html,app.js,style.css}`.)

- 2026-07-27: **Lifecycle commands wipe Autopilot state.** `./JARVIS.sh --stop / --delete /
  --setup / --start` now clear the saved Autopilot run + plan (`data/autopilot.json`,
  `data/plan.json`) so you always come back up to a clean slate — no zombie banner or leftover
  plan. An app *auto-restart* (crash recovery) still resumes a run as before; only the deliberate
  lifecycle commands reset it. (`JARVIS.sh`: `clear_autopilot_state`.)

### Added
- 2026-07-27: **Autopilot forced stop.** A plain **Stop** aborts the current step and ends the
  run — but if it's wedged on a step that won't quit, the button now changes to **Force stop**
  while it's stopping. Clicking it (with a confirm) ends the run *immediately* — the bar flips to
  the ended state without waiting for the cycle to unwind — and kills anything the run left
  running in the workbench (preview servers on ports 9101-9150). `POST /api/autopilot/forcestop`,
  `tools.killWorkbenchJobs()`, `finish()` made idempotent + a post-cycle guard so the orphaned
  cycle is a no-op. (`app/src/autopilot.js`, `app/src/tools.js`, `app/server.js`, frontend.)

### Changed
- 2026-07-27: **Autopilot clarify leans toward asking.** The pre-flight now confirms at least the
  architecture and where output should be saved for build/creation tasks instead of replying
  READY on a merely-specific request, so it asks a question more often than not. (`app/server.js`.)

### Added
- 2026-07-26: **Autopilot clarify-first.** Before it plans or builds, Autopilot now reviews
  your objective and asks any clarifying questions it needs (architecture, persistence,
  scope, where to save) so it builds the *right* thing instead of guessing. A checkbox
  ("Ask me clarifying questions first", on by default) in the launcher: Start → the model
  reviews the request and either replies READY (launches immediately) or surfaces its
  questions **one at a time** — a "Question 1 of N" wizard (Back / Next, Enter to advance)
  so you focus on a single question per screen instead of a wall of them. Your answers are
  folded into the objective the run is seeded with; **Skip the rest — just build it** launches
  early with whatever you've answered so far. `POST /api/autopilot/clarify` returns the
  questions as a structured list (uses `llm.chat({tier:"smart", noTools:true})`).
  (`app/server.js`, `app/public/{index.html,app.js,style.css}`.)

- 2026-07-26: **Autopilot: a finished run stays put so you can Continue it.** When Autopilot
  ends incomplete (time budget, stuck, or you stopped it), the bar no longer disappears — it
  switches to an ENDED state (⏱/⚠️/⏹) and keeps the plan. New **▶ Continue** button resumes on
  the SAME plan with a fresh 15-min budget (picks up from the first incomplete step — no
  rebuild), **Modify** changes the objective before continuing, and **✕ Dismiss** clears the
  bar. Survives an app restart too (the ended run is re-shown, not lost). `POST
  /api/autopilot/{continue,dismiss}`. (`app/src/autopilot.js`, `app/server.js`, frontend.)

### Added
- 2026-07-26: **Autopilot verbose mode.** A **Verbose** checkbox in the Autopilot launcher —
  when on, each cycle streams the model's live thinking + tokens into the chat (like a normal
  conversation) so you can watch what it's doing and check in while it works the plan. The
  streamed cycle text is shown but NOT added to your chat's model-context history (or spoken),
  so it won't bloat your next chat. (`app/src/autopilot.js`, frontend.)

### Fixed
- 2026-07-26: **Autopilot review — 6 planning/loop bugs fixed.**
  (1) **Stale plan hijack** (reported): a NEW Autopilot objective inherited a leftover plan
  from a previous task (e.g. a SimCity run continued the earlier DOOM plan). `start()` now
  clears any existing plan so each objective begins fresh; a fresh chat (New chat) clears it too.
  (2) **Anti-thrash misfire**: only file-writes counted as "work", so research/browser/serve
  cycles were wrongly nagged to "stop re-reading and write code" — now ANY non-read/non-plan
  tool counts as progress.
  (3) **Sporadic errors killed long runs**: the transient-error counter never reset; it now
  clears after each successful cycle.
  (4) **Completion vs budget**: a genuinely-finished objective is now reported "done" even if
  the time budget was hit the same cycle.
  (5) **Start guard**: starting a new run while one was PAUSED silently clobbered it; now
  rejected until you stop it.
  (`app/src/autopilot.js`, `app/public/app.js`; regression test added.)

### Changed
- 2026-07-26: **Prompts are now editable files in a top-level `/Prompts` directory.** Replaces
  the earlier inline/`data` approach. The ACTIVE prompt = `Prompts/default_master.prompt` +
  `Prompts/default_system.prompt`, read LIVE each turn (edits apply next turn, no reload), with
  the model receiving master -> system -> built-in tool/planner/coding rules. The Config
  **Prompts** section edits these; **Save as active** writes the default pair, **Save as… / Load /
  Delete** manage named sets `Prompts/<name>_master.prompt` + `<name>_system.prompt` (hand-editable
  outside the app). Ships a starter library: coder, researcher, concise, ops, creative, tutor.
  `/Prompts` is bind-mounted into the app (compose change -> recreate the container).
  (`app/src/config.js`, `app/server.js`, frontend, `docker-compose.yml`, `Prompts/`.)

### Fixed
- 2026-07-25: **File tools can now reach the workbench build area.**
  `list_dir`/`read_file`/`write_file`/`analyze_image` were restricted to the
  user-exchange folders, so the model couldn't inspect what it built in
  `/workspace` (7 errors in one session, e.g. `read_file /workspace/doom.html`).
  The workbench's `/workspace` volume is now also mounted into the app, and the
  path check allows `/workspace` (read + write). The model can inspect its own
  work instead of falling back to `run_shell cat`.
- 2026-07-25: **`fetch_url` can self-check served preview apps.** The SSRF guard
  blocked the model from fetching `localhost:9101` to check the app it just
  served. Now `fetch_url` transparently routes `localhost:<9101-9150>` to the
  workbench (where preview apps actually run) and allows the workbench host on
  those ports — other private/loopback addresses stay blocked. Verified: a
  served page fetched back `200`.

### Added
- 2026-07-26: **Prompt editor + external prompt-file library.** The Config tab has a new
  **Prompts** section with a **Master prompt** (identity/mission) and **System prompt**
  (operating instructions) editor. The model receives them as master -> system -> the
  built-in tool/planner/coding rules (always auto-appended). Prompt sets save/load as
  hand-editable external files `./data/prompts/<name>.prompt` (master on top, a
  `===SYSTEM===` delimiter, system below) via `GET/POST/DELETE /api/prompts[/:name]`, so you
  can version/share them and swap whole prompt sets. `llm.master_prompt` added.
  (`app/src/config.js`, `app/server.js`, frontend, `JARVIS_CONFIG_template.json`.)
- 2026-07-26: **Context window is configurable + auto-detected.** New **Context window** field
  in the Config tab (blank/0 = auto). `GET /api/context-window` resolves the meter's ceiling:
  a manual `llm.context_window` wins; otherwise AUTO — local Ollama uses `ollama.context_length`
  (the loaded num_ctx, i.e. the real effective ceiling, not the model's theoretical max which
  would mislead), and cloud via the LiteLLM gateway asks `/model/info`; else a default. Endpoint
  detection is best-effort (verify live). (`app/server.js`, frontend, `JARVIS_CONFIG_template.json`.)
- 2026-07-26: **"Summarize & continue" — real context compaction.** When the meter passes
  ~60%, a 🗜 Summarize button appears; it asks the model (smart tier, no tools) to write a
  complete-but-terse summary of the conversation, then REPLACES the sent history with that
  summary so the window actually shrinks and JARVIS keeps going with its own summary as
  memory (a plain "please summarize" wouldn't free anything). `POST /api/summarize`; llm.chat
  gains a `noTools` option. (`app/server.js`, `app/src/llm.js`, frontend.)
- 2026-07-26: **Context-window meter.** A small bar under the title shows how full the
  conversation context is (green <60%, amber <85%, red ≥85%) — e.g. `64% · 21k/33k` — driven
  by each turn's actual prompt size (`context_tokens`, the latest single call, not the per-turn
  sum) against `context_window` (from `llm.context_window` or `ollama.context_length`). Makes
  context-fill — a quiet cause of the model "forgetting"/degrading on long sessions — visible.
  (`app/src/llm.js`, `app/src/config.js`, frontend.)
- 2026-07-26: **Autopilot survives an app restart (persist + auto-resume).** The run state
  is now written to `/data/autopilot.json` on every change, so if the app crashes or is
  restarted mid-run, it **auto-resumes on startup** instead of dying silently — closing the
  one real hole in "kick it off and walk away." A run that was paused stays paused for you
  to resume. (`app/src/autopilot.js`, `app/server.js`.)
- 2026-07-26: **Autopilot observability — cycle markers + token/cost.** Each cycle drops a
  "🛫 Autopilot — cycle N" marker in the Activity tab, and the status bar shows the running
  token count + estimated cost (matters on cloud models). (`app/src/autopilot.js`, frontend.)
- 2026-07-26: **Log rotation + retention.** Level-5 logs grow fast; the day's file now rolls
  to `jarvis-<day>.N.log` past a size cap (`logging.max_mb`, default 50) and files older than
  `logging.retain_days` (default 14) are deleted on startup — the `Logs/` dir stays bounded.
  (`app/src/logger.js`.)
- 2026-07-26: **serve_app catches the wrong-directory mix-up.** If a static server is
  pointed at a folder with no `index.html`, GET / returns a directory listing (a false
  "it works"). serve_app now detects this, lists the HTML files it found, and tells the model
  to fix the entry point / cwd instead of declaring success. Plus a system-prompt nudge to
  syntax-check code right after creating/editing it. (`app/src/tools.js`, `app/src/config.js`.)
- 2026-07-26: **Test suite for the tool loop + core modules.** New `app/test/` with a
  deterministic harness that stubs the LLM transport (scripted SSE) and `execTool` to assert
  the `llm.js` guardrails (tool-call-as-text salvage, follow-through nudge, completion loop,
  repeat-tool guard), plus planner, autopilot (completion/budget/stuck/pause/resume/extend/
  modify + anti-loop), and edit/linkify logic. Run with `npm test` (`node test/run.js`); a
  `test/smoke.sh` checks the live HTTP surface + carries a model-behaviour checklist. 31
  assertions across 4 suites, all passing on the host (no container needed).
- 2026-07-26: **`edit_file` for shared files** — the `/READ_WRITE_FILES` counterpart of
  `edit_workbench_file` (targeted string-replace instead of rewriting the whole file).
  `write_file`'s description now steers to it. (`app/src/tools.js`.)
- 2026-07-26: **Coding-habit guidance baked into the system prompt** (cache-safe constant),
  from weaknesses the small model exposed: build in `/workspace` not `/READ_WRITE_FILES`;
  prefer `edit_workbench_file` over whole-file rewrites; and to debug a runtime rendering bug,
  `browser_goto` + `browser_console` to read the actual error rather than re-reading static
  HTML. `plan_show` is also discouraged in the planner rule (it's shown every turn).
  (`app/src/config.js`.)
- 2026-07-26: **Browser console capture — JARVIS can now debug a RUNNING web app.** The
  browser daemon captures the page's JavaScript console output + uncaught runtime errors,
  and `browser_goto` auto-includes any load-time errors in its result. New `browser_console`
  tool returns the messages + errors on demand. This closes the exact gap that stumped a
  coding session ("everything is black — fix the lighting"): the model kept re-reading the
  static HTML because it couldn't see the runtime error; now it can `browser_goto` the served
  app and read "Uncaught TypeError: … at render()" directly. (`app/src/browserd.py`,
  `app/src/tools.js`.)
- 2026-07-26: **`edit_workbench_file` — targeted edits instead of whole-file rewrites.** A
  string-replace edit tool (find an exact unique `old_string`, replace with `new_string`;
  `replace_all` optional) for workbench files. The model was rewriting entire large files
  with `write_workbench_file` and reintroducing bugs (undefined vars, malformed rows) each
  time; targeted edits are safer and cheaper. Reads via the shared `/workspace` mount (no
  truncation) and writes back reliably as root. `write_workbench_file`'s description now
  steers to it for edits. Literal-safe (a `$&` in `new_string` is not interpreted).
  (`app/src/tools.js`.)
- 2026-07-26: **Autopilot: pause / resume / modify / extend, plus anti-loop fixes.** The
  live status bar now has **⏸ Pause** (freezes the time budget; **▶ Resume** later),
  **+15m** (extend the budget — also rescues a run about to stop on time), and **Modify**
  (change the objective mid-run; the next cycle re-checks its plan against it), alongside
  the existing Wrap up / Stop. Backend gains `pause`/`resume`/`modify`/`extend`.
  **Log-review-driven fixes for a real re-read loop:** a session showed Autopilot re-reading
  the same file 40+ times and repeatedly narrating "now I'll build X" without building it
  (the model itself noticed "I've been calling plan_update without building anything"). Two
  fixes: each cycle now carries a **one-line recap of the previous cycle** ("continue from
  there — don't re-read what you already did"), and an **anti-thrash push** kicks in after a
  couple of cycles that only read/plan without writing files ("STOP re-reading, make the
  change NOW"). `plan_show` is discouraged in its description and the injected ledger note
  (it was called 36× redundantly since the plan is already shown every turn).
  (`app/src/autopilot.js`, `app/src/planner.js`, `app/src/tools.js`, `app/server.js`, frontend.)
- 2026-07-26: **Config tab: provider picker + live model listing.** The "Model & LLM"
  section now has a **Provider / endpoint** dropdown with presets (OpenAI, OpenRouter,
  Groq, Together, Mistral, DeepSeek, xAI, Perplexity, Google Gemini, Ollama, the bundled
  LiteLLM gateway, and Generic/custom). Picking one fills the endpoint URL and shows the
  right fields — an **API key** input for cloud providers (hidden for keyless local
  Ollama), and the **Ollama host-tuning** section only when a local Ollama endpoint is
  selected (the "dynamic windows"). A **List models** button queries the chosen endpoint
  (`POST /api/models/probe` with the entered URL + key) and loads the results into a shared
  datalist, so the model + per-tier pickers autocomplete real model names (type to filter).
  Generic points at any OpenAI-compatible URL with an optional key. (`app/server.js`,
  `app/public/{index.html,app.js,style.css}`.)
- 2026-07-26: **Autopilot — kick off a big objective and walk away.** Give an objective
  and a time budget; JARVIS drafts a plan (the Planner ledger) and then drives it
  autonomously in back-to-back build → test → refine → fix cycles until the objective is
  complete, the time budget is reached, it gets stuck, or you stop it. It runs
  SERVER-SIDE (like scheduled tasks), so you can close the tab and leave — it notifies you
  (in-app + desktop + spoken) with a summary when it's done. Controls: a header launcher
  (objective, "stop after N min", autonomy), a live status bar (state · cycle · countdown)
  with **Wrap up** (graceful — finish the current step, summarize, stop) and **Stop**
  (immediate, which also kills in-flight workbench commands via the hard-stop path). Runs
  in **patient mode** (watchdog off) so slow local cycles aren't killed, and stuck-detection
  pauses it after several cycles with no plan progress instead of thrashing. Autonomy is a
  config toggle: **guarded** (default — free to build/test in `/workspace`, but won't send
  email / post / spend / delete your files outside `/workspace` on its own; those become
  blocked steps) or **full** (no restrictions). (`app/src/autopilot.js` (new),
  `app/server.js`, `app/src/config.js`, frontend, `JARVIS_CONFIG_template.json`.)
- 2026-07-26: **Planner / persistent task ledger — JARVIS stops forgetting what it was
  doing.** For multi-step jobs the model now keeps an on-disk plan (objective + ordered
  checklist) via new `plan_create` / `plan_update` / `plan_add_step` / `plan_show` /
  `plan_clear` tools. The active plan is re-injected at the top of EVERY turn, so JARVIS
  always knows the goal and its place and **resumes from the first incomplete step after
  any interruption** (a stall, a Stop, even an app restart — the ledger is in
  `/data/plan.json`, not the lost in-turn context). This is the core fix for the
  "forgets what it was working on" behavior. A live banner above the chat shows the
  objective, per-step status (done/active/pending/blocked), progress, and notes, updating
  in real time; collapse or clear it from the banner. `GET/DELETE /api/plan`.
  (`app/src/planner.js` (new), `app/src/tools.js`, `app/src/llm.js`, `app/src/config.js`,
  `app/server.js`, frontend.)
- 2026-07-26: **Stream-watchdog switch (🐕) — patient mode for long tasks.** The 120s
  idle watchdog that stops a stalled stream can now be toggled per message from the
  header. ON (default) = current behavior, best for chat and quick tasks. OFF = patient
  mode: JARVIS keeps waiting through slow local cold-loads/prefills instead of erroring
  out with "stream idle >120s" (the real cause of it "losing its brains" mid-task and
  restarting). Stop/Esc still interrupts. Diagnosed from logs: every stall fired at
  ~125s and the same context succeeded in ~1-3s on the immediate retry — i.e. a slow
  cold model, not a dead one. Backend honors a per-request `watchdog` flag (default
  from `llm.idle_watchdog`); state persists client-side. (`app/src/llm.js`,
  `app/server.js`, frontend.)
- 2026-07-26: **Plan mode (🗺).** A header toggle that makes JARVIS clarify first, lay
  out a concise high-level plan, then execute it step by step — the plan-first workflow.
  Implemented as a per-turn steer injected into the volatile user-message suffix (keeps
  the cached system prefix byte-stable), sent via a per-message `planMode` flag; state
  persists. (`app/src/llm.js`, `app/server.js`, frontend.)
- 2026-07-26: **New Config-tab "Behavior" section + skill-hint logging + leak
  prevention.** Config tab now exposes completion checks, idle-timeout ms, the watchdog
  default, and the "model is slow" warning delay (`ui.stall_seconds`, wired through
  `publicConfig`). The chosen skill auto-hint is now logged at level 4 (`skill`
  category). Every system prompt carries a constant rule to always use the real
  tool-call mechanism (reduces the "tool call written as text" leak at the source; the
  harness still salvages any that slip through). (`app/src/config.js`, frontend,
  `JARVIS_CONFIG_template.json`.)
- 2026-07-26: **Collapsible, resizable side drawer.** The right-hand panel (Activity,
  Tasks, Memory, Files, Workbench, Config) is now an adjustable drawer: a **▥ Panel**
  toggle in the header (and a **»** chevron in the tab row) collapse it so chat goes
  full-width; drag the left-edge grip to any width; double-click the grip to cycle
  preset sizes (peek / half / full). Width + open/closed state persist across reloads
  (localStorage). Picking a tab re-opens it if closed, and the toggle shows a pulsing
  dot when a tool runs while the drawer is hidden, so you can keep it closed and still
  know work is happening. (`app/public/{index.html,app.js,style.css}`.)
- 2026-07-25: **Working/idle status — you never have to guess if JARVIS is busy.**
  An always-visible pill in the header shows **Idle** (green), **Working** (amber,
  pulsing dot), or **Stalled?** (red) driven by the streamed turn/tool events. A
  stall detector flips the working indicator to a red "still working — model is
  slow (press Esc to stop)" warning when no progress streams for 25s, so a slow
  model no longer looks like an idle one. (`app/public/{index.html,app.js,style.css}`.)
- 2026-07-25: **Hard stop — "just stop, I don't care what you're doing."** Stop
  (button / Esc) now aborts the LLM **and** kills any in-flight workbench command:
  the abort signal is threaded through `execTool` into `run_shell`, which kills
  the command's whole process group inside the container (namespace-correct — a
  long build or hung server dies immediately instead of running to its timeout).
  Typing a bare "stop" / "just stop" / "cancel" while it's busy now interrupts
  instead of being rejected with "I'm still working…". Verified: an aborted
  `sleep 60` leaves no surviving processes; normal commands keep their exit code.
  (`app/server.js`, `app/src/llm.js`, `app/src/tools.js`.)
- 2026-07-25: **Completion-verification loop — keep working until the job is
  really done.** When the model finishes a turn that used tools and thinks it's
  done, it's challenged to re-read the original request and confirm EVERY part is
  actually complete and verified; if not, it continues. It self-terminates when
  it stops finding new work (re-affirms with no new tool call), bounded by
  `llm.completion_checks` (default 2, `0` = off; in the Config tab). Catches
  premature "I'm done" stops. (`app/src/llm.js`.)

### Fixed
- 2026-07-26: **Context meter now always visible (even at 0%).** It was hidden until the
  first turn reported usage, so a fresh or just-refreshed chat showed nothing. It now renders
  on load — 0% on a new chat, and a rough estimate after a refresh / when loading a saved
  session — and the exact value replaces the estimate on the next turn. (`app/public/app.js`.)
- 2026-07-26: **Bare URLs in chat are now clickable.** When the model posts a plain link
  (e.g. `http://localhost:9101` for a served app), it now renders as a clickable link.
  Existing markdown links and URLs inside inline code are left as-is. (`app/public/app.js`.)
- 2026-07-26: **Autopilot objective box no longer closes when you select its text.** The
  launcher closed on any outside click, including a text-selection drag that ended outside
  the box — so clearing the field was painful. It now only closes when the press *started*
  outside. (`app/public/app.js`.)
- 2026-07-26: **Phantom "RUNNING" Autopilot bar on an idle app.** The `.autopilot-bar`
  CSS set `display:flex`, which (author > UA cascade) overrode the HTML `hidden`
  attribute, so the bar rendered with its default "running" text even with no run active.
  Added a global `[hidden] { display: none !important; }` guard. (`app/public/style.css`.)

### Changed
- 2026-07-26: **Side panel is now a single attached drag-handle drawer.** Removed the header
  "▥ Panel" button, the separate resize grip, and the » collapse chevron. One handle stays
  attached to the drawer's left edge and slides in/out with it: **click** to open/close
  (chevron flips ‹/›), **drag** to resize (drag it to the far right edge to close, or pull it
  out from the edge to open). Width + open state persist; the "work happening while closed"
  badge sits on the handle. (`app/public/{index.html,app.js,style.css}`.)
- 2026-07-26: **Header controls wrap** instead of overflowing — as the window narrows, the
  toolbar buttons flow onto additional rows so they stay on screen. (`app/public/style.css`.)
- 2026-07-26: **Removed the "System self-test" button** from the UI (it's a CLI/`curl`
  concern); the `GET /api/selftest` endpoint stays for command-line use.
  (`app/public/{index.html,app.js}`.)

### Fixed
- 2026-07-25: **Tool calls written as TEXT now actually run — a top cause of "said it
  did it but didn't."** The chat model (Qwen3 via Ollama) intermittently emitted a
  tool call as plain text — `<tool_call>run_shell <parameter=command>…</parameter>`
  (an XML-parameter dialect the server's JSON tool-call parser doesn't recognize) —
  so the command never executed, yet the model believed it had and carried on
  reporting the work as done. In one session **22 of 40** no-tool-call turns were
  actually leaked calls like this. The loop now detects `<tool_call>` blocks in the
  reply, **salvages and executes** the parseable ones for real (feeding results
  back), and **corrects** the model to use the real tool-call mechanism; malformed/
  unparseable ones get a corrective nudge instead of being silently accepted.
  Bounded to 6 fixes/turn. Verified against the real malformed strings from the logs
  (clean, garbled, JSON, and multi-call variants). (`app/src/llm.js`.)
- 2026-07-25: **Follow-through guardrail no longer 400s.** The nudge was pushed
  as a **system** message, but `oneSystemAtFront` relocates system messages to
  the front — which both defeated the nudge and left two assistant messages
  adjacent at the end → `400: Cannot have 2 or more assistant messages`. All
  in-loop nudges (follow-through, completion check, repeat-tool guard) are now
  **user**-role messages, so they stay where they belong and never trigger the
  400. Verified: a real task fired a completion check with zero 400s.
- 2026-07-24: **"Launched an app but it never started" — now verified & honest.**
  `open_app`/`open_url` used `nohup CMD & ; echo launched`, which reported success
  even when the app **crashed on startup** (e.g. Chromium exiting because as root it
  needs `--no-sandbox`) — so the model believed it had started something that never
  actually came up. Both now launch detached (`setsid`, survives the exec) AND
  verify the process is still alive ~1.5s later, returning the real startup output
  and a clear **`FAILED: the app exited immediately…`** with the reason instead of a
  false "launched". Confirmed against the exact Chromium-sandbox crash from the logs.
- 2026-07-24: **Browser tools were completely broken — now fixed, durably.**
  Root cause found via the new level-5 logs: the browser-daemon start command
  ran `pkill -f '[b]rowserd.py'` in a shell whose own command line contained
  `python3 /opt/jarvis/browserd.py`, so **pkill killed its own launching shell
  before the daemon could start** (surfacing as "browser daemon failed to
  start:" with an empty reason after a 30s hang). Now it frees the port with
  `fuser -k 9251/tcp` (port-based, can't match a command line), logs the daemon
  lifecycle, and surfaces the real failure detail instead of an empty string.
  Verified end-to-end: `browser_goto` + `browser_extract` work again.
  - **Durability** (answering "will it come back on rebuild?"): Playwright
    browsers now install to a fixed image path `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`
    in the workbench Dockerfile instead of `~/.cache` under the `/config`
    volume (which shadowed them on fresh volumes), and the install **fails the
    build loudly** if Chromium is missing instead of the old silent `|| true`.
    `fuser` (psmisc) was already in the Dockerfile, so the fix's dependency is
    baked in.
  - **JavaScript** is explicitly enabled in `browserd.py`
    (`java_script_enabled=True`) for JS-dependent sites — safe given the
    intentional sandboxed-container/root design.
- 2026-07-24: **Follow-through guardrail for "says it but doesn't do it."** When
  the model ends a turn narrating an action ("let me search that…", "I'll run
  the command…") but emits no tool call, the loop now nudges it to actually call
  the tool and continues (bounded budget). Matching is deliberately conservative
  (`ACTION_INTENT_RE` in `llm.js`) so ordinary conversation ("it's going to be
  great", "let me know") doesn't trip it; triggers are logged at WARN.
- 2026-07-24: **Workbench desktop can be brought back after opening it in a new
  tab.** The embedded desktop iframe shares the workbench's VNC session; opening
  it in a new tab (or backgrounding the JARVIS tab) left the embedded view frozen
  with no way to reconnect. Added a **"↻ Reconnect here"** button in the
  Workbench panel, and the desktop now **auto-reconnects** when you switch back to
  the JARVIS tab with the Workbench panel open. Front-end only (`app/public/`),
  no restart needed — just refresh.

### Added
- 2026-07-24: **Leveled debug logging → `JARVIS_AI/Logs/`.** New `logging.level`
  config flag (0-5), editable from the **Config tab** and applied **live** — no
  `--reload` (the full-config save now mutates the in-memory config in place, so
  the logger's live level read picks it up immediately). Levels: `1` errors, `2`
  warnings, `3` info (turn start/end + each tool call), `4` verbose (full tool
  args + results + token usage), `5` debug (the complete LLM request messages +
  raw response + browser actions). Off (`0`) by default — zero overhead. **Secret
  values are redacted** so a level-5 log is never a credential leak. New
  `app/src/logger.js` (one file per day, per-payload size cap, never throws);
  `llm.js` logs every turn's request/response, `tools.js` `execTool` logs every
  tool call/result/error. `Logs/` is bind-mounted and gitignored. This is the
  diagnostic engine for the pending agent-behavior fixes.

### Fixed
- 2026-07-21: **Massive prompt-processing latency fix (~50s → ~1s per turn).**
  Per-turn volatile context (the current-time note and the skill hint) was
  injected as a leading **system** message, so — merged to the front by
  `oneSystemAtFront` — the large, otherwise-stable system-prompt + tools
  prefix (~8k tokens) was byte-different every turn. That defeated
  Ollama/llama.cpp KV-cache reuse and forced a full re-prefill of the whole
  prompt on the first model call of EVERY turn (~40s on a 70B). Now that
  volatile context is prepended to the **last user message** instead, so the
  system+tools prefix stays byte-identical and the cache is reused; only the
  changing user tail is re-processed. (`app/src/llm.js`.) Pairs with the
  `--reload` Ollama `keep_alive:-1` fix that keeps the model + its cache
  resident. Note: model choice matters too — Llama-3.x templates render tool
  definitions inside the *last user message* (so the tools payload never
  caches across prompts), whereas Qwen3 templates put tools in the stable
  system block; on this hardware Qwen3.6 (35B-A3B MoE) is dramatically faster
  than a dense 70B for JARVIS's tool-heavy prompts.

### Added
- 2026-07-20: **Config tab — edit the entire configuration from the UI.** A new
  sidebar tab exposes everything in `JARVIS_CONFIG.json` and
  `JARVIS_SECRETS.json`. Hybrid editor: friendly fields for the high-value
  settings (LLM provider/base_url/model-mode/model, the per-task model tiers,
  temperature, max tokens, assistant name, voice engine/mic mode, toggles) plus
  raw-JSON editors for the complete config and secrets — the two views stay in
  sync (JSON is canonical at save). Secrets are shown masked with a Reveal
  toggle (fine on this localhost-only single-user app). New backend endpoints
  `GET/POST /api/config/full` read/validate/write both files; every save
  **auto-backs-up** the previous file to `/data` and validates before writing,
  so a bad edit is always recoverable. Saving does not hot-apply — it prompts
  to run `./JARVIS.sh --reload`.
- 2026-07-20: **Host Ollama settings are now first-class config.** New `ollama`
  block in `JARVIS_CONFIG.json` (`manage`, `context_length`, `keep_alive`,
  `num_parallel`, `max_loaded_models`), editable from the Config tab.
  `./JARVIS.sh --reload` now applies them to the host Ollama via
  `launchctl setenv` and restarts Ollama (macOS; skipped if `manage:false`),
  then restarts the app. This fixes the ~60s cold-load latency on large models:
  Ollama 0.32 auto-sizes context to the full window (128k → an 85GB resident
  footprint that gets evicted and reloaded); capping `context_length` (default
  65536) plus `keep_alive:-1` keeps models resident and warm.

### Fixed
- 2026-07-20: **Tool calls now work with strict chat templates (e.g. Qwen3
  derivatives).** JARVIS injects system notes anywhere in a turn (current
  time, per-turn skill hint, repeat-tool warning), but some models' chat
  templates raise `System message must be at the beginning`, which made
  Ollama's tool-call parser generation 400 the moment tools were attached
  (e.g. `AI-TAVS/Qwen3.6-35b-a3b-Uncensored:35b`). `app/src/llm.js` now
  collapses all system messages into a single leading one
  (`oneSystemAtFront`) before each request — the standard, most-compatible
  message shape, and a no-op in effect for lenient templates. Verified
  against Ollama: the same model that 400'd now returns a clean tool call.

### Added
- 2026-07-20: **Two additional local models registered in the LiteLLM
  gateway** (`litellm/config.yaml`), routed to host Ollama via the same
  OpenAI-dialect passthrough as the existing local models — so they appear in
  the header model switcher and can be selected for any tier:
  `llama3.3:latest` and `AI-TAVS/Qwen3.6-35b-a3b-Uncensored:35b` (both already
  pulled in Ollama, both tool-capable). `llama2-uncensored:70b` was also
  trialed but removed: Ollama reports it as `completion`-only with no
  tool-calling template, so it cannot drive JARVIS's tools. Existing models
  are unchanged. Requires a gateway reload to take effect
  (`docker compose up -d --force-recreate jarvis-litellm`).
- 2026-07-07: **Expressive-face ambient avatar (+ face/orb switch).** Ambient mode can now
  render an expressive glowing **face** — it blinks, its gaze wanders while thinking, and
  its mouth **lip-syncs to the voice** (driven by the AI's real amplitude on the Piper
  engine). The original pulsating **orb** is kept; a button in the top-left of ambient mode
  switches between them live and persists the choice (`voice.ambient_style`, default
  `face`). Implemented in `app/public/ambient.js` (`drawFace`/`drawOrb`); wired + allowlisted
  in `app/src/config.js`, persisted from `app/public/app.js`.
- 2026-07-07: **Conversational follow-up window for Wake mode.** After JARVIS finishes
  speaking, the mic stays awake for `voice.followup_seconds` (configurable; `0` = off) so
  you can reply **without** repeating the wake word — turning Wake mode into a natural
  back-and-forth. The timer is anchored to **end-of-speech** (not your last utterance), so
  the model thinking or giving a long answer never eats into the reply window; it re-opens
  after every response. It's the time to *start* replying — the countdown stops the moment
  you begin speaking (detected on interim results, re-armed to the engaged timeout), so a
  longer sentence won't be cut off. Applies to Wake mode with spoken replies on.
  Implemented in `app/public/voice.js` (`scheduleSleep`/follow-up logic in `finishSpeaking`
  + interim-speech detection in `onResult`); surfaced + allowlisted in `app/src/config.js`.
  `silence_timeout_seconds` still governs the initial post-wake-word window.
- 2026-07-07: **Emojis are no longer spoken.** The AI still uses emojis on screen to
  express tone, but they're now stripped before text-to-speech (both engines) so the voice
  reads the prose, not "🎉". Covers pictographs, flags, skin-tone modifiers, ZWJ sequences,
  variation selectors, and keycaps (`cleanForSpeech` in `app/public/voice.js`).
- 2026-07-07: **Offline neural voice (Piper).** A new fifth container, `jarvis-piper`,
  runs [Piper](https://github.com/rhasspy/piper) — an on-device neural text-to-speech
  engine — behind a tiny HTTP API (`piper/serve.py`). The voice engine is now selectable
  in the 🎚️ voice popover: **Browser** (OS/Chrome Web Speech voices, as before) or
  **Piper** (neural). Piper is **free, fully local, and machine-independent** — the engine
  binary + voice models are baked into the image at build time (arch auto-detected for
  arm64/x86_64), so at runtime nothing leaves the machine and the same voice travels with
  JARVIS to any host. Ships 7 curated en voices (US/GB, female/male). ~45× faster than
  real-time on CPU. New backend proxy `app/src/tts.js` + endpoints `GET /api/tts/voices`
  and `POST /api/tts` (browser stays same-origin; the app forwards to the internal-only
  container). New settings `voice.tts_engine` / `tts_voice` / `tts_rate` / `tts_pitch`,
  all UI-settable and persisted. Add/swap voices via `piper/download-voices.sh` + rebuild.
- 2026-07-07: The **ambient orb is now truly amplitude-reactive while speaking** when the
  Piper engine is active — because JARVIS plays its own audio through the Web Audio API,
  the orb is driven by the real waveform of its voice (the browser engine still uses the
  word-synced envelope, since it won't expose the synth waveform).

### Fixed
- 2026-07-07: Recurring gateway error `litellm.APIConnectionError: Extra data: line 1
  column N` (a JSON-decode failure in LiteLLM's Ollama NDJSON parser when Ollama's
  streamed chunks coalesce). Rerouted the local models in `litellm/config.yaml` from
  the `ollama_chat/` provider to `openai/` pointing at Ollama's OpenAI-compatible
  `/v1` endpoint, so LiteLLM is a clean OpenAI-dialect passthrough and never touches
  the flaky parser. Verified through the gateway: chat, tool calls, streaming
  reasoning (`reasoning_content` → the Thinking panel), vision, and the full app
  path. No functionality or flexibility lost (multi-provider tiers unchanged). Note:
  the bug is present even in the newest LiteLLM (running 1.92.0), so an upstream
  update would not have fixed it — the reroute was the right call.

### Changed
- 2026-07-07: Voice tweaks. The **🎤 Talk** push-to-talk button is now disabled in
  Wake/Open mic modes (they already listen — it's only useful when the mic is Off).
  The ambient orb now **animates continuously while the AI speaks** (a synthesized
  syllable-rate envelope + a fast surface ripple, layered with the per-word pulses),
  so it visibly reacts when talking, not just to your voice.
- 2026-07-07: De-cluttered the voice controls (they were redundant). The **Voice**
  button now toggles spoken replies (text-to-speech) — it was a combined open-mic +
  TTS shortcut. Removed the separate speaker on/off dip-switch (it did the same thing
  as the TTS toggle). Listening is now solely the **Off/Wake/Open** mic control +
  **🎤 Talk** push-to-talk. The wake word is configurable (`voice.wake_word`, defaults
  to `assistant_name`) and the mic status now shows the actual wake word instead of a
  hardcoded "Jarvis".

### Added
- 2026-07-07: **Voice picker.** A 🎚️ voice-settings popover (next to 🔊 Voice) to
  choose the spoken voice from the OS/browser's available voices, plus speed and pitch
  sliders and a Test button (previews immediately, even when muted). Persists to
  `voice.tts_voice` / `voice.tts_rate` / `voice.tts_pitch` (now exposed in
  `/api/config` and the settings allowlist). The code already honored `tts_voice` but
  never exposed it — now it's a first-class UI control.
- 2026-07-07: **Ambient (orb) voice mode** (`🌌 Ambient`). A full-screen, hands-free
  view that hides the UI and renders JARVIS as a glowing orb animated by state: soft
  breathing when idle, ripples to your real mic amplitude when listening (Web Audio),
  churns while thinking, and pulses per spoken word while speaking (SpeechSynthesis
  `boundary` events). Tap the orb to talk / interrupt; ✕ to exit. New
  `app/public/ambient.js` + a small `onSpeak`/`onBoundary` hook in `voice.js`; all of
  it is inert unless the orb is open. (Browser-native, no deps; the synth voice's raw
  waveform isn't readable by the browser, so "speaking" is word-synced not
  amplitude-synced.)
- 2026-07-07: Skill **auto-hinting**. Each turn keyword-matches the user's message
  against the skills (`TRIGGERS` in `skills.js`) and injects a one-line
  `get_skill('…')` nudge right before the message. Toggle with the `skills_autohint`
  config flag (default on), the `/hints on|off` UI command, or `POST /api/settings`;
  exposed in `/api/config`. Honest result from live testing: the nudge fires and is
  injected correctly, but qwen3-next often still proceeds directly (it's driven more
  by the always-on tool descriptions than by on-demand skills) — so it's a cheap
  backstop, not a forcing function.

### Changed
- 2026-07-07: Added `data-analysis` and `error-recovery` skills (18 total). Also
  measured whether the local model actually consults skills: across two live tests
  (a data-analysis ask and a browser task) qwen3-next called `list_skills`/`get_skill`
  ZERO times, yet behaved correctly — it drove the `browser_*` tools straight from
  their descriptions and answered sensibly. Takeaway: for this model, behavior is
  driven by the always-on tool descriptions, not by on-demand skills; getting skills
  actually used would require per-turn auto-hinting (deferred). The corrected/added
  skills are still kept (they're accurate now and cost no always-on tokens).
- 2026-07-07: Skills correctness pass (12 → 16 skills). Removed the dead `sql`-tool
  references that were teaching the model to call a tool that no longer exists (in
  the `internet` and `workflow-monitor-and-alert` skills). Rewrote `desktop-control`
  to match reality (screenshot returns a vision text analysis + coordinates, not a
  raw image; added `ui_actions`) and reframed it for non-browser apps. Replaced the
  `browser-automation` (Playwright-via-shell) skill with a `browser` skill leading on
  the first-class `browser_*` tools. Updated `scheduling` (output destinations,
  notify-as-stop-signal), `workflow-login-and-act` (browser-first), and `memory`
  (`update_memory`, timestamps). Added new skills: `vision`, `email`, `documents`,
  and `task-authoring`. Fixed the stale "seeded into the skills DB table" comment
  (skills are served in-memory now).
- 2026-07-06: Documentation overhaul. Rewrote the README to be high-level and
  accurate (it still described the removed MySQL `jarvis-db` / `sql` tool and
  predated the gateway, browser/email/document/MCP tools, personas, voice
  streaming, and the whole web UI). Added a `Docs/` directory with detailed guides:
  architecture, configuration, tools, web-ui, voice, memory-and-scheduling, cli,
  api, and extending — all cross-linked from the README and a `Docs/README.md`
  index.
- 2026-07-06: Voice made ChatGPT-like. TTS now uses a QUEUE and speaks the reply
  sentence-by-sentence AS it streams in (previously it waited for the entire reply,
  which meant ~30-90s of silence with the local reasoning model, then a dump). This
  also fixes a real soundness bug: the browser truncates long single utterances —
  chunking into sentences avoids it. Added barge-in: a new turn, the Stop button,
  Esc, or tapping the mic instantly silences speech and resumes listening. Spoken
  text is cleaned (code blocks, inline code, URLs, and importance markers are
  skipped, not read aloud). New one-tap "🎙 Voice" toggle turns on hands-free
  conversation (continuous listening + spoken replies) and remembers it. Mic still
  pauses during speech to avoid the assistant hearing itself (browser Web Speech has
  no echo cancellation for continuous recognition — so voice barge-in isn't possible
  mid-speech; use the mic tap / Esc / Stop).

### Added
- 2026-07-06: Framework upgrade — new tool families. **Browser control**
  (`browser_goto/snapshot/click/fill/extract`): a persistent Playwright-driven
  Chromium in the workbench (visible on the desktop, logins persist under
  /workspace/.browser_profile) driven by DOM refs/CSS selectors instead of pixel
  guessing — verified live (goto → snapshot → extract → click). **Email**
  (`check_email/read_email/send_email`) using the user's own account from a vault
  secret named `email` ({username, password, imap_host, smtp_host}). **Documents**
  (`read_document`): paged text extraction from PDF/DOCX/ODT/RTF/EPUB/HTML —
  verified against a real PDF. **Memory** gained `update_memory` (correct in
  place), metadata on add, and timestamps in results (new `/update` endpoint in the
  sidecar). **MCP client** (Streamable HTTP): configure `mcp.servers` in
  JARVIS_CONFIG.json and external tool servers register as `mcp_<server>_<tool>`.
  **Custom tools**: drop a JS module in `data/custom_tools/` (template included)
  and restart — no core edits; `/READ_WRITE_FILES/custom_tools` can also load if
  `custom_tools.allow_model_authored` is explicitly enabled (default off).
  **REST `POST /api/chat`** for scripts/automation (same brain as the WS chat, with
  optional tier/persona). **Personas**: a `personas` config block (full replacement
  via `system_prompt` or additive via `append`), a per-request persona on WS/REST,
  and a `/persona` slash command.

### Changed
- 2026-07-06: LiteLLM gateway is now the default LLM path (`llm.base_url` →
  `http://jarvis-litellm:4000/v1`). The local Ollama models are registered in
  litellm/config.yaml under their exact Ollama tags, so existing model names work
  unchanged, and cloud tiers (Claude/GPT/Gemini) become available by just exporting
  the provider key. Verified through the gateway: basic chat, streaming (reasoning
  arrives as `reasoning_content`), tool calls, vision (needs `ollama_chat/` prefix
  — plain `ollama/` requires Pillow the image lacks), and the FULL eval suite
  (11/11). Set base_url back to `http://host.docker.internal:11434/v1` to bypass.
- 2026-07-06: Tool-weakness fixes from the code review. `run_shell`: hard
  `timeout_s` (default 120s, killed in-container) and head+tail truncation with an
  explicit marker (errors live at the tail). `fetch_url`: headers/body/json are now
  actually exposed to the model (they existed but were unreachable), plus
  timeout_s, offset paging, binary `save_to`, and SSRF checks on EVERY redirect hop
  (was bypassable via 302) with fail-closed DNS. `web_search`: snippets, a `limit`
  param, and explicit rate-limited/blocked detection instead of a silent empty
  result. `read_file`: offset/max_chars paging, truncation notes, and a directive
  error on binary files; `list_dir` returns sizes+mtimes. `press_key`: multi-key
  sequences ("ctrl+a BackSpace") work instead of being silently mangled.
  `ui_actions`: stops at the first failing step and reports it, supports
  right_click, caps at 50 steps, and clamps the click button (was a shell-injection
  vector). `analyze_image`/`read_document` reject missing files. Retryability now
  lives with each tool definition (tools.isRetryable) instead of a hardcoded set.
- 2026-07-06: Memory sidecar namespaces its Chroma collection by embed model
  (`jarvis_<model>`), with a one-time rename migration of the legacy collection —
  switching embedders now lands in a fresh collection instead of silently
  corrupting search with mismatched vector dimensions.
- 2026-07-06: System prompt: removed the dead `sql` tool reference (three places
  taught the model to call a tool that no longer exists) and added the
  browser-first guidance + new tool pointers. Dropped the unused `mysql2`
  dependency.

### Changed
- 2026-07-06: Refined the "simplest interpretation" prompt nudge so it no longer
  discourages real tool use: conversational requests are answered in chat, but tasks
  that ask to compute/build/run/test/verify or produce a file must actually use the
  tools and confirm the result. Full eval suite (incl. the new vision test) is 11/11.

### Added
- 2026-07-06: Big feature batch. **Files tab** — browse, open/preview, download, and
  delete files in the shared folder (`GET /api/files`, `/api/files/raw`,
  `DELETE /api/files`), so JARVIS's outputs are reachable from the UI. **Image
  analysis** — an `analyze_image` tool runs an uploaded/shared image file through the
  vision look-step (describe / read text / answer questions). **Regenerate** button
  (and `/regen`) re-runs the last turn. **Model switcher** in the header lists the
  local Ollama models (`GET /api/models`) and switches the chat model on the fly.
  **Slash commands** — `/help`, `/new`, `/regen`, `/model`, `/remember`, and
  `/files|/tasks|/memory|/activity` to jump panels. **Settings persistence** —
  changing TTS and the mic mode now writes back to JARVIS_CONFIG.json (via
  `POST /api/settings`, gated by an allowlist so secrets can't be written), so they
  survive reboots/rebuilds. NOTE: this required mounting JARVIS_CONFIG.json
  read-write for jarvis-app; because it's a bind-mounted single file, the config is
  written in place (a tmp+rename swap would EBUSY over the mount point).
- 2026-07-06: Chat UX upgrades. Richer markdown in assistant replies — fenced code
  blocks (with a copy button), bullet/numbered lists, and clickable links, on top of
  the existing inline formatting (all still HTML-escaped first, so XSS-safe). A
  visible "＋ New chat" button and a running per-session token/cost total in the
  header. Drag-and-drop a file into the chat to upload it to the shared folder for
  the LLM to read (`POST /api/upload`). A filter box in the Memory tab. And a
  quick-add form in the Tasks tab to schedule a one-shot or recurring task without
  chatting (`POST /api/tasks/add`).
- 2026-07-06: Notifications can now be cleared — a "Clear" button in the Tasks
  tab's Recent notifications header (`POST /api/notifications/clear`) and a per-item
  dismiss (`DELETE /api/notifications/:id`).
- 2026-07-02: More post-review improvements. Performance: server-side history cap
  (last 40 turns) so context sent to the model stays bounded; a stream idle-timeout
  (`llm.idle_timeout_ms`, default 120s) so a stalled model can't hang forever.
  Usability: a Retry button on failed messages (re-sends without duplicating the
  turn); keyboard shortcuts (Cmd/Ctrl+K focus, ↑ to recall last message); a Memory
  tab that browses and deletes Mem0 long-term memories (`GET/DELETE /api/memories`);
  and a `ui_actions` tool that runs a whole desktop sequence (click → type → key) in
  ONE call/turn instead of many. Behavior: a system-prompt nudge to prefer the
  simplest interpretation — play/answer/quiz in the chat rather than reflexively
  building an app. Cleanup: trimmed dead `tools.js` exports and removed stale
  MySQL-era dirs (`db/`, `shared_ro/`, `shared_rw/`). Testing: added a vision eval.
  Verified live: computer-use end-to-end (open browser → screenshot → vision
  look-step → accurate description) and the backup→restore round-trip for memory.

### Changed
- 2026-07-02: Post-review hardening pass (correctness, performance, usability).
  Correctness/data-integrity: all JSON state (tasks, chatlog, sessions) now writes
  ATOMICALLY via a shared `persist.js` (temp-file + rename) so a crash can't corrupt
  it into empty state, with flush-on-exit; the scheduler was rebuilt on in-memory
  state with debounced atomic saves (no more read-modify-write races), runs tasks
  concurrently instead of serially (one slow task no longer blocks all others),
  advances recurring runs from the scheduled slot (no drift) collapsing missed runs,
  and recovers stale "running" tasks on restart. The server now rejects a second
  in-flight chat per connection (was silently overwriting the AbortController and
  interleaving tokens), and each tool result is keyed to its real tool_call_id (an
  "unknown" id could 400 the next turn). Performance: streaming re-renders are
  coalesced to one per animation frame (was an O(n^2) full-bubble rebuild per token);
  message + activity DOM growth is capped. Usability: the WebSocket now reconnects
  with exponential backoff, clears a stuck spinner on drop, and shows a
  lost/reconnected notice; the conversation persists across browser reloads
  (localStorage); assistant replies have a hover copy button; LLM error messages
  include the model. Cleanup: removed dead vision-tier routing (obsoleted by the
  look-step) and fixed a "warn"/"warning" notification-level mismatch.
- 2026-07-01: Computer-use "look" step so vision works with tool-calling. Local
  models split the job — the tool-driver (qwen3-next) is text-only, and the vision
  model (qwen2.5vl) rejects a `tools` payload ("does not support tools" 400). Now a
  screenshot is no longer injected as a raw image into the orchestrator's context;
  instead it's sent to the vision model IN ISOLATION (image + optional question, no
  tools), and that model's TEXT analysis — a description plus interactive-element
  pixel coordinates — is folded back into the tool result. qwen3-next then acts on
  those coordinates. The `screenshot` tool gained an optional `question` to focus
  the analysis, and the system prompt was updated to match.
- 2026-07-01: Local vision support. Pulled Qwen2.5-VL (7b + 32b) and switched the
  config to multi-model mode with the `vision` tier on a local VL model, so the
  screenshot/computer-use path works offline (chat/cheap/smart stay on
  qwen3-next:80b). The vision tier is qwen2.5vl:32b. NOTE: this requires Ollama
  0.31.1+ — on 0.30.10 the 32b failed to load its CLIP/vision projector ("Key not
  found: clip.vision.n_wa_pattern"); updating Ollama to 0.31.1 resolved it. The 7b
  also works and can be selected via models.vision for faster per-screenshot speed.
- 2026-07-01: Chat UX — scroll override and interrupt. The message list now
  auto-follows streaming output ONLY when you're already at the bottom; scroll up
  to read and it stops yanking you down, re-engaging when you return. Added a Stop
  button (and the Escape key) to interrupt in-flight processing: the server aborts
  the LLM request via an AbortController and replies "⏹ Stopped." — useful if the
  model gets stuck in a tool loop.
- 2026-07-01: Chat-awareness for background tasks. A persisted ring buffer
  (`data/chatlog.json`) records recent chat messages (user / assistant / task
  posts), exposed to the model via a new `read_recent_chat` tool. This lets a
  scheduled task SEE the live conversation it otherwise can't — e.g. check
  whether the user has replied (`roles:["user"]`) to escalate an unanswered
  prompt, or review its own recent posts to avoid repeating itself. The
  `schedule_task` and scheduled-run prompts now point the model at this tool so
  requests like "notice if I'm not answering and escalate" are handled instead
  of refused.
- 2026-07-01: Reasoning-model support. The streaming parser now surfaces the
  `reasoning`/`reasoning_content` field (qwen3-next et al.) as a live,
  collapsible "Thinking" panel above each answer, and `llm.max_tokens` is a
  documented config parameter (raised to 12000) so long chains of thought no
  longer exhaust the budget before the model can answer or call a tool. Added an
  always-respond guard: a turn that ends empty (e.g. hit the token cap) now
  replies with a plain "ran out of tokens…" message instead of stopping silently.
- 2026-06-30: Expanded the workbench toolchain with application frameworks and
  extra language tooling so common stacks work offline: Java build tools (Maven,
  Gradle); Python web frameworks (Flask, FastAPI + uvicorn/gunicorn, Django +
  DRF, Starlette, Celery, Streamlit, SQLModel, Jinja2); a Node/TypeScript global
  toolchain (typescript, ts-node, tsx, yarn, pnpm, eslint, prettier, vite,
  http-server, serve, nodemon, npm-check-updates); the Rust toolchain (rustup +
  cargo); Go dev tools (golangci-lint, air); and CLI helpers (direnv,
  universal-ctags). Everything installs outside the `/config` and `/workspace`
  runtime volumes so it survives at runtime. Rebuild with
  `docker compose build jarvis-workbench && docker compose up -d jarvis-workbench`.
- 2026-06-30: Added a Python "batteries" library set to the workbench: dev tooling
  (pytest + pytest-asyncio/-cov, coverage, tox, ruff, black, isort, mypy, flake8,
  pylint, bandit, pre-commit), database drivers (psycopg2-binary, pymysql,
  pymongo), app plumbing (python-dotenv, pydantic-settings, click, typer, tenacity,
  loguru, tqdm, faker, orjson, arrow), extra plotting (seaborn, plotly), and NLP/CV
  (nltk, spacy, opencv-python-headless); plus global Node CLIs (pm2, concurrently,
  npm-run-all). Heavy ML stacks (torch/transformers) are intentionally excluded —
  they are CPU-only in-container and inference runs via Ollama on the host.
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

- 2026-06-29: Made web-app previews reliably show a working UI. Root cause of "the
  demo doesn't work": the model built API-only servers (no GET / route), so the browser
  showed "Cannot GET /" even though the server was up — and serve_app reported "reachable"
  regardless of status. serve_app now checks GET / and returns `ok_homepage` + the HTTP
  status, with an explicit warning when / is 4xx/5xx (and the not-reachable message says
  not to tell the user it's ready). The tool description, the system prompt, and the
  `web-preview` skill (now with a known-good single-file Express UI+API template) require
  serving a real interactive HTML page at GET /, using a preview port 9101-9150, iterating
  in one app dir, and confirming 200 before handing the URL to the user.
- 2026-06-29: Added an explicit `llm.model_mode` switch (`single` | `multi`).
  `single` routes every task tier to `llm.model` (the `models` block is ignored, so it
  can stay defined); `multi` uses the per-task tiers with fallback. Omitting the key
  auto-detects (multi if a `models` block is present, else single). Implemented in
  `config.js` (`modelMode()`, used by `modelFor()` and surfaced in `publicConfig`), and
  documented in both `JARVIS_CONFIG.json` and `JARVIS_CONFIG_template.json` with
  `_model_mode_comment`/`_models_comment`. So a single-model setup is a one-line flip.

- 2026-06-29: Added a `TEMPLATES/` directory of ready-to-use example configs:
  `JARVIS_CONFIG.single-openai` (OpenAI direct, simplest), `openai-tiers` (OpenAI
  multi-tier via gateway), `multi-model` (OpenAI+Claude+Gemini), `anthropic-claude`,
  `local-ollama`, `local-openai-compatible` (LM Studio/llama.cpp/vLLM), and
  `mock-offline`; plus `JARVIS_SECRETS.empty`/`example` and a README. Each config is a
  complete copy-paste-ready file (full system prompt) generated from
  `JARVIS_CONFIG_template.json` by `TEMPLATES/_generate.py` — only the `llm` block
  differs per scenario. Templates use REPLACE_ME placeholders (safe to commit); the
  README documents the gateway-vs-direct choice and the Mem0/embeddings caveat for
  local setups.

- 2026-06-29: "Test what you build." Added a system-prompt principle: whenever the
  model generates code/a program it must RUN it and do a baseline functionality test
  before saying it's done (scripts: execute on a representative input, check output +
  exit code; web apps: after GET / is 200, exercise the real endpoints/UI via curl or
  Playwright) and report what it tested. Reinforced in the web-preview and workbench
  skills. To make this practical, added a `write_workbench_file(path, content)` tool
  that writes code files into the workbench reliably (base64-piped, no shell-quoting
  issues) — eliminating run_shell heredoc thrashing (a factorial test went from 13
  flailing run_shell calls to write_workbench_file + one run_shell). Bumped
  `max_tool_iterations` 12 -> 15 for build-test-fix loops; regenerated the TEMPLATES.

- 2026-06-29: Added a persistent "still working" indicator to the chat. Previously the
  3-dot typing indicator vanished as soon as the first token streamed, so during long
  tool-running phases (e.g. coding tasks) there was no sign the LLM was still going.
  Now an animated-dots indicator stays pinned at the bottom of the chat from send until
  the reply/ error completes, showing what it's doing (`running <tool>…`, `responding…`,
  `working…`) and a live elapsed timer (Ns). Frontend only (`app/public/app.js` +
  `style.css`, with a prefers-reduced-motion fallback) — refresh the browser to get it.

- 2026-06-29: Tasks now flag "no effective result." The scheduler detects when a run
  accomplished nothing useful — no tools called, every tool errored, or data-producing
  tools (run_shell/fetch_url/web_search) returned empty (e.g. a dead API) — marks the
  run `⚠ no effective result`, and notifies the user (once, until it recovers, for
  recurring tasks; one-shots surface it as a warn-level completion). Catches silently
  broken tasks instead of letting them log nothing forever. Verified on a no-op task.
- 2026-06-29: Grew the eval suite into a per-capability regression set under
  `data/evals/` (reasoning, memory store/recall, file write/read + append_log,
  shell + write_workbench_file→run→verify, internet + tasks), with a README. `--eval`
  runs them through the live model; verified 10/10 pass.
- 2026-06-29: Added `--backup-workspace` / `--restore-workspace` to JARVIS.sh (mirrors
  the memory backup): tar the workbench `/workspace` volume to
  backups/jarvis-workspace-<ts>.tgz and restore it (or reset to empty). Verified.

- 2026-06-30: Fixed runaway task duplication. A recurring task whose prompt mentioned
  a schedule ("…every 5 minutes") made the model call schedule_task on each run, spawning
  a new task every run (one user request -> dozens of tasks). Now scheduling tools
  (schedule_task/update_task/cancel_task) are EXCLUDED from a task's own toolset
  (`llm.chat({ excludeTools })` filters `toolDefs`), and the task-runner prompt states it
  is one execution of an already-scheduled task and must not create/modify/cancel tasks
  (an "every N minutes" phrase describes the existing schedule, not an instruction).
  Interactive chat is unaffected (it can still create tasks). Verified a task can no
  longer call schedule_task.

- 2026-06-30: Chat readability + LLM-controlled emphasis. User bubbles are now a
  distinct indigo (clearly different from the assistant's teal). Assistant messages
  render a safe markdown subset (**bold**, *italic*, __underline__, `code`, ~~strike~~;
  HTML escaped first, so no XSS). The LLM can flag a message's importance by starting it
  with `[importance: info|success|attention|emergency]` — attention shows a yellow
  border + a brief chat-window flash, emergency a red border + pulse — and it works for
  task post_to_chat messages too. System prompt documents the convention; verified the
  model uses it. Frontend-only (app/public) plus the prompt; refresh the browser.

- 2026-06-30: Fixed semantic memory for local models and made it fully-offline capable
  (memory/server.py). Chain of issues fixed: (1) Mem0 reused `llm.model` for its OpenAI
  extraction call, so a LOCAL chat model name broke it — it now MIRRORS the app's LLM
  endpoint (base_url + model) via the OpenAI-compatible API, overridable with
  `mem0.llm_model`/`mem0.llm_base_url`. (2) Mem0's multi-stage LLM inference (extract →
  decide) is unreliable on reasoning models (qwen3-next), which return empty — so add
  now defaults to `infer=false` (`mem0.infer`), storing the fact directly; the JARVIS
  chat model already decides WHAT to remember, so Mem0's re-extraction was redundant.
  (3) The embedder uses the OpenAI-compatible API so it works against a local Ollama
  endpoint (`/v1/embeddings`) — set `mem0.embed_base_url` + `mem0.embed_model` (e.g.
  `nomic-embed-text`) for FULLY-LOCAL memory (no cloud). Verified local store + recall.
  Also bumped the local setup's `max_tokens` to 4000 — reasoning models can spend ~900
  tokens thinking before answering, so a low cap truncated replies after a tool call.
- 2026-06-30: Validated JARVIS on local models via Ollama — qwen3:8b scored 10/10 on
  the eval suite and qwen3-next:80b passes all capabilities (tool-calling, code, files,
  shell, internet, tasks; memory once the fix above is in). Chat/tools run fully local;
  only Mem0 embeddings use OpenAI unless configured otherwise.

### Notes
- The LLM intentionally has root in the workbench container, open internet access,
  and computer-use control of the desktop; structured data lives in workbench
  DuckDB/SQLite files under /workspace.
- `config.shared` paths are paths INSIDE the container; the host location is set by
  the docker-compose bind mount. Keep the two aligned.
  The stack binds to localhost only; secrets live in the gitignored
  `JARVIS_CONFIG.json` / `JARVIS_SECRETS.json`.
