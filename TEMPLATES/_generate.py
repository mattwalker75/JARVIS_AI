#!/usr/bin/env python3
"""Generate the example JARVIS_CONFIG / JARVIS_SECRETS templates.

Each config example is the canonical JARVIS_CONFIG_template.json with only its
`llm` block overridden for that scenario — so the full system prompt and all other
sections stay consistent. Re-run after editing the base template:

    python3 TEMPLATES/_generate.py
"""
import json, copy, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "TEMPLATES")
BASE = json.load(open(os.path.join(ROOT, "JARVIS_CONFIG_template.json")))

# Doc keys (start with _) the app ignores; we drop the base llm doc-comments and add
# scenario-specific notes so each example reads cleanly.
LLM_DOC_KEYS = ["_providers", "_provider_keys", "_model_mode_comment", "_models_comment"]


def cfg(scenario, llm_set, llm_del=(), llm_notes=None, top_notes=None):
    c = copy.deepcopy(BASE)
    llm = c["llm"]
    for k in LLM_DOC_KEYS:
        llm.pop(k, None)
    for k in llm_del:
        llm.pop(k, None)
    # apply overrides
    for k, v in llm_set.items():
        llm[k] = v
    # rebuild llm with notes first
    new_llm = {}
    if llm_notes:
        new_llm["_notes"] = llm_notes
    new_llm.update(llm)
    c["llm"] = new_llm
    # top-level scenario banner first
    out = {"_scenario": scenario}
    if top_notes:
        out["_setup"] = top_notes
    out.update(c)
    return out


EMB = ("NOTE: the semantic-memory service (Mem0) uses OpenAI embeddings, which read "
       "llm.api_key. Set api_key to an OpenAI key for memory to work, OR edit "
       "memory/server.py to use a local embedder (e.g. mem0 embedder provider 'ollama', "
       "model 'nomic-embed-text'). Chat itself uses the model configured here.")

SCENARIOS = {
  # --- OpenAI ---
  "single-openai": cfg(
    "Single model, OpenAI directly (no LiteLLM gateway). The simplest setup.",
    {"provider": "openai", "base_url": "https://api.openai.com/v1",
     "model": "gpt-4o-mini", "model_mode": "single", "api_key": "sk-REPLACE_ME"},
    llm_del=["models", "anthropic_api_key", "gemini_api_key"],
    llm_notes="Everything uses 'model'. base_url points straight at OpenAI, so the "
              "jarvis-litellm gateway is not needed (it can stay stopped).",
    top_notes="Copy to ../JARVIS_CONFIG.json, set api_key, then ./JARVIS.sh --start."),

  "openai-tiers": cfg(
    "OpenAI only, multi-tier (cheap/standard/vision/reasoning) via the gateway.",
    {"provider": "openai", "base_url": "http://jarvis-litellm:4000/v1",
     "model": "gpt-4o-mini", "model_mode": "multi", "api_key": "sk-REPLACE_ME",
     "models": {"chat": "gpt-4o-mini", "cheap": "gpt-4o-mini", "vision": "gpt-4o", "smart": "o4-mini"}},
    llm_del=["anthropic_api_key", "gemini_api_key"],
    llm_notes="One provider, different models per task: cheap gpt-4o-mini for background "
              "tasks, gpt-4o for vision, o4-mini for hard reasoning. Add the model_names "
              "you use to litellm/config.yaml."),

  # --- Multi-provider ---
  "multi-model": cfg(
    "Multi-model across providers (OpenAI + Anthropic + Google) via the gateway.",
    {"provider": "openai", "base_url": "http://jarvis-litellm:4000/v1",
     "model": "gpt-4o-mini", "model_mode": "multi", "api_key": "sk-REPLACE_ME",
     "anthropic_api_key": "sk-ant-REPLACE_ME", "gemini_api_key": "REPLACE_ME_optional",
     "models": {"chat": "gpt-4o-mini", "cheap": "gpt-4o-mini", "vision": "gpt-4o", "smart": "claude-sonnet-4-6"}},
    llm_notes="Each tier can be any model_name from litellm/config.yaml. JARVIS.sh "
              "exports these keys to the gateway. Leave a provider's key empty if unused."),

  "anthropic-claude": cfg(
    "Anthropic Claude as the primary model (single), via the gateway.",
    {"provider": "openai", "base_url": "http://jarvis-litellm:4000/v1",
     "model": "claude-sonnet-4-6", "model_mode": "single",
     "api_key": "sk-REPLACE_ME", "anthropic_api_key": "sk-ant-REPLACE_ME"},
    llm_del=["models", "gemini_api_key"],
    llm_notes="Chat runs on Claude. " + EMB),

  # --- Local models ---
  "local-ollama": cfg(
    "Local model via Ollama running on your Mac (no cloud chat).",
    {"provider": "ollama", "base_url": "http://host.docker.internal:11434/v1",
     "model": "llama3.1", "model_mode": "single", "api_key": ""},
    llm_del=["models", "anthropic_api_key", "gemini_api_key"],
    llm_notes="Run `ollama serve` + `ollama pull llama3.1` on the host. provider 'ollama' "
              "sends no auth header. " + EMB,
    top_notes="Requires Ollama on the host. Vision/computer-use needs a vision-capable "
              "local model (e.g. llama3.2-vision / qwen2.5-vl)."),

  "local-openai-compatible": cfg(
    "Local OpenAI-compatible server (LM Studio / llama.cpp server / vLLM).",
    {"provider": "openai", "base_url": "http://host.docker.internal:1234/v1",
     "model": "your-local-model", "model_mode": "single", "api_key": "not-needed"},
    llm_del=["models", "anthropic_api_key", "gemini_api_key"],
    llm_notes="Point base_url at your local server's /v1 (LM Studio default :1234, "
              "llama.cpp `--port`, vLLM :8000). Set model to its served name. " + EMB,
    top_notes="Start your local server with an OpenAI-compatible API first."),

  # --- Offline ---
  "mock-offline": cfg(
    "Offline / no model — 'mock' provider returns canned replies (tools still real).",
    {"provider": "mock", "model": "mock"},
    llm_del=["models", "anthropic_api_key", "gemini_api_key", "base_url"],
    llm_notes="No API calls and no key needed. Chat replies are canned, but every tool "
              "(shell, files, memory, etc.) still works. Good for testing the stack."),
}

for name, data in SCENARIOS.items():
    path = os.path.join(OUT, f"JARVIS_CONFIG.{name}.json")
    json.dump(data, open(path, "w"), indent=2)
    print("wrote", os.path.relpath(path, ROOT))

# --- Secrets examples (independent of the model config) ---
secrets_example = {
  "_comment": "Credential vault example. Copy to ../JARVIS_SECRETS.json. PLAINTEXT by "
              "design. JARVIS reads these via get_secret to operate accounts YOU own; it "
              "can also add/update them itself via set_secret. Never commit real secrets.",
  "secrets": {
    "example-website": {"username": "you@example.com", "password": "REPLACE_ME",
                          "url": "https://example.com/login", "notes": "A site you own a login for"},
    "personal-email": {"username": "you@gmail.com", "password": "REPLACE_ME",
                        "url": "https://mail.google.com", "notes": "Use an app password, not your main one"},
    "github": {"username": "your-handle", "password": "ghp_REPLACE_ME_token",
               "url": "https://github.com", "notes": "A personal access token works as the password"}
  }
}
secrets_empty = {
  "_comment": "Empty vault. Copy to ../JARVIS_SECRETS.json. Add accounts under 'secrets', "
              "or just let JARVIS save them for you via set_secret.",
  "secrets": {}
}
json.dump(secrets_example, open(os.path.join(OUT, "JARVIS_SECRETS.example.json"), "w"), indent=2)
json.dump(secrets_empty, open(os.path.join(OUT, "JARVIS_SECRETS.empty.json"), "w"), indent=2)
print("wrote JARVIS_SECRETS.example.json, JARVIS_SECRETS.empty.json")
