# Activate the MLX Python environment (for running local models on Apple Silicon via mlx-lm).
# SOURCE this — don't execute it — so it can change your current shell:
#
#     source ./ACTIVATE.sh
#
# On first run it creates the venv (mlx/venv) and installs mlx-lm. It also points model
# downloads at mlx/models/ (HF_HOME). Leave the env with:  source ./DEACTIVATE.sh
#
# NOTE: MLX runs natively on the macOS HOST (needs Metal) — not inside the JARVIS containers.

# Resolve this file's directory in bash OR zsh (BASH_SOURCE in bash; $0 when sourced in zsh).
_mlx_src="${BASH_SOURCE[0]:-$0}"
_JROOT="$(cd "$(dirname "$_mlx_src")" && pwd)"
MLX_VENV="$_JROOT/mlx/venv"
MLX_MODELS="$_JROOT/mlx/models"

if [ ! -x "$MLX_VENV/bin/python" ]; then
  echo "==> Creating MLX venv ($MLX_VENV)..."
  python3 -m venv "$MLX_VENV"
fi

if [ -x "$MLX_VENV/bin/python" ]; then
  if ! "$MLX_VENV/bin/python" -c "import mlx_lm" >/dev/null 2>&1; then
    echo "==> Installing the MLX library set (mlx-lm) — first run, downloads mlx + deps..."
    "$MLX_VENV/bin/python" -m pip install --upgrade pip >/dev/null 2>&1
    "$MLX_VENV/bin/python" -m pip install mlx-lm
  fi
  mkdir -p "$MLX_MODELS"
  export HF_HOME="$MLX_MODELS"          # models download into mlx/models instead of ~/.cache
  # shellcheck disable=SC1091
  . "$MLX_VENV/bin/activate"
  echo "MLX env ACTIVE  —  $(python --version 2>&1)  @  $(command -v python)"
  echo "  models dir (HF_HOME) = $MLX_MODELS"
  echo "  serve a model:  mlx_lm.server --model mlx-community/<repo> --port 8080"
  echo "  leave the env:  source ./DEACTIVATE.sh"
else
  echo "!! Could not create the MLX venv. Is python3 installed?  ($(python3 --version 2>&1))"
fi
unset _mlx_src _JROOT
