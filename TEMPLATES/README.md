# JARVIS config & secrets templates

Ready-to-use example configurations for different model setups. Each
`JARVIS_CONFIG.*.json` is a **complete, copy-paste-ready** config (full system prompt
and all sections included) — only the `llm` block differs between them.

## How to use

```bash
# from the repo root:
cp TEMPLATES/JARVIS_CONFIG.single-openai.json   JARVIS_CONFIG.json
cp TEMPLATES/JARVIS_SECRETS.empty.json          JARVIS_SECRETS.json
# edit JARVIS_CONFIG.json -> fill in your api_key(s)
./JARVIS.sh --start        # or --reload if it's already running
```

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

In **multi** mode, every model name must exist in `litellm/config.yaml`, and provider
keys (`api_key`, `anthropic_api_key`, `gemini_api_key`) are exported to the gateway by
`JARVIS.sh` on start.

## When is the LiteLLM gateway needed?

- **Direct** configs (`single-openai`, `local-ollama`, `local-openai-compatible`) point
  `base_url` straight at the provider — the `jarvis-litellm` container isn't required.
- **Gateway** configs (`openai-tiers`, `multi-model`, `anthropic-claude`) point `base_url`
  at `http://jarvis-litellm:4000/v1` so one endpoint can route to many providers.

## ⚠️ Local / non-OpenAI setups and semantic memory

The semantic-memory service (**Mem0**, `jarvis-memory`) uses **OpenAI embeddings**, which
read `llm.api_key`. So for local/Claude/Ollama configs:

- Set `llm.api_key` to a (cheap) OpenAI key **just for embeddings**, and chat still runs on
  your chosen local/Claude model — **or**
- Edit `memory/server.py` to use a local embedder (Mem0 supports e.g. embedder provider
  `ollama`, model `nomic-embed-text`) for a fully-local stack.

Without one of these, `add_memory` / `search_memory` won't work (everything else will).

## Regenerating

These files are generated from `JARVIS_CONFIG_template.json` by `_generate.py` (only the
`llm` block is overridden per scenario). After editing the base template, re-run:

```bash
python3 TEMPLATES/_generate.py
```
