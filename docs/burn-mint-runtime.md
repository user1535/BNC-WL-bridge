# Burn·mint V2 실행·인터페이스

> **적용 범위.** 아래 명령과 토큰 명칭은 기존 로컬 V2 검증 세션 기준입니다. 새 방향의 xWL↔wWL 브리지는 이 ABI·증명·청구 흐름을 재사용하며, WL 소각 발행과 같은 체인 직접 거래는 별도 연동 단계입니다. [개정 개발계획서](bidirectional-burn-mint-direction-20261103.md)

2026-11-03의 로컬 구현 및 네이티브 확장 설계 검증 기록이다. 실제 네이티브 WL 노드/합의 활성화와 실제 네트워크 배포는 완료 범위에 포함하지 않는다. 실행 결과는 [현재 상태](current-status-report.md), [체크리스트](burn-mint-checklist.md), `results/burn-mint-guarded-validation`를 따른다. 최초 강화 전 통합 기록은 `results/burn-mint-development`에 보존한다.

## 격리 실행

```bash
bash scripts/run-burn-mint.sh
# UI: http://127.0.0.1:8581/burn-mint.html
# 상태: results/burn-mint-v2, 노드: 127.0.0.1:8575 / :8576
```

최초 통합 검사 세션 `results/burn-mint-v2`는 강화 전 계약의 과거 증거로 보존한다. 최종 실행은 발행 권한 강화가 포함된 `results/burn-mint-v2-guarded`를 사용한다. 다른 세션을 덮어쓰지 않는다. `BNC_STATE_DIR`, `BNC_WL_PORT`, `BNC_BNB_PORT`, `BNC_API_PORT`로 새 격리 위치를 지정할 수 있다. RPC chain ID는 31337/31338만 허용한다. `run-server.sh`는 기존 V1 복구 세션을 유지한다. 새 V2 런처도 실제 composite receipt·SDK 검증을 필수로 사용한다. native-only나 dev receipt 모드는 없다.

Ctrl+C는 API와 소유 proving 자식만 정지한다. 노드까지 정상 종료하려면 API 정지 후 `python3 scripts/burn-mint-session.py stop`을 실행한다. 재개는 같은 런처를 사용한다. API 시작 시 running job을 queued로 복구하며 기존 실제 receipt가 있으면 SDK로 재검증한다. 다른 세션 노드가 포트를 차지하면 채택하거나 초기화하지 않는다. 배포 시 source hash를 기록하고 이후 소스가 달라지면 기존 세션의 실행을 거부한다. 기존 배포를 검토할 때는 `python3 scripts/burn-mint-session.py verify-runtime`이 현재 컴파일 코드와 immutable 설정을 대조한다. 이 검사는 Foundry 산출물이 필요하지만 이미 기록한 세션의 정상 실행에는 빌드 cache가 필요하지 않다.

durable V2 실행 파일은 `.bin/bridge-burn-mint-proof`, `.bin/bridge-burn-mint-receipt-host`, 정책은 `configs/burn-mint-computation.json`이다. V1 실행 파일과 정책을 덮어쓰지 않는다. 현재 guest 소스는 V1 input 검증과 새 V2 input 검증을 포함한 새 Image ID를 만든다. 기존 receipt는 기존 호스트/정책으로 검증한다.

```bash
GOCACHE=/tmp/bnc-wl-go-cache go -C proof-generator build -buildvcs=false -o ../.bin/bridge-burn-mint-proof ./cmd/bridge-proof
cargo build --release --locked --manifest-path risc0/receipt-computation/Cargo.toml -p bridge-receipt-host -j 12
# 생성 guest ID가 configs/burn-mint-computation.json과 일치하는지 확인 후:
cp risc0/receipt-computation/target/release/bridge-receipt-host .bin/bridge-burn-mint-receipt-host
```

## ABI와 자산 도메인

양쪽 모두 `BurnMintToken`과 `BurnMintReceiver`를 배포한다. WL 역할 토큰의 초기 공급은 로컬 operator의 1000 WL이며 A/B/C에 각각 100 WL을 배포용 fixture로 지급한다. BSC wWL 초기 공급은 0이다. 초기 공급/fixture 지급은 브리지 발행 누계에 넣지 않는다.

```solidity
bridgeBurn(uint256 amount, address recipient, uint256 destinationChainId)
bridgeMint(bytes32 burnId, address recipient, uint256 amount) // 고정 receiver만 호출
submitBurnProof((uint256 blockNumber,bytes32 blockHash,uint256 txIndex,uint256 logIndex,bytes[] proofNodes))
claimedBurn(bytes32 burnId) -> bool
mintedBurn(bytes32 burnId) -> bool
burnNonce(address burner) -> uint64
totalBridgeBurned() -> uint256
totalBridgeMinted() -> uint256
```

이벤트는 `BridgeBurned(bytes32,address,address,uint256,uint64,uint256)`이며 burnId/burner/recipient를 indexed로 둔다. nonce는 소각자별 1부터 증가한다. ID는 `keccak256(abi.encode(keccak256("WORLDLAND_BNB_BURN_MINT_V2"),sourceChainId,sourceAsset,destinationChainId,destinationAsset,burner,recipient,amount,nonce))`다. 금액은 18자리 1:1이며 가스비 외 임의 공제가 없다. 0 수량/0 주소/잘못된 체인과 자산 도메인은 거부한다. 한 소각은 한 번에 전액 발행한다.

peerToken·mintReceiver는 배포자가 한 번 바인딩하며 다시 바꾸지 못한다. 최초 바인딩에서도 canonical BurnMintReceiver runtime과 immutable 설정을 대조하여 가짜 검증기·proxy·다른 자산 receiver에 발행 권한을 주지 않는다. receiver는 성공 receipt/MPT·emitter·이벤트·ID·수신자·수량·체인·peer 바인딩·replay를 검사한다. 처리 ID·발행·누계는 원자적이다. 발행 실패 시 ID를 사용한 것으로 남기지 않는다. 현재 보유자와 최종 수신자는 최초 소각자와 달라도 된다.

## 증명/API와 실패 복구

`POST /api/jobs`의 V2 action은 `burn-wl` 또는 `burn-bsc`이고 나머지 필드는 `transferId`, `fromBlock`이다. `GET /api/jobs/{id}`, `/package`, `POST /api/computation/verify`를 사용한다. 패키지 version과 guest journal version은 2다. source 블록·confirmation·운영자 등록 root를 패키지 제공과 청구 직전 SDK 재검증 시 다시 확인한다.

Go는 전체 source block receipt로 root를 재구성하고 선택한 receipt-local 로그를 증명한다. 공통 실제 로컬 벡터는 `configs/burn-mint-vectors.json`이다. RISC Zero는 동일 input의 receipt/MPT/event/ID를 계산하고 journal의 input commitment를 검증한다. composite SDK 검증이 실패하면 발행 청구 패키지를 제공하지 않는다. 계약은 RISC Zero 자체를 검증하지 않으며 이 경계는 UI에도 표시한다.

브라우저는 지갑 개인키를 서버로 보내지 않는다. 데모 지갑은 공개 Anvil mnemonic의 A/B/C 계정을 브라우저 메모리에서 사용한다. 확장 지갑은 EIP-1193 경로를 제공하지만 외부 확장 지갑의 실제 동작 검증은 별도다. RPC proxy는 이미 서명된 raw transaction 방송만 허용하며 서버가 사용자의 unlocked transaction을 보내지 않는다. 서버 operator는 배포 fixture와 root·감사 기록만 처리한다.

미확인 거래는 세션 ID·계정으로 분리하고 nonce·거래 hash를 서명 전/후 저장한다. 결과가 불명확한 요청은 자동 재전송하지 않는다. source 소각 후 실패는 같은 ID를 조회해 재요청한다. 원본 자동 복원은 하지 않는다. 증명 요청·이벤트 입력·다운로드한 JSON으로 재개할 수 있다. 목적지 발행 여부는 `claimedBurn`으로 조회한다.

UI 누계는 조회한 현재 RPC 값을 보여 주는 진단용 값이다. 서로 다른 체인의 조회 시점이 다르므로 확정 감사 snapshot으로 사용하지 않는다. 방향별 대기량은 `source.totalBridgeBurned - destination.totalBridgeMinted`다. 일반 transfer/approve/transferFrom은 브리지 누계를 바꾸지 않는다.

## 검증 명령

```bash
forge test --root contracts
GOCACHE=/tmp/bnc-wl-go-cache go -C proof-generator test -race ./...
cargo test --offline --manifest-path risc0/receipt-computation/Cargo.toml -p bridge-receipt-core
node --test wallet/client.test.mjs wallet/burn-mint.test.mjs
python3 scripts/check-receipt-computation.py
python3 -m unittest discover -s native-wl -v
node scripts/check-burn-mint-demo.mjs
node scripts/check-burn-mint-restart-browser.mjs
```

브라우저 왕복 검사는 `browser-resume.json`의 완료 단계를 건너뛰므로 중단 시 이미 실행한 소각을 반복하지 않는다. 새 세션 검사에는 별도 `BNC_EVIDENCE_DIR`와 `BNC_DEMO_URL`을 지정한다. 재시작 검사는 기본 V2 격리 세션에 한정하고 활성 증명 job이 있으면 정지한다. CPU 최대 12개, 시작 시 가용/cgroup 메모리의 70%, 1800초, 파일당 64 MiB 제한과 전역 proving lock을 사용한다.
