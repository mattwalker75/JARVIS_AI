# Run local models with MLX (Apple Silicon)

MLX is Apple's on-device runtime — it runs models natively on Apple Silicon Macs (fast/efficient).
It runs on the **host** (needs Metal), in a Python environment under `mlx/`. Text-only for now
(keep vision on Ollama).

MLX is **discovery-based, like Ollama** — you bring models online from the command line and the
script finds them. There is **no MLX config block** to edit. Each model runs as its **own
`mlx_lm.server` process on its own port**, so several can stay **hot at once** (no reload when JARVIS
switches tiers — great if you have plenty of RAM).

Print the full guide anytime with: `./JARVIS_LOCAL_LLM.sh config --backend mlx`

## Steps

1. **Activate the environment** (first run creates the venv + installs `mlx-lm`):
   ```
   source ./ACTIVATE.sh          # models cache in mlx/models/ ; leave with: source ./DEACTIVATE.sh
   ```

2. **Pick a model** from Hugging Face's `mlx-community` org (pre-quantized; `-4bit` suits most Macs):
   browse https://huggingface.co/mlx-community — e.g. `mlx-community/Qwen2.5-7B-Instruct-4bit`.
   Models auto-download into `mlx/models/` on first serve (or pre-fetch with `hf download <repo>`).
   - **List** what you've downloaded: `mlx_lm.manage --scan`
   - **Delete** one: `mlx_lm.manage --delete --pattern <substr>`

3. **Bring the model(s) online** — each becomes its own server on its own port:
   ```
   ./JARVIS_LOCAL_LLM.sh mlx-serve mlx-community/Qwen2.5-7B-Instruct-4bit          # auto-assigns a port (8080+)
   ./JARVIS_LOCAL_LLM.sh mlx-serve mlx-community/Qwen2.5-32B-Instruct-4bit --port 8081
   ./JARVIS_LOCAL_LLM.sh mlx-ls                                                    # what's running now
   ./JARVIS_LOCAL_LLM.sh mlx-stop <model | port | all>                            # take one/all offline
   ```
   `mlx-serve` remembers what you started, so **`./JARVIS_LOCAL_LLM.sh mlx-up`** relaunches your set
   after a reboot (MLX has no auto-starting daemon).

4. **Wire it into JARVIS + get the URL:**
   ```
   ./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway  # discovers running servers -> ONE URL via LiteLLM
   ./JARVIS_LOCAL_LLM.sh start --backend mlx            # single server -> its :port URL (no gateway)
   ./JARVIS_LOCAL_LLM.sh status                         # Ollama + running MLX servers + gateway
   ```

5. **Point JARVIS at it:** Config → **Endpoint URL** = the printed URL, **API key** blank, click
   **List models**, pick your model, **Save**.
   - **Multiple models** (`--gateway`): each shows by its real **id** (`mlx-community/…`, like an
     Ollama tag) — set the model (single mode) or the chat/cheap/smart tiers (multi mode) to those ids.
   - **Single model:** point the Endpoint URL straight at its `:port` (no gateway needed).

## Important

- **No config to edit.** The running `mlx_lm.server` processes are the source of truth — bring models
  up with `mlx-serve`, take them down with `mlx-stop`, list with `mlx-ls`.
- **Reboot recovery:** run `./JARVIS_LOCAL_LLM.sh mlx-up` to relaunch the set you'd served (or
  `mlx-serve` them again).
- **Several models stay hot at once** (one process each), so switching tiers is instant — but each
  loaded model uses memory. Big models (e.g. a 35B) take a while to load the first time.
- **Vision:** `mlx-lm` is text-only — keep the **vision** tier on an Ollama model like `qwen2.5vl`.
- Models save under `mlx/models/`; `rm -rf mlx/models` to reclaim disk.
