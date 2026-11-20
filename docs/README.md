# BNC-WL 문서

2026-11-19 현재 방향은 **WL 담보형 xWL + 내부 운영자 서명 기반 xWL↔wWL 브리지**다. 새 기본 실행에는 RISC Zero·MPT·운영자 루트 등록이 필요 없다.

- [실행·API·신뢰 경계](signed-bridge-runtime.md)
- [완료 체크리스트와 재개 루틴](signed-bridge-checklist.md)
- [현재 상태와 이전 실행 기록](current-status-report.md)
- [실제 로컬 검증 요약](../results/signed-bridge-validation/summary.json)
- [현재 Word 제안서](internal-signature-xwl-wwl-proposal-20261119-residual-risks.docx)
- [교수님 취소 방식 Word 제안서](professor-cancellation-design-review-20261119-external-server.docx)

## 과거 구현과 설계 기록

아래는 당시 소스·실행 근거이며 새 기본 경로의 사양이 아니다. 기존 세션에 새 설계를 덮어쓰지 않는다.

- [공용 Vault 직접 WL↔wWL](wl-vault-development-checklist.md)
- [이전 RISC Zero·MPT 구현 상세](implementation-details.md)
- [WL 소각 진입형 xWL 개발계획](bidirectional-burn-mint-direction-20261103.md)
- [WL 소각 진입형 xWL 체크리스트](xwl-development-checklist.md)
- [V2 실행·ABI·복구·검증](burn-mint-runtime.md)
- [V2 완료 체크리스트](burn-mint-checklist.md)
- [이전 네이티브 WL 확장 사양](native-wl-burn-mint-spec.md)
- [2026-11-03 코드 보고서](code-and-operation-report-20261103.md)
- [과거 로컬 사용 매뉴얼](local-demo-manual.md)
- [과거 테스트넷 후보 준비](vault-testnet-preflight.md)
- [정리 내역](cleanup-report.md)
- [과거 소스·세션 압축 보관](../legacy/README.md)

`private_keyless_Bridge.docx`, `source/bridge-design.docx`와 초기 면담 자료도 과거 모델의 기록이다. 출처 manifest와 기존 세션 증거는 보존한다.
