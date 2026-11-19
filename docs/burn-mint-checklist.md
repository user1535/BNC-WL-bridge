# 양방향 burn·mint 개발 완료 체크리스트

> 이 체크리스트는 기존 V2 검증 완료 기록입니다. WL 소각 발행과 직접 거래의 새 작업은 [개정 개발계획서](bidirectional-burn-mint-direction-20261103.md)에서 관리합니다.

검증 기준일은 2026-11-03이다.
완료 범위는 당시 계획의 로컬 기능·증명·UI·회귀와 네이티브 확장 설계 검토다. 실제 네이티브 WL 노드 적용·네트워크 활성화를 완료했다는 뜻은 아니다. 기존 복구 세션은 변경하지 않았다. 최종 근거: `results/burn-mint-guarded-validation/summary.json`.

- [x] 개발 계획과 완료 조건 확인, 이 체크리스트 작성.
- [x] 이 대화의 미완료 개발 재개 heartbeat 활성화: `bnc-wl-burn-mint`, 30분 간격으로 구성. 완료 범위 검증 후 PAUSED로 전환. 예전 TEE 자동화도 PAUSED 유지.
- [x] V2 이벤트 ABI, burn ID, 양방향 자산 도메인, 18자리/1:1 단위, 발행 권한과 재시도 상태 확정.
- [x] 격리 세션의 WL 역할 테스트 토큰/wWL과 양방향 MPT 발행 receiver 구현.
- [x] transfer/approve/transferFrom, 현재 보유자의 부분 소각과 타인 수신자 반환, 누적 소각·발행 및 소각 ID 1회 처리.
- [x] Go MPT 생성기·V2 이벤트/도메인 및 unsigned calldata 연결.
- [x] 새 RISC Zero guest Image ID·정책 명시적 고정, 양방향 실제 composite 생성·SDK 검증. 기존 guest 정책/receipt 보존.
- [x] 서버/API·지갑 미리보기·사용자 직접 소각/청구 서명·다운로드/업로드·재개 연결.
- [x] A 소각 → wWL 발행 → B/C 양도 → 부분 소각 → 다른 WL 주소 발행 브라우저 실측.
- [x] replay, 수신자/수량/체인/자산/증명 변조·누락 거부, 발행 실패 원자성 검사.
- [x] source 성공/목적지 미발행 상태 보존, 재시작/재시도, 동일 ID 처리상태, 기존 세션 불변 확인.
- [x] 결정적 네이티브 WL 시스템/노드 인터페이스, 공급량·receipt 기록·원자성·활성화 설계와 검증. 실제 노드 구현/네트워크 채택과 로컬 토큰을 구분.
- [x] 최종 발행 권한 강화 소스와 동일한 계약 배포에서 브라우저·SDK·재시작 통합 검증.
- [x] 적절한 Go/Rust/Solidity/wallet/SDK 회귀 및 자원 제한 검증.
- [x] README·매뉴얼·현재 상태·진행 JSON에 실행 근거와 제한 반영. 모든 항목 충족 후 자동화 중지.

## 완료 근거와 향후 범위

- 최종 소스와 배포 runtime·immutable 설정 일치. canonical 발행 권한 제한 포함 Solidity 44개, Go race/vet, Rust 5개, wallet 16개, 실제 SDK V1 7개/V2 4개, 자원 예산 4개, native 상태 전이 모델 5개, 감사 검사 PASS.
- 강화된 세션에서 실제 composite 2개(258.68초 / 255.76초), 브라우저 승인·서명 8건, 양도·대리 전송·C의 부분 소각·B의 WL 모델 발행 PASS.
- 누락/변조/replay 16개, 서버·두 노드 재시작, 동일 receipt hash/size/mtime, source 블록·계약·잔액, 미확인 거래 저장/복구 PASS. 재시작 새 증명 0개.
- 기존 `results/prototype-risc0` 24개 파일 hash/size/mtime 보존. 강화 전 `results/burn-mint-v2`와 그 증거도 보존.
- 최종 실행: `bash scripts/run-burn-mint.sh`, `results/burn-mint-v2-guarded`, UI 127.0.0.1:8581. 정책 `configs/burn-mint-computation.json`, durable host `.bin/bridge-burn-mint-receipt-host`.

당시 네이티브 WL 확장 후보의 후속 검증 범위에는 노드 공급량 변경 경로·권한 강제·가스/실패/reorg·다중 노드 합의 검증과 활성화가 있었다. `docs/native-wl-burn-mint-spec.md`에 설계와 미실행 게이트를 명시했다. 외부 확장 지갑·실제 네트워크 배포·실자산·온체인 RISC Zero·source consensus 인증은 수행하지 않았다.
