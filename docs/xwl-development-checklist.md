# xWL 개발 체크리스트 · 2026-11-05

기준은 [20261103 개발계획서의 11월 5일 개정판](bidirectional-burn-mint-direction-20261103.md) §2.4다. 로컬 구현과 실행 검증은 기존 V1/V2와 다른 세션과 계약 주소로 수행한다. WL 운영팀의 확인 사항은 맨 아래에 따로 기록한다.

- [x] 계획·이전 V2 실행 경로·현재 제한 확인.
- [x] 30분 간격 같은 대화 재개 루틴 설정. 로컬 검증 완료 후 일시정지했다.
- [x] 로컬 WL 소각 경로, 단위, 초기 공급과 진입 한도 명시. 블록·receipt 조회 근거 기록.
- [x] WL 10 소각 → xWL 10 발행. 무소각 발행·잘못된 수량/수신자 거부 및 실패 원자성.
- [x] WL과 xWL 직접 전송. 합의 수량·주소를 두 영수증으로 검증하고 한 건만 확정되면 부분 완료 표시.
- [x] 별도 xWL·wWL 주소와 기존 V2 검증기 바인딩. 기존 배포 주소의 증거 거부.
- [x] 양방향 실제 RISC Zero composite 생성, SDK 검증 및 브라우저 직접 청구. 잘못된 체인·자산·수량·수신자와 중복 소각 ID 거부.
- [x] WL 소각 → xWL → wWL → xWL → WL/xWL 직접 거래 실측과 수량·누계 대조.
- [x] 미청구 상태에서 동일 ID와 receipt로 서비스 재시작 후 이어가기. 기존 V1/V2 증거 보존 확인.
- [x] 실행·검증 근거와 제약 기록. 로컬 체크리스트가 충족되면 자동화 종료 여부 확정.

## 작업 재개

로컬 검증은 완료했다. `bash scripts/run-xwl.sh`로 `results/xwl-entry-v1` 상태를 열 수 있다. UI는 `http://127.0.0.1:8583/xwl.html`, 로컬 RPC는 8584/8585다. `node scripts/check-xwl-browser.mjs`는 완료 단계의 체크포인트를 사용한다. 새로 실측하려면 기존 결과와 활성 작업을 먼저 확인한다.

- 로컬 설정은 18자리, 초기 xWL 공급 0, 진입 발행 한도 1,000 xWL이다. WL 전송 대상은 `0x0000000000000000000000000000000000000000`이다. 소각 주소 유통 제외를 모형화했으며, 실제 WorldLand의 공식 공급량 집계는 운영 협의 항목이다. [로컬 설정](../configs/xwl-entry-local.json)
- 10 WL의 소각 주소 유입을 가스 팁과 분리해 확인했고, 브라우저 서명으로 xWL 10개를 발행했다. 진입 발행 누계와 브리지 누계를 분리했다. 계약 검사 47개와 지갑 회귀 16개가 통과했다.
- 실제 브라우저 서명 7건으로 10 xWL → 10 wWL → 10 xWL 왕복과 10 xWL 대 8 WL 직접 거래를 마쳤다. 한 건만 확인됐을 때 부분 완료를 표시했고 다른 전송의 해시를 넣어도 완료로 처리하지 않았다. [브라우저 실행 근거](../results/xwl-entry-validation/browser-summary.json)
- 새 계약 주소에서 실제 composite를 방향별로 1개씩 만들었다. 생성 시간은 270.89초와 266.83초다. 고정 guest의 SDK 검증, 체인·토큰·수량·수신자·ID 변조 거부, 실제 receipt 변조와 목적지 replay 거부를 확인했다. [종합 결과](../results/xwl-entry-validation/summary.json)
- WL 역할 체인 블록 8과 BSC 역할 체인 블록 13의 RPC 블록 정보 및 영속 노드 영수증을 대조했다. 각 블록의 전체 영수증 1개를 다시 인코딩한 MPT 루트가 원래 루트와 일치했다. [데이터 예시](../results/xwl-entry-validation/receipt-data-sample.json)
- 반환이 미청구인 상태로 서버와 두 노드를 재시작했다. 동일 계약·잔액·소각 블록·receipt를 보존했고, 기존 composite 2개를 재검증해 같은 ID로 반환을 청구했다. 재시작 중 새 proving 0건. 이전 V1/V2 증거 49개 파일의 SHA-256도 일치했다. [재시작](../results/xwl-entry-validation/restart-summary.json) · [기존 증거 보존](../results/xwl-entry-validation/prior-evidence-preservation.json)

## WL 운영팀 확인 사항

실제 운영 RPC의 샘플 블록과 전체 영수증, 회수 불가 소각 경로와 공급 집계, 진입 발행 한도와 배포 정책은 WL 측 회신이 필요하다. 현재 계획의 직접 거래는 개별 서명과 합의 가격을 사용한다.
