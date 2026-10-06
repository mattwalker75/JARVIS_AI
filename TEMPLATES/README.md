# JARVIS config & secrets templates

Ready-to-use example configurations for different model setups. Each
`JARVIS_CONFIG.*.json` is a **complete, copy-paste-ready** config (full system prompt
and all sections included) — only the `llm` block differs between them.

## How to use

```bash
# from the repo root:
cp TEMPLATES/JARVIS_CONFIG.single-openai.json   config/JARVIS_CONFIG.json
cp TEMPLATES/JARVIS_SECRETS.empty.json          config/JARVIS_SECRETS.json   # optional (see below)
# edit config/JARVIS_CONFIG.json -> fill in your api_key(s)
./JARVIS.sh --start        # or --reload if it's already running
```

If `config/JARVIS_SECRETS.json` (or `JARVIS_CONFIG.json`) is missing, `./JARVIS.sh --setup`,
`--start` and `--reload` create it from the `config/*_template.json` copy, and they keep both
files readable by your user account only.

`JARVIS_CONFIG.json` and `JARVIS_SECRETS.json` are gitignored; these template files use
only `REPLACE_ME` placeholders, so they're safe to keep in the repo.

## Config examples

| File | Setup |
| --- | --- |
| `JARVIS_CONFIG.single-openai.json` | **Simplest.** One OpenAI model, talking **directly** to OpenAI (the LiteLLM gateway isn't needed). |
| `JARVIS_CONFIG.openai-tiers.json` | **OpenAI only, multi-tier** via the gateway — cheap model for background tasks, `gpt-4o` for vision, `o4-mini` for hard reasoning. |
| `JARVIS_CONFIG.multi-model.json` | **Multi-provider** via the gateway — OpenAI + Anthropic Claude + Google Gemini, one model per task tier. |
| `JARVIS_CONFIG.anthropic-claude.json` | **Claude** as the single primary model (via the gateway). |
| `JARVIS_CONFIG.local-ollama.json` | **Local model via Ollama** on your Mac — no cloud chat. |
| `JARVIS_CONFIG.local-openai-compatible.json` | **Local OpenAI-compatible server** (LM Studio / llama.cpp server / vLLM). |
| `JARVIS_CONFIG.mock-offline.json` | **Offline** — `mock` provider, canned replies, no API key. Tools still work; good for testing the stack. |

## Secrets examples

| File | Setup |
| --- | --- |
| `JARVIS_SECRETS.empty.json` | Empty vault — start here. |
| `JARVIS_SECRETS.example.json` | Shows the structure with a few example accounts (placeholders). |

The vault is **plaintext by design** and stores logins for accounts **you own**; JARVIS
uses them via `get_secret` and can add/update them via `set_secret`.

## The `model_mode` switch

- `"single"` → every task uses `llm.model` (the `models` tiers are ignored).
- `"multi"`  → use the per-task `models` tiers (chat / cheap / vision / smart) with fallback.
- omit it → auto-detect (multi if a `models` block is present, else single).

In **multi** mode via the gateway, every model name must exist in `litellm/config.yaml`;
provider keys (`api_key`, `anthropic_api_key`, `gemini_api_key`) are exported to the
gateway by `JARVIS_LOCAL_LLM.sh` when it starts it.

## When is the LiteLLM gateway needed?

- **Direct** configs (`single-openai`, `local-ollama`, `local-openai-compatible`) point
  `base_url` straight at the provider — no gateway required.
- **Gateway** configs (`openai-tiers`, `multi-model`, `anthropic-claude`) point `base_url`
  at the standalone LiteLLM gateway (`http://host.docker.internal:4000/v1`, started with
  `./JARVIS_LOCAL_LLM.sh start --gateway`) so one endpoint can route to many providers.

> **You must add the cloud routes yourself.** The gateway's shipped config
> (`litellm/config_template.yaml` → `litellm/config.yaml`) has **no cloud models** — only the
> auto-generated block of your local ones. Before using a gateway config, add a route for every
> cloud model it names (e.g. `gpt-4o`, `o4-mini`, `claude-sonnet-4-6`) **above** the
> `BEGIN local routes` marker — see
> [Local models → Mixing a cloud model into the gateway](../Docs/local-llm.md#mixing-a-cloud-model-into-the-gateway-optional).
> Otherwise "model not found". If all the models come from **one** provider (e.g.
> `openai-tiers`), it's simpler to skip the gateway and point `base_url` straight at that
> provider (e.g. `https://api.openai.com/v1`) — multi mode works there too.

## Semantic memory needs an embedder

The semantic-memory service (**Mem0**, `jarvis-memory`) embeds facts with a **separate
embedding model**, configured under `mem0`. The templates default to a **local** embedder
(`nomic-embed-text` via Ollama on your host — `ollama pull nomic-embed-text`;
`./JARVIS.sh --start` prints the setup steps if it's missing). For a cloud embedder
instead, drop `mem0.embed_base_url` and set `mem0.embed_model` to e.g.
`text-embedding-3-small` (uses `llm.api_key`). Without a reachable embedder,
`add_memory` / `search_memory` won't work (everything else will).

## Regenerating

These files are generated from `JARVIS_CONFIG_template.json` by `_generate.py` (only the
`llm` block is overridden per scenario). After editing the base template, re-run:

```bash
python3 TEMPLATES/_generate.py
```
