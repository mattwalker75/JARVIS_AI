# Tools

<!-- AUTO-GENERATED — do not edit by hand. Regenerate with:  node app/scripts/gen-tools-md.js -->

The LLM calls tools to do real work. Every tool's schema (name, description,
parameters) is sent to the model each turn; for deeper guidance the model consults
[skills](extending.md#skills). Tools are defined and dispatched in `app/src/tools.js`
(plus `app/src/email.js`, `app/src/mcp.js`, and the browser daemon
`app/src/browserd.py`).

There are **63 built-in tools**, grouped by family below. The descriptions are
the exact text the model sees. [Custom tools](extending.md#custom-tools) and
[MCP servers](extending.md#mcp-servers) add more at runtime (MCP tools appear as
`mcp_<server>_<tool>`).

## Memory (semantic long-term)

### `add_memory(text, metadata?)`

Save a durable fact about the user or the world to your long-term semantic memory (Mem0). It auto-extracts the salient fact(s), dedupes, and makes them searchable by meaning. Use for names, preferences, relationships, places, decisions — anything worth recalling in future conversations.

- `text` (string, required) — The fact(s) to remember, in natural language.
- `metadata` (object) — Optional tags, e.g. {category: 'preference', topic: 'food'} — returned with search results.

### `update_memory(id, text)`

Correct/replace an existing long-term memory IN PLACE (keeps its id). Get the id from search_memory/list_memories. Prefer this over delete+add when a fact changed (moved house, new preference).

- `id` (string, required)
- `text` (string, required) — The corrected fact.

### `search_memory(query, limit?)`

Recall relevant facts from your long-term semantic memory by meaning (not exact match). ALWAYS call this when the user refers to themselves or past context (their name, home, preferences, prior decisions) before answering.

- `query` (string, required) — What you want to recall, in natural language.
- `limit` (integer) — Max memories to return (default 8).

### `list_memories()`

List all stored long-term memories for the user (ids + text). Use to review or before deleting one.

### `delete_memory(id)`

Delete a long-term memory by its id (from search_memory/list_memories).

- `id` (string, required)

### `consolidate_memories()`

MAINTENANCE: clean up the long-term memory store — merge near-duplicate facts and resolve contradictions (keeping the newer/more specific fact) across ALL stored memories, then delete the redundant ones. Use ONLY when the user asks to clean up / consolidate / dedupe your memory, or clearly complains about duplicate memories. Reports how many were updated/deleted.

## Workbench (root Linux shell)

### `run_shell(command, timeout_s?)`

Run a bash command as ROOT in your Linux workbench container. You may install packages (apt-get) and do any work or research. Returns stdout/stderr and the exit code. Commands are killed after timeout_s (default 120s) — pass a larger timeout_s for long builds/installs, and run servers in the background (nohup ... &) instead of foreground. Long output is truncated in the MIDDLE (head+tail kept) with an explicit marker.

- `command` (string, required)
- `timeout_s` (integer) — Max seconds before the command is killed (default 120, max 600).

### `write_workbench_file(path, content)`

Write a text/code file in your workbench (e.g. /LLM_WORKSPACE/app.py; a relative path like app.py resolves under /LLM_WORKSPACE). Use THIS to CREATE a new file (or fully replace a small one) — it's reliable with any content (quotes, backticks, newlines) unlike run_shell heredocs/echo. To CHANGE part of an EXISTING file, prefer edit_workbench_file (safer + cheaper). Then run it with run_shell. (For files you hand to the USER, use write_file -> /LLM_READ_WRITE_FILES instead.)

- `path` (string, required) — Absolute workbench path, e.g. /LLM_WORKSPACE/app.py
- `content` (string, required)

### `edit_workbench_file(path, old_string, new_string, replace_all?)`

Make a TARGETED edit to an existing workbench file by replacing an exact snippet — STRONGLY PREFER this over rewriting the whole file with write_workbench_file when changing existing code. It's safer and cheaper: you only emit the small piece that changes, so you don't reintroduce bugs elsewhere or waste tokens re-writing the whole file. Provide old_string = the exact text to find (copy it verbatim, including indentation/whitespace; include enough surrounding context to be UNIQUE) and new_string = what to replace it with. Fails if old_string is missing or appears more than once (then add more context or set replace_all=true). Read the file first so old_string matches exactly.

- `path` (string, required) — Absolute workbench path, e.g. /LLM_WORKSPACE/doom.html
- `old_string` (string, required) — Exact text to replace (must be unique in the file unless replace_all).
- `new_string` (string, required) — Replacement text (use "" to delete the old text).
- `replace_all` (boolean) — Replace every occurrence instead of requiring a unique match.

### `serve_app(command, port, cwd?)`

Run a web app/server inside the workbench and expose it so the USER can open it in their OWN browser to preview/test it (e.g. before you hand over the code). The app MUST serve a real, interactive HTML page at GET / (a working UI the user can actually use) — NOT just JSON/API endpoints, or the browser shows 'Cannot GET /' and it looks broken. Build the app under /LLM_WORKSPACE, then call this with the command that starts the server BOUND TO 0.0.0.0 on one of the preview ports (9101-9150). The tool reports whether GET / returned 200 (ok_homepage); if it didn't, add the homepage UI and call again BEFORE telling the user it's ready. Returns http://localhost:<port> for the user to visit; the server keeps running in the background. Bind-correct examples: 'python3 -m http.server 9101 --bind 0.0.0.0' (serves files incl. index.html); a Node/Express app that serves a page at '/' and listens on 0.0.0.0:9102; 'flask run --host 0.0.0.0 --port 9103'. Also save the final code to /LLM_READ_WRITE_FILES.

- `command` (string, required) — Command that starts the server, listening on 0.0.0.0:<port>.
- `port` (integer, required) — One of 9101-9150 (exposed to the host browser).
- `cwd` (string) — Working directory to run in (default /LLM_WORKSPACE).

## Files (shared folders)

### `list_dir(path?)`

List a directory inside the shared folders (read-only or read-write).

- `path` (string)

### `read_file(path, offset?, max_chars?)`

Read a TEXT file from the shared folders. Long files are paged: a truncated response tells you the offset to re-call with. Binary files error with a pointer to the right tool (analyze_image / read_document).

- `path` (string, required)
- `offset` (integer) — Character offset to start from (for long files).
- `max_chars` (integer) — Max characters to return (default 50000).

### `read_document(path, offset?, max_chars?)`

Extract the TEXT of a PDF, DOCX, ODT, RTF, EPUB, or HTML document from the shared folders (e.g. a file the user uploaded to /LLM_READ_WRITE_FILES/uploads/ or one you downloaded with fetch_url save_to). Paged: a truncated response tells you the offset to continue from.

- `path` (string, required) — Document path, e.g. /LLM_READ_WRITE_FILES/uploads/report.pdf
- `offset` (integer)
- `max_chars` (integer) — Default 15000.

### `write_file(path, content, append?)`

Write a text file into the read-write shared folder to share it back to the user. By default this OVERWRITES the file; pass append=true to add to the end instead (e.g. for a running log). This tool only reaches the shared folders — to write under the workbench /LLM_WORKSPACE, use write_workbench_file. To CHANGE part of an existing shared file, prefer edit_file.

- `path` (string, required)
- `content` (string, required)
- `append` (boolean) — Append to the end instead of overwriting (default false).

### `edit_file(path, old_string, new_string, replace_all?)`

Make a TARGETED edit to an existing shared file (in /LLM_READ_WRITE_FILES) by replacing an exact snippet — prefer this over rewriting the whole file with write_file. old_string must match verbatim (including whitespace) and be unique unless replace_all=true; new_string is what to put in its place ("" deletes). (For workbench /LLM_WORKSPACE files, use edit_workbench_file.)

- `path` (string, required)
- `old_string` (string, required) — Exact text to replace (unique unless replace_all).
- `new_string` (string, required) — Replacement text ("" to delete).
- `replace_all` (boolean) — Replace every occurrence.

### `append_log(path, message, fields?)`

Append ONE consistently-formatted line to a log file in the read-write shared folder. ALWAYS PREFER THIS over write_file/run_shell for recurring logs (e.g. periodic price checks): the code stamps a uniform ISO-8601 UTC timestamp, keeps each entry to exactly one newline-terminated line, and never lets entries run together — so every run produces identical formatting. Just pass the message (and optional structured fields); do NOT include your own timestamp.

- `path` (string, required) — Log file name/path in the read-write shared folder, e.g. 'bitcoin_price_log.txt'.
- `message` (string, required) — The event text, e.g. 'BTC $59,841.91 WOOOHOOO!'. Keep it to one logical entry.
- `fields` (object) — Optional structured key/values appended as k=v, e.g. {price: 59841.91, signal: 'up'}.

## Internet

### `fetch_url(url, method?, headers?, body?, json?, timeout_s?, offset?, save_to?, raw?)`

HTTP request to any internet URL (GET/POST/PUT/DELETE...). HTML pages come back as clean ARTICLE TEXT with structure preserved (headings/lists/links as markdown) when extractable, else stripped text — pass raw:true for the unprocessed body (e.g. to scrape attributes/markup). Supports custom headers (e.g. Authorization with a token from get_secret), a request body or json payload, a timeout, paging long responses via offset, and saving binary responses (PDF/image/zip) into the shared folder via save_to for analyze_image/read_document.

- `url` (string, required)
- `method` (string) — HTTP method (default GET).
- `headers` (object) — Request headers, e.g. {"Authorization": "Bearer <token>"}.
- `body` (string) — Raw request body (set your own Content-Type header).
- `json` (object) — JSON payload — sent as the body with Content-Type: application/json.
- `timeout_s` (integer) — Max seconds to wait (default 30).
- `offset` (integer) — Character offset for paging a long text response (a truncated response tells you the next offset).
- `save_to` (string) — For binary downloads: a path in the read-write shared folder to save the response to, e.g. 'downloads/report.pdf'.
- `raw` (boolean) — Return the unprocessed body — skip article extraction AND html stripping (for scraping markup).

### `web_search(query, limit?)`

Search the web (DuckDuckGo) and get result titles, URLs, and snippets. Follow up with fetch_url to read a result. If it reports being rate-limited/blocked, that is NOT an empty result — wait and retry or go directly to a known site.

- `query` (string, required)
- `limit` (integer) — Max results (default 8, max 20).

## Browser (deterministic web control)

### `browser_goto(url)`

PREFERRED way to work with websites: open a URL in the agent-controlled browser (visible on the workbench desktop; logins/cookies persist across sessions). Then use browser_snapshot to see the page structure and browser_click/browser_fill to act by SELECTOR — deterministic, no pixel-coordinate guessing. Use the pixel tools (screenshot/click) only for non-browser desktop apps.

- `url` (string, required)

### `browser_snapshot()`

See the current page in the agent browser: URL, title, a text preview, and the visible interactive elements (links, buttons, inputs) each with a short ref (e.g. 'e3') plus tag/text/name. Use the refs (or any CSS selector) with browser_click / browser_fill. Refs go stale after navigation — snapshot again.

### `browser_click(target)`

Click an element in the agent browser by ref from browser_snapshot (e.g. 'e3') or any CSS selector (e.g. 'button[type=submit]', 'text=Sign in'). Returns the resulting URL/title.

- `target` (string, required) — Snapshot ref like 'e3' or a CSS/Playwright selector.

### `browser_fill(target, text, press_enter?)`

Type into an input/textarea in the agent browser by ref or CSS selector (clears it first). Set press_enter=true to submit afterwards.

- `target` (string, required)
- `text` (string, required)
- `press_enter` (boolean) — Press Enter after filling (submit).

### `browser_press(key)`

Press a keyboard key in the agent browser (sent to the current page's focused element) — e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'PageDown', 'Control+a'. Use after browser_click/browser_fill for keyboard-driven UI (menus, dialogs, infinite scroll).

- `key` (string, required) — Playwright key name or chord, e.g. 'Enter', 'Escape', 'Control+a'.

### `browser_back()`

Go BACK one page in the agent browser's history (like the browser Back button). Returns the resulting URL/title.

### `browser_extract(selector?, offset?)`

Extract the visible TEXT of the current page in the agent browser (or of one element via a CSS selector). Long text is paged via offset. Use this to READ page content — it is exact, unlike the vision screenshot.

- `selector` (string) — Optional CSS selector (default: whole page body).
- `offset` (integer) — Character offset for paging.

### `browser_console(limit?, clear?)`

Get the browser's JavaScript CONSOLE output + uncaught runtime errors for the page currently open in the agent browser. THE way to debug a running web app that renders wrong or blank (e.g. a black canvas): browser_goto the app, then call this to see the exact error (e.g. 'Uncaught TypeError: … at render()') instead of guessing from the static HTML. browser_goto also auto-includes load-time errors in its result. Returns recent messages + the error/pageerror entries.

- `limit` (integer) — Max recent messages to return (default 100).
- `clear` (boolean) — Clear the buffer after reading.

### `browser_screenshot(question?)`

SEE the page currently open in the agent browser: captures a screenshot of the page viewport and runs it through the vision model, returning a text description (layout, visible elements, rendering problems). Use for VISUAL questions the DOM can't answer — does the layout look right, is the canvas blank, what does the chart show. For reading exact text use browser_extract, and for element refs use browser_snapshot (both are cheaper and exact). Optionally pass 'question' to focus the analysis.

- `question` (string) — Optional: what to look for in the page screenshot.

## Planning (task ledger) & Autopilot

### `plan_create(objective, steps)`

Start a persistent PLAN (task ledger) for a multi-step job — anything that will take several tool calls (build/fix an app, research + produce a report, multi-file changes). Give a one-line 'objective' and an ordered 'steps' array of short step descriptions. The plan is saved to disk and shown to you at the START of EVERY following turn, so you never lose track and resume from the first incomplete step even after an interruption. Creating a new plan replaces any previous one. Do NOT use for trivial one-shot requests.

- `objective` (string, required) — One-line statement of the overall goal.
- `steps` (array, required) — Ordered list of short, concrete, verifiable steps.

### `plan_update(step, status?, note?)`

Update a step in the active plan as you work — call this AS SOON AS a step's status changes so the ledger stays accurate. 'step' is the step number. 'status' is one of pending | active | done | blocked. Optionally attach a short 'note' (result, blocker reason, or link). Marking a step done auto-activates the next one.

- `step` (number, required) — The step number to update.
- `status` (string) — New status for the step.
- `note` (string) — Optional short note (result/blocker).

### `plan_add_step(text, after?)`

Add a new step to the active plan when the work turns out to need one you didn't foresee. Optionally pass 'after' (an existing step number) to insert it right after that step; otherwise it's appended at the end.

- `text` (string, required) — The new step description.
- `after` (number) — Insert after this step number (optional).

### `plan_show()`

Return the current active plan (objective + steps with their statuses). NOTE: your active plan is ALREADY shown to you at the top of every turn, so you rarely need this — do not call it just to re-read the plan; only use it in a fresh/standalone context where the plan isn't already in view.

### `plan_clear()`

Clear/close the active plan when the whole objective is complete or abandoned.

### `open_autopilot(objective, minutes?, autonomy?)`

Hand a SUBSTANTIAL multi-step task off to AUTOPILOT — an autonomous build→test→refine loop that runs server-side so the user can walk away. FLOW: when you're about to take on (or have just outlined) a big multi-step job, OFFER it: ask the user something like "Want me to run this on Autopilot so you can step away while I work?" Call this tool ONLY after they say yes. It opens the Autopilot launcher in the UI PRE-FILLED with your objective; the user then confirms the time budget + autonomy and clicks Start (you do NOT start it yourself). Use for real multi-step build/research/automation work and for follow-up improvement plans — NOT for quick answers you can just give in chat.

- `objective` (string, required) — A clear, self-contained mini-spec for the autonomous run — it CANNOT ask you questions once started, so state exactly what to build/do, the key features/requirements, any constraints, and where to save the output.
- `minutes` (number) — Suggested time budget in minutes (the user can change it). Default 30.
- `autonomy` (string) — Suggested autonomy: 'guarded' (won't take irreversible external actions on its own) or 'full'. Default guarded.

## Sub-agent delegation

### `delegate(task, context?, tier?)`

Hand ONE self-contained SUBTASK to a sub-agent that runs in its own FRESH context with the full toolset and returns only its final report — keeping THIS conversation's context small. Use for research sweeps, long document reads, or multi-step side quests whose intermediate output you don't need in your own context. The sub-agent CANNOT see this conversation: write the task like a brief to a colleague — the goal, exact inputs (paths/URLs/ids), constraints, and what the report must contain. Its tool activity streams to the Activity panel prefixed 'sub▸'. NOT for trivial one-tool actions (just call the tool), and a sub-agent cannot delegate further.

- `task` (string, required) — Self-contained brief: goal, inputs (paths/URLs), constraints, and the expected report content.
- `context` (string) — Optional extra background the sub-agent needs (it can't see this conversation).
- `tier` (string) — Model tier for the sub-agent (default chat; cheap for mechanical sweeps, smart for hard analysis).

## Vision, audio & desktop (computer use)

### `screenshot(question?)`

Look at the current desktop screen. This captures the screen and returns a TEXT analysis from a vision model: a description of what is visible plus the interactive elements (buttons, links, fields, icons, tabs) with their approximate CENTER pixel coordinates (x, y from the top-left). Use those coordinates with click/type/move_mouse to act. Optionally pass 'question' to focus the analysis (e.g. 'where is the address bar?', 'what are the search results?'). Take a screenshot to locate elements before acting, and again afterward to verify the result. The screen is 1024x768.

- `question` (string) — Optional: focus the visual analysis on a specific question about the screen.

### `analyze_image(path, question?)`

Look at / analyze an image FILE with the vision model — describe it, read text in it, or answer a question about it. Use this for images the user uploaded (they land in /LLM_READ_WRITE_FILES/uploads/) or any image in the shared folders. Pass the image's path and an optional question.

- `path` (string, required) — Path to the image, e.g. /LLM_READ_WRITE_FILES/uploads/photo.jpg
- `question` (string) — Optional: what to focus on or ask about the image.

### `transcribe_audio(path, language?, model_size?)`

Transcribe SPEECH from an audio or video file to text (fully local — faster-whisper on the workbench CPU; ffmpeg handles most formats: mp3, m4a, wav, ogg, webm, mp4, mov…). Point it at a file in the shared folders (user uploads land in /LLM_READ_WRITE_FILES/uploads/) or /LLM_WORKSPACE. Long recordings return [mm:ss]-stamped lines. First use downloads the model (~75MB); expect roughly real-time speed on CPU.

- `path` (string, required) — Audio/video file path, e.g. /LLM_READ_WRITE_FILES/uploads/memo.m4a
- `language` (string) — Optional ISO language hint, e.g. 'en' (default: auto-detect).
- `model_size` (string) — Whisper model size (default base; small/medium = better but slower).

### `ui_actions(actions)`

Perform a SEQUENCE of desktop UI actions in ONE call — far fewer round-trips than separate click/type/key calls. After a screenshot gives you element coordinates, use this to run the whole plan at once, e.g. click a field → type text → press Enter. A short settle delay runs between steps; the sequence STOPS at the first failing step and reports it. Screen is 1024x768; screenshot again afterward to verify. Each step is one of: {action:'click'|'double_click'|'right_click'|'move', x, y} , {action:'type', text} , {action:'key', keys:'Return'} , {action:'scroll', direction:'up'|'down', amount} , {action:'sleep', ms}. NOTE: for actions INSIDE a web page, prefer the browser_* tools (deterministic selectors) over pixel clicking.

- `actions` (array, required) — Ordered list of action steps to perform in sequence.

### `open_url(url)`

Open a URL in the Chromium browser on the desktop.

- `url` (string, required)

### `open_app(command)`

Launch a GUI application on the desktop (e.g. 'chromium', 'xterm', 'thunar').

- `command` (string, required)

### `click(x, y)`

Left-click at pixel (x, y) on the desktop.

- `x` (number, required)
- `y` (number, required)

### `double_click(x, y)`

Double-click at pixel (x, y).

- `x` (number, required)
- `y` (number, required)

### `right_click(x, y)`

Right-click at pixel (x, y).

- `x` (number, required)
- `y` (number, required)

### `move_mouse(x, y)`

Move the mouse to pixel (x, y) without clicking.

- `x` (number, required)
- `y` (number, required)

### `type_text(text)`

Type text at the current keyboard focus (e.g. into a focused form field or address bar).

- `text` (string, required)

### `press_key(keys)`

Press a key or chord using xdotool keysyms, e.g. 'Return', 'Tab', 'ctrl+l', 'ctrl+t', 'BackSpace'.

- `keys` (string, required)

### `scroll(direction, amount?)`

Scroll the mouse wheel up or down by an amount (wheel clicks).

- `direction` (string, required)
- `amount` (number)

## Email (the user's own account)

### `check_email(folder?, limit?, unseen_only?)`

List recent messages in the user's OWN email inbox (headers: from/subject/date/uid). Requires an 'email' secret in the vault ({username, password, imap_host, smtp_host} — app password for Gmail/Outlook). Use read_email with a uid to get a message body. Great in scheduled tasks: 'tell me when X emails me'.

- `folder` (string) — Mailbox (default INBOX).
- `limit` (integer) — Max messages (default 10).
- `unseen_only` (boolean) — Only unread messages.

### `read_email(uid, folder?)`

Read ONE email's full body (+attachment names) by uid from check_email.

- `uid` (integer, required)
- `folder` (string) — Mailbox (default INBOX).

### `send_email(to, subject, body)`

Send a plain-text email FROM the user's own account (the 'email' secret). Confirm with the user before sending anything they haven't explicitly asked you to send.

- `to` (string, required)
- `subject` (string, required)
- `body` (string, required)

## Scheduling & notifications

### `schedule_task(prompt, in_seconds?, at?, every_seconds?, until?, label?)`

Schedule a task to run later. Provide the task as a 'prompt' (what JARVIS should do when it runs). Use IN_SECONDS for a delay (e.g. 'in 10 minutes' -> 600), AT for an absolute ISO time (e.g. 'at 5pm' -> compute today's ISO datetime from the current time you were given), or EVERY_SECONDS for a recurring task (e.g. 'every 5 minutes' -> 300) with an optional natural-language 'until' stop condition. The current date/time is provided to you in context. IMPORTANT: the prompt is run by the model THROUGH ITS TOOLS at run time (it is NOT executed as literal code). Write a clear, concrete, VERIFIABLE instruction — name the exact tool/command and the exact file path. For deterministic jobs (data fetch + log to a file), prefer a single explicit run_shell command, e.g. 'Run exactly this with run_shell and report its output: <shell command using >> to append>'. Use real API ids/paths. Each run is a fresh, stateless conversation, so the prompt must be self-contained. A task CAN see the live conversation via read_recent_chat — e.g. to check whether the user has replied (roles:["user"]) so it can escalate an unanswered prompt, or to review its own recent posts to avoid repeating itself — so requests like 'notice if I'm not answering and escalate' ARE doable; author the prompt to use read_recent_chat, don't refuse them.

- `prompt` (string, required) — What to do when the task runs — a clear, concrete, self-contained instruction (the model executes it via its tools, not as literal code).
- `in_seconds` (number) — Run once after this many seconds.
- `at` (string) — Run once at this ISO 8601 datetime.
- `every_seconds` (number) — Recurring: run every this many seconds.
- `until` (string) — Recurring stop condition in plain language; the task stops when met (it notifies you).
- `label` (string) — Short label for the task.

### `list_tasks()`

List the user's scheduled/recurring tasks that are still active.

### `update_task(id, prompt?, label?, every_seconds?, until?, in_seconds?, at?)`

Change an EXISTING scheduled task IN PLACE (it keeps running). ALWAYS use this to modify a task — do NOT cancel_task + schedule_task, which stops the original. Get the id from list_tasks. Only the fields you pass are changed; omit the rest to keep them (e.g. change just the prompt and the recurring schedule is preserved).

- `id` (string, required) — Task id from list_tasks.
- `prompt` (string) — New instruction for the task.
- `label` (string)
- `every_seconds` (number) — New recurring interval.
- `until` (string) — New stop condition (plain language); pass empty to clear.
- `in_seconds` (number) — Re-time the NEXT run to this many seconds from now.
- `at` (string) — Re-time the next run to this ISO datetime.

### `cancel_task(id)`

Cancel a scheduled task by id (e.g. when the user says to stop it). To CHANGE a task without stopping it, use update_task instead.

- `id` (string, required)

### `notify_user(message, level?)`

Send a notification to the user (shows in the app and as a desktop notification). Use it to alert the user about a result or when a monitored condition is met.

- `message` (string, required)
- `level` (string)

### `post_to_chat(message)`

Post a message directly into the user's live chat conversation window (it appears as a message from you in the web chat). Use this when a task should speak up in the conversation, e.g. to report an outcome or ask a follow-up. For a passive alert/badge instead, use notify_user.

- `message` (string, required)

### `read_recent_chat(since_minutes?, roles?, limit?)`

Read recent messages from the user's live chat conversation (oldest→newest, each with an ISO timestamp). This is how a scheduled/background task can SEE the conversation it otherwise can't: use roles:["user"] to check whether the USER has replied lately (e.g. to decide whether to escalate an unanswered prompt), or look at your own recent role:"task"/"assistant" posts to avoid repeating yourself. Returns [{at, role, text}]. Roles are "user", "assistant", "task".

- `since_minutes` (number) — Only return messages from the last N minutes (omit for the most recent regardless of age).
- `roles` (array) — Filter to these roles, e.g. ["user"] to see only the user's replies.
- `limit` (number) — Max messages to return (default 30).

## Credential vault

### `list_secrets()`

List saved credential names (with usernames/urls/notes, NOT passwords) from the user's vault. These are the user's OWN accounts.

### `get_secret(name)`

Get a saved credential (including password) by name, to log in to the user's own account.

- `name` (string, required)

### `set_secret(name, username?, password?, url?, notes?)`

Create or update a saved credential in the user's vault (e.g. after the user gives you a login for one of their own accounts, or after you change a password on a site they own). Only the fields you pass are updated.

- `name` (string, required)
- `username` (string)
- `password` (string)
- `url` (string)
- `notes` (string)

### `delete_secret(name)`

Delete a saved credential from the vault by name.

- `name` (string, required)

## Skills (playbook knowledge base)

### `list_skills()`

List your available skill playbooks (name + category + summary). Skills are detailed how-to guides for your capabilities and common workflows.

### `get_skill(name)`

Get the full step-by-step playbook for a skill by name (from list_skills). Read the relevant skill before doing an unfamiliar or multi-step task.

- `name` (string, required)

---

Vault policy: JARVIS operates accounts **you already own**; it does not create
accounts or bypass CAPTCHA / phone verification. See [Extending](extending.md) for
adding custom tools, MCP servers, and email setup.
