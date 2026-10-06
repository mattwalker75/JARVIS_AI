# Web UI

The chat interface at `http://localhost:8110/`. Left is the conversation; right is a
tabbed side panel showing what JARVIS is doing.

## Chat

- **Chat tabs (parallel conversations)** — a tab strip above the messages holds multiple
  live chats: **＋** opens another, click switches (each keeps its own history), double-click
  renames, ✕ closes. Tabs persist locally **and auto-sync to the server** (they show as
  ● entries in Sessions ▾) — a fresh browser pointed at the same JARVIS restores them
  automatically.
- **Replies stay in their own tab** — a reply keeps going into the tab where you asked,
  even if you switch to another tab meanwhile. That tab shows a **working dot** while
  JARVIS answers, then a **"new reply" dot** until you open it; from other tabs the status
  pill reads **Working · <tab name>**. The ⏹ Stop button shows only in the working tab.
  Closing a tab that is still working asks first and then stops that reply.
- **One message at a time** — sending while a reply is in progress does not send it: you
  see *"JARVIS is still working on the last message — wait, or press Stop."* and your text
  stays in the box. Typing a bare **stop** acts as the Stop button; a stopped turn answers
  with one **⏹ Stopped.** reply.
- **Timestamps** — hover any message bubble to see when it was sent.
- **Search** — 🔍 in the header (or **Cmd/Ctrl-F**) opens in-chat search: match count,
  ↑/↓ (or Enter / Shift-Enter) to walk matches, Esc closes.
- **Export** — Sessions ▾ → **⬇ .md** downloads the current conversation as Markdown
  (with timestamps); the JSON export/import for re-loading lives there too.
- **Rich markdown** — bold/italic/code, fenced **code blocks** (with a copy button),
  lists, and **clickable links** (bare URLs the model posts become links too).
- **Thinking panel** — for reasoning models, a collapsible 💭 panel above each answer
  streams the model's chain-of-thought live, then collapses when the answer starts.
- **Working / idle status** — an always-visible pill by the title shows **Idle** (green) /
  **Working** (amber) / **Stalled?** (red), driven by streamed activity; after ~25s with no
  progress it warns the model may be slow. A third cyan **Autopilot** state shows while an
  autonomous run is working server-side (a live chat request's amber **Working** takes priority).
- **Plan banner** — when JARVIS is working a multi-step task, a live checklist above the chat
  shows the objective and each step's status (done ✓ / active ▸ / pending ○ / blocked ✕).
  Plans are **per chat tab** (Autopilot has its own; its plan takes over the banner while a
  run is working). A
  full-width **drawer handle** along its bottom edge shows/hides the steps (click, or
  Enter/Space) — purely visual, it never touches the running plan. See [Autopilot & the
  Planner](autopilot.md).
- **Autopilot bar** — status + controls for an autonomous run (pause/resume/modify/extend/continue). See [Autopilot](autopilot.md).
- **Context meter** — a bar by the title shows how full the context window is, with a **🗜 Summarize** button to compact and continue. See [Prompts & Context](prompts.md#the-context-window-meter).
- **Importance flags** — the model can flag a message `info` / `success` / `attention`
  (yellow, flashes) / `emergency` (red, pulses).
- **Streaming** — answers render token by token; the message list auto-follows only
  when you're at the bottom, with a **↓ Latest** button when you scroll up.
- **Per-message copy** — hover an assistant reply to copy it.
- **Stop / Regenerate** — ⏹ Stop (or Esc) interrupts (and kills any in-flight workbench
  command); 🔄 re-runs the last turn. Typing a bare "stop" while busy also interrupts.
- **🔇 Stop speaking** — appears by the message box while JARVIS is talking; Esc does the
  same (see [Keyboard shortcuts](#keyboard-shortcuts)).
- **Notices** — the app's own notices (failover, "still working", …) render markdown like
  replies.
- **Persistence** — the conversation survives a browser refresh (localStorage). **New chat** clears it.
- **Drag-drop** — drop a file onto the chat to upload it to the shared folder for
  JARVIS to read (it lands in `/LLM_READ_WRITE_FILES/uploads/`).

## Header controls

- **☀️/🌙 Theme** — toggle the light / dark theme (persists).
- **🔍 Search** — search the current conversation (Cmd/Ctrl-F).
- **＋ New chat** — start a fresh conversation (clears the plan too).
- **🌌 Ambient** — full-screen hands-free mode: a glowing avatar (the **face** by default, or the orb) that animates as JARVIS listens/thinks/speaks; tap it to talk, ✕ or **Esc** to exit. See [Voice](voice.md#ambient-hands-free-mode).
- **Model switcher** — a dropdown of available models (from the gateway/Ollama);
  switching persists to config.
- **🔊 Voice** (spoken replies on/off) / **🎤 Talk** (push-to-talk) / **Off·Wake·Open** mic mode — see [Voice](voice.md).
  The microphone needs a secure page: opened over plain `http://` from another device (a LAN
  IP or a Tailscale name), the mic pill shows **mic needs HTTPS**, and using the mic explains
  why. Serve JARVIS over HTTPS (for example with `tailscale serve`), or open
  `http://localhost:8110` on the computer that runs it.
- **🛫 Autopilot** — launch an autonomous objective run (objective, time budget, autonomy, verbose). See [Autopilot](autopilot.md).
- **🐕 Watchdog** — toggle the stream watchdog for chat messages from this page. On (default) = a stalled stream is stopped; **off = patient mode** (won't kill a slow local cold-load). Best off for long coding runs.
- **🗺 Plan** — plan-first mode: JARVIS clarifies, lays out a high-level plan, then executes.
- **Session usage** — running token (and cost, if any) total for the conversation.
- **Sessions ▾** — save / load / export / import / delete named conversations.
- **👤 name · Sign out** — only with the login on (Config → Access & users).

### Sign-in and users

With the login on, JARVIS opens on a **Sign in** screen (or **Create your login** the first
time, and after `data/.password` is deleted). Every password box has an eye button that shows
what you typed. **Config → Access & users** has the rest: *Allow other devices on my network*,
other names for this computer (a Tailscale name), turning the login on or off, how long you stay
signed in, and the users — add, reset a password, change your own, remove. Everything in JARVIS
is shared between users. Opened from another device, the **Workbench** tab explains that the
desktop only opens on the computer that runs JARVIS. When your session ends — your password
was changed, your user was removed, or JARVIS restarted with the login on — the page goes back
to the sign-in screen. Details:
[configuration](configuration.md#security-and-server-optional--who-can-open-jarvis).

## Side-panel drawer

On a desktop-width window (wider than 900px) the right-hand panel is a **resizable drawer**.
The handle on its edge is a button: drag it (mouse, pen or finger) to any width, click it — or
focus it and press Enter/Space — to open/close, and use **←/→** to resize from the keyboard.
It stays where you set it (persisted). A dot on the handle means something happened while it
was closed.

## Tablets and phones

- **900px wide or less (tablets, phones)** — the side panel becomes a full-height sheet over
  the chat, opened with **☰ Panels** in the top bar and closed with **✕ Close**, a tap
  outside, or **Esc**. A dot on ☰ Panels means there is new activity.
- **600px wide or less (phones)** — the top bar shows just the brand, **☰** and **⋯**; the
  other controls (theme, search, new chat, ambient, model, voice, mic, Autopilot, …) are under
  **⋯**.
- **Touch screens** get controls at least 40px tall, and the copy buttons are always visible
  (there is no hover). On phones, form text is 16px so the browser doesn't zoom in when you
  type.

| Tab | Contents |
| --- | --- |
| **Activity** | Every tool call streams here (name, input, result, timing) so you can watch JARVIS work — including Autopilot cycle markers and sub-agent (`sub▸`) calls. A **filter box** narrows by tool name, hover an entry to **copy** its output, long `run_shell` commands stream their output **live** (pulsing left edge), and screenshots/captures show as **📷 thumbnails** (click to zoom) — you see exactly what JARVIS saw. |
| **Tasks** | Active scheduled tasks — **✏️ edit in place** (prompt/label/interval/stop-condition), **⏸/▶ pause & resume**, cancel (with confirmation) — plus a quick-add form and notification history. |
| **Memory** | Everything JARVIS remembers, with a filter box, **✏️ edit-in-place**, delete buttons, and 🧹 Consolidate. |
| **Files** | Browse, open/preview, and download either shared folder (**Read-write / Read-only** switch); upload into the read-write folder with **⤒ Upload** (or drag-drop onto the chat); delete (read-write only). |
| **Workbench** | The live Linux desktop (noVNC) embedded — watch it use the browser and apps. Hidden while the workbench is turned off (Config → Workbench & shared folders → *Use the Linux workbench*). |
| **Config** | **Nearly every setting in `JARVIS_CONFIG.json` has a structured field here**, grouped into sections — Model & LLM (endpoint, keys, tier pickers), Prompts (editor + library), Behavior, Ollama tuning, Assistant & Voice, Memory (Mem0/embedder), Autopilot, Workbench & shared folders (incl. the pinnable base image), Security & housekeeping, and Diagnostics — all kept in sync with the raw JSON editors. Raw-JSON-only: `personas`, `mcp.servers`, `llm.system_prompt` / `llm.master_prompt` (fallbacks — the Prompts editor edits the prompt files), and `local_models.*` (not used by the code). The **Stream watchdog** checkbox (on when the setting is absent) covers requests that don't choose — scheduled tasks and the HTTP API; chat from this page follows the 🐕 button, and Autopilot never uses it. **A save is refused if the config changed since you opened the tab** (for example a header toggle was saved meanwhile): press **↻ Reload**, then make your change again. Secrets are saved only if you edited the secrets box. **List models** fills real dropdowns grouped by tier (see [Configuration](configuration.md#tier-grouping-in-the-config-pickers)); **Model mode** reveals the single-model input or the tier grid. **Saving applies live** — no restart for ordinary settings. MLX models are managed from the CLI (`mlx-serve` — discovery-based, see [MLX backend](cli.md#mlx-backend-apple-silicon)), then appear in **List models** like any other endpoint. See [Configuration](configuration.md) and [Prompts](prompts.md). |

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
| `/guide [topic]` | JARVIS reads its self-help guides (`/LLM_READ_ONLY_FILES/JARVIS_Guides/`) and walks you through the topic (no topic lists them). |
| `/ro [request]` | Run the request against the **read-only** shared folder's files (no request lists them). |
| `/rw [request]` | Run the request against the **read-write** shared folder's files (no request lists them). |
| `/files`, `/tasks`, `/memory`, `/activity`, `/workbench` | Open that side panel. |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| **Enter** | Send (Shift+Enter for a newline). |
| **↑** (empty input) | Recall your last message to edit. |
| **Cmd/Ctrl-K** | Focus the message box. |
| **Esc** | Always stops speech (also after the reply arrived, and inside a dialog). Otherwise, in order: closes the ☰ Panels sheet or the ⋯ menu, leaves Ambient mode, or stops the in-flight response in the open tab. |

## Install as an app (PWA)

JARVIS is installable as a standalone app: in Chrome/Edge use the **install icon in the
address bar** (or menu → *Install JARVIS*), on iOS Safari *Share → Add to Home Screen*.
You get an own window with the arc-reactor icon in the dock — no service worker is used
(a localhost app gains nothing from offline caching), so updates always load fresh.

> After updating the app's frontend, hard-refresh the browser (Cmd-Shift-R) so it
> reloads the JS/CSS.
