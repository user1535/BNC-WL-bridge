#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$root/.bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
state="${BNC_STATE_DIR:-$root/results/xwl-entry-v1}"
for required in "$root/.bin/bridge-burn-mint-proof" "$root/.bin/bridge-burn-mint-receipt-host"; do
  [[ -f "$required" ]] || { echo "Missing V2 runtime: $required" >&2; exit 1; }
done
mkdir -p "$state"
exec 9>"$state/launcher.lock"
flock -n 9 || { echo "xWL launcher already active" >&2; exit 1; }
python3 "$root/scripts/burn-mint-session.py" --xwl --dir "$state" start
python3 "$root/scripts/burn-mint-session.py" --xwl --dir "$state" deploy
exec python3 "$root/scripts/burn-mint-session.py" --xwl --dir "$state" --port "${BNC_API_PORT:-8583}" serve
