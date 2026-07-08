#!/usr/bin/env bash
# Download the baked-in Piper voice models at image-build time. After the build the
# container never needs the network again. To add/remove voices, edit the VOICES list
# below (find more at https://huggingface.co/rhasspy/piper-voices) and rebuild:
#   docker compose build jarvis-piper && docker compose up -d jarvis-piper
set -euo pipefail

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
DIR="${VOICES_DIR:-/opt/voices}"
mkdir -p "$DIR"

# "<voice-id>|<path within the model repo>"  (a good spread of US/GB, female/male)
VOICES="
en_US-amy-medium|en/en_US/amy/medium
en_US-lessac-medium|en/en_US/lessac/medium
en_US-kristin-medium|en/en_US/kristin/medium
en_US-ryan-medium|en/en_US/ryan/medium
en_US-hfc_male-medium|en/en_US/hfc_male/medium
en_GB-jenny_dioco-medium|en/en_GB/jenny_dioco/medium
en_GB-alan-medium|en/en_GB/alan/medium
"

for line in $VOICES; do
  id="${line%%|*}"
  sub="${line##*|}"
  echo "== downloading $id =="
  curl -fsSL -o "$DIR/$id.onnx"      "$BASE/$sub/$id.onnx"
  curl -fsSL -o "$DIR/$id.onnx.json" "$BASE/$sub/$id.onnx.json"
done

echo "== voices installed =="
ls -la "$DIR"
