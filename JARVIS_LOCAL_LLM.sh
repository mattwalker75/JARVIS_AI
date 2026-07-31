#!/usr/bin/env bash
# JARVIS_LOCAL_LLM.sh — manage a LOCAL LLM runtime and print the endpoint URL to paste into
# JARVIS → Config → Endpoint URL. JARVIS core no longer knows or cares WHERE the model lives;
# it just talks OpenAI-dialect to whatever URL you give it (a cloud provider, or the URL below).
#
# Usage:
#   ./JARVIS_LOCAL_LLM.sh start        [--backend ollama | mlx] [--gateway]   # apply config, ensure it's up, print the URL
#   ./JARVIS_LOCAL_LLM.sh gateway-sync [--backend ollama | mlx]               # refresh the gateway's model list from live models
#   ./JARVIS_LOCAL_LLM.sh url          [--gateway]                       # just print the URL (nothing else)
#   ./JARVIS_LOCAL_LLM.sh stop         [--gateway]
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

# Low-level: replace the marker block in litellm/config.yaml with the content of $1 (a file of YAML
# routes; an EMPTY file clears the block). Cloud routes above / litellm_settings below are untouched.
_splice_local_block() { # $1 = routes file
  [[ -f "$LITELLM_CONFIG" ]] || { err "gateway config not found: $LITELLM_CONFIG"; return 1; }
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
# Runs local models natively on the macOS host via mlx-lm's OpenAI-compatible server. Each
# configured model gets its own mlx_lm.server process on its own port; front several with the
# LiteLLM gateway for one endpoint. The venv + models live under mlx/ (see ./ACTIVATE.sh).
MLX_VENV="${SCRIPT_DIR}/mlx/venv"
MLX_MODELS_DIR="${SCRIPT_DIR}/mlx/models"
MLX_SERVER="$MLX_VENV/bin/mlx_lm.server"
MLX_DEFAULT_MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"

# True if the config actually declares MLX models (so `status` can show MLX without the
# default-fallback noise on pure-Ollama setups).
mlx_has_models() { python3 -c "import json,sys; sys.exit(0 if json.load(open('$CFG')).get('mlx',{}).get('models',[]) else 1)" 2>/dev/null; }
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
  # Skip only entries with no port — a live server should still show even if its name/model is
  # blank in config (that's a useful signal that the config needs fixing, not a reason to hide it).
  while IFS='|' read -r name model port; do
    [[ -z "$port" ]] && continue
    printf 'MLX %-8s (:%s): ' "${name:-?}" "$port"; port_up "http://localhost:${port}/v1/models" && echo "up  (${model:-<no model set in config>})" || echo "down"
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
# Emit the LiteLLM route YAML for the LIVE MLX servers (stdout = YAML only; notes → stderr).
# Unlike Ollama, each MLX model is its own process on its own port — so we probe EACH port and
# emit a route only for servers that are actually answering. model_name = the entry's friendly name.
mlx_gateway_routes() {
  local n=0
  while IFS='|' read -r name model port; do
    [[ -z "$name" ]] && continue
    if port_up "http://localhost:${port}/v1/models"; then
      printf '  - model_name: "%s"\n' "$name"
      printf '    litellm_params:\n'
      printf '      model: "openai/%s"\n' "$model"
      printf '      api_base: http://%s:%s/v1\n' "$APP_HOST" "$port"
      printf '      api_key: mlx\n'
      n=$((n+1))
    else
      warn "MLX '$name' (:$port) not responding — skipping (run 'start --backend mlx' first)." >&2
    fi
  done < <(mlx_models_list)
  echo "    ($n MLX servers up)" >&2
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

   DOWNLOAD — models auto-download on first serve into  mlx/models/  (nothing to do). To
   pre-fetch (so the first request isn't slow), activate the env then use any of these:
     source ./ACTIVATE.sh
     hf download mlx-community/Qwen2.5-7B-Instruct-4bit   # just fetch it into mlx/models/
     mlx_lm.generate --model <repo> --prompt "hi"         # fetch + a quick test
     mlx_lm.manage --scan                                 # list what's cached ('--delete' to remove)
   (Everything saves under  mlx/models/  — gitignored; delete that dir to reclaim space.)

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
    start|stop|status|url|config|gateway-sync) CMD="$(lc "$1")" ;;
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
  status)
    # Diagnostic view: report EVERY backend's real state, not just the --backend default (ollama).
    ollama_status
    mlx_has_models && mlx_status               # only show MLX when models are actually configured
    printf 'Gateway (:%s): '  "$GATEWAY_PORT"; port_up "http://localhost:${GATEWAY_PORT}/health/liveliness" && echo "up" || echo "down"
    ;;
  config)
    "${BACKEND}_config_help"
    ;;
  stop)
    "${BACKEND}_stop"
    clear_gateway_models       # local runtime is going away → drop its routes from the gateway config
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
