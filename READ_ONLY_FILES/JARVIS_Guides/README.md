# JARVIS self-help guides

These are short, task-focused guides about **JARVIS itself** — how to configure it,
switch models, run things, and what the pieces are. They live in the read-only shared
folder so JARVIS can read them at runtime and walk you through the steps.

**How to use them:** just ask JARVIS in plain language —
> "How do I switch from ChatGPT to a local model?"
> "What is the workbench?"
> "How do I run something on Autopilot?"

— or use the **`/guide`** command in chat (`/guide switching models`, or `/guide` alone to
list topics). JARVIS reads the matching guide from `/READ_ONLY_FILES/JARVIS_Guides/` and
walks you through it.

## Guides

| File | Topic |
| --- | --- |
| `switching-models.md` | Switch the model or provider (ChatGPT ↔ Ollama ↔ MLX ↔ others). |
| `local-models-ollama.md` | Run local models with Ollama. |
| `local-models-mlx.md` | Run local models with MLX (Apple Silicon). |
| `using-autopilot.md` | Give JARVIS an objective and let it work autonomously. |
| `maintenance.md` | Start/stop, reset the workbench, backups. |
| `glossary.md` | What the pieces are — workbench, tiers, gateway, memory, Autopilot, etc. |

> These ship with JARVIS. Add your own `.md` files here too and JARVIS can use them the same way.
