# Running models locally

JARVIS core is a pure **OpenAI-dialect client** — it talks to whatever URL is in `llm.base_url`
and does **not** host or manage models. To run a model on your own machine, a host-side helper
(**[`JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime)**) manages the runtime
and prints an endpoint URL that you paste into **JARVIS → Config → Endpoint URL**.

> **Why host-side?** Local runtimes need direct hardware access (Ollama's server / Apple's Metal),
> so they run natively on the **host**, not inside the JARVIS containers. The app reaches them over
> `host.docker.internal`. Cloud users skip all of this — just point `base_url` at the provider.

There are **two backends** today (a third, the optional LiteLLM gateway, unifies them):

| | **Ollama** | **MLX** |
| --- | --- | --- |
| Best for | Easiest; broad model library | Apple Silicon — more speed/efficiency per Mac |
| Platform | macOS / Linux / Windows | macOS on Apple Silicon only |
| Install | standalone app | Python venv (`source ./ACTIVATE.sh`) |
| Get models | `ollama pull <tag>` | Hugging Face `mlx-community` (auto-downloads) |
| Serving | **one daemon, many models** (swaps on demand) | **one server per model** (a process per port) |
| Models stored in | `~/.ollama/` (system-wide) | `mlx/models/` (in the repo, gitignored) |
| Vision | ✅ (e.g. `qwen2.5vl`) | ❌ text-only (use Ollama for vision) |
| Pick in JARVIS | the Ollama **tag** (`qwen3:8b`) | the **model id** (`mlx-community/…`) via gateway, or the `:port` direct |

Either backend has a built-in setup guide:

```bash
./JARVIS_LOCAL_LLM.sh config --backend ollama
./JARVIS_LOCAL_LLM.sh config --backend mlx
```

## The mental model

```
  (host)                                   (docker)
  ┌─ Ollama :11434  ─┐                      ┌───────────────┐
  │  or              │  host.docker.internal │  jarvis-app   │
  ├─ MLX  :8080…     ├──────────────────────►│  (Config →    │
  │  or              │   /v1  (OpenAI dialect)│   Endpoint URL)│
  └─ LiteLLM :4000 ──┘                      └───────────────┘
       (optional, fronts several as ONE endpoint)
```
`JARVIS_LOCAL_LLM.sh` starts/configures the host runtime and prints the URL; you paste it into Config.

---

## Option 1 — Ollama

**1. Install** — <https://ollama.com/download/mac> (or `/download` for other OSes); check `ollama --version`.

**2. Pull models** — the tag becomes the model name you set in JARVIS:
```bash
ollama pull qwen3:8b          # chat
ollama pull qwen2.5vl:32b     # vision (for screenshots / the vision tier)
ollama list                   # what you have
```

**3. (optional) Tune** the runtime in the `ollama` block of `config/JARVIS_CONFIG.json`
(context length, keep-alive, parallelism, max resident models) — see
[Configuration → `ollama`](configuration.md#ollama-optional). macOS applies these via `launchctl`.

**4. Start + get the URL:**
```bash
./JARVIS_LOCAL_LLM.sh start          # → http://host.docker.internal:11434/v1
```

**5. Point JARVIS at it** — paste that URL into **Config → Endpoint URL**, set the model (single
mode) or the chat/cheap/smart/vision tiers (multi mode) to your Ollama tags, then **Save**.

> Ollama's own daemon routes many models by name, so **you don't need the gateway** for pure-Ollama
> multi-model — just set each tier to a pulled tag.

---

## Option 2 — MLX (Apple Silicon)

MLX runs models natively on the Mac host via `mlx-lm`'s OpenAI-compatible server. Everything lives
under `mlx/` (a dedicated Python venv + a model cache).

**1. Activate the environment** (first run creates the venv + installs `mlx-lm`):
```bash
source ./ACTIVATE.sh          # sets HF_HOME → mlx/models ; leave with: source ./DEACTIVATE.sh
```

**2. Pick / download models** — from Hugging Face's **[`mlx-community`](https://huggingface.co/mlx-community)**
org (pre-quantized; `-4bit` variants suit most Macs). They **auto-download on first serve** into
`mlx/models/`, or pre-fetch:
```bash
hf download mlx-community/Qwen2.5-7B-Instruct-4bit    # into mlx/models/
mlx_lm.generate --model <repo> --prompt "hi"          # fetch + quick test
mlx_lm.manage --scan                                  # list cached ; --delete to remove
```

**3. Bring model(s) online** — MLX is **discovery-based, like Ollama** (no config array): each model
runs as its own `mlx_lm.server` on its own port, so several stay **hot at once** (no reload when JARVIS
switches tiers — ideal if you have the RAM). The script then discovers what's running.
```bash
./JARVIS_LOCAL_LLM.sh mlx-serve mlx-community/Qwen2.5-7B-Instruct-4bit          # auto-assigns a port (8080+)
./JARVIS_LOCAL_LLM.sh mlx-serve mlx-community/Qwen2.5-32B-Instruct-4bit --port 8081
./JARVIS_LOCAL_LLM.sh mlx-ls                                                    # what's running
./JARVIS_LOCAL_LLM.sh mlx-stop <model|port|all>                                 # take one/all offline
```
`mlx-serve` records what you started in `mlx/serving.json`, so **`mlx-up`** relaunches your set after a
reboot. (It's auto-written — not a hand-edited config.)

**4. Wire it into JARVIS + get the URL:**
```bash
./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway   # discovers running servers → ONE URL via LiteLLM
./JARVIS_LOCAL_LLM.sh start --backend mlx             # single server → its :port URL (no gateway)
./JARVIS_LOCAL_LLM.sh status                          # Ollama + running MLX servers + gateway
```

**5. Point JARVIS at it** — Endpoint URL = the printed URL, then **List models**. Multiple models
(`--gateway`): each shows by its real **id** (`mlx-community/…`, like an Ollama tag) — set the model
(single mode) or the chat/cheap/smart tiers (multi mode) to those ids. Single model: point Endpoint URL
straight at its `:port`.

> **Reboot recovery:** MLX servers aren't a daemon, so after a restart run `./JARVIS_LOCAL_LLM.sh mlx-up`
> (relaunches your registered set) — or `mlx-serve` them again.
> **Tool-calling:** JARVIS is tool-heavy; verify a model emits clean tool calls (JARVIS's text-tool
> salvage is the fallback). **Vision:** `mlx-lm` is text-only — keep vision on Ollama.

---

## Multiple models & the LiteLLM gateway

JARVIS points at **one** endpoint. If all your local models are Ollama tags, Ollama already routes
them — done. You need the **gateway** when you want several models (or **mixed runtimes**, e.g. chat
on Ollama + a reasoning model on MLX) behind **one** endpoint:

```bash
./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway    # → http://host.docker.internal:4000/v1
```

The gateway (LiteLLM) lives in a standalone `litellm/docker-compose.yml` started by this script
(not `JARVIS.sh`); routing is configured in `litellm/config.yaml`. See
[CLI → the gateway](cli.md#jarvis_local_llmsh--local-model-runtime).

### The model list stays in sync (no stale entries)

A gateway advertises whatever is written in its config file — so a hand-maintained list drifts out of
sync with what's actually installed. To prevent that, `litellm/config.yaml` has an **auto-managed
block** (between `BEGIN local routes` / `END local routes` markers) that is **regenerated from the live
backend** every time you run `start --gateway` — or on demand with **`gateway-sync`**:

```bash
./JARVIS_LOCAL_LLM.sh start --backend ollama --gateway   # local block = your installed `ollama list`
./JARVIS_LOCAL_LLM.sh start --backend mlx    --gateway   # local block = the MLX servers that are UP
./JARVIS_LOCAL_LLM.sh gateway-sync --backend ollama      # just refresh + reload (no full restart)
```

The selected `--backend` **owns** that block: Ollama contributes one route per installed tag (all →
`:11434`, embeddings skipped); MLX probes **each** model's port and contributes a route only for the
servers actually answering (each → its own port). **Cloud routes above the marker are never touched** —
those are your deliberate choices (enabling `claude-sonnet` etc. is a decision, not something to
auto-discover), and they only work once you export the matching API key. So after a sync, "List models"
in the Config tab shows exactly your live local models **plus** whatever cloud routes you chose to keep.

Conversely, **`stop` empties that block** — once the runtime is down the gateway shouldn't advertise
models it can't reach, so the local routes are removed (a still-running gateway is reloaded so it drops
them immediately, or taken down if nothing is left to serve). The next `start --gateway` repopulates it
from live models.

> **The gateway is for local models.** For **cloud** models you don't need it at all — point JARVIS
> straight at the provider (`api.openai.com`, etc.) in **single mode**. `litellm/config.yaml` therefore
> ships with **no cloud routes**, so its model list is purely your local models — no phantom
> Claude/GPT/Gemini entries.

### Mixing a cloud model into the gateway (optional)

The one case for putting a cloud model *in the gateway* is a **single endpoint serving local + cloud
tiers in multi mode** — e.g. chat on a local Ollama model, smart-tier on Claude, all via `:4000`. To do
that, add a route **above** the `BEGIN local routes` marker (the managed block only touches what's
between the markers):

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  # >>> BEGIN local routes — AUTO-GENERATED ... >>>
  # <<< END local routes <<<
```

Put the key in `JARVIS_CONFIG.json` (`llm.anthropic_api_key` → `ANTHROPIC_API_KEY`, `llm.api_key` →
`OPENAI_API_KEY`, `llm.gemini_api_key` → `GEMINI_API_KEY`); `JARVIS_LOCAL_LLM.sh` exports it into the
gateway on `--gateway` startup. Then set the relevant tier's model to `claude-sonnet-4-6`.

---

## Command reference

See **[CLI → `JARVIS_LOCAL_LLM.sh`](cli.md#jarvis_local_llmsh--local-model-runtime)** for the full
table (`start` / `stop` / `status` / `url` / `config`, `--backend`, `--gateway`).

## Troubleshooting

- **App can't reach the model** — confirm the runtime is up from the host (`curl localhost:11434/api/tags`
  or `curl localhost:8080/v1/models`). The app reaches it via `host.docker.internal`; on Linux the
  app container maps that host (see `extra_hosts` in `docker-compose.yml`).
- **"model not found"** — the name in JARVIS must match exactly: a **pulled Ollama tag**, or an
  entry in `litellm/config.yaml` (via the gateway), or the served MLX model.
- **MLX first request is slow** — it's downloading the model into `mlx/models/`; pre-fetch (step 2).
- **Reset MLX** — `rm -rf mlx/models` to reclaim disk; `rm -rf mlx/venv` (then `source ./ACTIVATE.sh`)
  to rebuild the environment.
