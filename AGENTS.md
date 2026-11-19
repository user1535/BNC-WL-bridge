# BNC-WL current scope — 2026-10-29

The user now trusts the bridge server operator and RPC provider. Restore and maintain the original web wallet with user-signed direct submission and actual RISC Zero receipt/MPT/event computation proofs. This supersedes the old untrusted-server/TEE requirements.

- Default: `bash scripts/run-server.sh`, mode `risc0-computation`, state `results/prototype-risc0`, UI 127.0.0.1:8580; chains 31337/31338 only.
- RISC Zero guest is pinned in configs/receipt-computation.json. Require real composite receipt SDK verification; never use RISC0_DEV_MODE or silently fall back to native-only mode.
- Composite computation receipts are verified by the server SDK. The destination contracts verify MPT/event/domain/replay against operator-registered roots. Do not claim on-chain RISC Zero verification or source consensus/finality authentication.
- User asset actions and claims are signed in the browser wallet. The server may register roots and audit commitments with the local operator. No personal private keys, testnet/mainnet deployment or real assets.
- TEE files and obsolete header/BLS/Groth16 experiments have been removed. Historical checkpoints are indexed in legacy/README.md. Do not reactivate its automation, source, UI, CI or services.
- Preserve the active results/prototype-risc0 session, current receipts/restoration evidence, and compact historical source/session archives. Removed experimental output was intentionally replaced by archives during the user-authorized cleanup. Do not recreate it.
- Bound proving to at most 12 CPUs, 70% available/cgroup memory, 1800 seconds and 64 MiB per file. Inspect active jobs and locks before proving; do not duplicate work.
- Keep docs/current-status-report.md and results/prototype-progress.json accurate. Report actual execution and remaining limitations separately.

- Only risc0-computation is supported. Native-only/header-proving launch modes, server-side user transaction CLI, and old diagnostic contracts were retired. Keep receipt generation, SDK verification and user browser submission mandatory.
- Durable runtime binaries are .bin/bridge-proof and .bin/bridge-receipt-host. Cargo/Foundry caches are regenerable and are not required to run the current session.
