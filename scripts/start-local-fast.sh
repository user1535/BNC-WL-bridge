#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$root_dir/configs/local-fast.env"

if ! command -v anvil >/dev/null 2>&1; then
  echo "error: anvil is required (install Foundry first)" >&2
  exit 127
fi

pids=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

anvil --host 127.0.0.1 --port 8545 --chain-id "$LOCAL_WORLDLAND_CHAIN_ID" \
  --block-time "$WORLDLAND_BLOCK_TIME" >"${TMPDIR:-/tmp}/bnc-wl-worldland-anvil.log" 2>&1 &
pids+=("$!")

anvil --host 127.0.0.1 --port 8546 --chain-id "$LOCAL_BSC_CHAIN_ID" \
  --block-time "$BSC_BLOCK_TIME" >"${TMPDIR:-/tmp}/bnc-wl-bsc-anvil.log" 2>&1 &
pids+=("$!")

wait_for_rpc() {
  local url=$1 expected=$2
  local body
  for _ in {1..50}; do
    body=$(curl --silent --show-error --fail \
      --header 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "$url" 2>/dev/null || true)
    if [[ $body == *"\"result\":\"0x$expected\""* ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "error: chain $url did not report chain ID 0x$expected" >&2
  return 1
}

wait_for_rpc "$LOCAL_WORLDLAND_RPC_URL" "$(printf '%x' "$LOCAL_WORLDLAND_CHAIN_ID")"
wait_for_rpc "$LOCAL_BSC_RPC_URL" "$(printf '%x' "$LOCAL_BSC_CHAIN_ID")"

echo "LOCAL_WORLDLAND ready: $LOCAL_WORLDLAND_RPC_URL (chain $LOCAL_WORLDLAND_CHAIN_ID)"
echo "LOCAL_BSC ready:       $LOCAL_BSC_RPC_URL (chain $LOCAL_BSC_CHAIN_ID)"
echo "Press Ctrl-C to stop both chains."
wait
