#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$root/.bin:$HOME/.foundry/bin:$PATH"
state="${BNC_STATE_DIR:-$root/results/signed-xwl-v1}"
mkdir -p "$state"
exec 9>"$state/launcher.lock"
flock -n 9 || { echo "Signed bridge launcher already active" >&2; exit 1; }
forge build --root "$root/contracts" --offline --quiet
python3 "$root/scripts/signed-bridge.py" start --dir "$state"
trap 'python3 "$root/scripts/signed-bridge.py" stop --dir "$state"' EXIT
python3 "$root/scripts/signed-bridge.py" deploy --dir "$state"
python3 "$root/scripts/signed-bridge.py" serve --dir "$state" --port "${BNC_API_PORT:-8580}" --confirmations 2 --demo-mine
