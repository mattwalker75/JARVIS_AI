# Run local models with Ollama

Ollama runs models on your own machine (macOS / Linux / Windows). JARVIS then talks to it and
never has to know it's local. A helper script manages it: **`./JARVIS_LOCAL_LLM.sh`**.

Print the full guide anytime with: `./JARVIS_LOCAL_LLM.sh config --backend ollama`

## Steps

1. **Install Ollama** — https://ollama.com/download/mac (or `/download` for other OSes).
   Check it: `ollama --version`.

2. **Pull the model(s) you want** — the tag becomes the name you set in JARVIS:
   ```
   ollama pull qwen3:8b          # a chat model
   ollama pull qwen2.5vl:32b     # a VISION model (for screenshots / the vision tier)
   ollama pull nomic-embed-text  # REQUIRED for long-term memory (see note below)
   ollama list                   # list what you've downloaded
   ollama rm qwen3:8b            # delete one to reclaim disk
   ```
   You don't "start" a model — Ollama loads it on demand. You just need it pulled.

> **Long-term memory needs its own model.** JARVIS's semantic memory (add/search) embeds text with
> **`nomic-embed-text`** on your host Ollama (`mem0.embed_base_url`, default `host.docker.internal:11434`)
> — even when your CHAT model is a cloud provider. So Ollama must be **running with `nomic-embed-text`
> pulled** whenever you use memory, or `search_memory`/`add_memory` fails. `./JARVIS.sh --start` now
> checks this and prints the exact steps if the embedder is unreachable.

3. **(optional) Tune** the runtime in the `ollama` block of `config/JARVIS_CONFIG.json`
   (context length, keep-alive, how many models stay resident). You can also edit these in the
   Config tab. Re-run `start` afterward to apply.

4. **Start it + get the URL:**
   ```
   ./JARVIS_LOCAL_LLM.sh start --backend ollama            # prints http://host.docker.internal:11434/v1
   ./JARVIS_LOCAL_LLM.sh start --backend ollama --gateway  # front it with the LiteLLM gateway instead
   ```

5. **Point JARVIS at it:** Config → **Endpoint URL** = that URL, **API key** blank, **Model** (or
   tiers) = your Ollama tag(s), then **Save**.

## Tips

- Ollama's own server routes many models by name, so for pure-Ollama multi-tier you do NOT need
  the gateway — just set each tier (chat/cheap/smart/vision) to a pulled tag.
- Models are stored in `~/.ollama/` (system-wide).
- Multi-tier with several models? Raise `max_loaded_models` so they all stay hot in RAM.
