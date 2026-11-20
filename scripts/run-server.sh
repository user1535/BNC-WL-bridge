#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ -n "${BNC_ENV_FILE:-}" ]]; then
  set -a
  source "$BNC_ENV_FILE"
  set +a
fi
export PATH="$root/.bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
if [[ "${BNC_MODE:-operator-signature}" != operator-signature ]]; then
  echo "Active mode is operator-signature. Historical receipts and launchers are preserved separately." >&2
  exit 1
fi
exec bash "$root/scripts/run-signed-bridge.sh"
