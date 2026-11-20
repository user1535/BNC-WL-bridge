# 내부 서명 기반 xWL ↔ wWL 로컬 브리지

## 실행

```bash
bash scripts/run-server.sh
```

지갑: http://127.0.0.1:8580/signature.html. 새 세션은 `results/signed-xwl-v1`이며 체인 A는 Anvil 31337 / RPC 8593, 체인 B는 Anvil 31338 / RPC 8594다. 종료는 실행 터미널의 Ctrl+C로 한다. 서버와 두 노드가 정상 종료되고 계약·잔액·패키지가 보존된다. 같은 명령으로 다시 실행한다.

필요 런타임은 Python 3, Bash·flock, Foundry의 forge·cast·anvil, 고정 Solidity 0.8.24다. 새 서버는 RISC Zero 호스트·Go 증명 생성기·MPT 구성·SDK 검증·운영자 루트 등록을 사용하지 않는다. Node·Playwright는 검사용이며 지갑·서버 실행에는 필요 없다. `.bin/node`는 이번 검증에 준비한 Node 24 런타임이다.

다른 로컬 실습은 새 상태 경로와 비어 있는 포트를 지정한다. 기존 세션의 RPC 설정은 변경하지 않는다.

```bash
BNC_STATE_DIR="$PWD/results/signed-xwl-practice" \
BNC_API_PORT=8588 BNC_WL_PORT=8596 BNC_BNB_PORT=8597 \
  bash scripts/run-server.sh
```

## 자산 흐름

1. 지갑에서 **WL 예치·상환**을 연다. 예치한 WL은 `VaultXWL` 계약에 남고 같은 수량의 xWL이 수령인에게 발행된다.
2. xWL은 체인 A에서 전송·사용 승인·대리 전송할 수 있다. 보유자가 상환하면 xWL을 소각하고 WL을 받는다. 상환에는 서버 서명이 필요 없다.
3. **xWL ↔ wWL**에서 xWL을 브리지용으로 소각한다. 목적지 수령인을 소각 이벤트에 기록한다.
4. **서버 서명 받기**로 원본 소각과 확정 깊이를 확인한다. 서버는 EIP-712 메시지에 서명한 패키지를 제공한다. 지갑에서 내용을 검토하고 직접 청구하면 체인 B의 wWL이 발행된다.
5. wWL은 체인 B에서 자유 전송·사용 승인·대리 전송할 수 있다. 반환 시 wWL을 소각하고, 같은 서명·직접 청구 절차로 체인 A의 xWL을 발행받는다. 이후 WL 상환은 별도 로컬 거래다.

두 체인에 두 토큰이 모두 배포되는 것은 아니다. 시장 교환 계약이나 유동성 풀을 제공하지 않으며, 자유 전송과 사용 승인을 제공한다. 브리지 전환은 18자리 단위의 1:1이며 가스비는 별도다.

## 서명과 신뢰 경계

`BridgeClaim`은 소각 ID, 출발 체인·토큰, 소각자·수령인·수량·nonce, 원본 거래·블록 해시·블록 번호·로그 위치와 유효기한을 포함한다. EIP-712 도메인은 목적지 체인·계약·버전에 묶인다. 청구 계약은 등록된 서명자, 필드·소각 ID, 만료, 중복 처리를 검증한다. 청구인이 누구든 서명에 고정된 수령인에게만 발행한다.

서명자 주소는 배포 시 고정된다. 서버가 소각의 정당성을 판단하며 목적지 계약은 원본 체인의 합의·최종성을 독립 검증하지 않는다. 유효한 내부 키가 잘못 사용되면 허위 발행을 승인할 수 있다. 이 로컬 버전은 공개 Anvil 계정 9번의 키를 노드에서 사용하며 개인 키를 파일·API에 제공하지 않는다. 실제 운영용 키 관리·교체·다중 서명은 이 버전의 범위 밖이다.

서버가 요청자에게 받는 것은 출발 체인·원본 거래 해시·선택적 로그 위치뿐이다. 수량·수령인 등은 성공한 소각 이벤트에서 읽는다. 상환용 소각과 일반 전송은 서명하지 않는다. API의 RPC 프록시는 서버 서명·unlocked 거래·Anvil 제어 메서드를 차단하며, 이용자의 raw 서명 거래만 중계한다. 원본 Anvil RPC는 공개 테스트 노드이므로 실제 운영 보안 경계로 사용하지 않는다.

## 중단·재개

- 공개 거래 기록에서 소각 건을 선택하면 새 브라우저에서도 이어갈 수 있다.
- 서명은 목적지 블록 시각 기준 1시간 유효하다. 만료 시 같은 소각 ID로 다시 발급하며 이미 처리한 소각은 재발행하지 않는다.
- 지갑 응답을 잃으면 **미확인 거래 → 거래 상태 확인**을 사용한다. 브라우저에 저장한 nonce와 거래 내용을 대조해 실제 포함 여부를 확인한다. 자동으로 재전송하지 않는다.
- 기존 세션·소스 지문·배포 코드·상대 토큰·서명자·체인 ID가 다르면 재사용을 거부한다.
- 마지막 작업과 다음 단계는 [체크리스트](signed-bridge-checklist.md)에 남긴다. 체크리스트는 새 대화를 자동 실행하지 않지만 다음 실행이 이어갈 수 있는 기록이다.

```bash
python3 scripts/check-signed-bridge.py status
bash scripts/check-signed-local.sh
```

`check-signed-local.sh`는 계약·지갑 회귀, API 권한·서명 재사용, 담보 보존과 과거 세션 보존을 검사하며 자산 거래를 제출하지 않는다. 기존 루프백 서버에 접근할 수 있는 환경에서 실행한다.

## 브라우저 검증 재현

검증 결과는 `results/signed-bridge-validation/`에 저장한다. `check-signed-bridge-browser.mjs`는 실제 브라우저의 공개 테스트 지갑으로 자산 거래를 서명한다. 완료한 단계는 체크포인트를 읽어 재전송하지 않는다. 새 검증은 별도 새 상태와 별도 출력 경로를 사용하도록 스크립트의 설정을 맞춰야 한다.

이번 환경의 검증 명령:

```bash
export BNC_PLAYWRIGHT_MODULE=/tmp/bnc-browser/node_modules/playwright/index.mjs
export PLAYWRIGHT_BROWSERS_PATH=/tmp/bnc-browsers
export LD_LIBRARY_PATH=/tmp/bnc-browser-libs/extracted/usr/lib/x86_64-linux-gnu
export FONTCONFIG_FILE=/tmp/bnc-fonts/fonts.conf
.bin/node scripts/check-signed-bridge-browser.mjs forward
python3 scripts/check-signed-bridge.py snapshot
# 서버 Ctrl+C → 같은 실행 명령으로 재시작
python3 scripts/check-signed-bridge.py compare
.bin/node scripts/check-signed-bridge-browser.mjs return
.bin/node scripts/check-signed-bridge-browser.mjs recovery
.bin/node scripts/check-signed-bridge-browser.mjs expiry
```

`/tmp`의 Playwright·Chromium·폰트 설정은 재생성 가능한 검사 도구다. 필요하면 Node 환경에서 Playwright를 설치하고 해당 Chromium과 시스템 라이브러리를 준비한 뒤 환경 변수로 지정한다. 이번에 실제 설치된 버전과 경로는 최종 검증 요약에 기록한다.

## 관련 파일

- 계약: `contracts/signature/SignedBridge.sol`
- 서버·세션: `scripts/signed-bridge.py`, 기본 실행: `scripts/run-server.sh`
- 지갑: `wallet/signature.html`, `wallet/signature-client.mjs`, `wallet/signature-ui.mjs`
- 계약·클라이언트·API·브라우저 검사: `contracts/test/SignedBridge.t.sol`, `wallet/signature.test.mjs`, `scripts/check-signed-bridge*.py`, `scripts/check-signed-bridge-browser.mjs`
- 이전 RISC Zero 세션·실행 코드와 증거는 보존되어 있으며 새 기본 경로와 혼용하지 않는다.
