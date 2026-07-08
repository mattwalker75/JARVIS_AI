# Changelog

All notable changes to JARVIS are tracked here.

This project follows a Keep a Changelog-style format. Keep the `[Unreleased]`
section current with concise notes about user-facing, operational,
infrastructure, security, documentation, or test-policy changes.

## [Unreleased]

### Added
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
