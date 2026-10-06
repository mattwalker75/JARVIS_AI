# Configuration

All configuration lives in **`config/JARVIS_CONFIG.json`** (gitignored). Copy the template
and edit (or let `./JARVIS.sh --setup` / `--start` create it from the template for you):

```bash
cp config/JARVIS_CONFIG_template.json config/JARVIS_CONFIG.json
```

> The config + secrets files live in **`config/`** (`JARVIS_CONFIG.json`, `JARVIS_SECRETS.json`,
> and their `*_template.json`) to keep the repo root tidy. `./JARVIS.sh --setup`, `--start` and
> `--reload` create either file from its template when it's missing, and keep both (and the
> config's backup copies) **owner-only** — readable by your user account only.

> **If the file can't be read** (a JSON typo, say), JARVIS doesn't guess: the page shows a plain
> sentence naming the problem, every other request is refused, and nothing is saved — so a broken
> file is never overwritten, and the login can't be skipped. Fix the file, then
> `./JARVIS.sh --reload`.

Keys beginning with `_` are documentation-only and ignored by the app.

The **Config tab** has a structured field for **every scalar setting** in this file
(grouped: Model & LLM, Prompts, Behavior, Ollama, Assistant & Voice, Memory, Autopilot,
Workbench & shared folders, Security & housekeeping, Diagnostics), kept in sync with the
raw JSON editor; only the structured blocks (`personas`, `mcp.servers`) are raw-JSON-only.

**Applying changes:** saving from the **Config tab** applies them **live** — the app re-reads
the config on your next message, no restart needed for ordinary settings (endpoint, model, tiers,
temperature, max_tokens, completion_checks, prompts, log level, …). Container-level settings
(network access, the workbench switch, the SearXNG search container) need `./JARVIS.sh --reload`.
The **memory service** (a separate container) only reads its settings — e.g. the embedding key and
the `mem0` block — when *it* starts, and `--reload` doesn't restart it: run
`docker restart jarvis-memory`, or `./JARVIS.sh --stop --start`. If you edit `JARVIS_CONFIG.json`
**by hand** (outside the UI), run `./JARVIS.sh --reload` to pick it up.

> **Two tabs, one file.** The Config tab remembers which version of the files it loaded. If
> something else changed them in the meantime (a header toggle, a secret JARVIS saved, another
> tab), **Save** is refused with a message asking you to reload the tab — instead of silently
> overwriting that change.

> The file is mounted **read-write** so the UI can persist a few settings (see
> [below](#settings-the-ui-can-change)). It's written **in place** (a bind-mounted
> single file can't be atomically replaced), so avoid editing it by hand while the
> app is writing to it.

## Top-level sections

| Section | Purpose |
| --- | --- |
| `assistant_name` | The AI's name — sets its identity (via `{assistant_name}` in the prompt), the UI title, and the voice wake word. |
| `llm` | Model backend, routing, generation params, and system prompt. |
| `ollama` | Local-Ollama tuning — applied by `JARVIS_LOCAL_LLM.sh`; JARVIS core reads only `context_length` (for the context meter). |
| `voice` | Speech-to-text / text-to-speech behavior. |
| `mem0` | Semantic memory service settings. |
| `workbench` | Whether the Linux workbench is used at all (`enabled`), its container name + embedded desktop URL. |
| `shared` | Shared folder paths. |
| `personas` | Optional alternate system prompts. |
| `mcp` | Optional external MCP tool servers. |
| `custom_tools` | Custom-tool loading options. |
| `skills_autohint` | Per-turn skill nudges on/off. |
| `autopilot` | Autonomy mode, default time budget, cycle cap. |
| `ui` | Front-end behavior (stall warning delay). |
| `logging` | Debug log level, rotation, retention. |
| `backups` | Config-backup retention + scheduled memory/workspace backups. |
| `notifications` | External alert bridge (ntfy) for closed-browser notifications. |
| `search` | Web-search backend: DuckDuckGo scrape or the SearXNG sidecar. |
| `security` | The optional login (on/off, session length) and extra allowed `Host`/`Origin` hostnames. |
| `server` | Network access: this computer only, or other devices on your network too. |
| `secret_access_notice` | Chat notice on every `get_secret` read. |
| `memory_auto_recall` | Inject top memory hits into every chat turn (default off). |

## `llm`

```jsonc
"llm": {
  "provider": "ollama",                         // "openai" | "ollama" | "local" | "mock" (offline canned replies); ollama/local = no API key is sent
  "base_url": "",                                // OpenAI-dialect endpoint JARVIS talks to. "" = OpenAI.
  "model": "qwen3-next:80b",                     // used in single-model mode
  "model_mode": "multi",                         // "single" | "multi" | omit to auto-detect
  "models": {                                    // used in multi-model mode
    "chat":   "qwen3-next:80b",                  //   default conversation
    "cheap":  "qwen3-next:80b",                  //   background / scheduled tasks
    "vision": "qwen2.5vl:32b",                   //   auto-selected when an image is analyzed
    "smart":  "qwen3-next:80b"                   //   hard reasoning
  },
  "api_key": "sk-...",                            // your model key (also used by Mem0 for embeddings if cloud)
  "anthropic_api_key": "",                        // optional — only used by the optional LiteLLM gateway (JARVIS_LOCAL_LLM.sh --gateway)
  "gemini_api_key": "",                           // optional — only used by the optional LiteLLM gateway (JARVIS_LOCAL_LLM.sh --gateway)
  "temperature": 0.4,
  "max_tokens": 12000,                            // per-turn cap; keep generous for local reasoning models
  "idle_timeout_ms": 180000,                      // watchdog: abort a MID-STREAM stall (no data for this long)
  "first_token_timeout_ms": 600000,               // watchdog: separate, larger budget for the FIRST token
                                                  //   (prefill on a slow local model with a big context)
  "idle_watchdog": true,                          // default for the 🐕 watchdog toggle (off = patient mode)
  "max_tool_iterations": 15,
  "completion_checks": 2,                          // times to re-verify "is it really done?" before accepting (0 = off)
  "context_window": 0,                            // context-meter ceiling; 0/omit = auto (see below)
  "master_prompt": "",                            // FALLBACK identity prompt (the active one is Prompts/default_master.prompt)
  "system_prompt": "You are {assistant_name}, ..."  // FALLBACK (active one is Prompts/default_system.prompt)
}
```

### The endpoint (`base_url`)
JARVIS is a pure OpenAI-dialect client — it POSTs to whatever `base_url` points at and
does **not** host or manage models. It no longer defaults to an in-stack gateway. Set it to:

- a **cloud provider** — e.g. `https://api.openai.com/v1` (with `api_key`). Empty (`""`)
  falls back to OpenAI.
- the URL **`JARVIS_LOCAL_LLM.sh` prints** for a local runtime — Ollama direct (e.g.
  `http://host.docker.internal:11434/v1`), or its optional LiteLLM gateway
  (`http://host.docker.internal:4000/v1`) with `--gateway`. See
  [CLI → `JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime).

The tool-use, planner, and coding guidance is appended to every prompt automatically, so
`system_prompt` only needs the behavior/identity. The **active** master + system prompts live
in editable files under `Prompts/` (see [Prompts & Context](prompts.md)); the `llm.*_prompt`
values are used only if those files are absent.

### Model tiers
Each tier in `models` names a model your endpoint serves — an Ollama tag, a cloud model
name, or a `model_name` from `litellm/config.yaml` if you front it with the gateway. The
app picks a tier per task:
- **chat** — normal conversation (also the header model switcher target),
- **cheap** — scheduled/background task runs,
- **vision** — used by the screenshot/image "look" step (must be vision-capable),
- **smart** — reserved for hard reasoning.

An omitted tier falls back to `chat`, then to `model`. In **single** mode, every tier
uses `model`.

A tier may also be an **object** carrying per-tier generation overrides:

```jsonc
"models": {
  "chat":  "qwen3.6:35b",
  "smart": { "model": "qwen3:32b", "temperature": 0.2, "max_tokens": 8000 }
}
```
`temperature` / `max_tokens` in the object beat the global `llm.*` values for that tier
only. The Config-tab pickers edit the `model` and preserve the params.

Related: **`llm.smart_routing`** (default `true`) automatically routes judgment-heavy
turns to the `smart` tier — plan-mode chat turns, and Autopilot's planning + wrap-up
cycles. A no-op when no smart tier is configured.

### Model failover (optional)

```jsonc
"llm": {
  "failover": {
    "enabled": false,
    "model": "",       // required to enable — e.g. "qwen3:8b" or "gpt-4o-mini"
    "base_url": "",    // empty = same endpoint; or a different one (e.g. OpenAI while Ollama is down)
    "api_key": ""      // only used with a different base_url
  }
}
```
When the primary fails **hard** — endpoint down, repeated 5xx after retries, or a
stalled stream — the **rest of that turn** runs on the fallback, the chat shows an
⚡ notice, and the next turn tries the primary again. Key hygiene: with a different
`base_url`, only `failover.api_key` is ever sent there — the primary key never leaves
its own endpoint (regression-tested).

### The context window (`context_window`)
A number here wins. With `0` (or no key), JARVIS works it out:

- talking **straight to Ollama** (`provider` `"ollama"` / `"local"`, or a `base_url` on port
  `11434`) → `ollama.context_length`, the window Ollama actually loads the model with;
- anything else (the LiteLLM gateway, a cloud provider) → it asks the endpoint's `/model/info`;
- if neither answers → **32768**.

### Context-size discipline

```jsonc
"llm": {
  "history_token_budget": 16000,   // cap on the chat history sent per turn (~4 chars/token; 0 = 40-msg cap only)
  "turn_compaction_chars": 60000   // once ONE turn's tool results exceed this, older results are elided (0 = off)
}
```
Long tool chains and paste-heavy histories are the two ways a local model's prefill
balloons; these keep both bounded. The UI adds **`ui.auto_compact_pct`** (default 85,
0 = never): when the context meter reaches that %, Summarize-&-continue runs
automatically instead of waiting for the 🗜 button.

### Tier grouping in the Config pickers
In multi-model mode the Config tab's `chat` / `cheap` / `smart` / `vision` dropdowns are
**grouped by capability**: models that fit the tier appear in a "★ *tier* — recommended"
optgroup on top, everything else under "Other models", and non-chat models
(embeddings / TTS / whisper / dall-e / transcribe) are dropped — so the **vision** picker
surfaces vision models, **smart** surfaces reasoning models, etc. Grouping only **orders** the
list; you can still pick **any** model in **any** tier, plus a **✎ Custom…** option to type one
by hand.

The grouping is driven by a **user-maintained catalog at `app/public/models.json`**, matched by
**longest name-prefix** (so `gpt-4.1` also matches `gpt-4.1-2025-04-14`; a model may sit in
several buckets). Anything your endpoint lists that isn't in the file falls back to a name
heuristic. Edit `models.json` and refresh to keep it current as providers ship models;
**`MODELS.md`** (repo root) is the human-readable companion reference for which models fit which
tier. See [Extending → Models & providers](extending.md#models--providers).

### Mixing local + cloud
To fan out one endpoint across several providers, point `base_url` at the LiteLLM gateway
(`JARVIS_LOCAL_LLM.sh --gateway`) and mix `model_name`s from `litellm/config.yaml`:

```jsonc
"models": {
  "chat":   "qwen3-next:80b",       // local, fast, free
  "smart":  "claude-sonnet-4-6",    // cloud, for hard problems  (needs anthropic_api_key)
  "vision": "qwen2.5vl:32b",        // local vision
  "cheap":  "qwen3:8b"              // small local for background tasks
}
```

### Talking straight to one backend
If you don't need multi-provider routing, skip the gateway and point `base_url` directly
at the runtime (this is what `JARVIS_LOCAL_LLM.sh start` without `--gateway` prints):
```jsonc
"base_url": "http://host.docker.internal:11434/v1"   // Ollama directly
"base_url": "https://api.openai.com/v1"              // OpenAI directly
```

## `ollama` (optional)

```jsonc
"ollama": {
  "manage": true,              // false = leave your Ollama install untouched
  "context_length": 65536,     // OLLAMA_CONTEXT_LENGTH
  "keep_alive": "-1",          // OLLAMA_KEEP_ALIVE (-1 = keep model resident)
  "num_parallel": 1,           // OLLAMA_NUM_PARALLEL
  "max_loaded_models": 3       // OLLAMA_MAX_LOADED_MODELS
}
```

This block is applied by **`JARVIS_LOCAL_LLM.sh`** (the local-LLM helper), not by
`JARVIS.sh --reload`: on `./JARVIS_LOCAL_LLM.sh start` it sets these as `OLLAMA_*` settings and
restarts Ollama so they take effect (macOS). JARVIS core reads just one of them —
`context_length`, as the context meter's ceiling when it talks straight to Ollama (see
[the context window](#the-context-window-context_window)). Cloud-only setups can
ignore it. See [CLI → `JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime).

## MLX (Apple Silicon) — no config block

MLX has **no entry in `JARVIS_CONFIG.json`.** It's **discovery-based, like Ollama**: you bring models
online from the CLI and the script finds them. Bring a model up with
`./JARVIS_LOCAL_LLM.sh mlx-serve <model>` (each runs its own `mlx_lm.server` on its own port, so
several stay hot at once), then `start --backend mlx --gateway`. See
[CLI → MLX backend](cli.md#mlx-backend-apple-silicon) for the full flow (`mlx-serve` / `mlx-stop` /
`mlx-ls` / `mlx-up`). First run: `source ./ACTIVATE.sh` to create the venv + install `mlx-lm`.

## `voice`

```jsonc
"voice": {
  "enabled": true,
  "tts": true,                      // speak replies
  "stt": true,                      // accept speech input
  "mic_mode": "off",                // "off" | "wake" | "open" (persisted from the UI)
  "stt_engine": "browser",          // speech input: "browser" (streaming; needed for wake/open) | "local" (whisper push-to-talk)
  "silence_timeout_seconds": 12,    // wake mode: sleep after this much silence
  "followup_seconds": 0,            // wake mode: reply without the wake word for N s AFTER it stops talking (0 = off)
  "ambient_style": "face",          // the voice-mode avatar: "face" | "orb" (persisted from the UI)
  "wake_word": "jarvis",            // optional; defaults to assistant_name
  "stop_phrase": "jarvis stop listening",
  "tts_engine": "browser",          // "browser" (OS/Chrome voices) | "piper" (offline neural)
  "tts_voice": "",                  // engine-specific voice id ("" = auto)
  "tts_rate": 1.0,                  // 0.5–2.0 speaking speed (both engines)
  "tts_pitch": 1.0                  // 0.5–2.0 pitch (browser engine only)
}
```
`tts_engine: "piper"` uses the offline neural voice from the `jarvis-piper` container —
free, fully local, and machine-independent. See [Voice](voice.md#neural-voice-piper) for
the engine comparison and how to add voices.

## `mem0`

```jsonc
"mem0": {
  "url": "http://jarvis-memory:8000",
  "user_id": "default",
  "infer": false,                                  // false = store facts directly (fast, model-agnostic)
  "embed_model": "nomic-embed-text",               // embedder (SEPARATE from the chat model)
  "embed_base_url": "http://host.docker.internal:11434/v1"   // Ollama /v1 for local embeddings
}
```
For a cloud embedder, drop `embed_base_url` and set `embed_model` to e.g.
`text-embedding-3-small` (uses `llm.api_key`). Switching embedders creates a fresh,
namespaced Chroma collection — see [Memory](memory-and-scheduling.md).

Optional overrides: `llm_model` / `llm_base_url` point Mem0's own extraction LLM
somewhere other than the app's `llm.base_url`/`model` (only used with `infer: true`),
and `infer: true` re-enables Mem0's LLM extraction/dedup stages.

## `workbench` and `shared`

```jsonc
"workbench": {
  "enabled": true,            // false = run JARVIS without the Linux workbench (see below)
  "container": "jarvis-workbench",
  "desktop_url": "http://localhost:8111/",
  "base_image": ""            // workbench build base — "" = the floating default tag
},
"shared":    { "read_only_dir": "/LLM_READ_ONLY_FILES", "read_write_dir": "/LLM_READ_WRITE_FILES" }
```

### Running without the workbench (`workbench.enabled`)

The workbench is the heaviest container and is only needed for software development, deep
research and automation. Turn it off in **Config → Workbench & shared folders → Use the
Linux workbench** (or set `"enabled": false`; a missing key means on). The switch applies on
**Save**:

| With the workbench off | |
| --- | --- |
| Container | Stopped on Save (and started again when you turn it back on). `./JARVIS.sh --start`, `--reload` and `--update` leave it stopped; `--setup` skips building its image. |
| Model tools | Withheld: `run_shell`, `write_workbench_file`, `edit_workbench_file`, `serve_app`, every `browser_*` tool, the desktop tools (`screenshot`, `ui_actions`, `open_url`, `open_app`, `click`, `type_text`, …), `read_document` (PDF/Office) and `transcribe_audio`. The system prompt tells the model the workbench is off, and the workbench skill playbooks are not listed. |
| Still works | Chat, long-term memory, `web_search` / `fetch_url`, the shared folders (`list_dir`, `read_file`, `write_file`, `edit_file`), `analyze_image`, email, the vault, scheduled tasks, plans, custom tools and MCP servers. |
| Web UI | The **Workbench** tab is hidden; the *local (whisper)* speech engine is unavailable (the browser engine is used); the self-test skips the workbench and desktop checks. |
| Backups | The automatic backup skips the workspace half (it is archived from inside the workbench). `./JARVIS.sh --backup-workspace` still works — it reads the host folder. |

Nothing is deleted: the workbench image, its home volume and `LLM_WORKSPACE/` stay as they
are. If the workbench was never built (a fresh install with it off), turning it on later needs
one `./JARVIS.sh --reload` to create the container — the first build takes several minutes.
The line under the switch shows what the container is doing.

`base_image` makes the workbench's base **configurable and pinnable**: it's read by
`./JARVIS.sh --setup` and passed to the image build. Empty uses the floating
`lscr.io/linuxserver/webtop:ubuntu-xfce` tag; for **reproducible rebuilds** pin the
digest of an image you know works:

```bash
docker inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce
# → set "base_image": "lscr.io/linuxserver/webtop@sha256:<digest>"
```

## `personas` (optional)

Alternate system prompts, switchable per conversation with `/persona`:

```jsonc
"personas": {
  "work":  { "system_prompt": "You are JARVIS in work mode. Be concise and formal." },
  "brief": { "append": "Always answer in 2 sentences or fewer." }
}
```
- `system_prompt` fully replaces the base prompt; `append` adds to it.
See [Extending](extending.md#personas).

## `mcp` (optional)

Plug in external [MCP](https://modelcontextprotocol.io/) tool servers (HTTP transport):

```jsonc
"mcp": {
  "servers": [
    { "name": "github", "url": "http://host.docker.internal:9300/mcp",
      "headers": { "Authorization": "Bearer ..." } }
  ]
}
```
Each server's tools register as `mcp_<server>_<tool>`. See [Extending](extending.md#mcp-servers).

## `skills_autohint` (optional)

```jsonc
"skills_autohint": true
```
When `true` (the default), each turn keyword-matches your message against the
[skills](extending.md#skills) and, if one looks relevant, injects a one-line nudge
("`get_skill('data-analysis')` has a playbook for this…") right before your message.
It's a cheap backstop — the model may or may not act on it (a confident local model
often proceeds directly). Toggle it live from the UI with `/hints on|off`, or set it
`false` here to disable. See [Extending → Skills](extending.md#skills).

## `autopilot` (optional)

```jsonc
"autopilot": {
  "autonomy": "guarded",   // "guarded" (default) | "full" — see docs/autopilot.md
  "default_minutes": 30,   // time budget prefilled in the launcher
  "max_cycles": 100        // safety cap on build/test iterations
}
```
See [Autopilot & the Planner](autopilot.md).

## `ui` (optional)

```jsonc
"ui": { "stall_seconds": 25, "auto_compact_pct": 85 }   // stall warning delay · auto-compaction threshold (0 = never)
```

## `logging` (optional)

```jsonc
"logging": {
  "level": 0,          // 0 off … 3 info, 4 verbose (tool args/results), 5 debug (full LLM req/resp)
  "max_mb": 50,        // roll the day's file to jarvis-<day>.N.log past this size
  "retain_days": 14    // delete log files older than this (checked at startup and once a day after)
}
```
Read live — change `level` from the Config tab and it applies immediately. Secrets are redacted —
also when they appear JSON-escaped or base64-encoded inside a logged request.

## `backups` (optional)

```jsonc
"backups": {
  "retain": 10,                                        // newest N config/secrets backups in data/ (0 = keep everything)
  "auto": { "enabled": false, "every_hours": 24, "keep": 7 }   // scheduled memory + workspace backups
}
```
Before every save from the Config tab, the previous `JARVIS_CONFIG.json` /
`JARVIS_SECRETS.json` is copied to `data/<name>.backup.<timestamp>.json`. Each config
backup contains the live `api_key`, so the pile is pruned to the newest `retain`
per file on every new backup.

**`auto`** additionally backs up the two things `--delete` would wipe — the semantic
**memory volume** and **`/LLM_WORKSPACE`** — on a schedule, from inside the app (tar
streamed out of the containers into `data/backups/`, which survives `--delete`). The
newest `keep` tarballs are kept per kind, a notification reports each run, and
**💾 Back up now** in Config → Diagnostics (or `POST /api/backup/run`) triggers the
same pair on demand. Only one backup runs at a time (pressing it while one is running says
"A backup is already running…"), each part is stopped if it takes longer than 10 minutes, and
a new backup never overwrites an existing file.

## `notifications` (optional)

```jsonc
"notifications": { "ntfy_url": "", "min_level": "info" }
```
An external bridge so alerts reach you with the browser **closed**: point `ntfy_url` at
an [ntfy](https://ntfy.sh) topic (public ntfy.sh with a hard-to-guess topic name, or
self-hosted) and subscribe to it in the ntfy phone app — every `notify_user` /
scheduled-task / Autopilot notification is POSTed there with a mapped priority.
`min_level` filters what leaves the machine (`info` = everything, `warning`, `error`).
Empty URL = off.

## `security` and `server` (optional) — who can open JARVIS

```jsonc
"security": { "login_enabled": false, "session_hours": 12, "allowed_hosts": [] },
"server":   { "allow_network": false }
```

All of this is in **Config → Access & users**.

| Key | Default | Applies | Meaning |
| --- | --- | --- | --- |
| `server.allow_network` | `false` | `./JARVIS.sh --reload` | `false`: the chat UI's port is published on `127.0.0.1` — only this computer can open it. `true`: published on every interface, so other devices on your network (or VPN) can. The workbench desktop (`:8111`) and the preview ports **always stay on this computer** — they have no login. |
| `security.login_enabled` | `false` | at once | Everyone signs in. Change it with the buttons in the Config tab (not by hand, and the full-config editor never changes it): *Turn the login on…* then asks for the first login name and password; *Turn the login off…* removes every user and password. |
| `security.session_hours` | `12` | new sign-ins | How long you stay signed in (1–720). |
| `security.allowed_hosts` | `[]` | at once | Other names this computer is reached by that JARVIS should answer to, e.g. a Tailscale name `["jarvis.tail1234.ts.net"]`. |
| `security.password_file` | `/data/.password` | at once | Where the passwords are kept, as a path **inside the app container** (`/data` is the `data/` folder next to `JARVIS.sh`). Only editable by hand. |

**Users.** With the login on, *Access & users* lists the users. Every user can add a user,
reset another user's password, change their own, and remove another user. **Everything in
JARVIS is shared** — chats, memory, tasks, files, settings and the vault (the Config tab shows
API keys and vault entries to any signed-in user). A login only decides who may open JARVIS,
so only give one to someone you would trust with all of it.

**Passwords** need at least 8 characters and are stored as salted scrypt hashes in
`data/.password` (owner-only): `{"users": [{"loginName": "…", "passwordHash": "scrypt$…"}]}`.
Forgot one? Another user resets it. If nobody can sign in, **delete `data/.password` and reload
the page** — you create one login again and add the others back; nothing else is touched.
A restart or `--reload` signs everyone out (the session key is new at every start), and removing
a user or changing a password ends that user's sessions.

**The terminal client** (`./JARVIS.sh --terminal`, `--prompt`) runs on this computer, inside the
app container, and needs no login.

**The Host/Origin guard** is always on: every REST and WebSocket request must carry a `Host`
(and, when a browser sends one, a same-site `Origin`) that names this computer, or it is rejected
with 403 — this blocks CSRF and DNS-rebinding attacks from websites you visit. Localhost names
always pass. While network access is on, so do private-network IP addresses (10/8, 172.16/12,
192.168/16, the 100.64/10 range Tailscale uses) and this computer's own name. Any other name —
a Tailscale `…ts.net` name, a reverse proxy — goes in `security.allowed_hosts`.

> **Network on, login off** means anyone on your network can use JARVIS: run commands in the
> workbench, read your files and the vault, spend your model key. The Config tab and
> `./JARVIS.sh --start` both warn about it. Traffic is plain HTTP either way — use a network you
> trust (a VPN such as Tailscale encrypts it for you).

## `secret_access_notice` (optional)

```jsonc
"secret_access_notice": true   // default
```
When the model reads a credential with `get_secret`, a 🔑 notice is posted into the
live chat so vault access is always visible in the moment (the audit log records it
regardless). Set `false` to silence the notices.

## `search` (optional)

```jsonc
"search": { "provider": "duckduckgo", "searxng_url": "http://jarvis-searxng:8080" }
```
The `web_search` tool's backend. **`duckduckgo`** (default) scrapes DuckDuckGo's HTML —
zero setup, but rate-limit-prone and parser-fragile. **`searxng`** uses the optional
self-hosted [SearXNG](https://docs.searxng.org/) sidecar: a real JSON metasearch API
across many engines. `./JARVIS.sh --start` (and `--reload`) bring the container up when
selected (compose profile `search`; settings in `searxng/settings.yml`), and
`web_search` **falls back to DuckDuckGo** if the sidecar is unreachable. So after switching to
`searxng`, run `./JARVIS.sh --reload` once to start the container; switching back to
`duckduckgo` needs nothing (the idle container is stopped by the next `--stop`).

## `custom_tools` (optional)

```jsonc
"custom_tools": { "allow_model_authored": false }
```
Tools in `data/custom_tools/*.js` always load. Setting `allow_model_authored: true`
**also** loads `/LLM_READ_WRITE_FILES/custom_tools/*.js` — letting JARVIS write its own
tools. That's an escalation path (model-authored code runs in the app container), so
it's **off by default**. See [Extending](extending.md#custom-tools).

## Settings the UI can change

These can be changed from the web UI (voice toggles, mic mode, avatar style, model switcher)
and are persisted back to `JARVIS_CONFIG.json` via `POST /api/settings`, gated by an
allowlist:

```
voice.tts   voice.stt   voice.enabled   voice.mic_mode   voice.silence_timeout_seconds
voice.followup_seconds   voice.ambient_style   voice.tts_engine   voice.tts_voice
voice.tts_rate   voice.tts_pitch   voice.stt_engine
llm.model   llm.models.chat   llm.temperature   llm.max_tokens   assistant_name
skills_autohint
```

Each value's type is checked (on/off switches must be true/false, numbers must be numbers,
`llm.max_tokens` above 0, text under 500 characters) — a wrong one is refused and nothing is
saved. The header model switcher (`llm.models.chat`) sets `llm.model` in **single** mode
(so it never flips you into multi mode), and in multi mode changes only the tier's model,
keeping a tier object's other overrides.

Anything not on this list (notably `api_key` and other secrets) **cannot** be written
through the settings endpoint. The Config tab's **full editor** is a different route
(`POST /api/config/full`): it rewrites the whole `JARVIS_CONFIG.json` and/or
`JARVIS_SECRETS.json` (keys included), backing each file up first — see [API](api.md).
