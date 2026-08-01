# Switching the model or provider

JARVIS talks to **whatever endpoint you point it at** — a cloud provider (ChatGPT/OpenAI,
Anthropic, Gemini) or a local runtime (Ollama, MLX). You change it in the **Config** tab; saving
applies **live** (no restart) for ordinary settings.

## The two fields that matter

- **Endpoint URL** (`llm.base_url`) — where the model lives.
- **Model** (single mode) or the **chat/cheap/smart/vision tiers** (multi mode) — which model name(s).
- **API key** — only for cloud providers (local runtimes need none).

## Switch to a CLOUD model (e.g. ChatGPT/OpenAI)

1. Open **Config**.
2. **Endpoint URL** → `https://api.openai.com/v1` (Anthropic/Gemini have their own URLs).
3. **API key** → your key (click **Show** to check it).
4. **Model mode** → `single` is best for a capable cloud model (it handles chat + vision in one).
5. **Model** → e.g. `gpt-4o` or `gpt-4.1`. Click **List models** to pull your account's list.
6. **Save** — applies on your next message.

## Switch to a LOCAL model (Ollama or MLX)

Local runtimes run on your computer, outside JARVIS. First get the runtime up and get its URL:

- **Ollama:** see `local-models-ollama.md` → run `./JARVIS_LOCAL_LLM.sh start` → it prints a URL
  like `http://host.docker.internal:11434/v1`.
- **MLX (Apple Silicon):** see `local-models-mlx.md` → bring a model online with
  `./JARVIS_LOCAL_LLM.sh mlx-serve <model>`, then `./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway`.

Then in **Config**:
1. **Endpoint URL** → paste the URL the script printed.
2. **API key** → leave blank (local needs none).
3. **Model / tiers** → the local model name (an Ollama tag like `qwen3:8b`, or your MLX model).
4. **Save**.

## Notes

- **Multi vs single mode:** `multi` (separate chat/cheap/smart/vision models) is mainly for LOCAL
  setups that stitch specialized models together. A cloud model is multimodal, so use `single`.
- You do NOT need a working model just to open the UI and configure it — boot, set the endpoint, Save.
- Mixing local + cloud, or several local models behind one endpoint, uses the optional LiteLLM
  gateway — see the local-models guides.
