# Memory & Scheduling

Two of the things that make JARVIS feel like an assistant rather than a chatbot:
it **remembers** across conversations, and it can **do things on a schedule**.

---

## Semantic memory

JARVIS has real long-term memory via the `jarvis-memory` sidecar — a FastAPI wrapper
(`memory/server.py`) around [Mem0](https://github.com/mem0ai/mem0), backed by a local
**Chroma** vector store. Facts are embedded and recalled by **meaning**, not exact
match.

### How the model uses it
- `add_memory("Matt prefers dark mode")` — save a fact.
- `search_memory("what are my UI preferences")` — recall by meaning (always called
  before answering anything personal).
- `update_memory(id, "...")` — correct a fact in place.
- `list_memories()` / `delete_memory(id)` — manage.

The chat model decides *what* is worth remembering; `mem0.infer` is `false` by default,
so a fact is embedded directly (fast, and works with any model) rather than running
Mem0's own LLM extraction stages.

### The embedder (separate model)
Embeddings need a dedicated model, not the chat model. Configure it under `mem0`:
- Local: `embed_model: "nomic-embed-text"`, `embed_base_url: <Ollama /v1>`.
- Cloud: `embed_model: "text-embedding-3-small"` (uses `llm.api_key`).

### Embedder namespacing (important)
The Chroma collection is named per embed model — e.g. `jarvis_nomic_embed_text`.
Different embedders produce different vector dimensions, and mixing them in one
collection silently corrupts search. Namespacing means **switching embedders lands in
a fresh collection** (the old one stays on disk) instead of breaking memory in a
confusing way. On first start after upgrading, a legacy `jarvis` collection is
migrated automatically. The active collection is printed in the memory container log.

### Browse & prune in the UI
The **Memory** tab lists everything JARVIS remembers, with a filter box and delete
buttons. Or use `/remember <fact>` in chat to save one directly.

### Backup / restore
The store is a Docker volume (wiped by `--delete`). Back it up:
```bash
./JARVIS.sh --backup-memory
./JARVIS.sh --restore-memory --from backups/<file>.tgz
```

---

## Scheduling

Ask in plain language and JARVIS schedules the work; the scheduler
(`app/src/scheduler.js`, inside the app) runs due tasks through the same tool loop and
notifies you. Tasks persist to `data/tasks.json` and survive restarts.

### Kinds of task
- **One-shot, delay:** *"summarize my unread email in 10 minutes"* → runs once in 600s.
- **One-shot, absolute:** *"back up my notes at 5pm"* → runs once at 5pm today.
- **Recurring + stop condition:** *"every 5 minutes, check the error log and alert me
  if anything looks critical — until I say stop"* → runs every 300s and **stops when it
  notifies you** (condition met) or when you cancel it.

Recurring runs advance from the scheduled slot (no drift), collapse missed runs after
downtime into a single catch-up, and recover cleanly if the app restarts mid-run.

### Managing tasks
- In chat: *"what's scheduled?"* (`list_tasks`), *"stop the log monitor"* (`cancel_task`).
- In the **Tasks** tab: see active tasks, cancel with a click, review notifications,
  and **quick-add** a task without chatting.

### Where results go
A task chooses its output:
- `post_to_chat(msg)` — speak into the live chat window,
- `notify_user(msg)` — a passive alert/badge (and the **stop signal** for recurring tasks),
- `append_log`/`write_file` to `/READ_WRITE_FILES` — a persistent file.

Notifications appear in-app (🔔), as a browser notification, spoken (if audio is on),
and as a desktop toast on the workbench.

### Chat-awareness
Scheduled tasks run stateless, but they can call `read_recent_chat({roles:["user"]})`
to see whether you've replied lately — which is how "escalate to warning/urgent if I'm
not answering" works. They can also review their own recent posts to avoid repeating
themselves.

> The scheduler runs **inside the app container**. Tasks fire while it's up; if it's
> down they wait in `data/tasks.json` and catch up on the next `--start`.
