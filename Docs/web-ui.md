# Web UI

The chat interface at `http://localhost:8110/`. Left is the conversation; right is a
tabbed side panel showing what JARVIS is doing.

## Chat

- **Rich markdown** — bold/italic/code, fenced **code blocks** (with a copy button),
  lists, and links.
- **Thinking panel** — for reasoning models, a collapsible 💭 panel above each answer
  streams the model's chain-of-thought live, then collapses when the answer starts.
- **Importance flags** — the model can flag a message `info` / `success` / `attention`
  (yellow, flashes) / `emergency` (red, pulses).
- **Streaming** — answers render token by token; the message list auto-follows only
  when you're at the bottom, with a **↓ Latest** button when you scroll up.
- **Per-message copy** — hover an assistant reply to copy it.
- **Stop / Regenerate** — ⏹ Stop (or Esc) interrupts; 🔄 re-runs the last turn.
- **Persistence** — the conversation survives a browser refresh (localStorage).
- **Drag-drop** — drop a file onto the chat to upload it to the shared folder for
  JARVIS to read (it lands in `/READ_WRITE_FILES/uploads/`).

## Header controls

- **＋ New chat** — start a fresh conversation.
- **🌌 Ambient** — full-screen hands-free "orb" mode that animates as JARVIS listens/thinks/speaks; tap the orb to talk, ✕ to exit. See [Voice](voice.md#ambient-orb-mode).
- **Model switcher** — a dropdown of available models (from the gateway/Ollama);
  switching persists to config.
- **🔊 Voice** (spoken replies on/off) / **🎤 Talk** (push-to-talk) / **Off·Wake·Open** mic mode — see [Voice](voice.md).
- **Session usage** — running token (and cost, if any) total for the conversation.
- **Sessions ▾** — save / load / export / import / delete named conversations.

## Side-panel tabs

| Tab | Contents |
| --- | --- |
| **Activity** | Every tool call streams here (name, input, result, timing) so you can watch JARVIS work. |
| **Tasks** | Active scheduled tasks (cancel with a click), a quick-add form, and notification history (clear all or dismiss one). |
| **Memory** | Everything JARVIS remembers, with a filter box and delete buttons. |
| **Files** | Browse, open/preview, download, and delete files in the shared folder — JARVIS's deliverables and your uploads. |
| **Workbench** | The live Linux desktop (noVNC) embedded — watch it use the browser and apps. |

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
