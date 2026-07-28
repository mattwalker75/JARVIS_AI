#!/usr/bin/env bash
# JARVIS_LOCAL_LLM.sh — manage a LOCAL LLM runtime and print the endpoint URL to paste into
# JARVIS → Config → Endpoint URL. JARVIS core no longer knows or cares WHERE the model lives;
# it just talks OpenAI-dialect to whatever URL you give it (a cloud provider, or the URL below).
#
# Usage:
#   ./JARVIS_LOCAL_LLM.sh start  [--backend ollama] [--gateway]   # apply config, ensure it's up, print the URL
#   ./JARVIS_LOCAL_LLM.sh url    [--gateway]                       # just print the URL (nothing else)
#   ./JARVIS_LOCAL_LLM.sh stop   [--gateway]
#   ./JARVIS_LOCAL_LLM.sh status
#
# Backends: ollama (default). MLX / vLLM / llama.cpp can be added later as new backend blocks —
# each just implements: <backend>_apply_config, <backend>_ensure_running, <backend>_url, <backend>_stop.
#
# --gateway fronts the runtime with the LiteLLM gateway (one OpenAI endpoint, multi-model routing);
# without it, JARVIS talks straight to the runtime. Either way you paste the printed URL into Config.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${SCRIPT_DIR}/JARVIS_CONFIG.json"
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

usage() { awk 'NR>=2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }

# ============================ dispatch ============================
CMD=""; BACKEND="ollama"; USE_GATEWAY=0
while [[ $# -gt 0 ]]; do
  case "$(lc "$1")" in
    start|stop|status|url) CMD="$1" ;;
    --gateway)             USE_GATEWAY=1 ;;
    --backend)             shift; BACKEND="$(lc "${1:-ollama}")" ;;
    -h|--help|help)        usage; exit 0 ;;
    *) err "unknown argument: $1"; usage; exit 1 ;;
  esac
  shift
done
[[ -z "$CMD" ]] && { usage; exit 1; }

if [[ "$BACKEND" != "ollama" ]]; then
  err "backend '$BACKEND' is not implemented yet — only 'ollama'. (MLX / vLLM / llama.cpp: add a backend block above.)"; exit 1
fi

the_url() { if [[ "$USE_GATEWAY" == 1 ]]; then gateway_url; else ollama_url; fi; }

case "$CMD" in
  start)
    ollama_apply_config
    ollama_ensure_running || true
    [[ "$USE_GATEWAY" == 1 ]] && gateway_up
    echo
    ok "Local LLM ready."
    echo -e "${C_BOLD}Paste this into JARVIS → Config → Endpoint URL:${C_RESET}"
    echo -e "    ${C_GRN}$(the_url)${C_RESET}"
    if [[ "$USE_GATEWAY" == 1 ]]; then info "Via the gateway: set your model name(s) to entries in litellm/config.yaml."
    else info "Straight to Ollama: set your model name(s) to the Ollama tag (e.g. qwen3:8b, qwen2.5vl:32b)."; fi
    ;;
  url)
    the_url
    ;;
  status)
    printf 'Ollama  (:%s): ' "$OLLAMA_PORT";  port_up "http://localhost:${OLLAMA_PORT}/api/tags"           && echo "up" || echo "down"
    printf 'Gateway (:%s): '  "$GATEWAY_PORT"; port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && echo "up" || echo "down"
    ;;
  stop)
    [[ "$USE_GATEWAY" == 1 ]] && gateway_down
    ollama_stop
    ;;
esac
