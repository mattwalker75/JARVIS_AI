# Run local models with MLX (Apple Silicon)

MLX is Apple's on-device runtime — it runs models natively on Apple Silicon Macs (fast/efficient).
It runs on the **host** (needs Metal), in a Python environment under `mlx/`. Text-only for now
(keep vision on Ollama).

Print the full guide anytime with: `./JARVIS_LOCAL_LLM.sh config --backend mlx`

## Steps

1. **Activate the environment** (first run creates the venv + installs `mlx-lm`):
   ```
   source ./ACTIVATE.sh          # models cache in mlx/models/ ; leave with: source ./DEACTIVATE.sh
   ```

2. **Pick a model** from Hugging Face's `mlx-community` org (pre-quantized; `-4bit` suits most Macs):
   browse https://huggingface.co/mlx-community — e.g. `mlx-community/Qwen2.5-7B-Instruct-4bit`.
   Models auto-download into `mlx/models/` on first serve (or pre-fetch with `hf download <repo>`).

3. **Configure the model(s)** — the `mlx.models` list in `config/JARVIS_CONFIG.json`, each with its
   own port. Easiest: the **MLX models** section in the Config tab (add rows of name / model / port):
   ```
   "mlx": { "models": [
     { "name": "chat", "model": "mlx-community/Qwen2.5-7B-Instruct-4bit", "port": 8080 }
   ] }
   ```

4. **Start it + get the URL:**
   ```
   ./JARVIS_LOCAL_LLM.sh start  --backend mlx            # one model  -> one URL
   ./JARVIS_LOCAL_LLM.sh start  --backend mlx --gateway  # many models-> ONE URL via LiteLLM
   ./JARVIS_LOCAL_LLM.sh status                          # each model's port + up/down
   ./JARVIS_LOCAL_LLM.sh stop   --backend mlx            # stop the server(s)
   ```

5. **Point JARVIS at it:** Config → **Endpoint URL** = the printed `http://host.docker.internal:<port>/v1`,
   **API key** blank, set the model, **Save**.

## Important

- Editing `mlx.models` (in the UI or the file) only writes config — the UI can't launch host
  processes. **Re-run `./JARVIS_LOCAL_LLM.sh start --backend mlx`** to (re)launch the server(s).
- **One model = one `mlx_lm.server` process** on its own port. For several models behind one
  endpoint, add `--gateway` (LiteLLM fronts them).
- Models save under `mlx/models/`; `rm -rf mlx/models` to reclaim disk.
