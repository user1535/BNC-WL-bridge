#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$root/.bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
export BNC_WL_PORT="${BNC_WL_PORT:-8569}"
export BNC_BNB_PORT="${BNC_BNB_PORT:-8570}"
state="${BNC_STATE_DIR:-$root/results/wl-vault-v1}"
for runtime in bridge-vault-proof bridge-vault-receipt-host; do
  [[ -x "$root/.bin/$runtime" ]] || { echo "Missing Vault runtime: $runtime" >&2; exit 1; }
done
mkdir -p -- "$state"
exec 9>"$state/launcher.lock"
flock -n 9 || { echo "Vault launcher already active" >&2; exit 1; }
python3 "$root/scripts/local-session.py" --vault --dir "$state" start
trap 'python3 "$root/scripts/local-session.py" --vault --dir "$state" stop' EXIT
python3 "$root/scripts/local-session.py" --vault --dir "$state" deploy
python3 "$root/scripts/proof-service.py" --vault --session "$state" --port "${BNC_API_PORT:-8584}" --confirmations 2 --demo-mine
