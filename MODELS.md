# Model reference

> ### 📖 Use this file as a reference when selecting a model.
> When you're filling in the Config tab's model fields (single **Model**, or the multi-model
> **chat / cheap / smart / vision** tiers), check here for which models fit which tier before you
> pick. You can still choose any model in any tier — this is guidance, not a restriction.

A human-readable cheat sheet of common models by **tier bucket**, for filling in the
Config tab's multi-model fields (chat / cheap / smart / vision).

- **chat** — main conversation + tool-calling (what Autopilot runs on)
- **cheap** — fast/low-cost, for background + scheduled tasks
- **smart** — hard reasoning (clarify, summarize, tough problems)
- **vision** — must read images (required for the vision tier)

> This file is just a **reference for you**. The Config UI actually reads the machine copy at
> [`app/public/models.json`](app/public/models.json) to group the dropdowns — so when you add a
> model here, add it there too (same buckets). Grouping only **orders** the pickers; you can still
> select **any** model in **any** tier, and **✎ Custom…** lets you type one that isn't listed.

_Last updated: 2026-07-28 — capabilities/limits change often; verify against your provider._

---

## OpenAI

| Model | Buckets | Notes |
| --- | --- | --- |
| `gpt-4.1` | chat, vision | Flagship. 1M context. **30k TPM on tier 1** — bump tier or use mini if throttled. |
| `gpt-4.1-mini` | cheap, vision | Great default — ~200k TPM tier 1, ~5× cheaper, still strong. |
| `gpt-4.1-nano` | cheap | Cheapest 4.1; weakest — fine for trivial background work. |
| `gpt-4o` | chat, vision | Multimodal workhorse. 128k context. Also 30k TPM tier 1. |
| `gpt-4o-mini` | cheap, vision | Cheap multimodal; high limits. |
| `gpt-5` | chat, smart, vision | Newest flagship (reasoning + chat). |
| `gpt-5-mini` / `gpt-5-nano` | cheap (+vision for mini) | Smaller GPT‑5 tiers. |
| `o3` | smart, vision | Deep reasoning. Pricier/slower — use for hard problems, not chat. |
| `o4-mini` | smart, vision | Cheaper reasoning; good smart-tier value. |
| `o1` / `o3-mini` / `o1-mini` | smart | Reasoning (o1‑mini/o3‑mini are text‑only). |
| `text-embedding-3-*`, `whisper-1`, `tts-1`, `dall-e-3`, `gpt-4o-transcribe` | — (not a chat tier) | Embeddings / audio / image — excluded from the pickers. |

## Anthropic (Claude)

| Model | Buckets | Notes |
| --- | --- | --- |
| `claude-sonnet-4` | chat, vision | Balanced flagship. |
| `claude-opus-4` / `claude-opus-4-1` | smart, vision | Strongest reasoning. |
| `claude-3-7-sonnet` / `claude-3-5-sonnet` | chat, vision | Prior strong chat models. |
| `claude-3-5-haiku` / `claude-haiku-4-5` | cheap, vision | Fast/cheap. |
| `claude-3-opus` | smart, vision | Older top-tier reasoning. |

## Google (Gemini)

| Model | Buckets | Notes |
| --- | --- | --- |
| `gemini-2.5-pro` | chat, smart, vision | Flagship. |
| `gemini-2.5-flash` / `gemini-2.0-flash` | chat, cheap, vision | Fast, huge context. |
| `gemini-1.5-pro` | chat, vision | Long context. |
| `gemini-1.5-flash` / `2.0-flash-lite` | cheap, vision | Cheapest. |

## Local (Ollama)

| Model | Buckets | Notes |
| --- | --- | --- |
| `qwen3`, `qwen2.5`, `llama3.3`, `mistral-large` | chat | General local chat. |
| `llama3.2`, `qwen2.5:7b`, `phi-4`, `gemma3` | cheap | Small/fast local. |
| `deepseek-r1`, `qwq` | smart | Local reasoning. |
| `qwen2.5vl`, `llava`, `llama3.2-vision`, `moondream`, `minicpm-v` | vision | Local multimodal (needed for the vision tier). |

---

### How matching works (for editing `models.json`)
Names are matched by **longest prefix** against whatever your endpoint's **List models** returns,
so listing the clean base name is enough:
- `gpt-4.1` → also matches `gpt-4.1-2025-04-14`
- `gpt-4.1-mini` (longer) wins for `gpt-4.1-mini-2025-04-14`

A model may sit in **multiple** buckets (e.g. `gpt-4o` is chat **and** vision). Anything not listed
falls back to a name heuristic, so new models still land somewhere sensible until you add them here.
