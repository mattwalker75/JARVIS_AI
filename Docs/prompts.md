# Prompts & Context

## The prompt system

Every request to the model is assembled as:

```
[ master prompt ]  →  [ system prompt ]  →  [ built-in tool / planner / coding rules ]
```

- **Master prompt** — a short, stable statement of *who* JARVIS is and its mission (identity).
- **System prompt** — the detailed *how*: behavior, workflows, formatting.
- **Built-in rules** — the tooling guidance (always use real tool calls, keep the plan
  ledger, workbench/coding habits, debug via `browser_console`, etc.) is **appended
  automatically**, so your editable prompts stay focused on identity + behavior and never
  need to repeat the tooling boilerplate.

`{assistant_name}` in either prompt is replaced with the configured assistant name.

## Editing & the file library

Prompts live as **editable files** in the top-level `Prompts/` directory (bind-mounted
into the app). Each prompt **set** is two files:

```
Prompts/<name>_master.prompt     # identity/mission
Prompts/<name>_system.prompt     # instructions
```

- **Active prompt** = `default_master.prompt` + `default_system.prompt`. These are read
  **live** every turn, so edits apply on the **next turn** — no restart needed.
- **`stock`** = a protected, permanent copy of the original defaults. Load it and "Save as
  active" to restore the originals anytime. (`default` and `stock` can't be deleted.)

### In the Config tab → **Prompts**

| Action | Effect |
| --- | --- |
| **(dropdown) + Load** | Load a saved set into the Master/System editors (non-destructive — nothing is activated yet). |
| **💾 Save as active** | Write the editors to `default_*.prompt` — makes them the live prompt. |
| **Save as…** | Save the editors to a named set `<name>_*.prompt`. |
| **Delete** | Remove a saved set (both files). |

You can also edit the `.prompt` files directly in any text editor, or drop in your own —
they show up in the dropdown automatically.

### Starter library

Ready-made personas you can Load → Save as active (all editable):

`default` · `coder` · `researcher` · `data_scientist` · `investigator` ·
`writer` · `creative` · `tutor` · `concise` · `ops` · `pentester` · `defender` ·
`financial` · `investment` · `investor` · `passive_income` · `quick_money` · `accountant` ·
`business_research` · `market_research` · `marketing` · `customer_acquisition` · `sales` ·
`seo` · `entrepreneur` · `product_manager` · `negotiator` · `career` · `realestate` ·
`legal` · `relationship` · `counselor` · `parenting` · `handyman` · `survivalist` ·
`chef` · `dietician` · `fitness` · `gardener` · `travel`.

Sensitive personas (financial/investment, counselor, survivalist, legal, dietician, …)
carry brief guardrails — educational-not-licensed-advice, do-your-own-diligence, and
professional/emergency pointers where warranted. The `pentester` persona is scoped to
authorized security testing (your own systems / lab / CTF / permitted engagements).

API: `GET /api/prompts` (names) · `GET|POST|DELETE /api/prompts/:name` (a set's two files).

Config fallback: if the `Prompts/` files are missing, `llm.master_prompt` and
`llm.system_prompt` in `JARVIS_CONFIG.json` are used instead.

## The context-window meter

A small bar under the title shows how full the conversation context is —
e.g. `64% · 21k/33k` (**green** < 60%, **amber** < 85%, **red** ≥ 85%). It's driven by each
turn's actual prompt size against the **context window**:

- resolved automatically (`GET /api/context-window`): a manual `llm.context_window` wins;
  otherwise for local Ollama it uses `ollama.context_length` (the loaded `num_ctx` — the real
  effective ceiling), and for cloud via the gateway it asks `/model/info`; else a default.
- set a number in **Config → Context window** to override, or leave blank for auto.

### Summarize & continue

When the meter passes ~60%, a **🗜 Summarize** button appears. It asks the model (no tools)
for a complete-but-terse summary of the conversation, then **replaces** the sent history
with that summary — so the window actually **shrinks** and JARVIS continues seamlessly with
its own summary as memory. (A plain "please summarize" wouldn't free anything; this
compacts.) API: `POST /api/summarize`.

The meter shows at 0% on a fresh chat, estimates on a refresh, and the exact value lands on
the next turn. **New chat** resets it.
