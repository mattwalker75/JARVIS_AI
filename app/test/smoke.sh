#!/usr/bin/env bash
# Live smoke test — run AFTER `./JARVIS.sh --start` to confirm the HTTP surface is healthy.
#   bash app/test/smoke.sh            (defaults to http://localhost:8110)
#   APP=http://localhost:8110 bash app/test/smoke.sh
set -u
APP="${APP:-http://localhost:8110}"
pass=0; fail=0
chk() { # chk "label" "url" [expected-substring]
  local label="$1" url="$2" want="${3:-}"
  local body; body="$(curl -sS --max-time 10 "$url" 2>/dev/null)"
  if [ -z "$body" ]; then echo "  ✗ $label (no response)"; fail=$((fail+1)); return; fi
  if [ -n "$want" ] && ! printf '%s' "$body" | grep -q "$want"; then echo "  ✗ $label (missing '$want')"; fail=$((fail+1)); return; fi
  echo "  ✓ $label"; pass=$((pass+1))
}
echo "=== JARVIS smoke test @ $APP ==="
chk "app serves UI"          "$APP/"                  "JARVIS"
chk "/api/config"            "$APP/api/config"        "provider"
chk "/api/plan (idle=null)"  "$APP/api/plan"
chk "/api/autopilot (idle)"  "$APP/api/autopilot"     "active"
chk "/api/models"            "$APP/api/models"        "models"
chk "/api/selftest"          "$APP/api/selftest"
# model listing against the CONFIGURED endpoint (uses the running config's base_url)
BASE="$(curl -sS "$APP/api/config" | sed -n 's/.*"base_url":"\([^"]*\)".*/\1/p')"
if [ -n "$BASE" ]; then
  echo "  · probing models at $BASE"
  chk "/api/models/probe"    "$APP/api/models/probe"  || true
fi
echo ""
echo "HTTP smoke: $pass passed, $fail failed"
echo ""
cat <<'CHECK'
=== Manual model-behaviour checklist (needs a real turn) ===
Ask JARVIS to do these and watch the Activity tab + Logs (level 4+):
  [ ] Coding: "build a small web app, serve it" -> uses plan_create + serve_app; posts a
      CLICKABLE link; prefers edit_workbench_file over full rewrites on follow-up changes.
  [ ] Debug: break the app's JS, ask it to fix -> it browser_goto's the URL and calls
      browser_console to read the runtime error (does NOT just re-read the HTML).
  [ ] Autopilot: start a small objective (5 min) -> plan fills in; try Pause/Resume,
      +15m, Modify; confirm the finish notification fires.
  [ ] Config: pick a provider, paste a key, click "List models" -> the model pickers populate.
CHECK
[ "$fail" -eq 0 ]
