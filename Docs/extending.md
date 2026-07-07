# Extending JARVIS

JARVIS is built to grow without editing core code. Five extension points, cheapest
first.

## Custom tools

Drop a JS module in **`data/custom_tools/`** and restart the app — the tool appears in
the model's toolset automatically. No core edits, no image rebuild. A template ships
at `data/custom_tools/EXAMPLE.js.template`.

```js
// data/custom_tools/dice.js
module.exports = {
  name: "roll_dice",
  description: "Roll N six-sided dice and return the results.",
  parameters: {
    type: "object",
    properties: { n: { type: "integer", description: "How many dice (default 1)." } },
    required: [],
  },
  retryable: false,            // true only for read-only / idempotent tools
  handler: async (args) => {
    const n = Math.min(100, Math.max(1, Number(args.n) || 1));
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
  },
};
```

Then `./JARVIS.sh --reload`. The handler runs **in the app container** (Node.js) and
can `require` anything the app has.

### Model-authored tools
Set `custom_tools.allow_model_authored: true` in config to **also** load
`/READ_WRITE_FILES/custom_tools/*.js` — files JARVIS itself can write. Powerful
("write yourself a tool that does X"), but it's arbitrary code executing in the app
container, so it's **off by default**. Enable it deliberately.

## MCP servers

Plug in any external [MCP](https://modelcontextprotocol.io/) tool server (HTTP /
Streamable-HTTP transport). Add to config:

```jsonc
"mcp": {
  "servers": [
    { "name": "github", "url": "http://host.docker.internal:9300/mcp",
      "headers": { "Authorization": "Bearer ghp_..." } }
  ]
}
```

On start, the app handshakes each server and registers its tools as
`mcp_<server>_<tool>`. A dead server is logged and skipped (never blocks startup).
Restart to pick up config changes. Implementation: `app/src/mcp.js`.

## Personas

Alternate system prompts, switchable per conversation. In config:

```jsonc
"personas": {
  "work":  { "system_prompt": "You are JARVIS in work mode. Terse, formal, cite sources." },
  "brief": { "append": "Always answer in 2 sentences or fewer." }
}
```
- `system_prompt` **replaces** the base prompt; `append` **adds** to it.
- Switch in the UI with `/persona work` (`/persona off` to clear, `/persona` to list).
- Or per request: pass `"persona": "work"` to `POST /api/chat` or the WebSocket.

Great for a strict tool-runner persona on scheduled tasks vs. a chatty one for you.

## Models & providers

The **LiteLLM gateway** (`litellm/config.yaml`) is the multi-provider layer. Add a
model by adding a `model_name` entry, then reference it by that name in
`llm.model` / `llm.models`.

```yaml
# litellm/config.yaml
model_list:
  - model_name: my-local-mistral
    litellm_params:
      model: ollama_chat/mistral
      api_base: http://host.docker.internal:11434
  - model_name: claude-opus-4-8
    litellm_params:
      model: anthropic/claude-opus-4-8
      api_key: os.environ/ANTHROPIC_API_KEY
```

Then in `JARVIS_CONFIG.json`: `"models": { "smart": "claude-opus-4-8", ... }`.
Provider keys are exported from your config on `--start`. Restart the gateway after
editing (`docker compose restart jarvis-litellm`).

Notes:
- Local chat models use the `ollama_chat/` prefix; local **vision** models also need
  `ollama_chat/` (plain `ollama/` requires Pillow, which the gateway image lacks).
- To bypass the gateway entirely, point `llm.base_url` at Ollama or OpenAI directly.

## Skills

Skills are on-demand **how-to playbooks** the model reads before unfamiliar or
multi-step tasks — decision rules and known-good templates, not tool re-listings.
The model calls `list_skills()` then `get_skill(name)`.

Skills are an in-memory catalog in `app/src/skills_data.js`, served by
`app/src/skills.js`. Edit the data file and reload (`./JARVIS.sh --reload`) to change
a playbook. The 18 skills cover: memory, the workbench shell, the internet, the
browser tools, vision, scheduling, task-authoring, data-analysis, error-recovery,
credentials, email, document reading, document/image creation, shared files,
web-preview, desktop control, and the login/monitor workflows.

### Auto-hinting

Because a capable model often doesn't call `list_skills`/`get_skill` on its own, JARVIS
can **nudge** it: each turn it keyword-matches your message against the skills
(`TRIGGERS` in `skills.js`) and, if one is relevant, injects a one-line hint right
before your message — e.g. *"get_skill('browser') has a playbook for this…"*.

- **On/off:** `skills_autohint` in config (default `true`), or `/hints on|off` in the
  UI (persists). Also settable via `POST /api/settings`.
- **Add a trigger** for a skill by editing the `TRIGGERS` map in `app/src/skills.js`.
- **Honest caveat:** it's a *soft* nudge, not a forcing function. In testing, a
  confident local model (qwen3-next) frequently proceeded directly anyway — and often
  did the right thing straight from the tool descriptions. Auto-hinting is a cheap
  backstop for harder/unfamiliar tasks and for models that do consult skills; it
  costs a few tokens only on turns that match. If you'd rather it never fire, set
  `skills_autohint: false`.

> **What actually drives this model's behavior:** the always-on **tool descriptions**,
> more than the on-demand skills. If a capability behaves poorly, sharpening the tool's
> `description` in `app/src/tools.js` usually helps more than writing a skill.

> **Roadmap note:** skills are defined in JS and loaded at startup. Making them
> file-based/user-editable (a mounted folder, hot-reload) and adding an `add_skill`
> tool so JARVIS can codify its own workflows is a planned improvement.

## Email setup

To enable the `check_email` / `read_email` / `send_email` tools, save a vault secret
named `email` (ask JARVIS to `set_secret`, or edit `JARVIS_SECRETS.json`):

```json
{
  "email": {
    "username": "you@gmail.com",
    "password": "APP-PASSWORD",
    "imap_host": "imap.gmail.com",
    "smtp_host": "smtp.gmail.com"
  }
}
```
Use an **app password** for Gmail/Outlook (not your login password). Optional fields:
`imap_port` (993), `smtp_port` (465), `from`.
