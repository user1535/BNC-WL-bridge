# 현재 개발 상태

## 공용 Vault 테스트넷 후보 — 2026-11-10

Gwangju 10359와 BSC 테스트넷 97 후보에 초기 연결 검증과 명시적 활성화, 양쪽 예치·소각 정지, 정지 중 미사용 루트 교체, 원래 수신자에 한정한 WL 지급 주소 복구를 추가했다. 지갑의 1 WL 수량 인코딩과 해시가 없는 거래의 복구 경로를 보강했다. 읽기 전용 증명 서비스는 RPC 조회 한도와 진행 중 작업 수를 제한하고, 시작 시 고정 guest의 저장된 composite를 실제 SDK로 확인한다. 실제 Gwangju RPC와 연결 가능한 BSC 테스트넷 RPC, 권한 주소와 확인 깊이 확정 및 테스트넷 배포·왕복 검증이 남아 있다. [준비 절차](vault-testnet-preflight.md) · [코드 보강 검증](../results/wl-vault-testnet-preflight/hardening.json) · [초기 검증 결과](../results/wl-vault-testnet-preflight/summary.json)

## 공용 Vault 로컬 구현·검증 완료 — 2026-11-10

WorldLand 공용 Vault에 네이티브 WL을 보관하고 BSC에서 거래 가능한 wWL을 발행한다. wWL 보유자가 소각할 때 지정한 WorldLand 주소로 담보를 지급한다. `bash scripts/run-vault.sh`로 로컬 31337/31338 세션과 [Vault 지갑](http://127.0.0.1:8584/)을 연다.

실브라우저에서 A의 10 WL 예치, C에게 10 wWL 발행, C→B의 wWL 전송, B의 소각, C에게 10 WL 지급과 C의 2 WL 재전송을 서명했다. 실제 RISC Zero composite 2건을 SDK로 검증했다. 지급 직전에 API와 두 노드를 정상 재시작하고, 같은 ID·루트·receipt로 지급을 마쳤다. 신규 증명 생성 0건과 이전 상태 파일 63개 보존을 확인했다. [Vault 체크리스트](wl-vault-development-checklist.md) · [종합 실행 근거](../results/wl-vault-validation/summary.json)

실제 체인의 RPC·영수증 데이터, 루트 등록 운영 정책, 배포와 실자산 검증은 별도 범위다. 아래 xWL과 V1/V2는 기존 실행 기록이다.

> **2026-11-05 방향 결정.** WL 소각→xWL 온체인 1:1 발행, 당사자 합의 가격의 같은 체인 WL·xWL 직접 거래, xWL↔wWL 기존 V2 브리지 연동으로 개발계획을 개정했습니다. 직접 거래는 지갑의 일반 전송으로 진행합니다. 원자적 교환과 유동성 풀은 후속 검토 항목입니다. 이번 개정에 따른 로컬 실행 결과를 아래에 기록합니다. [현재 개발계획서](bidirectional-burn-mint-direction-20261103.md)

## xWL 로컬 개발 검증 완료

`bash scripts/run-xwl.sh`로 31337/31338의 격리 세션 `results/xwl-entry-v1`과 포트 8583 지갑을 열 수 있습니다. 로컬 WL 10을 유통 제외 주소에 보내 10 xWL을 발행하고, 새 xWL·wWL 계약에서 10개씩 왕복한 다음 10 xWL과 8 WL을 각자 서명해 전송했습니다. 두 영수증이 확인된 뒤 거래 완료가 표시됐습니다.

실제 composite 두 개를 SDK에서 검증했고, 미청구 반환 상태에서 서버와 양쪽 노드를 재시작한 뒤 같은 소각 ID와 영수증으로 발행을 완료했습니다. 서버와 RPC를 신뢰하며 목적지 계약은 등록된 영수증 루트의 MPT·이벤트·재사용을 검증합니다. 기존 증거 49개 파일의 해시가 유지됐습니다. [체크리스트](xwl-development-checklist.md) · [종합 결과](../results/xwl-entry-validation/summary.json)

실제 WorldLand 운영 RPC, 소각 주소·공급량 집계 방식, 배포·한도 정책은 WL 운영팀 확인 사항입니다.

## 기존 V2 실행 기록

V2 지갑은 방향 선택 화면, WL → wWL, wWL → WL, 토큰 거래·감사 기록 페이지로 나뉩니다. 브리지 페이지는 지갑 연결, 소각, 증명, 발행 순서로 진행합니다. 완료 표시는 영수증, SDK 검증, 목적지 청구 결과를 바탕으로 갱신합니다. 기존 브라우저에 저장된 소각 ID와 증명 요청은 해당 방향에서 이어갈 수 있습니다.

실행 중인 데모에서 지갑 연결, 잔액, 감사 조회를 확인했습니다. 양방향 단계와 증명 오류 후 재확인, 새로고침 복구 및 모바일 화면은 기존 증명 패키지와 모의 RPC·SDK 응답으로 브라우저에서 검사했습니다. 지갑 회귀 검사 16개가 통과했습니다.

각 방향의 **내 소각 기록**은 출발 체인의 소각자와 수신자 주소를 조회하고, 영속 증명 작업과 목적지 발행 여부를 건별로 연결합니다. 새 브라우저에서도 소각량·발행량·증명 상태를 확인하고 이어갈 수 있습니다. 발행 전에는 발행량이 0으로 표시됩니다. 데모 웹 서비스 재시작 후 저장된 증명 3건을 조회했고, 실제 WL 방향 브라우저 목록에 2건이 표시됐습니다. 증명 미요청 소각과 발행량 갱신은 양방향 모의 응답으로 검사했습니다.

2026-11-05에 직접 테스트용 V2 세션을 `results/burn-mint-v2-manual`에서 시작했습니다. 지갑은 `http://127.0.0.1:8581/burn-mint.html`이며 데모 계정 A/B/C에 테스트 WL을 각각 100개 지급했습니다. 화면과 매니페스트 응답을 확인했습니다. 이 세션의 소각·발행은 사용자 테스트 단계입니다.

운영자 협의 자료(2026-11-05 개정)는 [WL 운영자 면담 Word 요청서](wl-operator-meeting-brief-20261103.docx)와 [원본](wl-operator-meeting-brief-20261103.md)에서 확인할 수 있습니다. 데이터 API, WL 소각→xWL 온체인 1:1 발행, xWL→WL 시장가 교환을 각각 흐름도가 포함된 한 쪽으로 구성했습니다. 추가 협의사항과 공개 조사 근거를 뒤에 배치했습니다.

## [최중요] V2 발행 우회 차단 — 2026-11-03

V2 로컬 ERC20 모델에서 최초 receiver 연결의 canonical runtime·immutable 설정을 대조하고, 가짜 검증기·프록시 및 관리자 발행 우회를 차단했습니다. Solidity 전체 44개(V2 12개, 비인가 호출 fuzz 256회) 통과. 별도 Anvil 31337/31338, 포트 8577/8578에 배포하여 직접 발행·관리자 우회·재연결 eth_call 28개 거부를 확인했습니다. 상태는 `results/mint-authority-guard-session-20261103`에 저장하고 노드를 정상 종료했습니다. 기존 `prototype-risc0` 파일 hash·크기·mtime을 유지했습니다.

이 권한 검사에서는 새 증명·사용자 브리지 거래를 수행하지 않았습니다. **네이티브 WL 합의 mint 구현이 아니며**, 아래 별도 V2 브라우저/SDK 개발과도 범위를 구분합니다. [V2 발행 권한 검증](burn-mint-checklist.md), [실제 배포 검사](../results/mint-authority-guard-20261103/live-deployment.json)를 참고하세요.

## Burn·mint V2 로컬 구현·통합 검증 완료 — 2026-11-03

계획 §2.4의 로컬 burn·mint 구현, 실제 증명·지갑·회귀와 네이티브 확장 설계 검토를 완료했습니다. **실제 네이티브 WL 노드 구현·활성화는 완료하지 않았습니다.** 최종 실행은 `bash scripts/run-burn-mint.sh`, 상태 `results/burn-mint-v2-guarded`, UI `http://127.0.0.1:8581/burn-mint.html`입니다. 기본 `run-server.sh`와 기존 V1 세션은 보존했습니다.

- canonical receiver·immutable 설정을 포함한 최종 소스와 실제 배포 코드 일치를 확인했습니다. 과거 소스와 다른 세션을 재사용할 때 소스 버전 검사가 실행을 거부합니다.
- 사용자 브라우저 서명 8건으로 WL 모델 10 소각 → wWL 10 발행 → A/B/C 양도·승인·대리 전송 → C의 4 소각 → B의 WL 모델 4 발행을 완료했습니다. 최종 WL 모델 A/B/C는 90/104/100, wWL C는 6입니다. 전체 공급량 1000과 방향별 누계가 일치합니다.
- 실제 새 V2 composite 2개를 258.68초 / 255.76초에 생성·SDK 검증했습니다. 최대 RSS 약 4.94 GB, CPU 최대 12개, 가용/cgroup 메모리 70%, 1800초·파일 64 MiB 제한 안에서 실행됐습니다. 강화 전 별도 실측 증명 2개는 과거 증거로 보존합니다. 이번 개발의 새 증명 총 4개와 브라우저 서명 총 16건을 최종 세션의 2개/8건과 구분합니다.
- 양방향 수신자·금액·체인·자산·증명 누락/변조·V1 guest 혼용·replay 거부 16개를 브라우저/실제 SDK에서 확인했습니다. 계약 검사는 발행 실패의 원자성과 재시도, 가짜 receiver/proxy/관리자 발행·교체 우회 거부도 포함합니다.
- 서버·두 노드를 정상 재시작하고 계약·잔액·source 블록·기존 receipt hash/크기/mtime을 보존했습니다. SDK 2개 재검증, 브라우저 미확인 거래 저장·복구·replay 거부·감사 UI 통과. 재시작 새 증명/사용자 거래는 0개입니다.
- Go race/vet, Solidity 44개(V2 12개), Rust 5개, wallet 16개, 실제 V1 SDK/취소 7개·V2 SDK 4개, 자원 예산 4개, native 상태 전이 모델 5개와 감사 회귀를 통과했습니다. 패키지는 V1/V2 호스트·소스·공개 fixture를 포함하며 세션·개인키를 포함하지 않습니다.
- 기존 `results/prototype-risc0`의 24개 파일 hash·크기·mtime은 모두 보존했습니다. 강화 전 V2와 별도 발행 권한 검사 세션도 유지했습니다.

[최종 실행 근거](../results/burn-mint-guarded-validation/summary.json), [체크리스트](burn-mint-checklist.md), [V2 실행·ABI·재빌드](burn-mint-runtime.md), [네이티브 확장 사양](native-wl-burn-mint-spec.md)를 참고하세요. 외부 확장 지갑 실측·네이티브 노드 구현·네트워크 활성화·실제 배포/실자산·온체인 RISC Zero 검증·source 합의 인증은 수행하지 않았습니다.

## 개발 착수 전 읽기 전용 확인 — 2026-11-03

당시에는 네이티브 WL의 증거 기반 발행을 포함한 양방향 burn·mint 후보를 검토했습니다. 해당 설계는 [네이티브 WL 확장 검토](native-wl-burn-mint-spec.md)에 기록돼 있습니다. 아래는 그 시점의 기존 코드 실행 확인 결과입니다.

현재 구현은 서버 운영자·RPC 신뢰, 사용자 브라우저 직접 서명, 실제 RISC Zero composite 연산 증명과 서버 SDK 검증을 사용하는 로컬 시제품입니다. 기본 실행은 `bash scripts/run-server.sh`, 웹 UI는 http://127.0.0.1:8580/ 입니다.

- 확인 시점에 UI 8580과 RPC 8565/8566이 모두 연결을 거부했습니다. 현재 기본 주소에서 서비스는 실행 중이지 않으며, 저장된 `phase: ready`를 실행 중이라는 의미로 해석하지 않습니다.
- 실행 사전 검사 7개 항목, 실제 SDK·취소 회귀 검사 7개, 감사 회귀 검사, Python 16개 파일 구문 확인을 통과했습니다.
- 현재 세션의 lock/burn composite receipt 2개를 실제 SDK로 다시 검증했습니다. 파일 hash·크기·mtime은 10월 29일 기록과 일치합니다.
- 정리 후 기준 소스·설정·fixture 94개가 SHA256 비교에서 모두 일치했습니다. 현재 감사 기록 11개의 해시 연결과 과거 압축 자료 2개의 SHA256도 확인했습니다.
- 이번 검토에서는 체인 시작·배포·사용자/운영자 거래·새 증명을 수행하지 않았습니다. 현재 세션 전체 파일의 hash·크기·mtime을 유지했습니다. 전체 Go/Rust/Solidity/wallet 검사와 브라우저 왕복은 재실행하지 않았습니다.
- 구현상 메모리 예산은 물리 메모리/cgroup 총한도의 70%이며 현재 가용 메모리를 차감하지 않습니다. 감사 순회도 proving과 같은 worker에 있어 긴 proving 중 지연될 수 있습니다. 보고서에 후속 개선 항목으로 구분했습니다.

[코드 현황·작동 방식 종합 보고서](code-and-operation-report-20261103.md), [Word 보고서](code-and-operation-report-20261103.docx), [이번 확인 결과](../results/code-review-20261103/summary.json)를 참고하세요. 실제 체인 합의 인증과 온체인 RISC Zero 검증은 여전히 범위 밖입니다.

## 파일 정리 후 검증 기록 — 2026-10-29

추가 요구사항 조사(2026-11-03): BSC에서 거래한 wWL의 현재 보유자가 원본 WL을 상환하되 브리지가 담보를 보관하지 않는 방향을 검토했습니다. 조사한 공식 공개 소스에는 일반 EOA의 네이티브 WL을 계좌에 둔 채 잠그고 소각 증명으로 타인에게 이전하는 기능이 확인되지 않았습니다. 개인별 스마트 계약 지갑 또는 프로토콜 변경은 별도 설계이며 구현하지 않았습니다. [근거와 한계](native-wl-lock-feasibility-20261103.md)를 참고하세요.

아래 항목은 10월 29일의 검증·용량 기록이며 오늘 다시 실행한 검사와 구분합니다.

- 이전 TEE·헤더/BLS/Groth16 실험 코드와 전용 도구·진단 계약·중복 바이너리·캐시·로그 43,492개, 약 21GB를 제거했습니다. 현재 트리는 압축 보관본을 포함해 약 67MB입니다.
- 현재 receipt-computation Rust workspace, MPT 생성기, 토큰·MPT·감사 계약, 사용자 웹 지갑과 필요한 검사만 유지합니다. RISC0 호스트는 Cargo cache 대신 `.bin/bridge-receipt-host`에 보관합니다.
- 현재 계약·잔액·source 블록·기존 receipt 파일 hash/mtime을 정리 전과 대조했습니다. 추가 사용자 자산 거래와 새 증명 생성은 모두 0입니다.
- 재빌드한 Go 생성기로 lock/burn 패키지를 다시 계산했고, 기존 증명 입력과 일치하며 실제 SDK 검증을 통과했습니다.
- Go race/vet/build, Rust core 4개, Solidity 32개, wallet 10개, 실제 SDK/취소 7개, 감사 검사 통과. 브라우저에서 증명 재업로드·재검증·replay 차단·기존 저장소 보존·매뉴얼/감사 UI를 확인했습니다.
- 패키지 파일의 SHA256과 별도 경로에서의 SDK 사전 검증도 통과했습니다. 임시 패키지와 검사 후 생성 캐시는 제거했습니다.
- 과거 소스·세션 29개의 상태와 요약 351개는 검증한 압축 기록으로 보관합니다. 원본 연구 DOCX와 현재 receipt fixture 출처는 유지합니다.

[정리 설명](cleanup-report.md), [삭제 목록](../results/cleanup-20261029/removed-files.json), [검증 결과](../results/cleanup-20261029/summary.json), [정리 후 소스 hash](../results/cleanup-20261029/source-sha256.json)를 참고하세요.

서버 운영자와 RPC를 신뢰하며 composite proof는 서버 SDK에서 검증합니다. 목적지 계약은 MPT·이벤트·replay를 검증합니다. 실제 체인 합의 인증·온체인 RISC0 연산 증명 검증·실자산 배포는 범위 밖입니다.

## 외부 탐색기 API 확인 — 2026-10-29

외부 데이터 수집 가능성만 읽기 전용으로 확인했다. 기본 로컬 실행 경로와 기존 증명·세션은 변경하지 않았다.

- WorldLand Scan의 최신 높이와 거래 상세 API는 실제 응답했다. `/api/eth-rpc`의 `eth_getBlockByNumber`, `eth_getBlockReceipts`, `eth_getTransactionReceipt`는 모두 `Action not found.`를 반환했다. 공개 문서와 실제 거래 상세 응답만으로는 현 MPT 생성기에 필요한 블록 `receiptsRoot`와 전체 영수증 데이터를 얻을 수 없다.
- 공식 공개 RPC `https://seoul.worldland.foundation/`에서는 블록 `receiptsRoot` 조회 및 일반 전송 거래 한 건의 영수증 필드 조회가 성공했다. 전체 비어 있지 않은 블록의 MPT 재구성이나 실제 브리지 이벤트 검증은 수행하지 않았다.
- BscScan은 Etherscan V2의 `eth_getBlockByNumber`와 `eth_getTransactionReceipt`로 필요한 데이터를 문서상 제공한다. 공식 chainlist는 BNB 56/97에 유료 플랜이 필요하다고 명시한다. 인증된 API 키를 사용한 실응답 및 MPT 재구성은 미검증이다.
- 탐색기 수집 어댑터는 아직 연결하지 않았다. 서버 운영자 신뢰와 충분한 confirmation 대기를 전제로 한다.

[API 확인 결과와 실제 응답](../results/explorer-api-check-20261029/summary.json)을 참고한다.

## 직전 복구 시점의 검증 기록

아래는 파일 정리 전 복구 시점의 기록입니다. 당시 소스·검사 개수는 현재 정리 버전과 다르며 현재 소스 hash는 위 링크를 따릅니다.

기준: 2026-10-29. **사용자 직접 제출 + 실제 RISC0 내부 연산 증명 + 기존 웹 UI 복구와 로컬 실행 검증 완료.**

- 실행: `bash scripts/run-server.sh`, UI http://127.0.0.1:8580/, 상태 `results/prototype-risc0`.
- 서버 운영자와 RPC를 신뢰한다. 이전 TEE 소스·UI·실행기·CI·worker를 제거하고 복구용 아카이브만 legacy에 보존했다. 기존 TEE 개발 heartbeat는 PAUSED다.
- 실제 새 RISC0 composite proof를 lock/burn 양쪽에서 생성하고 SDK로 검증했다. 각각 261.74초 / 271.78초, 최대 RSS 약 4.90 / 4.93 GB(십진), CPU 상한 12개였다.
- 원래 웹페이지의 브라우저 데모 지갑으로 lock → mint → burn → unlock 거래 4개를 직접 승인·서명했다. 최종 원본 100, 잠금 0, wrapped 0으로 복원됐다.
- 양방향 각각 증명 누락, 잘못된 guest/journal/scope/input commitment, receipt 변조 후 SHA256 재계산을 거부했다. 실제 SDK가 변조 receipt를 거부한다. 중복 청구도 차단했다.
- 증명 패키지 JSON 다운로드·재업로드·SDK 재검증, 페이지 새로고침과 매뉴얼·감사 UI를 검증했다.
- 서버와 두 노드를 정상 종료한 뒤 같은 상태로 재시작했다. 계약·잔액·source 블록·기존 증명 파일 hash/mtime이 유지됐고 새 증명 생성은 0개였다. 재시작 후 다운로드한 증명의 재검증과 replay 거부를 확인했다.
- 영속 세션 ID로 브라우저 요청·미확인 거래 저장소를 분리한다. 기존 저장소를 덮어쓰지 않는 것도 브라우저에서 확인했다.
- Go 전체 검사, Solidity 56개, Rust core 4개, 기존 wallet 회귀 9개, 실제 SDK·프로세스 취소 검사 7개 통과.

## 증거

- [종합 결과](../results/restoration-20261029/summary.json)
- [브라우저 양방향 왕복](../results/restoration-20261029/browser-summary.json)
- [재시작 상태·캐시 대조](../results/restoration-20261029/after-restart.json)
- [재시작 후 UI 검증](../results/restoration-20261029/restart-browser-summary.json)
- [실행 화면](../results/restoration-20261029/restored-ui.png)
- [정확한 소스 hash](../results/restoration-20261029/source-sha256.json)

## 검증 범위

RISC0 composite 연산 증명은 서버 SDK에서 검증하며 목적지 계약은 운영자 등록 root에 대해 MPT·이벤트·도메인·replay를 검증한다. 연산 증명의 온체인 RISC0 검증이나 원본 체인 합의·최종성 인증을 완료했다고 주장하지 않는다. 서버 운영자·RPC를 신뢰하는 모델이다.

두 Anvil 로컬 체인 31337/31338과 브라우저 데모 지갑을 사용했다. 실제 WorldLand/BSC 배포, 실자산, 외부 확장 지갑 실측은 수행하지 않았다. 기존 시제품 세션과 증거는 별도로 보존했다.
