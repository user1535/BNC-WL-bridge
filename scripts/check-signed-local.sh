#!/usr/bin/env bash
# Read-only verification of the active deployment; never submits asset actions.
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$root/.bin:$HOME/.foundry/bin:$PATH"
cd "$root"
mkdir -p results/signed-bridge-validation
forge test --root contracts --offline --json > results/signed-bridge-validation/contracts.json
node --test --test-isolation=none --test-reporter=spec wallet/client.test.mjs wallet/burn-mint.test.mjs wallet/signature.test.mjs > results/signed-bridge-validation/wallet-tests.txt
python3 scripts/check-signed-bridge-api.py
python3 scripts/check-signed-bridge.py verify
python3 scripts/check-signed-bridge.py status
