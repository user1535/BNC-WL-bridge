# 네이티브 WL의 계좌 내 잠금·타인 상환 가능성 조사

> **이전 설계 조사.** 이 문서는 네이티브 WL 계좌 잠금 후보를 검토한 기록입니다. 현재 연동 방향은 [xWL 설계](xwl-market-entry-direction.md)를 따릅니다.

조사일: 2026-11-03. 공식 문서와 공개 소스의 읽기 전용 조사다. 메인넷 실행 바이너리와 공개 소스 commit의 일치 여부, 실제 배포 기능은 별도 검증하지 않았다.

## 결론

조사한 공개 구현에는 일반 사용자 EOA의 네이티브 WL을 그대로 두고 브리지 몫만 잠그거나, BSC 소각 증명만으로 해당 EOA의 잔액을 다른 계좌로 이전하는 기능이 확인되지 않았다. 현재 테스트용 `BridgeLockableToken`의 계정 내부 잠금은 자체 ERC20 장부 기능이며 네이티브 WL 잔액 제어 기능이 아니다.

## 확인한 근거

- 공식 문서는 WL을 자체 메인넷의 네이티브 자산으로 설명한다: https://docs.worldland.foundation/tokenomics/overview
- `WorldLand/worldland`의 `core/evm.go`에서 `CanTransfer()`는 잔액과 금액만 비교하고 `Transfer()`는 송신자 차감·수신자 증가를 수행한다. 브리지 예약 금액 검사는 없다. `feature/beta-mainnet`, `feature/mio-testnet`에서도 해당 함수는 같은 구조다.
- `core/vm/evm.go`의 `Call()`은 caller 잔액에서 value를 이전한다. 별도 브리지 계약이 임의의 EOA를 송신자로 지정하여 잔액을 인출하는 인터페이스가 아니다.
- 확인한 `core/types/state_account.go`는 Nonce·Balance·Root·CodeHash를 가진다. 이 필드 조사만으로 모든 가능한 확장 부재를 증명하지는 않으며, 전송 경로·precompile·트랜잭션 처리 코드와 함께 확인했다.
- 확인한 `core/vm/contracts.go`의 precompile 목록에 요청한 계좌 잠금·브리지 상환용 기능은 보이지 않았다.
- Rockies v1.0 구현 사양은 Draft이며 EVM London 유지와 합의·DID/VRF 기능을 다룬다. stake registry의 잠금은 일반 EOA의 WL에 대한 범용 브리지 잠금 API가 아니다.
- `WorldLand_Contracts/token_contracts/contracts/MyToken.sol`은 `WorldLandNativeToken`이라는 이름의 ERC20이다. 이름만으로 네이티브 잔액 제어 기능으로 해석하면 안 된다. 해당 코드는 초기 발행 ERC20이며 요청한 잠금/강제이전 기능이 없다.

확인한 기본 브랜치 head: `f7010850f7098165c547b4c3a28449816d47d142`. 소스 원문·blob SHA·다른 브랜치 조회 결과는 `results/native-wl-lock-research-20261103/evidence.json`에 보존했다.

## 설계에 주는 의미

| 조건 | 판단 |
| --- | --- |
| 기존 EOA에 네이티브 WL 유지 + 체인 변경 없음 + A의 재승인 없이 B에게 상환 | 확인한 구현으로 지원되지 않음 |
| 개인별 스마트 계약 지갑 안에 WL 유지 | 검토 가능한 별도 설계. 잠금 중 소유자도 우회 인출할 수 없고, 검증된 상환만 허용해야 함. 기존 EOA와 다른 주소 모델이며 구현·검증 필요 |
| 기존 EOA 잔액에 프로토콜 예약을 추가 | 전송·가스 지불 등 모든 지출 경로와 상환 규칙의 합의 변경 및 네트워크 채택 필요 |
| bridge 공동 보관 계약 사용 | 일반적인 담보 모델이나 사용자가 밝힌 보관 금지 조건과 맞지 않음 |

RISC Zero 증명은 계산의 유효성을 증명한다. 그 증명을 사용할 자산 이동 권한이나 네이티브 잔액 잠금 규칙은 별도로 존재해야 한다. 서버가 SDK로 검증했다는 사실만으로 네이티브 WL 이동 권한이 생기지 않는다.

조사 중 공개 체인 거래·배포·새 증명 생성·노드 실행·현재 앱 소스 변경은 수행하지 않았다. 요구사항에 맞는 실제 구현 방향은 아직 확정하지 않았다.

## 주요 소스

- https://github.com/cryptoecc/WorldLand/blob/f7010850f7098165c547b4c3a28449816d47d142/core/evm.go
- https://github.com/cryptoecc/WorldLand/blob/f7010850f7098165c547b4c3a28449816d47d142/core/vm/evm.go
- https://github.com/cryptoecc/WorldLand/blob/worldland/core/state_transition.go
- https://github.com/cryptoecc/WorldLand/blob/worldland/core/vm/contracts.go
- https://github.com/cryptoecc/WorldLand/blob/docs/rockies-v1.0-spec/docs/specs/rockies-v1.0-instructions.md
- https://github.com/cryptoecc/WorldLand_Contracts/blob/main/token_contracts/contracts/MyToken.sol
