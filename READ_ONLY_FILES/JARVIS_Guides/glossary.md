# Glossary — what the pieces are

Plain-language definitions of the parts of JARVIS.

- **JARVIS core / the app** — the brain that runs the chat, picks tools, and talks to the model.
  It runs in a container and reaches out to whatever model **endpoint** you configure.

- **Endpoint URL (`base_url`)** — the single address JARVIS sends model requests to. It can be a
  cloud provider (OpenAI/Anthropic/Gemini) or a local runtime. JARVIS doesn't care where the model
  lives — it just talks the OpenAI dialect to this URL.

- **Provider / model** — *provider* is who serves the model (OpenAI, Ollama, MLX…). *Model* is the
  specific one (e.g. `gpt-4o`, `qwen3:8b`).

- **Model mode: single vs multi** — *single* uses one model for everything (best for a capable
  cloud model). *multi* uses separate models per task tier — mainly for LOCAL setups.

- **Tiers (chat / cheap / smart / vision)** — in multi mode, different models for different jobs:
  `chat` = main conversation, `cheap` = fast/background, `smart` = hard reasoning, `vision` = reads
  images. A cloud model is multimodal, so it fills all of these itself.

- **Workbench** — a full Linux desktop in a container where the LLM works as root: runs commands,
  writes/tests code, drives a browser. Watch it live in the **Workbench** tab.

- **/workspace** — the workbench's scratch/build area (in-progress work). Separate from the shared
  folders. Finished deliverables get copied to **/READ_WRITE_FILES**.

- **Shared folders** — **READ_ONLY_FILES** (you → JARVIS, read-only) and **READ_WRITE_FILES**
  (both ways; where JARVIS saves your deliverables and where UI uploads land).

- **Autopilot** — give an objective + time budget and JARVIS works autonomously (build/test/refine)
  until done. See `using-autopilot.md`.

- **Planner** — the live task ledger (objective + checklist) shown above the chat so JARVIS keeps
  its place and resumes correctly after any interruption.

- **Memory** — semantic long-term memory (a database JARVIS owns). It remembers facts about you
  across conversations; browse/prune it in the **Memory** tab.

- **Local runtime (Ollama / MLX)** — software that runs models on your own machine. Managed by
  `./JARVIS_LOCAL_LLM.sh`, which prints a URL you paste into Config.

- **LiteLLM gateway** — an optional piece that puts ONE endpoint in front of several models /
  runtimes (e.g. chat on Ollama + reasoning on MLX, or mixing local + cloud). Started with
  `./JARVIS_LOCAL_LLM.sh --gateway`.

- **`JARVIS.sh`** — the control script for the stack (start/stop/reset/backup). Run
  `./JARVIS.sh --help` to see everything.

- **`JARVIS_LOCAL_LLM.sh`** — the control script for LOCAL model runtimes (Ollama/MLX) and the
  optional gateway.
