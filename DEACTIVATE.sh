# Leave the MLX Python environment. SOURCE this — don't execute it:
#
#     source ./DEACTIVATE.sh
#
# (`deactivate` is the function the venv defines while active.)

if command -v deactivate >/dev/null 2>&1; then
  deactivate
  unset HF_HOME
  echo "MLX env deactivated."
else
  echo "No active venv to deactivate (nothing to do)."
fi
