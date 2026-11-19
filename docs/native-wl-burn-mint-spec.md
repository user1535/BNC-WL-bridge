# 네이티브 WL burn·mint 확장 사양 및 검증 범위

> **이전 설계 기록.** 2026-11-05에 채택한 [xWL 방향](xwl-market-entry-direction.md)은 WL 소각 발행·시장 교환과 ERC20 브리지로 구성합니다. 아래 사양은 네이티브 공급 규칙 확장 후보를 검토한 기록입니다.

> **최중요 — 발행 권한 경계:** 네이티브 발행은 고정된 소각 검증 경로만 수행할 수 있어야 한다. 관리자·복구용 mint, 교체 가능한 receiver/facade, delegatecall·proxy로 검증을 우회하는 진입점을 허용하지 않는다. 노드의 native-supply 경로에서 실제 호출 주소와 코드 hash를 강제하고, 검증된 이벤트의 수신자·수량 및 소각 ID 1회 처리를 원자적으로 반영해야 한다. 이 조건은 네이티브 확장의 필수 완료 게이트다. 로컬 ERC20 모델의 구현·우회 거부 검사는 [V2 검증 기록](burn-mint-checklist.md)에 기록했으며 네이티브 노드 구현 완료로 간주하지 않는다.

상태: 2026-11-03 설계·상태 전이 참조 모델. **WL 노드 구현이나 네트워크 활성화 완료가 아니다.**
현재 실행 경로는 로컬 31337/31338의 ERC20 모델이다. 네이티브 WL 노드 소스는 이 저장소에 없으며 네트워크 배포는 실행 범위 밖이다.

## 선택한 확장 경계

권장 후보는 고정 시스템 계약 + 제한된 native-supply precompile이다. 일반 계약에 네이티브 잔액 쓰기 권한을 주지 않고, 노드가 합의 규칙으로 지정된 시스템 주소·호출자·코드 hash·활성화 높이를 확인한다. 전용 새 거래 타입보다 기존 EVM 거래·receipt·지갑/RPC 경로를 재사용하기 쉽다는 설계상의 판단이다. 실제 채택에는 WL 실행 엔진과의 검토가 필요하다.

시스템 자산 facade는 `peerChainId()`, `peerToken()`, `mintReceiver()`, `burnNonce(address)`, `mintedBurn(bytes32)`, `totalBridgeBurned()`, `totalBridgeMinted()`, `bridgeBurn(uint256,address,uint256)`, `bridgeMint(bytes32,address,uint256)` 의미를 제공한다. 브리지용 초기 배포 설정은 genesis/활성화 패치의 불변 파라미터이며 관리자 임의 mint나 실행 중 재바인딩 진입점은 없다.

현 `BurnMintReceiver`의 토큰 `code.length` 검사는 로컬 ERC20 계약을 위한 것이다. 네이티브 facade는 코드가 있는 시스템 계약이어야 이 검사를 그대로 사용할 수 있다. 코드 없는 precompile을 자산 주소로 직접 넣지 않는다. 실제 네이티브 버전은 별도 artifact·정책·체인 도메인으로 배포한다. 로컬 chain 제한을 제거하는 것은 이 작업에 포함하지 않는다.

## 이벤트와 도메인

소각의 receipt 로그는 시스템 자산 facade 주소에서 다음 ABI로 발생해야 한다.

```solidity
event BridgeBurned(bytes32 indexed burnId, address indexed burner,
    address indexed recipient, uint256 amount, uint64 nonce, uint256 destinationChainId);
event BridgeMinted(bytes32 indexed burnId, address indexed recipient, uint256 amount);
```

단위는 18 decimals, 1:1이며 가스비와 전환 수량을 분리한다. 네이티브 자산 ID는 배포 구성에 고정된 `(WL chain ID, system asset facade address)`다. ERC20처럼 네이티브 자산의 임의 transfer/approve 인터페이스를 요구하지 않는다. BSC wWL은 일반 ERC20이다.

```text
DOMAIN = keccak256("WORLDLAND_BNB_BURN_MINT_V2")
burnId = keccak256(abi.encode(DOMAIN,
  sourceChainId, sourceAsset, destinationChainId, destinationAsset,
  burner, recipient, amount:uint256, nonce:uint64))
```

V2 로컬 증거의 소각 ID는 위 식과 동일하다. 실제 네트워크를 위한 domain/version 선택은 활성화 검토에서 명시해야 한다. V1 Locked/Burned 로그와 V1 composite receipt를 V2 발행 근거로 쓰지 않는다. source/destination 자산·체인·수신자·수량·nonce가 하나라도 달라지면 다른 ID다.

## 소각 상태 전이

1. 노드의 일반 거래 검증이 사용자 서명, 계정 거래 nonce, chain ID, gas 한도와 선납을 처리한다.
2. 활성화 높이 이상인지, 고정 상대 체인/자산과 수신자·양수 수량·uint256 범위·uint64 브리지 nonce를 검사한다.
3. 사용자 잔액에서 수량을 감소시키고 네이티브 공급량을 감소시킨다. 시스템의 보관 잔액으로 누적하지 않는다. 만약 payable facade를 쓴다면 `msg.value == amount`를 강제하고 이미 이동한 시스템 잔액을 같은 EVM frame에서 소각한다. 사용자 잔액을 두 번 차감하면 안 된다.
4. 사용자 브리지 nonce·소각 누계·위 이벤트를 같은 journal frame에서 기록한다.

실행 실패 시 자산 잔액·공급·브리지 nonce·누계·로그가 모두 rollback된다. 일반 EVM 규칙의 거래 nonce·사용한 가스 비용은 별개다. 상태 전이 참조 모델의 잔액은 가스 선납 후 사용 가능 잔액이며 가스 처리는 모델 범위 밖이다.

## 발행 상태 전이

1. 사용자가 목적지 receiver의 `submitBurnProof`를 호출한다. receiver는 체인 내부의 승인 root에 대한 성공 receipt/MPT, 허용 BSC wWL emitter, 이벤트·도메인·수신자·수량·nonce와 소각 ID를 결정적으로 검증한다.
2. receiver는 ID 처리 표시와 발행 누계를 갱신하고 시스템 facade의 `bridgeMint`를 호출한다. 시스템은 고정 receiver 호출자와 예상 코드 hash·peer 바인딩·소각 ID 미처리를 다시 강제한다.
3. 지정 수신자 잔액·네이티브 공급량·브리지 발행 누계·처리 ID·발행 로그를 같은 frame에서 변경한다. 실패하면 receiver의 변경까지 전부 되돌린다.

네이티브 precompile은 고정 facade만 호출할 수 있고 facade의 mint는 고정 receiver만 호출할 수 있어야 한다. 단순 임의 관리자 `mint(address,amount)`는 허용하지 않는다. receiver나 facade를 delegatecall한 다른 주소는 이 권한을 얻지 않는다. 재진입 전에 처리 표시를 하고 외부 콜백을 유발하지 않는다.

서버는 앱에서 실제 composite receipt를 SDK로 검증한다. 합의 실행 중 Python SDK·외부 RPC 호출을 하지 않는다. 체인이 강제하는 것은 operator root에 대한 결정적 MPT/event/replay다. 운영자가 잘못된 root를 등록해도 안전하다는 보장과 onchain RISC0 검증은 없다.

## 조회·복구와 공급량

일반 block/receipt RPC에 시스템 로그를 포함하여 `receiptsRoot`를 일관되게 계산한다. 브리지 nonce·burnId·mintedBurn·양쪽 누계는 재실행 시 동일해야 한다. 월렛은 `source_burn_confirmed → waiting_confirmations → proving → proof_ready → claim_submitted → destination_minted`를 ID별로 보존한다. proving/API/청구 실패는 재시도 가능한 상태이며 원본 자동 재발행 경로를 만들지 않는다.

브리지 순공급 변화는 `totalBridgeMinted - totalBridgeBurned`다. 네이티브 공급 통계는 초기 공급·채굴 보상·기타 규칙 변화와 이 값을 별도로 집계한다. 고정 안전 높이의 `B_WL >= M_BSC`, `B_BSC >= M_WL`와 미발행 수량을 대조한다. 서로 다른 시점의 RPC snapshot은 확정 감사 증거가 아니다.

## 활성화 및 검증 게이트

genesis/upgrade 설정에는 activation height, protocol version, 두 체인/자산, 시스템 facade·precompile·receiver 주소와 코드 hash, root 등록 권한, 가스 스케줄, 18자리 단위, counter storage key를 고정한다. 활성화 전 호출은 거부한다. 모든 검증 노드가 같은 block input으로 같은 상태 root·receipt root를 계산해야 한다. 노드 채택과 활성화는 별도 승인·실행 범위다.

이 저장소에서 수행할 수 있는 검증은 다음과 같다.

- 로컬 Solidity receiver가 실제 MPT·이벤트·도메인·재사용·발행 원자성을 검사하는 테스트.
- Go·guest·지갑이 동일 ABI/ID와 실제 source receipt를 검사하는 교차 검증.
- `native-wl/test_reference.py`의 공급량/잔액/nonce/재사용/활성화/overflow/rollback/결정적 재실행 모델 검증. 이 모델은 MPT 검증이나 노드 구현을 대체하지 않는다.

실제 노드 완료에는 실행 엔진 integration test, native balance syscall 권한 검사, payable 중복 차감 방지, 가스/실패 receipt, reorg rollback, 다중 노드 state/receipt root 일치, 업그레이드 전후 fork 재실행, 탐색기 공급량 대조가 추가로 필요하다. 이 항목들은 **미구현·미실행**으로 기록한다.
