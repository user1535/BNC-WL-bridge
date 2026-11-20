# BNC-WL · 내부 서명 기반 xWL ↔ wWL 브리지

체인 A에서 네이티브 WL을 계약 Vault에 예치하면 1:1 ERC-20 xWL을 발행한다. xWL은 같은 체인에서 자유 전송·사용 승인·상환할 수 있다. 브리지는 xWL과 체인 B의 wWL을 소각·발행 방식으로 1:1 전환한다.

서버가 원본 소각을 확인해 교환 메시지에 내부 서명하고, 이용자가 내용을 검토한 뒤 목적지 체인에 직접 제출한다. 새 기본 경로는 RISC Zero·MPT·운영자 루트 등록을 사용하지 않는다.

## 실행

```bash
bash scripts/run-server.sh
```

지갑: **http://127.0.0.1:8580/signature.html**

| 항목 | 값 |
| --- | --- |
| 프로토콜 / 모드 | `signed-xwl-bridge-v1` / `operator-signature` |
| 체인 A | Anvil 31337 · RPC `http://127.0.0.1:8593` · WL, xWL |
| 체인 B | Anvil 31338 · RPC `http://127.0.0.1:8594` · wWL |
| 상태 | `results/signed-xwl-v1` |
| 런타임 | Python 3, Bash·flock, Foundry forge·cast·anvil, Solidity 0.8.24 |

지갑의 공개 테스트 계정 A/B/C로 로컬 자산 거래를 직접 서명한다. 개인 키·실자산·외부 체인 배포는 사용하지 않는다. 실행 터미널에서 Ctrl+C로 종료하면 서버·두 노드의 상태를 보존한다. 같은 명령으로 재시작한다. [실행·복구 상세](docs/signed-bridge-runtime.md)

## 자산 흐름

```text
체인 A: WL ↔ Vault·xWL
브리지: xWL 소각 → 서버 서명 → 이용자 직접 청구 → 체인 B의 wWL 발행
반환:   wWL 소각 → 서버 서명 → 이용자 직접 청구 → 체인 A의 xWL 발행
상환:   체인 A에서 xWL 소각 → Vault의 WL 지급
```

xWL은 체인 A에서, wWL은 체인 B에서 유통된다. 시장 교환 계약·유동성 풀을 제공하지는 않으며 실제 교환에는 거래 상대·유동성이 필요하다. WL 상환용 소각은 브리지 발행을 승인하지 않는다. 체인 내부 예치·상환에는 서버 서명이 필요 없다.

서버는 자산 거래를 제출하지 않는다. 목적지 계약은 EIP-712 서버 서명, 도메인·소각 ID·수량·수령인·만료·중복 여부를 검증한다. 제3자가 청구해도 발행 대상은 서명된 수령인으로 고정된다.

**운영자와 RPC를 신뢰한다.** 공개 이벤트·메시지·서명·청구 결과를 대조할 수 있지만 원본 체인의 합의·최종성을 독립 인증하지는 않는다. 키 탈취는 허위 발행을 승인할 수 있다. 이 버전의 서명자는 공개 Anvil fixture이며 배포 후 고정된다. 실제 운영용 키 관리·교체, 확장 지갑 실측·외부 배포는 별도 범위다.

## 검증과 재개

```bash
python3 scripts/check-signed-bridge.py status
bash scripts/check-signed-local.sh
```

점검 루틴은 계약·지갑 회귀, API 권한·동시 발급·확정 기준, 담보와 과거 세션 보존을 확인하며 자산 거래를 제출하지 않는다. 브라우저 검사는 공개 테스트 지갑으로 거래를 서명하고 완료한 단계는 재전송하지 않는다.

- [완료 체크리스트·재개 절차](docs/signed-bridge-checklist.md)
- [실행·API·브라우저 검증 환경](docs/signed-bridge-runtime.md)
- [현재 상태](docs/current-status-report.md)
- [실제 로컬 실행 요약](results/signed-bridge-validation/summary.json)
- [브라우저 거래·복구·만료 검증](results/signed-bridge-validation/browser-summary.json)

## 파일 구조

| 구성 | 역할 |
| --- | --- |
| `contracts/signature/SignedBridge.sol` | 담보형 xWL, wWL, 소각·서명 기반 청구 |
| `scripts/signed-bridge.py` | 로컬 세션, 소각 검증, EIP-712 내부 서명, 공개 API |
| `scripts/run-server.sh`, `scripts/run-signed-bridge.sh` | 기본 실행과 상태·노드 관리 |
| `wallet/signature*` | 사용자 직접 서명·패키지 검토·공개 기록·복구 |
| `contracts/test/SignedBridge.t.sol`, `wallet/signature.test.mjs` | 계약·클라이언트 검사 |
| `scripts/check-signed-*` | API·브라우저·재시작·담보·재개 루틴 |
| `results/signed-xwl-v1`, `results/signed-bridge-validation` | 새 세션과 별도 검증 근거 |

이전 RISC Zero·Vault·소각 진입형 xWL 구현과 세션은 보존한다. 새 담보형 xWL과 과거 WL 유통 제외 주소 전송형 xWL을 혼동하지 않는다. [문서 목록](docs/README.md) · [과거 압축 기록](legacy/README.md)
