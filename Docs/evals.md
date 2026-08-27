# Evals — the regression suite

JARVIS ships a small eval harness (`app/eval.js`) that replays fixture conversations
through the **live model + tool loop** and asserts on cheap, observable signals: what
the reply contains, which tools actually ran, and how long/expensive the run was. It's
the regression check to run **after changing a prompt, a guardrail, or the model** —
exactly the changes that can silently degrade behavior.

```bash
./JARVIS.sh --eval        # exit 0 = all passed, non-zero = a case failed
```

The stack must be running (`--start`); each case makes real model calls at your
configured endpoint.

## Where cases live

`data/evals/*.json` (bind-mounted into the app at `/data/evals`). Each file holds one
case or an array of cases; files are run in name order. The shipped suite covers one
capability area per file — see [`data/evals/README.md`](../data/evals/README.md) for
the current list.

## Case schema

```jsonc
{
  "name": "shell-run",                       // shown in the report
  "messages": [                              // the conversation to replay (system prompt
    { "role": "user", "content": "..." }     // is added automatically)
  ],
  "tier": "chat",                            // optional model tier (chat | cheap | smart)
  "expect": {
    "contains":     ["391"],                 // reply must include ALL of these (case-insensitive)
    "not_contains": ["error"],               // reply must include NONE of these
    "tools_used":   ["run_shell"],           // these tools must actually have been CALLED
    "max_ms":       60000,                   // wall-clock ceiling for the run
    "max_cost_usd": 0.03,                    // estimated-cost ceiling (cloud models)
    "no_error":     true                     // default: the run must not throw
  }
}
```

Every `expect` field is optional — assert only what matters for the case.

## Authoring tips

- **`tools_used` is the strongest assertion.** A reply can *claim* work happened; the
  tool list records what actually ran. Use it whenever the point of the case is "the
  model must act, not narrate" (the follow-through / tool-call-as-text guardrails).
- **Adapt a real conversation.** Any saved session (`data/sessions/*.json`) becomes a
  case by copying its `messages` and adding an `expect` block — the cheapest way to
  turn a bug you just fixed into a permanent regression check.
- **Assert loosely on wording.** Model phrasing varies run to run; prefer a number, a
  filename, or a keyword that only appears when the behavior is correct over exact
  sentences.
- **Mind side effects.** Cases run with the full toolset, so they can write files and
  store memories (the shipped ones create `eval_probe.*` artifacts and a test memory).
  Keep new cases similarly harmless and identifiable.
- **Network-dependent cases flake offline.** Mark them clearly (the shipped
  `internet-and-tasks.json` depends on `api.ipify.org`).

## Reading the report

```
PASS  shell-run  (8123ms · $0 · qwen3.6:35b · tools: run_shell)
FAIL  memory-recall  (4310ms · $0 · qwen3.6:35b)
        - tool not used: search_memory
```

One line per case with timing, cost estimate, model, and the tools that ran; failures
list each unmet expectation. The command exits non-zero if any case failed, so it can
gate a commit or run in a script.

## Relationship to the unit tests

`node app/test/run.js` (no model, no Docker needed) covers the deterministic pieces —
planner, tool-loop guardrail logic, edit tools — **plus** `smoke-server.test.js`, which
boots the real server with the `mock` provider in scratch dirs and exercises the HTTP
surface, the WebSocket chat loop, the PWA assets, and the cross-site request guard
end-to-end. Evals cover what those can't: whether the **live model, prompts, and
guardrails together** still produce correct behavior. Run the unit suite on every
change; run evals when prompts, guardrails, or models change. (`app/test/smoke.sh`
additionally spot-checks a **running** stack after `--start`.)
