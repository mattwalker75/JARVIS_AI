#!/usr/bin/env bash
#
# JARVIS.sh - Single control script for the JARVIS multi-container stack.
#
# Wraps docker-compose.yml (jarvis-app + jarvis-memory + jarvis-workbench + jarvis-piper).
# Expands on the ByOwnerOS RUN_LOCAL_DEV.sh pattern with memory backup/restore.
#
#   jarvis-app        Node.js backend + JS frontend (orchestrator)            :8110
#   jarvis-memory     Mem0 semantic long-term memory (vector store)           :8120
#   jarvis-workbench  Linux desktop (noVNC) the LLM works in as root          :8111
#   jarvis-piper      Offline neural text-to-speech (Piper), internal-only    :5000
#
# LLM HOSTING is NOT managed here. JARVIS just talks to whatever URL is in llm.base_url
# (a cloud provider, or a local runtime). To run models locally, use ./JARVIS_LOCAL_LLM.sh
# (Ollama + an optional LiteLLM gateway) and paste the URL it prints into the Config tab.
#
# Usage:
#   ./JARVIS.sh <flag> [<flag> ...]
#
# Flags:
#   -c, --check        Verify the local Docker daemon is running.
#   -b, --setup        Build the app/workbench/memory/voice images.
#   -u, --start        Start the whole stack; print URLs.
#   -r, --reload       Restart the app to re-read config files (JARVIS_CONFIG.json +
#                      JARVIS_SECRETS.json). Memory + workbench keep running. Run this after
#                      saving from the Config tab. (Local LLM runtimes: see ./JARVIS_LOCAL_LLM.sh.)
#   -t, --terminal     Chat with JARVIS in this terminal (no browser).
#   -p, --prompt <text>  Run one prompt and print the answer; supports piping stdin in.
#   -e, --eval         Replay data/evals/*.json through the model and report pass/fail.
#       --probe-context   Measure the current model's usable context window (needle test).
#   -i, --status       Show whether the containers are running.
#   -x, --stop         Stop the stack (keeps data volumes).
#   -d, --delete       Remove containers, network, and ALL data volumes.
#                      If long-term memory is online, it first ASKS whether to back it up
#                      (runs --backup-memory on "yes"). Add -f/--force to skip that prompt.
#   -f, --force        Skip interactive confirmations (currently: --delete's memory-backup prompt).
#       --backup-memory   Save the semantic memory (Mem0 vector store) to backups/jarvis-memory-<ts>.tgz.
#       --restore-memory [--from <file>]   Restore the memory from a backup tarball,
#                      or (no --from) reset to a FRESH empty memory.
#       --backup-workspace   Save the workbench /LLM_WORKSPACE to backups/jarvis-workspace-<ts>.tgz.
#       --restore-workspace [--from <file>]   Restore /LLM_WORKSPACE from a backup,
#                      or (no --from) reset it to EMPTY.
#       --reset-workbench   DELETE & REBUILD only the dev OS container (the Linux the LLM works in),
#                      back to its clean image — wipes everything the LLM installed/changed at RUNTIME
#                      (apt & pip packages, system tweaks). KEEPS /LLM_WORKSPACE build files + browser
#                      logins, and leaves the app, memory, config, and LLM_READ_WRITE_FILES untouched.
#                      (Also rebuild the IMAGE from the Dockerfile: --setup. Also wipe /LLM_WORKSPACE:
#                      --restore-workspace --fresh.)
#   -h, --help         Show this help.
#
# Lifecycle flags run in the order given, e.g.:  ./JARVIS.sh --setup --start
# URLs (once started):  http://localhost:8110  (chat UI)   http://localhost:8111  (desktop)
#
# Example workflows:
#   # First run — build images and start everything:
#   ./JARVIS.sh --check --setup --start
#
#   # Chat with JARVIS right in the terminal (no browser):
#   ./JARVIS.sh --terminal
#
#   # Ask one question and get the answer on stdout:
#   ./JARVIS.sh --prompt "what is in /etc/os-release on the workbench?"
#
#   # Pipe data IN for analysis (stdin is sent along with the prompt):
#   cat my_application.log | ./JARVIS.sh --prompt "analyze this log and list the issues"
#   git diff | ./JARVIS.sh --prompt "review this diff for bugs"
#   ./JARVIS.sh --prompt "summarize this" < report.txt
#
#   # After editing JARVIS_CONFIG.json or JARVIS_SECRETS.json:
#   ./JARVIS.sh --reload
#
#   # Back up / restore the LLM's semantic memory (Mem0 vector store):
#   ./JARVIS.sh --backup-memory
#   ./JARVIS.sh --restore-memory --from backups/jarvis-memory-20260628-101500.tgz
#   ./JARVIS.sh --backup-workspace        # the LLM's /LLM_WORKSPACE project/code dir
#   ./JARVIS.sh --restore-workspace --from backups/jarvis-workspace-20260628-101500.tgz
#
#   # Stop the stack, or fully tear it down. --delete removes containers, network, and the
#   # data volumes (semantic memory + workbench home); bind mounts -- LLM_WORKSPACE, config,
#   # Prompts, and the shared folders -- survive.
#   ./JARVIS.sh --stop
#   ./JARVIS.sh --stop --delete           # if memory is online, asks: back it up first? [y/N]
#   ./JARVIS.sh --stop --delete --force   # skip that prompt and just delete (no backup)
#
#   # Health check (memory + workbench + internet + vault):
#   curl http://localhost:8110/api/selftest
#
# Data & persistence (on the host, via bind mounts):
#   data/sessions/<id>.json        saved conversations ("Save current" in the web UI; /save in --terminal)
#   data/tasks.json                scheduled tasks + notification history
#   LLM_READ_WRITE_FILES/              files JARVIS writes for you (LLM_READ_ONLY_FILES/ = files you share to it)
#   backups/jarvis-memory-<ts>.tgz    semantic-memory backups (--backup-memory)
#   backups/jarvis-workspace-<ts>.tgz workbench /LLM_WORKSPACE backups (--backup-workspace)
#   These (and LLM_WORKSPACE) survive --delete — they are bind mounts. --delete wipes only the
#   Docker volumes (semantic memory + workbench home).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
PROJECT="jarvis"
APP_CONTAINER="jarvis-app"
WB_CONTAINER="jarvis-workbench"
MEM_CONTAINER="jarvis-memory"
MEM_VOLUME="${PROJECT}_jarvis_memory_data"
# (LLM_WORKSPACE is a host bind mount now — ./LLM_WORKSPACE — not a Docker volume)
APP_PORT="8110"; WB_PORT="8111"; MEM_PORT="8120"
FORCE=0   # set by -f/--force; when 1, --delete skips its "back up memory first?" prompt

# LLM hosting/management lives OUTSIDE this script now — see ./JARVIS_LOCAL_LLM.sh (local runtimes
# like Ollama + an optional LiteLLM gateway). JARVIS just talks to whatever URL is in
# JARVIS_CONFIG.json's llm.base_url (a cloud provider, or the URL that helper prints).

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YEL='\033[0;33m'; C_BLU='\033[0;34m'; C_BOLD='\033[1m'
else C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BOLD=''; fi
info() { echo -e "${C_BLU}==>${C_RESET} $*"; }
ok()   { echo -e "${C_GRN}OK ${C_RESET} $*"; }
warn() { echo -e "${C_YEL}!! ${C_RESET} $*"; }
err()  { echo -e "${C_RED}ERROR${C_RESET} $*" >&2; }
lc()   { echo "$1" | tr '[:upper:]' '[:lower:]'; }

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

require_compose_file() { [[ -f "$COMPOSE_FILE" ]] || { err "compose file not found: $COMPOSE_FILE"; exit 1; }; }
daemon_running() { docker info >/dev/null 2>&1; }
require_daemon() {
  daemon_running && return 0
  err "Docker daemon is NOT running."
  echo "    Start Docker Desktop (macOS:  open -a Docker), wait for it to be ready, then re-run."
  exit 1
}
container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

read_cfg() { # $1 dotted.key  $2 default
  local cfg="${SCRIPT_DIR}/config/JARVIS_CONFIG.json"
  [[ -f "$cfg" ]] || { echo "$2"; return; }
  python3 - "$cfg" "$1" "$2" <<'PY' 2>/dev/null || echo "$2"
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
wait_http() { # $1 port  $2 path  $3 label
  for _ in $(seq 1 40); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$1$2" 2>/dev/null)" == "200" ]] \
      && { ok "$3 responding."; return 0; }
    sleep 2
  done
  warn "$3 not responding yet on http://localhost:$1$2 (may still be starting)."; return 1
}

# The memory service (Mem0) embeds text with a model served by a LOCAL Ollama on the host
# (mem0.embed_base_url, default host.docker.internal:11434 -> localhost:11434 from here). The chat
# LLM may be cloud, but memory still needs this embedder up — so if it's unreachable, print the full
# clean-install steps to enable it. Non-fatal: the stack runs fine, only long-term memory is affected.
check_memory_embedder() {
  local url model port tags
  url="$(read_cfg mem0.embed_base_url "http://host.docker.internal:11434/v1")"
  model="$(read_cfg mem0.embed_model "nomic-embed-text")"
  # Only meaningful for a LOCAL Ollama we can actually probe from the host.
  case "$url" in
    *host.docker.internal*|*localhost*|*127.0.0.1*) : ;;
    *) return 0 ;;
  esac
  port="$(printf '%s' "$url" | sed -n 's#.*:\([0-9]\{2,5\}\).*#\1#p')"; [[ -z "$port" ]] && port=11434
  tags="$(curl -sf --max-time 3 "http://localhost:${port}/api/tags" 2>/dev/null)"
  if [[ -z "$tags" ]]; then
    warn "memory embedder unreachable — perform the following steps to enable memory"
    echo "    - Install Ollama"
    echo "    - Run:  ollama pull ${model}"
    echo "    - Run:  ollama serve"
  elif ! printf '%s' "$tags" | grep -q "$model"; then
    warn "memory embedder is running but the '${model}' model isn't pulled — run:  ollama pull ${model}"
  fi
}

# Autopilot run state + the task-ledger plan persist in data/ (bind mount) so a run survives
# an app auto-restart. The deliberate lifecycle commands (stop/delete/setup/start), though,
# should hand you a clean slate — no zombie Autopilot banner or leftover plan. Wipe them here.
clear_autopilot_state() {
  local removed=0
  for f in "${SCRIPT_DIR}/data/autopilot.json" "${SCRIPT_DIR}/data/plan.json"; do
    [[ -e "$f" ]] && { rm -f "$f" && removed=1; }
  done
  [[ "$removed" == 1 ]] && info "Cleared saved Autopilot run + plan (fresh start)." || true
}

cmd_check() {
  info "Checking the local Docker daemon..."
  daemon_running && ok "Docker daemon running ($(docker version -f '{{.Server.Version}}' 2>/dev/null))." \
    || { err "Docker daemon is NOT running."; return 1; }
}

cmd_setup() {
  require_daemon
  clear_autopilot_state
  info "SETUP: building the app + workbench + memory + voice (piper) images..."
  warn "The workbench builds on linuxserver/webtop and installs a large toolchain; the first build can take several minutes and needs internet. jarvis-piper downloads its neural voice models (a few hundred MB) on first build."
  dc build jarvis-app jarvis-workbench jarvis-memory jarvis-piper || { err "Image build failed."; return 1; }
  ok "SETUP complete. Next:  ./JARVIS.sh --start"
}

cmd_start() {
  require_daemon
  clear_autopilot_state
  info "START: bringing up app + memory + workbench + voice..."
  dc up -d || { err "Failed to start the stack."; return 1; }
  wait_http "$MEM_PORT" "/healthz" "Memory service" || true
  wait_http "$APP_PORT" "/healthz" "JARVIS app" || true
  echo
  ok "JARVIS is up."
  echo -e "${C_BOLD}  Chat UI:${C_RESET}            http://localhost:${APP_PORT}/"
  echo -e "${C_BOLD}  Workbench desktop:${C_RESET}  http://localhost:${WB_PORT}/   (the Linux the LLM works in)"
  echo -e "${C_BOLD}  Semantic memory:${C_RESET}    http://localhost:${MEM_PORT}/"
  echo "      Self-test the LLM's tools:  curl http://localhost:${APP_PORT}/api/selftest"
  echo -e "  ${C_BOLD}Model:${C_RESET} set an endpoint in the Config tab. Cloud → paste the provider URL; local → run  ${C_BOLD}./JARVIS_LOCAL_LLM.sh start${C_RESET}  and paste the URL it prints."
  check_memory_embedder
}

cmd_reload() {
  require_daemon
  info "RELOAD: restarting the app to re-read JARVIS_CONFIG.json + JARVIS_SECRETS.json..."
  info "(The database, memory service, and workbench keep running; the LLM's memory and any browser session are preserved.)"
  info "(Local LLM runtimes are managed separately — see ./JARVIS_LOCAL_LLM.sh.)"
  dc restart jarvis-app || { err "Reload failed."; return 1; }
  wait_http "$APP_PORT" "/healthz" "JARVIS app" || true
  ok "Configuration reloaded."
}

cmd_terminal() {
  require_daemon
  container_running "$APP_CONTAINER" || { err "JARVIS app is not running. Start it: ./JARVIS.sh --start"; return 1; }
  info "JARVIS terminal — type a message and press Enter.  /exit to quit, /reset to clear history."
  docker exec -it "$APP_CONTAINER" node cli.js --interactive
}

cmd_eval() {
  require_daemon
  container_running "$APP_CONTAINER" || { err "JARVIS app is not running. Start it: ./JARVIS.sh --start"; return 1; }
  info "EVAL: replaying data/evals/*.json through the live model + tool loop..."
  docker exec "$APP_CONTAINER" node eval.js
}

cmd_probe_context() {
  require_daemon
  container_running "$APP_CONTAINER" || { err "JARVIS app is not running. Start it: ./JARVIS.sh --start"; return 1; }
  info "CONTEXT PROBE: measuring the current model's usable context window (needle-in-haystack)..."
  docker exec "$APP_CONTAINER" node probe_context.js
}

cmd_prompt() {
  require_daemon
  container_running "$APP_CONTAINER" || { err "JARVIS app is not running. Start it: ./JARVIS.sh --start"; return 1; }
  local prompt="$1"
  [[ -z "$prompt" ]] && { err "--prompt requires a prompt string"; return 1; }
  if [ -t 0 ]; then
    # interactive terminal, nothing piped in
    docker exec "$APP_CONTAINER" node cli.js --prompt "$prompt" </dev/null
  else
    # stdin is a pipe/redirect — forward it to the prompt
    docker exec -i "$APP_CONTAINER" node cli.js --prompt "$prompt"
  fi
}

cmd_status() {
  require_daemon
  info "Container status:"; dc ps; echo
  for pair in "$MEM_CONTAINER memory" "$WB_CONTAINER workbench" "$APP_CONTAINER app"; do
    set -- $pair
    if container_running "$1"; then echo -e "  $2  ($1): ${C_GRN}running${C_RESET}"; else echo -e "  $2  ($1): ${C_RED}stopped${C_RESET}"; fi
  done
  if container_running "$APP_CONTAINER"; then
    echo -e "  app health (http://localhost:${APP_PORT}/healthz): HTTP $(curl -s -o /dev/null -w '%{http_code}' http://localhost:${APP_PORT}/healthz 2>/dev/null)"
  fi
}

cmd_stop() { require_daemon; info "STOP: stopping the stack..."; dc stop; clear_autopilot_state; ok "Stopped. Restart with:  ./JARVIS.sh --start"; }

cmd_delete() {
  require_daemon
  # --delete wipes the semantic-memory volume. If memory is ONLINE (so there may be memories worth
  # keeping), offer to back it up first — unless -f/--force, or there's no terminal to prompt on.
  if [[ "$FORCE" != "1" ]] && container_running "$MEM_CONTAINER"; then
    if [[ -t 0 ]]; then
      printf '%b' "${C_YEL}?? ${C_RESET}Long-term memory is online. Back it up before deleting? [y/N] "
      local ans; read -r ans
      case "$(lc "$ans")" in
        y|yes) cmd_backup_memory || { err "Memory backup failed — aborting delete so nothing is lost."; return 1; } ;;
        *)     info "Skipping memory backup." ;;
      esac
    else
      warn "Long-term memory is online but there's no terminal to prompt — skipping backup. Run --backup-memory first, or pass --force to silence this."
    fi
  fi
  warn "DELETE: removing containers, network, and the data volumes (semantic-memory vector store + workbench home). Bind mounts — config, shared folders, and LLM_WORKSPACE — survive."
  dc down -v --remove-orphans
  clear_autopilot_state
  ok "Removed."
}

# The semantic memory (Mem0) lives in the jarvis-memory volume at /data (Chroma
# vector store). Back it up / restore it as a tarball.
cmd_backup_memory() {
  require_daemon
  container_running "$MEM_CONTAINER" || { err "Memory service is not running. Start it first: ./JARVIS.sh --start"; return 1; }
  mkdir -p "${SCRIPT_DIR}/backups"
  local ts file; ts="$(date +%Y%m%d-%H%M%S)"; file="${SCRIPT_DIR}/backups/jarvis-memory-${ts}.tgz"
  info "Backing up semantic memory -> backups/jarvis-memory-${ts}.tgz ..."
  if docker exec "$MEM_CONTAINER" sh -c 'tar czf - -C /data .' > "$file" && [[ -s "$file" ]]; then
    ok "Backup written: backups/jarvis-memory-${ts}.tgz ($(du -h "$file" | cut -f1 | tr -d ' '))"
  else
    err "Backup failed."; rm -f "$file"; return 1
  fi
}

cmd_restore_memory() { # $1 = backup file (empty => wipe to a fresh, empty memory)
  require_daemon
  local from="$1"
  if [[ -n "$from" ]]; then
    [[ -f "$from" ]] || { err "Backup file not found: $from"; return 1; }
    warn "Restoring semantic memory from ${from} — this REPLACES the current memories."
    info "Stopping the memory service to restore cleanly..."
    dc stop "$MEM_CONTAINER" >/dev/null 2>&1 || true
    if docker run --rm -i -v "${MEM_VOLUME}:/data" alpine sh -c 'rm -rf /data/* /data/..?* 2>/dev/null; tar xzf - -C /data' < "$from"; then
      dc up -d "$MEM_CONTAINER" >/dev/null 2>&1 || return 1
      wait_http "$MEM_PORT" "/healthz" "Memory service" || true
      ok "Semantic memory restored from ${from}."
    else
      err "Restore failed."; dc up -d "$MEM_CONTAINER" >/dev/null 2>&1 || true; return 1
    fi
  else
    warn "Resetting semantic memory to EMPTY — this DESTROYS all stored memories."
    dc rm -sf "$MEM_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$MEM_VOLUME" >/dev/null 2>&1 || true
    dc up -d "$MEM_CONTAINER" || return 1
    wait_http "$MEM_PORT" "/healthz" "Memory service" || true
    ok "Fresh, empty semantic memory deployed."
  fi
}

# The workbench /LLM_WORKSPACE is now a HOST bind mount (./LLM_WORKSPACE), so back it up /
# restore it by tarring that host folder directly — no running container required.
cmd_backup_workspace() {
  local ws="${SCRIPT_DIR}/LLM_WORKSPACE"
  [[ -d "$ws" ]] || { err "Workspace dir not found: $ws"; return 1; }
  mkdir -p "${SCRIPT_DIR}/backups"
  local ts file; ts="$(date +%Y%m%d-%H%M%S)"; file="${SCRIPT_DIR}/backups/jarvis-workspace-${ts}.tgz"
  info "Backing up LLM_WORKSPACE -> backups/jarvis-workspace-${ts}.tgz ..."
  if tar czf "$file" -C "$ws" . && [[ -s "$file" ]]; then
    ok "Backup written: backups/jarvis-workspace-${ts}.tgz ($(du -h "$file" | cut -f1 | tr -d ' '))"
  else
    err "Backup failed."; rm -f "$file"; return 1
  fi
}

cmd_restore_workspace() { # $1 = backup file (empty => wipe to an empty LLM_WORKSPACE)
  local ws="${SCRIPT_DIR}/LLM_WORKSPACE" from="$1"
  mkdir -p "$ws"
  if [[ -n "$from" ]]; then
    [[ -f "$from" ]] || { err "Backup file not found: $from"; return 1; }
    warn "Restoring LLM_WORKSPACE from ${from} — this REPLACES its current contents."
    find "$ws" -mindepth 1 ! -name '.gitkeep' -delete 2>/dev/null || true
    if tar xzf "$from" -C "$ws"; then
      ok "Workspace restored from ${from}."
    else
      err "Restore failed."; return 1
    fi
  else
    warn "Resetting LLM_WORKSPACE to EMPTY — this DESTROYS its current contents."
    find "$ws" -mindepth 1 ! -name '.gitkeep' -delete 2>/dev/null || true
    touch "$ws/.gitkeep"
    ok "Fresh, empty LLM_WORKSPACE."
  fi
}

# Reset ONLY the dev OS container to its clean built image — the escape hatch for when the LLM
# has installed a pile of packages / made a mess of the system. Recreating the container from
# jarvis-workbench:local gives it a fresh writable layer, so every runtime apt/pip install and
# system tweak is wiped. Kept: the /LLM_WORKSPACE bind mount (build files) + the workbench-home
# volume (desktop / any browser logins), and every OTHER container (app, memory, piper) + your config
# + LLM_READ_WRITE_FILES are left completely untouched.
cmd_reset_workbench() {
  require_daemon
  info "RESET WORKBENCH: recreating the dev OS container ($WB_CONTAINER) from its clean image..."
  info "  WIPED: everything the LLM installed/changed at RUNTIME (apt & pip packages, system tweaks)."
  info "  KEPT:  /LLM_WORKSPACE build files + the workbench home (desktop / browser logins), and every"
  info "         other container (app, memory) + your config + LLM_READ_WRITE_FILES."
  dc rm -sf "$WB_CONTAINER" >/dev/null 2>&1 || true
  dc up -d "$WB_CONTAINER" || { err "Failed to bring the workbench back up."; return 1; }
  wait_http "$WB_PORT" "/" "Workbench desktop" || true
  ok "Workbench reset to its image baseline. (the desktop takes a few seconds to come back)"
  info "Deeper wipes: /LLM_WORKSPACE too → ./JARVIS.sh --restore-workspace --fresh ; rebuild the image → ./JARVIS.sh --setup ."
}

usage() { awk 'NR>=3 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }

main() {
  require_compose_file
  [[ $# -eq 0 ]] && { usage; exit 1; }
  # Pre-scan for -f/--force so it applies to --delete regardless of flag order.
  for a in "$@"; do case "$(lc "$a")" in -f|--force) FORCE=1 ;; esac; done
  local rc=0
  while [[ $# -gt 0 ]]; do
    case "$(lc "$1")" in
      -f|--force)   : ;;   # modifier, handled in the pre-scan above
      -c|--check)   cmd_check  || rc=$? ;;
      -b|--setup)   cmd_setup  || rc=$? ;;
      -u|--start)   cmd_start  || rc=$? ;;
      -r|--reload)  cmd_reload || rc=$? ;;
      -t|--terminal) cmd_terminal || rc=$? ;;
      -e|--eval)    cmd_eval   || rc=$? ;;
      --probe-context) cmd_probe_context || rc=$? ;;
      -p|--prompt)
        if [[ -z "${2:-}" ]]; then err "--prompt requires a prompt string"; echo; usage; rc=2;
        else cmd_prompt "$2" || rc=$?; shift; fi
        ;;
      -i|--status)  cmd_status || rc=$? ;;
      -x|--stop)    cmd_stop   || rc=$? ;;
      -d|--delete)  cmd_delete || rc=$? ;;
      --backup-memory)  cmd_backup_memory || rc=$? ;;
      --restore-memory)
        local from=""
        if [[ "$(lc "${2:-}")" == "--from" || "$(lc "${2:-}")" == "--from-backup" ]]; then from="${3:-}"; shift 2;
        elif [[ "$(lc "${2:-}")" == "--fresh" ]]; then shift 1; fi
        cmd_restore_memory "$from" || rc=$? ;;
      --reset-workbench)   cmd_reset_workbench || rc=$? ;;
      --backup-workspace)  cmd_backup_workspace || rc=$? ;;
      --restore-workspace)
        local fromw=""
        if [[ "$(lc "${2:-}")" == "--from" || "$(lc "${2:-}")" == "--from-backup" ]]; then fromw="${3:-}"; shift 2;
        elif [[ "$(lc "${2:-}")" == "--fresh" ]]; then shift 1; fi
        cmd_restore_workspace "$fromw" || rc=$? ;;
      -h|--help)    usage ;;
      check) cmd_check || rc=$? ;; setup) cmd_setup || rc=$? ;; start) cmd_start || rc=$? ;;
      reload) cmd_reload || rc=$? ;; terminal) cmd_terminal || rc=$? ;;
      prompt)
        if [[ -z "${2:-}" ]]; then err "prompt requires a string"; echo; usage; rc=2;
        else cmd_prompt "$2" || rc=$?; shift; fi
        ;;
      status) cmd_status || rc=$? ;; stop) cmd_stop || rc=$? ;; delete) cmd_delete || rc=$? ;; help) usage ;;
      reset-workbench) cmd_reset_workbench || rc=$? ;;
      *) err "Unknown flag: $1"; echo; usage; rc=2 ;;
    esac
    [[ $rc -ne 0 ]] && break
    shift; echo
  done
  exit $rc
}

main "$@"
