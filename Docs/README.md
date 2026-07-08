# JARVIS Documentation

Detailed documentation for JARVIS, a personal local AI framework. Start with the
[project README](../README.md) for the high-level picture, then dive in here.

## Contents

| Doc | What's inside |
| --- | --- |
| [Architecture](architecture.md) | The five containers, how a message flows end to end, the LLM gateway, volumes, ports, and the security model. |
| [Configuration](configuration.md) | Complete `JARVIS_CONFIG.json` reference — every section and key, with examples for local / cloud / mixed setups. |
| [Tools](tools.md) | Every tool the model can call, grouped by family, with parameters and notes. |
| [Web UI](web-ui.md) | The chat interface: tabs (Activity / Tasks / Memory / Files / Workbench), slash commands, model switcher, drag-drop, settings that persist. |
| [Voice](voice.md) | Voice modes, streaming text-to-speech, barge-in, and configuration. |
| [Memory & Scheduling](memory-and-scheduling.md) | Semantic memory (Mem0), embedder namespacing, backup/restore, and the task scheduler. |
| [CLI](cli.md) | `JARVIS.sh` — every command, plus terminal/scripting usage. |
| [API](api.md) | REST + WebSocket endpoints, including `POST /api/chat` for automation. |
| [Extending](extending.md) | Add tools (custom + MCP), personas, models/providers, and skills — without editing core code. |

## Conventions used in these docs

- **Host paths** are relative to the repo root (e.g. `data/tasks.json`).
- **Container paths** start with `/` and refer to inside a container
  (e.g. `/READ_WRITE_FILES`, `/workspace`).
- Commands assume you run them from the repo root.
