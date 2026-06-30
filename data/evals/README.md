# Eval suite

Regression checks for JARVIS's capabilities. Run them through the live model + tool
loop with:

```bash
./JARVIS.sh --eval        # exit 0 = all passed, non-zero = a case failed
```

Each `*.json` file holds one case or an array of cases:

```json
{
  "name": "shell-run",
  "messages": [{ "role": "user", "content": "..." }],
  "tier": "chat",                      // optional model tier
  "expect": {
    "contains": ["..."],               // reply must include all of these (case-insensitive)
    "not_contains": ["..."],           // reply must include none of these
    "tools_used": ["run_shell"],       // these tools must have been called
    "max_ms": 60000,                   // run must finish within this
    "max_cost_usd": 0.03,              // estimated cost ceiling
    "no_error": true                   // default; the run must not error
  }
}
```

## Files (one per capability area)

| File | Covers |
| --- | --- |
| `reasoning.json` | basic reasoning + identity |
| `memory.json` | semantic memory store + recall (add_memory / search_memory) |
| `files.json` | shared-file write/read + append_log |
| `shell-and-code.json` | run_shell + write_workbench_file → run → verify output |
| `internet-and-tasks.json` | fetch_url + list_tasks |

## Notes

- Cases make **real model calls** and have **side effects** (they create
  `eval_probe.*` files, a `/workspace` script, and store a test memory `XYZZY-42`).
  Harmless, but that's why they live here and aren't run automatically.
- `internet-and-tasks` depends on the network (api.ipify.org); it can flake if you're
  offline.
- Add your own cases by dropping a `.json` file here — adapt a saved session
  (`data/sessions/*.json`) by copying its `messages` and adding an `expect` block.
