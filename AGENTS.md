# BNC-WL current scope — 2026-11-19

The user's explicit 2026-11-19 instruction replaces the former RISC Zero requirement with an operator-signed xWL/wWL bridge. Complete and maintain the local implementation according to `docs/signed-bridge-checklist.md`.

- Chain A (local 31337): deposit native WL in the contract Vault and issue 1:1 ERC-20 xWL. xWL is freely transferable and locally redeemable without server approval. Redemption burns must never authorize cross-chain issuance.
- Bridge: burn xWL or wWL, verify the burn with trusted RPC, sign an EIP-712 message internally, and let the user directly submit the destination claim. wWL lives on local 31338. Bind source event, amount, recipient, chains, assets, domain, deadline and replay ID.
- Default: `bash scripts/run-server.sh`, mode `operator-signature`, state `results/signed-xwl-v1`, UI 127.0.0.1:8580. Only local chains 31337/31338. No external network deployment or real assets.
- Active runtime must not require RISC Zero, MPT construction/verification, SDK verification, Go proof binaries, or operator root registration. Do not silently change trust models or claim source consensus/finality authentication.
- All user asset actions and claims are signed in the browser wallet. The server signs messages only. Deployment and initial binding may use the local operator. Public Anvil fixtures are allowed; no personal keys. Do not add a server-side user transaction CLI.
- Maintain `docs/signed-bridge-checklist.md` as the durable completion/resume record. Save actual validation under `results/signed-bridge-validation/`. Keep `docs/current-status-report.md` and `results/prototype-progress.json` accurate; distinguish execution evidence from limitations.
- Preserve historical sessions, receipts, archives and restoration evidence. In particular do not mutate `results/prototype-risc0`, `results/wl-vault-v1`, or `results/xwl-entry-v1`. Never relabel historical receipts as new execution.
- TEE and obsolete header/BLS/Groth16 experiments were removed. Historical checkpoints are indexed in `legacy/README.md`. Do not reactivate their automation, source, UI, CI or services, or recreate intentionally archived output.
- New contracts are under `contracts/signature/` so old `contracts/src/` source fingerprints remain valid. Do not migrate old saved sessions to the new protocol in place.
- Historical RISC Zero launchers and durable proof binaries remain preserved evidence. Do not run new proofs for the signature flow. If historical proving is explicitly required later, inspect jobs/locks first; retain 12 CPUs, 70% available/cgroup memory, 1800 seconds and 64 MiB per file. Never use RISC0_DEV_MODE or fake verification.

## Resume

Read the checklist and progress JSON, inspect active services and locks, then run `python3 scripts/check-signed-bridge.py status`. `bash scripts/check-signed-local.sh` checks the running deployment without submitting asset transactions. Browser validation stores checkpoints and skips completed phases. These files do not automatically start a new chat.
