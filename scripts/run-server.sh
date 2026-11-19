#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ -n "${BNC_ENV_FILE:-}" ]]; then
  set -a
  source "$BNC_ENV_FILE"
  set +a
fi
export PATH="$root/.bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
exec bash "$root/scripts/run-prototype.sh" "${BNC_MODE:-risc0-computation}" "${BNC_STATE_DIR:-$root/results/prototype-risc0}"
