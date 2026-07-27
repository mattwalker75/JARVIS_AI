# Web UI

The chat interface at `http://localhost:8110/`. Left is the conversation; right is a
tabbed side panel showing what JARVIS is doing.

## Chat

- **Rich markdown** — bold/italic/code, fenced **code blocks** (with a copy button),
  lists, and **clickable links** (bare URLs the model posts become links too).
- **Thinking panel** — for reasoning models, a collapsible 💭 panel above each answer
  streams the model's chain-of-thought live, then collapses when the answer starts.
- **Working / idle status** — a pill by the title shows Idle / Working / Stalled?, driven
  by streamed activity; after ~25s with no progress it warns the model may be slow.
- **Plan banner** — when JARVIS is working a multi-step task, a live checklist above the chat
  shows the objective and each step's status (done ✓ / active ▸ / pending ○ / blocked ✕). See [Autopilot & the Planner](autopilot.md).
- **Autopilot bar** — status + controls for an autonomous run (pause/resume/modify/extend/continue). See [Autopilot](autopilot.md).
- **Context meter** — a bar by the title shows how full the context window is, with a **🗜 Summarize** button to compact and continue. See [Prompts & Context](prompts.md#the-context-window-meter).
- **Importance flags** — the model can flag a message `info` / `success` / `attention`
  (yellow, flashes) / `emergency` (red, pulses).
- **Streaming** — answers render token by token; the message list auto-follows only
  when you're at the bottom, with a **↓ Latest** button when you scroll up.
- **Per-message copy** — hover an assistant reply to copy it.
- **Stop / Regenerate** — ⏹ Stop (or Esc) interrupts (and kills any in-flight workbench
  command); 🔄 re-runs the last turn. Typing a bare "stop" while busy also interrupts.
- **Persistence** — the conversation survives a browser refresh (localStorage). **New chat** clears it.
- **Drag-drop** — drop a file onto the chat to upload it to the shared folder for
  JARVIS to read (it lands in `/READ_WRITE_FILES/uploads/`).

## Header controls

- **＋ New chat** — start a fresh conversation (clears the plan too).
- **🌌 Ambient** — full-screen hands-free "orb" mode that animates as JARVIS listens/thinks/speaks; tap the orb to talk, ✕ to exit. See [Voice](voice.md#ambient-orb-mode).
- **Model switcher** — a dropdown of available models (from the gateway/Ollama);
  switching persists to config.
- **🔊 Voice** (spoken replies on/off) / **🎤 Talk** (push-to-talk) / **Off·Wake·Open** mic mode — see [Voice](voice.md).
- **🛫 Autopilot** — launch an autonomous objective run (objective, time budget, autonomy, verbose). See [Autopilot](autopilot.md).
- **🐕 Watchdog** — toggle the stream watchdog. On (default) = a stalled stream is stopped; **off = patient mode** (won't kill a slow local cold-load). Best off for long coding runs.
- **🗺 Plan** — plan-first mode: JARVIS clarifies, lays out a high-level plan, then executes.
- **Session usage** — running token (and cost, if any) total for the conversation.
- **Sessions ▾** — save / load / export / import / delete named conversations.

## Side-panel drawer

The right-hand panel is a **resizable drawer**: grab the handle on its edge to drag it to any
width, click the handle to open/close, and it stays where you set it (persisted).

| Tab | Contents |
| --- | --- |
| **Activity** | Every tool call streams here (name, input, result, timing) so you can watch JARVIS work — including Autopilot cycle markers. |
| **Tasks** | Active scheduled tasks (cancel with a click), a quick-add form, and notification history (clear all or dismiss one). |
| **Memory** | Everything JARVIS remembers, with a filter box and delete buttons. |
| **Files** | Browse, open/preview, download, and delete files in the shared folder — JARVIS's deliverables and your uploads. |
| **Workbench** | The live Linux desktop (noVNC) embedded — watch it use the browser and apps. |
| **Config** | Provider/model picker (with **List models**), prompts editor + library, behavior, Ollama tuning, diagnostics, and the raw config/secrets editors. See [Configuration](configuration.md) and [Prompts](prompts.md). |

## Slash commands

Type these in the message box:

| Command | Action |
| --- | --- |
| `/help` | List all commands. |
| `/new`, `/clear` | Start a new conversation. |
| `/regen`, `/retry` | Regenerate the last response. |
| `/model [name]` | Switch chat model (no name opens the picker). |
| `/persona [name\|off]` | Switch [persona](extending.md#personas) (no name lists them). |
| `/hints [on\|off]` | Toggle skill auto-hints (no arg shows the state); persists to config. |
| `/remember <fact>` | Save a fact to long-term memory. |
| `/files`, `/tasks`, `/memory`, `/activity`, `/workbench` | Open that side panel. |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| **Enter** | Send (Shift+Enter for a newline). |
| **↑** (empty input) | Recall your last message to edit. |
| **Cmd/Ctrl-K** | Focus the message box. |
| **Esc** | Stop the in-flight response (and silence speech). |

> After updating the app's frontend, hard-refresh the browser (Cmd-Shift-R) so it
> reloads the JS/CSS.
