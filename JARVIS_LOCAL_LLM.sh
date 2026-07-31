#!/usr/bin/env bash
# JARVIS_LOCAL_LLM.sh — manage a LOCAL LLM runtime and print the endpoint URL to paste into
# JARVIS → Config → Endpoint URL. JARVIS core no longer knows or cares WHERE the model lives;
# it just talks OpenAI-dialect to whatever URL you give it (a cloud provider, or the URL below).
#
# Usage:
#   ./JARVIS_LOCAL_LLM.sh start        [--backend ollama | mlx] [--gateway]   # apply config, ensure it's up, print the URL
#   ./JARVIS_LOCAL_LLM.sh gateway-sync [--backend ollama | mlx]               # refresh the gateway's model list from live models
#   ./JARVIS_LOCAL_LLM.sh url          [--gateway]                       # just print the URL (nothing else)
#   ./JARVIS_LOCAL_LLM.sh stop         [--backend ollama | mlx] [--gateway]   # no --backend = stop ALL running runtimes
#   ./JARVIS_LOCAL_LLM.sh status
#   ./JARVIS_LOCAL_LLM.sh config       [--backend ollama | mlx]         # print setup steps (install / pull / configure)
#
# Backends: ollama (default) and mlx (Apple Silicon). vLLM / llama.cpp can be added as new backend
# blocks — each implements: <backend>_apply_config/_ensure_running/_url/_status/_stop/_hint/
# _config_help/_gateway_routes.
#
# --gateway fronts the runtime with the LiteLLM gateway (one OpenAI endpoint, multi-model routing);
# without it, JARVIS talks straight to the runtime. Either way you paste the printed URL into Config.
#
# GATEWAY MODEL LIST stays honest: on `start --gateway` (or `gateway-sync`) the auto-managed block in
# litellm/config.yaml is REGENERATED from whatever --backend selects — Ollama's installed tags, or the
# MLX servers that are actually up — so it never drifts. On `stop` the block is EMPTIED (the runtime is
# gone, so the gateway shouldn't advertise it); a still-running gateway is reloaded to reflect that.
# Cloud routes above the marker are left alone throughout.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${SCRIPT_DIR}/config/JARVIS_CONFIG.json"
LITELLM_COMPOSE="${SCRIPT_DIR}/litellm/docker-compose.yml"
OLLAMA_PORT=11434
GATEWAY_PORT="${LITELLM_PORT:-4000}"
# The JARVIS app runs in a container, so it reaches host services via host.docker.internal.
# That's the host you paste into Config. (From your own host shell, it's localhost instead.)
APP_HOST="host.docker.internal"

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YEL='\033[0;33m'; C_BLU='\033[0;34m'; C_BOLD='\033[1m'
else C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BOLD=''; fi
info() { echo -e "${C_BLU}==>${C_RESET} $*"; }
ok()   { echo -e "${C_GRN}OK ${C_RESET} $*"; }
warn() { echo -e "${C_YEL}!! ${C_RESET} $*"; }
err()  { echo -e "${C_RED}ERROR${C_RESET} $*" >&2; }
lc()   { echo "$1" | tr '[:upper:]' '[:lower:]'; }

read_cfg() { # $1 dotted.key  $2 default
  [[ -f "$CFG" ]] || { echo "$2"; return; }
  command -v python3 >/dev/null 2>&1 || { echo "$2"; return; }
  python3 - "$CFG" "$1" "$2" <<'PY' 2>/dev/null || echo "$2"
import json, sys
cfg, key, dflt = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(cfg))
    for k in key.split("."):
        d = d[k]
    print(d)
except Exception:
    print(dflt)
PY
}

port_up() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null)" != "000" ]]; }

# Export provider API keys from JARVIS_CONFIG.json so the (optional) gateway can reach each
# provider. Only relevant with --gateway; harmless otherwise.
export_provider_keys() {
  [[ -f "$CFG" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local k
  for pair in "api_key:OPENAI_API_KEY" "anthropic_api_key:ANTHROPIC_API_KEY" "gemini_api_key:GEMINI_API_KEY"; do
    k=$(python3 -c "import json;print(json.load(open('$CFG')).get('llm',{}).get('${pair%%:*}','') or '')" 2>/dev/null || true)
    [[ -n "$k" ]] && export "${pair##*:}=$k"
  done
}

# ============================ backend: ollama ============================
ollama_apply_config() {
  local manage; manage="$(lc "$(read_cfg ollama.manage true)")"
  if [[ "$manage" != "true" ]]; then info "ollama.manage=false in config — leaving Ollama untouched."; return 0; fi
  if [[ "$(uname)" != "Darwin" ]]; then
    warn "Ollama auto-config is implemented for macOS only. On Linux set OLLAMA_* env vars yourself and run 'ollama serve'."; return 0
  fi
  command -v ollama >/dev/null 2>&1 || { warn "ollama CLI not on PATH; skipping config (install Ollama, or set ollama.manage=false)."; return 0; }
  local ctx keep par maxl
  ctx="$(read_cfg ollama.context_length 65536)"
  keep="$(read_cfg ollama.keep_alive -1)"
  par="$(read_cfg ollama.num_parallel 1)"
  maxl="$(read_cfg ollama.max_loaded_models 3)"
  info "Ollama: context_length=${ctx} keep_alive=${keep} num_parallel=${par} max_loaded_models=${maxl}"
  launchctl setenv OLLAMA_CONTEXT_LENGTH    "$ctx"  2>/dev/null || true
  launchctl setenv OLLAMA_KEEP_ALIVE        "$keep" 2>/dev/null || true
  launchctl setenv OLLAMA_NUM_PARALLEL      "$par"  2>/dev/null || true
  launchctl setenv OLLAMA_MAX_LOADED_MODELS "$maxl" 2>/dev/null || true
  info "Ollama: restarting so the new settings take effect..."
  osascript -e 'quit app "Ollama"' 2>/dev/null || killall Ollama 2>/dev/null || true
  sleep 2
  open -a Ollama 2>/dev/null || { warn "Could not launch Ollama.app; start Ollama manually."; return 0; }
}
ollama_ensure_running() {
  for _ in $(seq 1 30); do
    port_up "http://localhost:${OLLAMA_PORT}/api/tags" && { ok "Ollama responding on :${OLLAMA_PORT}."; return 0; }
    sleep 1
  done
  warn "Ollama did not answer on :${OLLAMA_PORT} yet (it may still be starting)."; return 1
}
ollama_url()  { echo "http://${APP_HOST}:${OLLAMA_PORT}/v1"; }
ollama_stop() {
  if [[ "$(uname)" == "Darwin" ]]; then osascript -e 'quit app "Ollama"' 2>/dev/null || killall Ollama 2>/dev/null || true; info "Ollama quit."
  else warn "Stop Ollama yourself on this OS (e.g. kill the 'ollama serve' process)."; fi
}
ollama_hint() { echo "Straight to Ollama: set your model name(s) to the Ollama tag (e.g. qwen3:8b, qwen2.5vl:32b)."; }
ollama_status() { printf 'Ollama  (:%s): ' "$OLLAMA_PORT"; port_up "http://localhost:${OLLAMA_PORT}/api/tags" && echo "up" || echo "down"; }
# Printed by `config [--backend ollama]` — a start-to-finish setup guide.
ollama_config_help() {
  echo -e "${C_BOLD}Set up Ollama for JARVIS${C_RESET}  — local models run on THIS machine; JARVIS talks to them over http://${APP_HOST}:${OLLAMA_PORT}/v1"
  cat <<TXT

1) INSTALL Ollama on this machine
     macOS:   download & run   https://ollama.com/download/mac
     other:   https://ollama.com/download
     check:   ollama --version

2) PULL the model(s) you want   (the tag becomes your JARVIS model / tier value)
     ollama pull qwen3:8b          # a general chat model
     ollama pull qwen2.5vl:32b     # a VISION model (needed for the vision tier / screenshots)
   LIST the models you have downloaded:
     ollama list
   DELETE a downloaded model to reclaim disk:
     ollama rm qwen3:8b            # remove by its tag

3) (optional) TUNE the runtime in  config/JARVIS_CONFIG.json  -> the "ollama" block:
     manage            true = this script configures + restarts Ollama for you
     context_length    num_ctx pre-allocated per model (bigger = more RAM, fixed ceiling)
     keep_alive        "-1" keeps models resident (no cold reloads), or e.g. "30m"
     num_parallel      concurrent requests per model
     max_loaded_models how many models stay resident at once
   You can also edit these in the JARVIS UI -> Config tab. Either way you must
   RE-RUN  ./JARVIS_LOCAL_LLM.sh start  afterwards for the changes to take effect.

4) START it + get the URL
     ./JARVIS_LOCAL_LLM.sh start          # add --gateway to front it with LiteLLM (multi-model routing)
     -> prints  http://${APP_HOST}:${OLLAMA_PORT}/v1

5) POINT JARVIS at it
     JARVIS -> Config -> Endpoint URL = that URL. Set the model (single mode) or the
     chat/cheap/smart/vision tiers (multi mode) to your pulled Ollama tags, then Save.

TIP:  going multi-tier with several local models? Set max_loaded_models >= the number of
      distinct tier models so they all stay hot in RAM instead of thrashing in and out.

Note: the auto-config in steps 3-4 is macOS-only (launchctl + Ollama.app). On Linux, set the
      OLLAMA_* env vars yourself and run 'ollama serve'.
TXT
}

# Emit the LiteLLM route YAML for the LIVE Ollama models (stdout = YAML only; notes → stderr).
# One route per installed tag, all pointing at the single Ollama daemon. Embeddings/rerank models
# are skipped — they aren't chat models and would just be dead routes.
ollama_gateway_routes() {
  if ! port_up "http://localhost:${OLLAMA_PORT}/api/tags"; then
    warn "Ollama not up on :${OLLAMA_PORT} — no Ollama routes to sync (start it first)." >&2; return 0
  fi
  # NOTE: curl's JSON goes to a TEMP FILE, not a pipe — because the python heredoc (`<<'PY'`) itself
  # redirects stdin, so a piped body would be swallowed by the heredoc and json.load(sys.stdin) would
  # read empty. Passing the file path as argv keeps stdin free for the script.
  local tmp; tmp="$(mktemp)"
  curl -s --max-time 8 "http://localhost:${OLLAMA_PORT}/v1/models" -o "$tmp"
  python3 - "$APP_HOST" "$OLLAMA_PORT" "$tmp" <<'PY'
import sys, json, re
host, port, f = sys.argv[1], sys.argv[2], sys.argv[3]
try: data = json.load(open(f)).get("data", [])
except Exception: data = []
skip = re.compile(r'embed|rerank|guard|moderation', re.I)
n = 0
for m in sorted(data, key=lambda x: (x.get("id") or x.get("name") or "")):
    mid = m.get("id") or m.get("name")
    if not mid or skip.search(mid): continue
    print(f'  - model_name: "{mid}"')
    print(f'    litellm_params:')
    print(f'      model: "openai/{mid}"')
    print(f'      api_base: http://{host}:{port}/v1')
    print(f'      api_key: ollama')
    n += 1
sys.stderr.write(f"    ({n} Ollama models)\n")
PY
  rm -f "$tmp"
}

# ============================ optional gateway (LiteLLM) ============================
# Markers in litellm/config.yaml that delimit the auto-managed local-routes block.
GW_BEGIN_TAG="BEGIN local routes"
GW_END_TAG="END local routes"
LITELLM_CONFIG="${SCRIPT_DIR}/litellm/config.yaml"
LITELLM_TEMPLATE="${SCRIPT_DIR}/litellm/config_template.yaml"

# The live litellm/config.yaml is gitignored (regenerated every run). Seed it from the committed
# template on first use so a fresh clone / a wiped file just works.
ensure_gateway_config() {
  [[ -f "$LITELLM_CONFIG" ]] && return 0
  [[ -f "$LITELLM_TEMPLATE" ]] || { err "missing $LITELLM_CONFIG and $LITELLM_TEMPLATE — cannot seed gateway config."; return 1; }
  cp "$LITELLM_TEMPLATE" "$LITELLM_CONFIG" && info "Seeded litellm/config.yaml from the committed template."
}

# Low-level: replace the marker block in litellm/config.yaml with the content of $1 (a file of YAML
# routes; an EMPTY file clears the block). Cloud routes above / litellm_settings below are untouched.
_splice_local_block() { # $1 = routes file
  ensure_gateway_config || return 1
  if ! grep -q "$GW_BEGIN_TAG" "$LITELLM_CONFIG" || ! grep -q "$GW_END_TAG" "$LITELLM_CONFIG"; then
    err "markers not found in $LITELLM_CONFIG (need the '$GW_BEGIN_TAG' / '$GW_END_TAG' lines)."; return 1
  fi
  python3 - "$LITELLM_CONFIG" "$GW_BEGIN_TAG" "$GW_END_TAG" "$1" <<'PY' || { err "failed to rewrite $LITELLM_CONFIG"; return 1; }
import sys
path, btag, etag, routesfile = sys.argv[1:5]
routes = open(routesfile).read().rstrip("\n")
lines = open(path).read().splitlines()
bi = next(i for i, l in enumerate(lines) if btag in l)
ei = next(i for i, l in enumerate(lines) if etag in l)
mid = routes.split("\n") if routes.strip() else []
open(path, "w").write("\n".join(lines[:bi+1] + mid + lines[ei:]) + "\n")
PY
}

# Regenerate the marker block in litellm/config.yaml from the SELECTED backend's live models.
sync_gateway_models() {
  info "Syncing gateway model list from live $BACKEND backend..."
  local routes; routes="$("${BACKEND}_gateway_routes")"
  local n; n="$(grep -c 'model_name:' <<<"$routes" 2>/dev/null || echo 0)"
  if [[ "$n" -eq 0 ]]; then
    warn "No live $BACKEND models found — the managed block will be emptied. Are the servers up?"
  fi
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$routes" > "$tmp"
  _splice_local_block "$tmp" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  ok "Gateway config synced: ${n} local model(s) from $BACKEND."
}

# Empty the marker block — used on `stop`, since the local runtime is going away and the gateway
# should no longer advertise models it can't reach. Cloud routes are kept.
clear_gateway_models() {
  grep -q "$GW_BEGIN_TAG" "$LITELLM_CONFIG" 2>/dev/null || return 0
  local tmp; tmp="$(mktemp)"; : > "$tmp"     # empty routes file
  _splice_local_block "$tmp" && info "Removed the gateway's local-model routes from config (cloud routes kept)."
  rm -f "$tmp"
}

gateway_up() {
  [[ -f "$LITELLM_COMPOSE" ]] || { err "gateway compose not found: $LITELLM_COMPOSE"; return 1; }
  command -v docker >/dev/null 2>&1 || { err "docker not found (needed for --gateway)."; return 1; }
  ensure_gateway_config || return 1
  export_provider_keys
  info "Gateway: starting LiteLLM on :${GATEWAY_PORT} (fronts the runtime, routes model names)..."
  # --force-recreate so a freshly-synced config.yaml is always re-read (LiteLLM loads it only at start).
  docker compose -f "$LITELLM_COMPOSE" up -d --force-recreate || { err "gateway failed to start."; return 1; }
  for _ in $(seq 1 20); do port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && { ok "Gateway up on :${GATEWAY_PORT}."; return 0; }; sleep 1; done
  warn "Gateway not answering on :${GATEWAY_PORT} yet."
}
gateway_down() { [[ -f "$LITELLM_COMPOSE" ]] && docker compose -f "$LITELLM_COMPOSE" down 2>/dev/null || true; }
gateway_url()  { echo "http://${APP_HOST}:${GATEWAY_PORT}/v1"; }

# ============================ backend: mlx (Apple Silicon) ============================
# Runs local models natively on the macOS host via mlx-lm's OpenAI-compatible server. DISCOVERY-BASED
# (like Ollama): you bring models online with `mlx-serve <model>` (each = its own mlx_lm.server process
# on its own port, so several stay hot at once); the script DISCOVERS the running servers and maps them
# — no config array. Front several with the LiteLLM gateway for one endpoint. venv + models under mlx/.
MLX_VENV="${SCRIPT_DIR}/mlx/venv"
MLX_MODELS_DIR="${SCRIPT_DIR}/mlx/models"
MLX_SERVER="$MLX_VENV/bin/mlx_lm.server"

MLX_REGISTRY="${SCRIPT_DIR}/mlx/serving.json"
MLX_PORT_BASE=8080

mlx_ensure_venv() {
  [[ "$(uname)" == "Darwin" ]] || { err "MLX requires macOS on Apple Silicon."; return 1; }
  [[ -x "$MLX_SERVER" ]] || { err "MLX not installed yet — run:  source ./ACTIVATE.sh  (first run installs mlx-lm)."; return 1; }
}
mlx_apply_config() { info "MLX models cache: $MLX_MODELS_DIR (HF_HOME)"; }

# ---- DISCOVERY: the RUNNING mlx_lm.server processes are the source of truth (like Ollama's daemon,
#      but one process per model). Emit "model|port" for each, parsed from its command line.
mlx_discover() {
  local pid args model port
  for pid in $(pgrep -f 'mlx_lm\.server' 2>/dev/null); do
    args="$(ps -p "$pid" -o args= 2>/dev/null)"
    [[ "$args" == *mlx_lm.server* ]] || continue
    model="$(sed -n 's/.*--model[= ][= ]*\([^ ]*\).*/\1/p' <<<"$args")"
    port="$(sed -n 's/.*--port[= ][= ]*\([0-9][0-9]*\).*/\1/p' <<<"$args")"
    [[ -n "$port" ]] || port="$MLX_PORT_BASE"
    [[ -n "$model" ]] && echo "${model}|${port}"
  done | sort -u
}
mlx_running() { [[ -n "$(mlx_discover)" ]]; }

# ---- REGISTRY (mlx/serving.json): auto-written by mlx-serve so `mlx-up` / `start` can relaunch your
#      set after a reboot. NOT hand-edited — it just remembers what you brought online.
mlx_registry_add() {  # model port
  python3 - "$MLX_REGISTRY" "$1" "$2" <<'PY' 2>/dev/null
import json, sys, os
path, model, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
try: reg = json.load(open(path))
except Exception: reg = []
reg = [e for e in reg if e.get("model") != model and e.get("port") != port]
reg.append({"model": model, "port": port})
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(reg, open(path, "w"), indent=2)
PY
}
mlx_registry_remove() {  # model|port|all
  python3 - "$MLX_REGISTRY" "$1" <<'PY' 2>/dev/null
import json, sys
path, key = sys.argv[1], sys.argv[2]
try: reg = json.load(open(path))
except Exception: reg = []
reg = [] if key == "all" else [e for e in reg if str(e.get("model")) != key and str(e.get("port")) != key]
json.dump(reg, open(path, "w"), indent=2)
PY
}
mlx_registry_list() {  # emit "model|port"
  python3 - "$MLX_REGISTRY" <<'PY' 2>/dev/null
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: reg = []
for e in reg: print(f"{e.get('model','')}|{e.get('port', 8080)}")
PY
}
mlx_next_port() {  # first free port at/after MLX_PORT_BASE
  local p="$MLX_PORT_BASE"
  while port_up "http://localhost:$p/v1/models" || lsof -ti tcp:"$p" >/dev/null 2>&1; do p=$((p+1)); done
  echo "$p"
}

# Bring ONE model online as its own mlx_lm.server (backgrounded, logged) + record it in the registry.
mlx_serve_one() {  # model [port]
  mlx_ensure_venv || return 1
  local model="$1" port="${2:-}"
  [[ -n "$model" ]] || { err "usage: ./JARVIS_LOCAL_LLM.sh mlx-serve <model> [--port N]"; return 1; }
  local up; up="$(mlx_discover | awk -F'|' -v m="$model" '$1==m{print $2; exit}')"
  if [[ -n "$up" ]]; then ok "MLX $model already up on :$up."; mlx_registry_add "$model" "$up"; return 0; fi
  [[ -n "$port" ]] || port="$(mlx_next_port)"
  local log; log="${SCRIPT_DIR}/mlx/$(echo "$model" | tr '/:' '__').log"
  info "Starting MLX $model on :$port  (first run downloads into mlx/models; big models take a while)..."
  HF_HOME="$MLX_MODELS_DIR" nohup "$MLX_SERVER" --model "$model" --host 0.0.0.0 --port "$port" > "$log" 2>&1 &
  mlx_registry_add "$model" "$port"
  for _ in $(seq 1 180); do port_up "http://localhost:${port}/v1/models" && { ok "MLX $model up on :$port."; return 0; }; sleep 1; done
  warn "MLX $model not answering on :$port yet — may still be loading (see $log)."
}
# Relaunch any registered model that isn't currently running (reboot recovery).
mlx_up() {
  mlx_ensure_venv || return 1
  local any=0
  while IFS='|' read -r model port; do
    [[ -z "$model" ]] && continue; any=1
    if port_up "http://localhost:${port}/v1/models"; then ok "MLX $model already up on :$port."
    else mlx_serve_one "$model" "$port"; fi
  done < <(mlx_registry_list)
  [[ "$any" == 0 ]] && info "No MLX models registered yet — bring one online:  ./JARVIS_LOCAL_LLM.sh mlx-serve <model>"
}
# Stop a running MLX server by model id or port, or all; drop it from the registry.
mlx_stop_target() {  # model|port|all
  local target="${1:-all}" stopped=0 pid
  while IFS='|' read -r model port; do
    [[ -z "$port" ]] && continue
    if [[ "$target" == "all" || "$target" == "$model" || "$target" == "$port" ]]; then
      pid="$(lsof -ti tcp:"$port" 2>/dev/null | head -1)"
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && { ok "stopped $model (:$port)."; stopped=1; }
      [[ "$target" != "all" ]] && mlx_registry_remove "$target"
    fi
  done < <(mlx_discover)
  if [[ "$target" == "all" ]]; then pkill -f "mlx_lm.server" 2>/dev/null || true; mlx_registry_remove all; ok "stopped all MLX servers."; fi
  [[ "$stopped" == 0 && "$target" != "all" ]] && warn "No running MLX server matched '$target'."
  return 0
}
mlx_ls() {
  local any=0
  while IFS='|' read -r model port; do
    [[ -z "$model" ]] && continue; any=1
    printf 'MLX (:%s) ' "$port"; port_up "http://localhost:${port}/v1/models" && echo "up    $model" || echo "down  $model"
  done < <(mlx_discover)
  [[ "$any" == 0 ]] && info "No MLX servers running. Bring one online:  ./JARVIS_LOCAL_LLM.sh mlx-serve <model>"
}

# ---- backend contract (all discovery-driven) ----
mlx_ensure_running() { mlx_ensure_venv || return 1; mlx_up; }   # `start` relaunches the registered set
mlx_url() {
  local n; n="$(mlx_discover | grep -c .)"
  if [[ "$n" -le 1 ]]; then local port; port="$(mlx_discover | head -1 | cut -d'|' -f2)"; echo "http://${APP_HOST}:${port:-8080}/v1"
  else while IFS='|' read -r model port; do [[ -n "$model" ]] && echo "http://${APP_HOST}:${port}/v1   # ${model}"; done < <(mlx_discover)
       echo "# multiple models: front them with --gateway for ONE endpoint."; fi
}
mlx_status() {
  while IFS='|' read -r model port; do
    [[ -z "$port" ]] && continue
    printf 'MLX     (:%s): ' "$port"; port_up "http://localhost:${port}/v1/models" && echo "up  ($model)" || echo "down  ($model)"
  done < <(mlx_discover)
}
mlx_stop() { mlx_stop_target all; }
mlx_hint() { echo "Via the gateway: 'List models' shows your running MLX models by id — set the JARVIS model / tier to one. Single model: point Endpoint URL straight at its :port."; }
# Emit the LiteLLM route YAML for the DISCOVERED (running) MLX servers — one route per live server,
# named by the actual model id it serves (like an Ollama tag), so "List models" shows the real model.
mlx_gateway_routes() {
  local n=0
  while IFS='|' read -r model port; do
    [[ -z "$model" ]] && continue
    if port_up "http://localhost:${port}/v1/models"; then
      printf '  - model_name: "%s"\n' "$model"
      printf '    litellm_params:\n'
      printf '      model: "openai/%s"\n' "$model"
      printf '      api_base: http://%s:%s/v1\n' "$APP_HOST" "$port"
      printf '      api_key: mlx\n'
      n=$((n+1))
    fi
  done < <(mlx_discover)
  echo "    ($n MLX servers discovered)" >&2
}
mlx_config_help() {
  echo -e "${C_BOLD}Set up MLX for JARVIS${C_RESET}  — Apple's on-device LLM runtime (Apple Silicon). Models run on the macOS HOST."
  cat <<TXT

1) ACTIVATE the Python env (creates the venv + installs mlx-lm on first run)
     source ./ACTIVATE.sh          # models download into mlx/models/ ; leave with: source ./DEACTIVATE.sh

2) PICK a model — MLX models come from Hugging Face's 'mlx-community' org (pre-quantized):
     browse:  https://huggingface.co/mlx-community     (the '-4bit' variants suit most Macs)
     e.g.     mlx-community/Qwen2.5-7B-Instruct-4bit
              mlx-community/Qwen2.5-32B-Instruct-4bit

   (The tools below need the env from step 1 active, so HF_HOME points at mlx/models — otherwise
    they read/write ~/.cache instead.)

   DOWNLOAD — models auto-download on first serve; pre-fetch to avoid a slow first request:
     hf download mlx-community/Qwen2.5-7B-Instruct-4bit   # just fetch it into mlx/models/
     mlx_lm.generate --model <repo> --prompt "hi"         # fetch + a quick test
   LIST the models you have downloaded (cached under mlx/models/):
     mlx_lm.manage --scan
   DELETE a downloaded model to reclaim disk (matches repos containing the pattern):
     mlx_lm.manage --delete --pattern Qwen2.5-7B          # e.g. removes ...Qwen2.5-7B-Instruct-4bit
   (Everything saves under  mlx/models/  — gitignored.)

3) CONFIGURE them in  config/JARVIS_CONFIG.json  ->  the "mlx" block (each gets its own port):
     "mlx": { "models": [
        { "name": "chat",  "model": "mlx-community/Qwen2.5-7B-Instruct-4bit",  "port": 8080 },
        { "name": "smart", "model": "mlx-community/Qwen2.5-32B-Instruct-4bit", "port": 8081 }
     ] }
   Edit this file directly (or the raw JSON in the JARVIS UI -> Config), then re-run start.

4) START the server(s) + get the URL(s)
     ./JARVIS_LOCAL_LLM.sh start --backend mlx            # one model  -> one URL
     ./JARVIS_LOCAL_LLM.sh start --backend mlx --gateway  # many models-> ONE URL via LiteLLM
     ./JARVIS_LOCAL_LLM.sh stop  --backend mlx            # clean stop (kills the server processes)
     ./JARVIS_LOCAL_LLM.sh status                         # shows each model's port

5) POINT JARVIS at it
     JARVIS -> Config -> Endpoint URL = the printed URL. Single model: paste its :port URL.
     Multiple: use --gateway and set the model/tiers to each model's ID (the gateway route is named
     by the actual 'model', e.g. mlx-community/Qwen2.5-7B-Instruct-4bit — the 'name' just labels the
     process in start/stop/status).

NOTE: MLX runs on the HOST, not in the JARVIS containers (it needs Metal). JARVIS reaches it over
      host.docker.internal. mlx-lm is text-only; vision models use a separate package (mlx-vlm) —
      keep vision on Ollama (qwen2.5vl) for now.
TIP:  tool-calling — JARVIS is tool-heavy. If a model doesn't emit clean OpenAI tool_calls, JARVIS's
      text-tool-call salvage still handles it, but verify with a quick task after first start.
TXT
}

usage() { awk 'NR>=2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }

# ============================ dispatch ============================
CMD=""; BACKEND="ollama"; BACKEND_EXPLICIT=0; USE_GATEWAY=0; MLX_ARG=""; MLX_PORT_ARG=""
while [[ $# -gt 0 ]]; do
  case "$(lc "$1")" in
    start|stop|status|url|config|gateway-sync) CMD="$(lc "$1")" ;;
    mlx-serve|mlx-stop|mlx-ls|mlx-up)          CMD="$(lc "$1")" ;;
    --gateway)             USE_GATEWAY=1 ;;
    --backend)             shift; BACKEND="$(lc "${1:-ollama}")"; BACKEND_EXPLICIT=1 ;;
    --port)                shift; MLX_PORT_ARG="${1:-}" ;;
    -h|--help|help)        usage; exit 0 ;;
    -*)                    err "unknown option: $1"; usage; exit 1 ;;
    *)                     MLX_ARG="$1" ;;    # positional: model id / target for the mlx-* commands
  esac
  shift
done
[[ -z "$CMD" ]] && { usage; exit 1; }

case "$BACKEND" in
  ollama|mlx) ;;
  *) err "unknown backend '$BACKEND' — supported: ollama, mlx. (vLLM / llama.cpp: add a backend block above.)"; exit 1 ;;
esac

the_url() { if [[ "$USE_GATEWAY" == 1 ]]; then gateway_url; else "${BACKEND}_url"; fi; }

case "$CMD" in
  start)
    "${BACKEND}_apply_config"
    "${BACKEND}_ensure_running" || true
    if [[ "$USE_GATEWAY" == 1 ]]; then
      sync_gateway_models    # regenerate the local-routes block from THIS backend's live models...
      gateway_up             # ...then (re)start the gateway so it re-reads the fresh config.
    fi
    echo
    ok "Local LLM ready ($BACKEND)."
    echo -e "${C_BOLD}Paste this into JARVIS → Config → Endpoint URL:${C_RESET}"
    echo -e "    ${C_GRN}$(the_url)${C_RESET}"
    if [[ "$USE_GATEWAY" == 1 ]]; then info "Via the gateway: model names now mirror your live $BACKEND models (auto-synced into litellm/config.yaml)."
    else info "$("${BACKEND}_hint")"; fi
    ;;
  gateway-sync)
    # Refresh the gateway's local-routes block from the selected backend WITHOUT a full start,
    # then reload the gateway if it's running so the change takes effect.
    sync_gateway_models || exit 1
    if port_up "http://localhost:${GATEWAY_PORT}/health/liveliness"; then gateway_up
    else info "Gateway not running — start it with:  ./JARVIS_LOCAL_LLM.sh start --backend $BACKEND --gateway"; fi
    ;;
  url)
    the_url
    ;;
  mlx-serve)
    mlx_serve_one "$MLX_ARG" "$MLX_PORT_ARG"
    [[ "$USE_GATEWAY" == 1 ]] && { BACKEND=mlx; sync_gateway_models && { port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && gateway_up; }; }
    ;;
  mlx-stop)   mlx_stop_target "${MLX_ARG:-all}" ;;
  mlx-ls)     mlx_ls ;;
  mlx-up)     mlx_up ;;
  status)
    # Diagnostic view: report EVERY backend's real state, not just the --backend default (ollama).
    ollama_status
    mlx_running && mlx_status                  # show MLX when any server is actually running
    printf 'Gateway (:%s): '  "$GATEWAY_PORT"; port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && echo "up" || echo "down"
    ;;
  config)
    "${BACKEND}_config_help"
    ;;
  stop)
    if [[ "$BACKEND_EXPLICIT" == 1 ]]; then
      "${BACKEND}_stop"                        # stop just the named backend
    else
      # No --backend given → stop EVERY local runtime that's actually running, not just the ollama
      # default (that mismatch is why a plain `stop` used to report Ollama while MLX was running).
      stopped=0
      port_up "http://localhost:${OLLAMA_PORT}/api/tags" && { ollama_stop; stopped=1; }
      mlx_running && { mlx_stop; stopped=1; }
      [[ "$stopped" == 0 ]] && info "No local runtime appears to be running."
    fi
    clear_gateway_models       # local runtime(s) going away → drop their routes from the gateway config
    if [[ "$USE_GATEWAY" == 1 ]]; then
      gateway_down             # bringing the gateway down too — cleared config is ready for next start
    elif port_up "http://localhost:${GATEWAY_PORT}/health/liveliness"; then
      # Gateway still up: reload it if any routes remain to serve, otherwise there's nothing left → down.
      if grep -qE '^[[:space:]]*-[[:space:]]*model_name:' "$LITELLM_CONFIG"; then
        info "Gateway still running — reloading so it drops the now-stopped local models..."
        gateway_up
      else
        info "No models left for the gateway to serve — bringing it down."
        gateway_down
      fi
    fi
    ;;
esac
