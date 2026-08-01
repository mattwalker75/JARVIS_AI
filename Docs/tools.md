# Tools

The LLM calls tools to do real work. Every tool's schema (name, description,
parameters) is sent to the model each turn; for deeper guidance the model consults
[skills](extending.md#skills). Tools are defined and dispatched in `app/src/tools.js`
(plus `app/src/email.js`, `app/src/mcp.js`, and the browser daemon
`app/src/browserd.py`).

Below, tools are grouped by family. There are ~48 built-in tools; custom and MCP
tools add more at runtime.

## Memory (semantic long-term)

| Tool | Purpose |
| --- | --- |
| `add_memory(text, metadata?)` | Save a durable fact. Optional metadata tags come back on search. |
| `search_memory(query, limit?)` | Recall facts by meaning; returns text, score, timestamp, metadata. |
| `update_memory(id, text)` | Correct a fact in place (keeps its id). |
| `list_memories()` | List all stored memories (ids + text). |
| `delete_memory(id)` | Remove a memory. |

## Workbench (root Linux shell)

| Tool | Purpose |
| --- | --- |
| `run_shell(command, timeout_s?)` | Run bash as **root** in the workbench. Killed after `timeout_s` (default 120s, max 600). Long output keeps head **and tail** with a truncation marker. A hard Stop kills the in-flight command. |
| `write_workbench_file(path, content)` | Reliably **create** a file under `/LLM_WORKSPACE` (base64-piped — no quoting issues). A **relative path** is accepted and resolved under `/LLM_WORKSPACE`. |
| `edit_workbench_file(path, old_string, new_string, replace_all?)` | **Targeted** find-and-replace in an existing workbench file — preferred over rewriting the whole file (safer, cheaper, fewer new bugs). Also accepts a **relative path** (resolved under `/LLM_WORKSPACE`). |
| `serve_app(command, port, cwd?)` | Start a web app in the workbench on a preview port (9101–9150) the browser can open. Reports whether GET / serves a real page, and warns if a static server is pointed at a folder with no `index.html`. |

## Files (shared folders)

| Tool | Purpose |
| --- | --- |
| `list_dir(path)` | List a shared folder (returns names, sizes, mtimes). |
| `read_file(path, offset?, max_chars?)` | Read a text file, paged. Errors on binary with a pointer to the right tool. |
| `read_document(path, offset?, max_chars?)` | Extract text from PDF / DOCX / ODT / RTF / EPUB / HTML, paged. |
| `write_file(path, content, append?)` | Write a file into the read-write shared folder (deliverables). Given a **directory** path it returns an actionable error ("include a filename") instead of a raw `EISDIR`. |
| `edit_file(path, old_string, new_string, replace_all?)` | Targeted find-and-replace in an existing shared file (the `/LLM_READ_WRITE_FILES` counterpart of `edit_workbench_file`). |
| `append_log(path, message, fields?)` | Append one uniformly-formatted, timestamped log line. |

## Internet

| Tool | Purpose |
| --- | --- |
| `fetch_url(url, method?, headers?, body?, json?, timeout_s?, offset?, save_to?)` | HTTP request to any URL. Supports auth headers, JSON bodies (→ use vault tokens against APIs), paging, and saving binary downloads to the shared folder. SSRF-guarded on every redirect hop. |
| `web_search(query, limit?)` | DuckDuckGo search → titles, URLs, snippets. Reports explicitly when rate-limited (vs. empty results). |

## Browser (deterministic web control)

The preferred way to work with websites — DOM selectors, not pixel guessing. Backed
by a persistent, **visible** Chromium in the workbench (logins persist under
`/LLM_WORKSPACE/.browser_profile`). Started automatically on first use.

| Tool | Purpose |
| --- | --- |
| `browser_goto(url)` | Open a URL. Also reports any load-time JavaScript errors. |
| `browser_snapshot()` | See the page: URL, title, text preview, and interactive elements each with a short `ref` (e.g. `e3`). |
| `browser_click(target)` | Click by `ref` or CSS/Playwright selector. |
| `browser_fill(target, text, press_enter?)` | Type into a field (optionally submit). |
| `browser_extract(selector?, offset?)` | Extract exact page/element text, paged. |
| `browser_console(limit?, clear?)` | Get the page's JavaScript **console output + uncaught runtime errors** — the way to debug a running web app that renders wrong or blank. |

## Planning (task ledger)

Used to keep a persistent objective + checklist that survives interruptions. See
[Autopilot & the Planner](autopilot.md).

| Tool | Purpose |
| --- | --- |
| `plan_create(objective, steps[])` | Start a plan (replaces any existing one). |
| `plan_update(step, status, note?)` | Set a step `pending`/`active`/`done`/`blocked` (done auto-activates the next). |
| `plan_add_step(text, after?)` | Add a newly-discovered step. |
| `plan_show()` | Return the current plan (rarely needed — it's shown every turn). |
| `plan_clear()` | Close the plan when the objective is complete. |
| `open_autopilot(objective, minutes?, autonomy?)` | Offer to run a big multi-step job on **Autopilot**: opens the launcher **pre-filled** with a self-contained objective (plus a suggested time budget + autonomy) for you to confirm and press Start. It never auto-starts a run. See [Autopilot](autopilot.md#jarvis-can-offer-to-run-it). |

## Vision & desktop (computer use)

For non-browser desktop apps and screen understanding.

| Tool | Purpose |
| --- | --- |
| `screenshot(question?)` | Capture the desktop; a vision model returns a text description + element coordinates. Optional focused `question`. |
| `analyze_image(path, question?)` | Analyze an image **file** (uploads land in `/LLM_READ_WRITE_FILES/uploads/`) with the vision model. |
| `ui_actions(actions[])` | Run a **sequence** of desktop actions in one call (click/type/key/scroll/…). Stops at the first failing step; max 50. |
| `click` / `double_click` / `right_click` / `move_mouse` (x, y) | Single mouse actions. |
| `type_text(text)` / `press_key(keys)` | Keyboard input (`press_key` supports sequences like `ctrl+a BackSpace`). |
| `scroll(direction, amount?)` | Mouse-wheel scroll. |
| `open_url(url)` / `open_app(command)` | Launch Chromium / a GUI app on the desktop. |

## Email (your own account)

Requires a vault secret named `email` (see [Extending](extending.md#email-setup)).

| Tool | Purpose |
| --- | --- |
| `check_email(folder?, limit?, unseen_only?)` | List recent messages (from/subject/date/uid). |
| `read_email(uid, folder?)` | Read one message's body + attachment names. |
| `send_email(to, subject, body)` | Send plain-text mail from your account. |

## Scheduling & notifications

| Tool | Purpose |
| --- | --- |
| `schedule_task({prompt, in_seconds?/at?/every_seconds?, until?, label?})` | Schedule a one-shot or recurring task. |
| `list_tasks()` / `update_task(...)` / `cancel_task(id)` | Manage scheduled tasks. |
| `notify_user(message, level?)` | Passive alert/badge (also the stop signal for recurring tasks). |
| `post_to_chat(message)` | Post a message straight into the live chat window. |
| `read_recent_chat({since_minutes?, roles?, limit?})` | See recent chat (e.g. whether the user replied) — for scheduled tasks. |

See [Memory & Scheduling](memory-and-scheduling.md).

## Credential vault

| Tool | Purpose |
| --- | --- |
| `list_secrets()` | Names/usernames/urls only. |
| `get_secret(name)` | Full secret (to log in). |
| `set_secret(name, fields)` / `delete_secret(name)` | Manage secrets. |

Policy: JARVIS operates accounts **you already own**; it does not create accounts or
bypass CAPTCHA / phone verification.

## Skills (knowledge base)

| Tool | Purpose |
| --- | --- |
| `list_skills()` | List available how-to playbooks. |
| `get_skill(name)` | Read one before an unfamiliar/multi-step task. |

## Runtime-added tools

- **Custom tools** — from `data/custom_tools/*.js`, appear under their own names.
- **MCP tools** — from configured servers, appear as `mcp_<server>_<tool>`.

See [Extending](extending.md).
