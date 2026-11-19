# 공용 Vault 테스트넷 배포 전 준비

대상은 **WorldLand Gwangju 10359 ↔ BSC 테스트넷 97**입니다. Seoul 공식 RPC는 체인 103의 공개 데이터를 읽어 영수증 처리 호환성을 확인하는 데 사용합니다. Gwangju와 Seoul은 다른 네트워크입니다. [WorldLand 공식 네트워크](https://docs.worldland.foundation/developer/dapp/dev-environment) · [BNB Chain 공식 RPC 목록](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)

## 실행 전에 확보할 값

| 값 | 필요한 시점 |
| --- | --- |
| WorldLand 운영팀이 제공한 Gwangju HTTPS RPC | 배포 전 읽기 점검과 테스트넷 서비스 |
| BSC 97에서 로그·블록·전체 영수증 또는 거래별 영수증을 읽을 수 있는 HTTPS RPC | 배포 전 읽기 점검과 테스트넷 서비스 |
| 양 체인의 배포 EOA 공개 주소와 `pending` nonce | 미서명 배포 계획 생성 |
| 양 체인의 영수증 루트 등록 운영자 주소와 WL Vault의 초기 연결 권한 주소 | 생성자 인자와 초기 연결 거래 |
| 방향별로 승인한 확인 깊이, 테스트 가스 WL·tBNB | 실제 테스트넷 실행 |
| 실제 계약 주소·검토한 런타임 해시·배포 블록 | 배포가 끝난 뒤 읽기 전용 서비스 설정 |

RPC 자격 증명이 필요한 경우 실행 환경에만 설정합니다. 구성 파일에는 공개 계약 주소와 공개 권한 주소만 넣습니다. 지갑 서명에 사용할 개인키나 시드 문구는 서버에 입력하지 않습니다.

## 1. 읽기 전용 점검

```bash
go -C proof-generator run ./cmd/vault-rpc-check --network seoul
BNC_READ_RPC="$BNC_GWANGJU_RPC" go -C proof-generator run ./cmd/vault-rpc-check --network gwangju
BNC_READ_RPC="$BNC_BSC_TESTNET_RPC" go -C proof-generator run ./cmd/vault-rpc-check --network bsc-testnet
```

필요하면 `--block`으로 거래와 로그가 있는 샘플 블록을 지정합니다. 성공 기준은 예상 체인 ID, 비어 있지 않은 블록의 영수증 루트 재계산, 그리고 `eth_getLogs` 결과가 영수증 로그와 일치하는 것입니다. Seoul에서 관측한 샘플은 거래 1건의 legacy 영수증으로 루트가 일치했고, 로그는 0건이었습니다. Gwangju 주소는 공식 문서에 공개되어 있지 않고, 이 실행 환경에서는 BSC 공개 후보에 연결하지 못했습니다. [Seoul 실측](../results/wl-vault-testnet-preflight/seoul.json) · [BSC 연결 결과](../results/wl-vault-testnet-preflight/bsc-testnet.json)

## 2. 계약과 미서명 배포 계획

```bash
testnet_artifacts="$PWD/results/wl-vault-testnet-preflight/london-artifacts"
FOUNDRY_EVM_VERSION=london forge build --root contracts --no-cache \
  --out "$testnet_artifacts" testnet/VaultTestnet.sol

python3 scripts/vault-testnet.py plan --artifacts "$testnet_artifacts" \
  --wl-deployer "$WL_DEPLOYER" --wl-nonce "$WL_DEPLOYER_NONCE" \
  --bnb-deployer "$BSC_DEPLOYER" --bnb-nonce "$BSC_DEPLOYER_NONCE" \
  --wl-operator "$WL_ROOT_OPERATOR" --bnb-operator "$BSC_ROOT_OPERATOR" \
  --binding-authority "$WL_BINDING_AUTHORITY" > vault-testnet-unsigned.json
```

계획은 양쪽 레지스트리, WL Vault, wWL 배포 4건과 Vault의 `bindWrappedToken`, 각 레지스트리의 `configureBridge`를 포함해 미서명 데이터 7건을 만듭니다. Solidity 0.8.24·London 산출물만 받습니다. 배포 주소는 EOA와 nonce로 계산합니다. 서명 전에 체인과 nonce를 다시 읽고, 다르면 계획을 다시 생성합니다. 배포 영수증의 주소가 예상과 일치하는지 확인한 뒤 연결 거래를 진행합니다. 레지스트리는 비활성으로 배포됩니다. 최초 활성화 전까지 연결 권한자가 Vault의 상대 주소를 바로잡을 수 있고, 최초 활성화 시 각 체인의 연결을 고정합니다. [테스트넷 계약](../contracts/testnet/VaultTestnet.sol) · [미서명 계획 도구](../scripts/vault-testnet.py)

## 3. 연결 확인 후 활성화와 서비스 시작

런타임의 시험용 빌드가 필요하면 Go 생성기와 RISC Zero 호스트를 전용 파일에 설치합니다. 호스트는 `vault-testnet` feature로 빌드하고, `configs/vault-testnet-computation.json`의 Image ID와 실제 SDK 검증 결과를 대조합니다.

```bash
mkdir -p .bin
go -C proof-generator build -buildvcs=false -o ../.bin/bridge-vault-testnet-proof ./cmd/bridge-proof
cargo build --release --locked --manifest-path risc0/receipt-computation/Cargo.toml \
  -p bridge-receipt-host --features vault-testnet
# 고정 guest ID와 SDK 검증을 대조한 뒤 설치
install -m 755 risc0/receipt-computation/target/release/bridge-receipt-host .bin/bridge-vault-testnet-receipt-host
```

[공개 설정 양식](../configs/vault-testnet.example.json)을 복사해 배포한 주소, 배포에서 확인한 런타임 해시, 권한과 확인 깊이를 채웁니다. `historyStartBlock`은 각 체인의 자산 계약 배포 블록입니다. 활성화 계획과 서버 시작 모두 체인 ID, 런타임 해시, 양쪽 자산·레지스트리의 연결, 등록 운영자 및 Vault 연결 권한을 대조합니다. 또 저장된 합성 composite를 고정 Image ID의 실제 SDK로 재검증합니다. 런타임 설치와 함께 `results/wl-vault-testnet-preflight/lock/`의 `input.json` 및 `receipt.bin`이 필요합니다. 점검 중에는 새 증명을 생성하지 않습니다.

```bash
python3 scripts/vault-testnet.py activate-plan --config /path/to/vault-testnet.json > vault-testnet-activation.json
python3 scripts/vault-testnet.py serve --config /path/to/vault-testnet.json
```

양쪽 운영자가 각자의 활성화 거래를 검토·서명한 뒤 두 영수증과 두 레지스트리의 `active()`를 확인합니다. 지갑 주소는 `http://127.0.0.1:8586/`입니다. 확장 지갑에 두 테스트넷을 먼저 추가합니다. 지갑은 두 레지스트리가 활성 상태일 때 예치·소각 서명을 요청합니다. 사용자는 확장 지갑에서 예치·소각·청구를 서명하고 지갑에 설정한 네트워크로 제출합니다. 서버의 testnet RPC 경로는 읽기 전용입니다.

1. 출발 거래가 설정한 확인 깊이에 도달하면 서버가 해당 영수증 루트를 로컬에서 재계산합니다.
2. 목적지에 루트가 없으면 `waiting_root`와 미서명 `rootRegistration`을 표시합니다. 목적지 운영자가 `chainId`, 레지스트리 주소, 출발 블록 해시와 루트를 확인한 뒤 자신의 지갑으로 서명합니다.
3. 서버가 등록 루트를 대조한 뒤 실제 RISC Zero composite를 생성·SDK 검증합니다. 지갑은 패키지와 청구 데이터를 검토하고 사용자에게 목적지 청구 서명을 요청합니다.
4. 두 방향의 영수증·잔액을 대조합니다. 실제 테스트넷에서 예치 → 제3자 발행 → wWL 전송 → 보유자 소각 → 지정 주소 지급과 재시작 복구를 확인한 뒤 다음 단계로 넘어갑니다.

## 4. 정지와 복구

```bash
python3 scripts/vault-testnet.py pause-plan --config /path/to/vault-testnet.json \
  --evidence-digest "$INCIDENT_DIGEST" > vault-testnet-pause.json
python3 scripts/vault-testnet.py invalidate-plan --config /path/to/vault-testnet.json \
  --source wl --block "$INCIDENT_BLOCK" > vault-testnet-invalidate.json
```

- 정지 계획은 기존에 검증한 공개 설정에서 양쪽 미서명 거래를 만들며 RPC가 끊겨도 생성할 수 있습니다. 서명 지갑에서 각 체인과 운영자·레지스트리 주소를 다시 대조합니다. 두 체인의 정지는 별도 거래입니다. 양쪽 영수증과 `active()`를 확인합니다. 각 정지 상태에서 해당 체인의 예치 또는 소각과 루트 등록·청구가 막힙니다. 보유 중인 wWL의 일반 전송과 사용 승인은 계속 가능합니다.
- 서버가 확인하는 출발 블록과 등록 루트가 다르면 증명 진행을 차단하고, 등록 루트의 사용 여부를 표시합니다. `invalidate-plan`의 `--source wl`은 BSC 레지스트리를 대상으로 하며, `--source bnb`는 WorldLand 레지스트리를 대상으로 합니다. 목적지가 정지돼 있고 현재 출발 블록의 해시 또는 루트가 등록값과 다를 때, 청구에 쓰이지 않은 등록만 무효화할 수 있습니다. 확인 후 활성화 계획으로 재개하고 새 확인 깊이를 충족한 올바른 루트의 등록 절차를 따릅니다. 이미 발행·지급에 쓰인 루트는 변경이 차단되므로 재개 전에 두 체인의 거래와 잔액을 대조해야 합니다.
- WL 수신 계약이 지급을 거부하면 청구가 되돌아갑니다. 소각에 기록된 수신 주소가 직접 `submitBurnProofTo`를 호출해 받을 주소를 바꿀 수 있습니다. 확장 지갑에서 수신 주소로 연결하면 지급 단계에 주소 변경 입력이 표시됩니다. 계약 수신자는 해당 주소에서 호출을 실행할 기능이 필요합니다. 제어할 수 없는 주소에 보낸 자산은 이 경로로 복구할 수 없습니다.
- 지갑에서 거래 해시를 돌려주지 않았으면 지갑 내역의 해시로 원본 거래나 채굴된 대체 거래를 확인합니다. 해시를 찾지 못하고 RPC에서 확인한 최신·대기 nonce가 모두 원래 값과 같으면 같은 내용과 nonce로만 다시 서명할 수 있습니다.

## 검증 결과와 범위

- Foundry 57개, Node 지갑 17개, Go 회귀 및 테스트넷 서비스 7개를 통과했습니다. 초기 연결과 활성화, 정지 중 예치·소각 제한, 미사용 루트 교체와 사용된 루트 보호, 지급 실패 후 수신자 재청구, 1 WL 수량 인코딩, 공급자 로그 조회 제한을 확인했습니다.
- 합성 테스트넷 예치·소각 영수증으로 두 방향의 실제 composite를 생성하고 고정 Image ID로 SDK 재검증했습니다. 합성 증거는 테스트넷 RPC에서 조회한 거래가 아닙니다.
- 실제 테스트넷 배포와 지갑 서명, Gwangju/BSC RPC로 진행하는 양방향 인수 검증은 위 준비값이 필요합니다. Seoul 메인넷은 공개 데이터 조회에만 사용했습니다. [초기 검증 결과](../results/wl-vault-testnet-preflight/summary.json) · [코드 보강 검증 결과](../results/wl-vault-testnet-preflight/hardening.json)

현재 로컬 Vault 검증 세션은 증거에 대응하는 기존 고정 바이너리를 사용합니다. 공유 Rust 소스의 변경으로 새 로컬 빌드의 Image ID는 기존 정책과 달라질 수 있습니다. 기존 세션의 고정 호스트는 해당 Image ID와 함께 유지합니다. 테스트넷은 별도 바이너리와 정책을 사용합니다.
