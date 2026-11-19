#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
python_bin="${BNC_PYTHON:-python3}"
mode="${1:-risc0-computation}"
if [[ "$mode" != risc0-computation ]]; then
  echo "Only risc0-computation is supported; header proving and native-only modes were retired." >&2
  exit 2
fi
session_dir="${2:-${BNC_STATE_DIR:-results/prototype-risc0}}"
mkdir -p -- "$session_dir"
exec 9>"$session_dir/launcher.lock"
flock -n 9 || { echo "This state directory already has an active launcher" >&2; exit 1; }
"$python_bin" scripts/server-doctor.py
"$python_bin" scripts/local-session.py --dir "$session_dir" start
cleanup() { "$python_bin" scripts/local-session.py --dir "$session_dir" stop; }
trap cleanup EXIT
"$python_bin" scripts/local-session.py --dir "$session_dir" deploy
"$python_bin" scripts/proof-service.py --session "$session_dir" --confirmations 2 --demo-mine
