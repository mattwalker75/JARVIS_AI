# JARVIS

A specialized **AI enablement tool**: a local web interface to an LLM that has real
capabilities — persistent **memory** (a MySQL database it fully owns), a **root Linux
workbench** it can work in (and you can watch), two **shared folders** to exchange
files with you, and **voice** conversation with a "Jarvis" wake word.

Model backend is flexible: any **OpenAI-compatible** endpoint (OpenAI, or a local
model via **Ollama**), or a built-in **mock** for offline testing.

> ⚠️ **Powerful by design.** JARVIS can run arbitrary root commands in its workbench
> container and has full admin over its memory database. That is intentional. The
> stack binds to **localhost only**, root access is **inside the workbench container**
> (not your host), and the LLM API key + config live in the gitignored
> `JARVIS_CONFIG.json`. Run it on a machine you trust.

## Architecture

```
docker compose (project: jarvis, localhost only)
  jarvis-app        Node.js backend + JS frontend (orchestrator)        :8110
                    chat UI, LLM tool-calling, websocket activity, voice
  jarvis-db         MySQL 8 — the LLM's memory (full admin)             :13306
  jarvis-workbench  Ubuntu XFCE desktop via noVNC, LLM works as root     :8111

  READ_ONLY_FILES/        you -> LLM (read-only to the LLM)   -> /READ_ONLY_FILES
  READ_WRITE_FILES/        you <-> LLM (LLM read/write)         -> /READ_WRITE_FILES
```

The app reaches the workbench through the Docker socket (`docker exec` as root) and
the database over the internal network. The LLM is given three tool families:

| Tool | What it does |
| --- | --- |
| `sql(query)` | Full-admin SQL against its MySQL memory database. |
| `run_shell(command)` | Root bash in the workbench (install packages, do work/research). |
| `read_file` / `write_file` / `list_dir` | Files in the shared folders (`/READ_ONLY_FILES` read-only, `/READ_WRITE_FILES` read-write). |
| `fetch_url(url)` / `web_search(query)` | **Open internet access** — read any URL/API and search the web. |
| `screenshot` + `open_url` / `click` / `type_text` / `press_key` / `scroll` / … | **Desktop control (computer use)** — see the screen and drive the real Chromium browser + apps. |
| `list_secrets` / `get_secret` / `set_secret` / `delete_secret` | The **credential vault** — read, create, update, and delete logins for the user's *own* accounts. |
| `schedule_task` / `list_tasks` / `cancel_task` / `notify_user` | **Scheduling** — run a prompt later, at a time, or on a recurring interval, and notify the user. |
| `list_skills` / `get_skill` | **Skills knowledge base** — detailed how-to playbooks (in the DB) the model reads on demand. |

### How JARVIS knows its tools

The model receives every tool's full schema (name + description + parameters) on
each call, plus a **tool-selection guide** in the system prompt (which tool for
which job, and common multi-tool workflows). For deeper, step-by-step guidance it
calls `list_skills` / `get_skill`, which read a **`skills` table** seeded into the
memory database from `app/src/skills_data.js`. The seed runs on app startup and is
idempotent — edit `skills_data.js` and restart to update the playbooks. The LLM's
own working memory is *not* predefined: it has full DB admin and creates whatever
tables it needs.

### Scheduling tasks

Ask JARVIS in plain language and it schedules the work; the scheduler (in the
running app) executes due tasks through the same tool loop and notifies you
(in-app 🔔, browser notification, and spoken if audio is on). Tasks persist to
`data/tasks.json` and survive restarts.

- **One-shot, delay:** *"summarize my unread email in 10 minutes"* → runs once in 600s.
- **One-shot, absolute:** *"back up the database at 5pm"* → runs once at 5pm today.
- **Recurring + stop condition:** *"every 5 minutes, check the error log and notify me
  if you see anything critical — until I say stop"* → runs every 300s and **stops when it
  notifies you** (condition met) or when you say to stop (it cancels the task).

Manage them in chat: *"what tasks are scheduled?"* (`list_tasks`) or *"stop the log
monitor"* (`cancel_task`) — or use the **Tasks** tab in the web UI to see active
tasks, **cancel** them with a click, and review notification history.

> The scheduler runs **inside the app container**. Tasks fire while it's up; if the
> container is down they wait in `data/tasks.json` and catch up on the next
> `--start`. Notifications appear in-app (🔔), as a browser notification, spoken (if
> audio is on), and as a desktop toast on the workbench (after a `--setup` rebuild
> that adds `libnotify-bin`).

### Desktop control (computer use)

JARVIS can operate the real desktop the user is watching (the **Workbench** tab):
it takes a `screenshot` (the image is fed to the vision model so it can *see* the
screen), then uses `open_url`/`open_app`, `click`/`double_click`/`right_click`,
`type_text`, `press_key`, and `scroll` (via xdotool) to drive Chromium and other
GUI apps. `run_shell` has `DISPLAY=:1` preset so GUI commands target that desktop.

> Computer use needs a **vision-capable** model (e.g. OpenAI `gpt-4o*`, or
> `qwen2.5-vl` via Ollama). A text-only model can still use every other tool.

### Credential vault & account policy

`JARVIS_SECRETS.json` (gitignored; see `JARVIS_SECRETS_template.json`) holds logins
for the **user's own accounts**, exposed to the LLM via `list_secrets` (names only)
and `get_secret` (full). This is for JARVIS to **operate accounts you already own**.
JARVIS does **not** create new accounts or bypass sign-up CAPTCHAs / phone
verification — you create and verify an account yourself, then JARVIS operates it.

### Workbench toolchain & internet

The workbench is a **custom image** (`workbench/Dockerfile`, built on linuxserver
webtop) pre-loaded with a broad CLI toolchain so the LLM can work immediately:
languages (Python, Node.js, Go, Java, Ruby, PHP, Perl, Lua, C/C++/clang), build
tools, networking/research utils (curl, wget, httpie, nmap, dig, traceroute, …),
database clients (mysql, psql, redis-cli, sqlite3), data/text tools (jq, ripgrep,
fd, bat, ag, datamash, …), media/docs (ffmpeg, imagemagick, poppler, pandoc), and
more — plus root + apt to install anything else.

**Internet is enabled end to end:** the image has internet at build time (apt/pip),
the workbench container has outbound internet at runtime (default Docker bridge),
and the LLM itself has open web access via the `fetch_url`/`web_search` tools (and
`curl`/`wget` in the workbench). Access is **not** allow-listed — JARVIS can reach
any site.

Every tool call streams to the **Activity** panel so you can watch what JARVIS does,
and the **Workbench** tab embeds the live Linux desktop.

## Languages

- **JavaScript** frontend (`app/public/`)
- **Node.js** backend (`app/server.js`, `app/src/`)
- **Bash** control script (`JARVIS.sh`)

## Quick start

```bash
./JARVIS.sh --check          # verify Docker is running
./JARVIS.sh --setup          # build app image + pull db/workbench (workbench image is large)
./JARVIS.sh --start          # start everything, prints URLs
./JARVIS.sh --reload         # re-read config + secrets (restarts app only; db/workbench stay up)
./JARVIS.sh --terminal       # chat with JARVIS in this terminal (no browser)
./JARVIS.sh --prompt "..."   # one-shot prompt -> answer on stdout (supports piping stdin)
./JARVIS.sh --status         # what's running
./JARVIS.sh --stop           # stop (keeps data)
./JARVIS.sh --delete         # remove containers + ALL data volumes
./JARVIS.sh --backup-db      # dump memory DB to backups/
./JARVIS.sh --deploy-db --from backups/<file>.sql   # restore a backup
./JARVIS.sh --deploy-db      # (no --from) reset to a FRESH empty database
./JARVIS.sh --help
```

- **Chat UI:** <http://localhost:8110/>
- **Workbench desktop:** <http://localhost:8111/>
- **Tool self-test (no model needed):** `curl http://localhost:8110/api/selftest`

### Terminal & scripting (no browser)

```bash
./JARVIS.sh --terminal                 # interactive chat in the terminal
./JARVIS.sh --prompt "your question"   # one-shot; answer prints to stdout

# Pipe data in — stdin is sent along with the prompt:
cat my_application.log | ./JARVIS.sh --prompt "analyze this log and list the issues"
git diff               | ./JARVIS.sh --prompt "review this diff for bugs"
./JARVIS.sh --prompt "summarize this" < report.txt
```

The final answer goes to **stdout** (pipe-friendly); tool activity goes to **stderr**.
Both reuse the same tool-calling loop as the web UI, so JARVIS can use its DB,
shell, internet, and files while answering.

In the terminal you can also manage saved conversations: `/sessions`, `/save [name]`,
`/load <id>` (continues from that conversation), plus `/reset` and `/exit`.

### Saving & loading conversations (sessions)

In the web UI, the **Sessions ▾** menu (top bar) lets you **save** the current
conversation, **load** a saved one back into the chat to continue where you left
off, **export** it to a `.json` file, **import** one, **delete**, or start a **New**
session. Sessions are stored as JSON under `data/sessions/` (gitignored) and are
also reachable via `/api/sessions`. This is handy for resuming work and for
iterating on the model/prompt against a fixed conversation.

## Configuration — `JARVIS_CONFIG.json`

Copy the template and edit (it is gitignored):

```bash
cp JARVIS_CONFIG_template.json JARVIS_CONFIG.json
```

| Section | Purpose |
| --- | --- |
| `assistant_name` | The AI's name. Sets its identity (substituted into `system_prompt` via `{assistant_name}`), the displayed title, and the voice **wake word** + stop phrase (say this name to start talking). |
| `llm` | `provider` (`openai` / `ollama` / `mock`), `base_url`, `model`, `api_key`, `temperature`, `max_tokens`, `max_tool_iterations`, `system_prompt`. |
| `local_models` | Optional note for local `.gguf`/`.safetensors`; serve them via Ollama and point `llm.base_url` at it. |
| `voice` | `enabled`, `tts`, `stt`, `silence_timeout_seconds`. The wake word and stop phrase derive from `assistant_name` (override with optional `wake_word` / `stop_phrase`). |
| `memory` | MySQL connection the LLM uses as memory (must match the compose db credentials). |
| `workbench` | Workbench container name + the desktop URL embedded in the UI. |
| `shared` | The read-only and read-write shared folder paths. |

**Model examples**

```jsonc
"llm": { "provider": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": "sk-..." }
"llm": { "provider": "ollama", "base_url": "http://host.docker.internal:11434/v1", "model": "llama3.1" }
"llm": { "provider": "mock" }   // offline; tools still work, replies are canned
```

The default local config ships as `mock` so chat works with no key while the tools
(memory, shell, files) are fully live — run the self-test to see them. Switch to
`openai`/`ollama` for real, tool-using responses. After editing the config,
`./JARVIS.sh --stop --start`.

## Voice

Browser-native (Web Speech API), best in **Chrome**; also works in **Safari**.
Toggle it on in the header, then:

- say **"Jarvis"** to start talking;
- after a short silence it sleeps — say **"Jarvis"** again to resume;
- say **"Jarvis stop listening"** to turn the mic off (e.g. in a noisy room).

Replies are spoken back (text-to-speech); the mic pauses while JARVIS talks.
