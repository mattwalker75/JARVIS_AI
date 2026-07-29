# Configuration

All configuration lives in **`JARVIS_CONFIG.json`** (gitignored). Copy the template
and edit:

```bash
cp JARVIS_CONFIG_template.json JARVIS_CONFIG.json
```

Keys beginning with `_` are documentation-only and ignored by the app.

**Applying changes:** saving from the **Config tab** applies them **live** — the app re-reads
the config on your next message, no restart needed for ordinary settings (endpoint, model, tiers,
temperature, max_tokens, completion_checks, prompts, log level, …). A restart (`./JARVIS.sh
--reload`, or `--stop --start`) is only needed for the memory service's embedding key (a separate
container) and container-level settings like ports. If you edit `JARVIS_CONFIG.json` **by hand**
(outside the UI), run `./JARVIS.sh --reload` to pick it up.

> The file is mounted **read-write** so the UI can persist a few settings (see
> [below](#settings-the-ui-can-change)). It's written **in place** (a bind-mounted
> single file can't be atomically replaced), so avoid editing it by hand while the
> app is writing to it.

## Top-level sections

| Section | Purpose |
| --- | --- |
| `assistant_name` | The AI's name — sets its identity (via `{assistant_name}` in the prompt), the UI title, and the voice wake word. |
| `llm` | Model backend, routing, generation params, and system prompt. |
| `ollama` | Local-Ollama tuning — read by `JARVIS_LOCAL_LLM.sh`, not by JARVIS core. |
| `voice` | Speech-to-text / text-to-speech behavior. |
| `mem0` | Semantic memory service settings. |
| `workbench` | Workbench container name + embedded desktop URL. |
| `shared` | Shared folder paths. |
| `personas` | Optional alternate system prompts. |
| `mcp` | Optional external MCP tool servers. |
| `custom_tools` | Custom-tool loading options. |

## `llm`

```jsonc
"llm": {
  "provider": "ollama",                         // "openai" | "ollama" | "mock" (offline canned replies)
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
  "idle_timeout_ms": 120000,                      // watchdog: abort a stream that sends no data for this long
  "idle_watchdog": true,                          // default for the 🐕 watchdog toggle (off = patient mode)
  "max_tool_iterations": 15,
  "completion_checks": 2,                          // times to re-verify "is it really done?" before accepting (0 = off)
  "context_window": 0,                            // context-meter ceiling; 0/omit = auto (Ollama num_ctx / gateway /model/info)
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

This block is read by **`JARVIS_LOCAL_LLM.sh`** (the local-LLM helper) — **not** by
JARVIS core or `JARVIS.sh --reload`. On `./JARVIS_LOCAL_LLM.sh start` it applies these as
`OLLAMA_*` settings and restarts Ollama so they take effect (macOS). Cloud-only setups can
ignore it. See [CLI → `JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime).

## `voice`

```jsonc
"voice": {
  "enabled": true,
  "tts": true,                      // speak replies
  "stt": true,                      // accept speech input
  "mic_mode": "off",                // "off" | "wake" | "open" (persisted from the UI)
  "silence_timeout_seconds": 12,    // wake mode: sleep after this much silence
  "followup_seconds": 0,            // wake mode: reply without the wake word for N s AFTER it stops talking (0 = off)
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

## `workbench` and `shared`

```jsonc
"workbench": { "container": "jarvis-workbench", "desktop_url": "http://localhost:8111/" },
"shared":    { "read_only_dir": "/READ_ONLY_FILES", "read_write_dir": "/READ_WRITE_FILES" }
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
"ui": { "stall_seconds": 25 }   // how long with no streamed progress before the "model is slow" warning
```

## `logging` (optional)

```jsonc
"logging": {
  "level": 0,          // 0 off … 3 info, 4 verbose (tool args/results), 5 debug (full LLM req/resp)
  "max_mb": 50,        // roll the day's file to jarvis-<day>.N.log past this size
  "retain_days": 14    // delete log files older than this on startup
}
```
Read live — change `level` from the Config tab and it applies immediately. Secrets are redacted.

## `custom_tools` (optional)

```jsonc
"custom_tools": { "allow_model_authored": false }
```
Tools in `data/custom_tools/*.js` always load. Setting `allow_model_authored: true`
**also** loads `/READ_WRITE_FILES/custom_tools/*.js` — letting JARVIS write its own
tools. That's an escalation path (model-authored code runs in the app container), so
it's **off by default**. See [Extending](extending.md#custom-tools).

## Settings the UI can change

These can be changed from the web UI (voice toggles, mic mode, model switcher) and
are persisted back to `JARVIS_CONFIG.json` via `POST /api/settings`, gated by an
allowlist:

```
voice.tts   voice.stt   voice.enabled   voice.mic_mode   voice.silence_timeout_seconds
voice.followup_seconds   voice.tts_engine   voice.tts_voice   voice.tts_rate   voice.tts_pitch
llm.model   llm.models.chat   llm.temperature   llm.max_tokens   assistant_name
skills_autohint
```

Anything not on this list (notably `api_key` and other secrets) **cannot** be written
through the settings endpoint.
