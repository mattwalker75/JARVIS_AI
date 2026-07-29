#!/usr/bin/env bash
# JARVIS_LOCAL_LLM.sh — manage a LOCAL LLM runtime and print the endpoint URL to paste into
# JARVIS → Config → Endpoint URL. JARVIS core no longer knows or cares WHERE the model lives;
# it just talks OpenAI-dialect to whatever URL you give it (a cloud provider, or the URL below).
#
# Usage:
#   ./JARVIS_LOCAL_LLM.sh start  [--backend ollama|mlx] [--gateway]   # apply config, ensure it's up, print the URL
#   ./JARVIS_LOCAL_LLM.sh url    [--gateway]                       # just print the URL (nothing else)
#   ./JARVIS_LOCAL_LLM.sh stop   [--gateway]
#   ./JARVIS_LOCAL_LLM.sh status
#   ./JARVIS_LOCAL_LLM.sh config [--backend ollama|mlx]           # print setup steps (install / pull / configure)
#
# Backends: ollama (default) and mlx (Apple Silicon). vLLM / llama.cpp can be added as new backend
# blocks — each implements: <backend>_apply_config/_ensure_running/_url/_status/_stop/_hint/_config_help.
#
# --gateway fronts the runtime with the LiteLLM gateway (one OpenAI endpoint, multi-model routing);
# without it, JARVIS talks straight to the runtime. Either way you paste the printed URL into Config.
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
     ollama list                   # see what you already have

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

# ============================ optional gateway (LiteLLM) ============================
gateway_up() {
  [[ -f "$LITELLM_COMPOSE" ]] || { err "gateway compose not found: $LITELLM_COMPOSE"; return 1; }
  command -v docker >/dev/null 2>&1 || { err "docker not found (needed for --gateway)."; return 1; }
  export_provider_keys
  info "Gateway: starting LiteLLM on :${GATEWAY_PORT} (fronts the runtime, routes model names)..."
  docker compose -f "$LITELLM_COMPOSE" up -d || { err "gateway failed to start."; return 1; }
  for _ in $(seq 1 20); do port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && { ok "Gateway up on :${GATEWAY_PORT}."; return 0; }; sleep 1; done
  warn "Gateway not answering on :${GATEWAY_PORT} yet."
}
gateway_down() { [[ -f "$LITELLM_COMPOSE" ]] && docker compose -f "$LITELLM_COMPOSE" down 2>/dev/null || true; }
gateway_url()  { echo "http://${APP_HOST}:${GATEWAY_PORT}/v1"; }

# ============================ backend: mlx (Apple Silicon) ============================
# Runs local models natively on the macOS host via mlx-lm's OpenAI-compatible server. Each
# configured model gets its own mlx_lm.server process on its own port; front several with the
# LiteLLM gateway for one endpoint. The venv + models live under mlx/ (see ./ACTIVATE.sh).
MLX_VENV="${SCRIPT_DIR}/mlx/venv"
MLX_MODELS_DIR="${SCRIPT_DIR}/mlx/models"
MLX_SERVER="$MLX_VENV/bin/mlx_lm.server"
MLX_DEFAULT_MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"

# Emit the configured MLX models as "name|model|port" lines (one sensible default if unset).
mlx_models_list() {
  python3 - "$CFG" "$MLX_DEFAULT_MODEL" <<'PY' 2>/dev/null
import json, sys
cfg, default = sys.argv[1], sys.argv[2]
try: m = json.load(open(cfg)).get("mlx", {}).get("models", [])
except Exception: m = []
if not m: m = [{"name": "chat", "model": default, "port": 8080}]
for e in m:
    print(f"{e.get('name','model')}|{e.get('model','')}|{e.get('port',8080)}")
PY
}
mlx_ensure_venv() {
  [[ "$(uname)" == "Darwin" ]] || { err "MLX requires macOS on Apple Silicon."; return 1; }
  [[ -x "$MLX_SERVER" ]] || { err "MLX not installed yet — run:  source ./ACTIVATE.sh  (first run installs mlx-lm)."; return 1; }
}
mlx_apply_config() { info "MLX models cache: $MLX_MODELS_DIR (HF_HOME)"; }
mlx_start_one() { # name model port
  local name="$1" model="$2" port="$3"
  if port_up "http://localhost:${port}/v1/models"; then ok "MLX '$name' already up on :$port ($model)."; return 0; fi
  [[ -n "$model" ]] || { warn "MLX '$name' has no model set — skipping."; return 0; }
  info "Starting MLX '$name' → $model on :$port  (first run downloads the model into mlx/models)..."
  HF_HOME="$MLX_MODELS_DIR" nohup "$MLX_SERVER" --model "$model" --host 0.0.0.0 --port "$port" \
    > "${SCRIPT_DIR}/mlx/${name}.log" 2>&1 &
  for _ in $(seq 1 120); do port_up "http://localhost:${port}/v1/models" && { ok "MLX '$name' up on :$port."; return 0; }; sleep 1; done
  warn "MLX '$name' not answering on :$port yet — the model may still be downloading (see mlx/${name}.log)."
}
mlx_ensure_running() {
  mlx_ensure_venv || return 1
  while IFS='|' read -r name model port; do [[ -n "$name" ]] && mlx_start_one "$name" "$model" "$port"; done < <(mlx_models_list)
}
mlx_url() {
  local n; n="$(mlx_models_list | grep -c .)"
  if [[ "$n" -le 1 ]]; then
    local port; port="$(mlx_models_list | head -1 | cut -d'|' -f3)"; echo "http://${APP_HOST}:${port:-8080}/v1"
  else
    while IFS='|' read -r name model port; do [[ -n "$name" ]] && echo "http://${APP_HOST}:${port}/v1   # ${name}: ${model}"; done < <(mlx_models_list)
    echo "# multiple models: front them with --gateway for ONE endpoint, or point a tier at each port."
  fi
}
mlx_status() {
  while IFS='|' read -r name model port; do
    [[ -z "$name" ]] && continue
    printf 'MLX %-8s (:%s): ' "$name" "$port"; port_up "http://localhost:${port}/v1/models" && echo "up  ($model)" || echo "down"
  done < <(mlx_models_list)
}
mlx_stop() {
  info "Stopping MLX server(s)..."
  while IFS='|' read -r name model port; do
    [[ -z "$port" ]] && continue
    local pid; pid="$(lsof -ti tcp:"$port" 2>/dev/null | head -1)"
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null && ok "stopped '$name' (:$port)."; }
  done < <(mlx_models_list)
  pkill -f "mlx_lm.server" 2>/dev/null || true
}
mlx_hint() { echo "Set the JARVIS model / tier to the same 'name' you gave each mlx.models entry (routed via the gateway), or point a tier straight at a port above."; }
mlx_config_help() {
  echo -e "${C_BOLD}Set up MLX for JARVIS${C_RESET}  — Apple's on-device LLM runtime (Apple Silicon). Models run on the macOS HOST."
  cat <<TXT

1) ACTIVATE the Python env (creates the venv + installs mlx-lm on first run)
     source ./ACTIVATE.sh          # models download into mlx/models/ ; leave with: source ./DEACTIVATE.sh

2) PICK model(s) from Hugging Face's 'mlx-community' org (pre-quantized for MLX), e.g.
     mlx-community/Qwen2.5-7B-Instruct-4bit
     mlx-community/Qwen2.5-32B-Instruct-4bit
   They auto-download on first serve — no manual pull needed.

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
     Multiple: use --gateway and set the tiers to each model's 'name'.

NOTE: MLX runs on the HOST, not in the JARVIS containers (it needs Metal). JARVIS reaches it over
      host.docker.internal. mlx-lm is text-only; vision models use a separate package (mlx-vlm) —
      keep vision on Ollama (qwen2.5vl) for now.
TIP:  tool-calling — JARVIS is tool-heavy. If a model doesn't emit clean OpenAI tool_calls, JARVIS's
      text-tool-call salvage still handles it, but verify with a quick task after first start.
TXT
}

usage() { awk 'NR>=2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }

# ============================ dispatch ============================
CMD=""; BACKEND="ollama"; USE_GATEWAY=0
while [[ $# -gt 0 ]]; do
  case "$(lc "$1")" in
    start|stop|status|url|config) CMD="$1" ;;
    --gateway)             USE_GATEWAY=1 ;;
    --backend)             shift; BACKEND="$(lc "${1:-ollama}")" ;;
    -h|--help|help)        usage; exit 0 ;;
    *) err "unknown argument: $1"; usage; exit 1 ;;
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
    [[ "$USE_GATEWAY" == 1 ]] && gateway_up
    echo
    ok "Local LLM ready ($BACKEND)."
    echo -e "${C_BOLD}Paste this into JARVIS → Config → Endpoint URL:${C_RESET}"
    echo -e "    ${C_GRN}$(the_url)${C_RESET}"
    if [[ "$USE_GATEWAY" == 1 ]]; then info "Via the gateway: set your model name(s) to entries in litellm/config.yaml."
    else info "$("${BACKEND}_hint")"; fi
    ;;
  url)
    the_url
    ;;
  status)
    "${BACKEND}_status"
    printf 'Gateway (:%s): '  "$GATEWAY_PORT"; port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && echo "up" || echo "down"
    ;;
  config)
    "${BACKEND}_config_help"
    ;;
  stop)
    [[ "$USE_GATEWAY" == 1 ]] && gateway_down
    "${BACKEND}_stop"
    ;;
esac
