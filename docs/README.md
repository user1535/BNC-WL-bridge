# BNC-WL 문서

- **현재 방향:** [개발계획서 · WL 소각→xWL 1:1 발행, 직접 거래, xWL↔wWL 브리지](bidirectional-burn-mint-direction-20261103.md).

- **WL 운영자 면담 자료:** [Word 요청서](wl-operator-meeting-brief-20261103.docx) · [Markdown 원본](wl-operator-meeting-brief-20261103.md). 핵심 세 요청을 각각 한 쪽에 설명하고 흐름도 3개, 추가 협의사항 9개와 참고자료를 포함합니다.

2026-10-29 기본 경로는 **서버 운영자·RPC 신뢰 + 사용자 직접 제출 + 실제 RISC0 연산 증명**이다.

기존 V1 세션과 격리된 V2는 증명·브라우저 실행의 검증 근거다. 현재 방향에서 재사용할 범위는 V2 실행 문서와 체크리스트를 참고한다.

- [xWL 로컬 개발 체크리스트와 실행 근거](xwl-development-checklist.md)
- [xWL 자산 흐름 요약](xwl-market-entry-direction.md)
- [V2 실행·ABI·복구·검증](burn-mint-runtime.md)
- [V2 완료 체크리스트](burn-mint-checklist.md)
- [이전 설계 기록 · 네이티브 WL 확장 사양](native-wl-burn-mint-spec.md)
- [로컬 사용 매뉴얼](local-demo-manual.md)
- [2026-11-03 코드 현황·작동 방식 종합 보고서](code-and-operation-report-20261103.md) · [Word](code-and-operation-report-20261103.docx)
- [현재 상태](current-status-report.md)
- [구현·API·검증 범위](implementation-details.md)
- [범위·후속 작업](plan-gap-analysis.md)
- [정리 내역](cleanup-report.md)
- [과거 소스·세션 상태 압축 보관](../legacy/README.md)

private_keyless_Bridge.docx, source/bridge-design.docx 및 archive의 문서는 과거 모델의 기록이다. 이번 복구의 최신 사양은 위 Markdown 문서를 따른다. protocol-sources와 JSON source manifest는 출처 기록이므로 변경하지 않는다.
