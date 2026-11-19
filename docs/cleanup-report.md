# 2026-10-29 코드·파일 정리

현재 실행 경로인 신뢰 서버/RPC + 사용자 직접 제출 + RISC0 receipt/MPT 연산 증명을 기준으로 파일 참조와 의존성을 확인했습니다.

## 제거

- 이전 TEE 결과·백업, 헤더/BLS/네이티브 합의/Groth16 실험 소스·실행기·진단 계약·전용 테스트와 fixture.
- 루트 RISC0 헤더 workspace와 다른 guest workspace. 현재 risc0/receipt-computation 소스만 유지합니다.
- 현재 경로에서 사용하지 않는 Go CLI·패키지 및 의존성.
- 오래된 웹 테스트·숨겨진 시연 preset·수동 헤더 승인 UI와 관련 JS. 기존 페이지의 체인 탭·잔액·지갑·RISC0 증명·이벤트·감사 기능은 유지합니다.
- 증명 없는 비교 모드, 헤더 proving 모드, 서버 측 사용자 거래 CLI. 지원 모드를 명시적으로 제한하여 제거한 경로로 자동 우회하지 않습니다.
- 반복 저장된 실행 파일, Cargo/Foundry 캐시, 과거 실험 출력·로그, 현재와 맞지 않는 클라우드 배포 템플릿.

## 보존

- 현재 세션 results/prototype-risc0의 계약·체인 상태·잔액·증명 캐시.
- 현재 실제 RISC0 receipt와 복구 검증 결과, SDK 사전 검증용 공개 receipt.
- 현재 코어·MPT·토큰·감사·지갑 검사. 테스트용 mock receiver는 자산 보존 회귀 검사에 사용하므로 유지합니다.
- 원본 연구 DOCX와 현재 receipt fixture의 출처·해시.
- 과거 소스, 세션 29개의 상태와 실험 요약 351개를 [압축 보관](../legacy/README.md). 삭제 전에 압축 파일 내부 내용을 원본 SHA256과 대조했습니다.

삭제 파일 수와 용량은 [삭제 내역](../results/cleanup-20261029/removed-files.json)에 기록합니다. 정리 후 실행·검증 결과는 [현재 상태](current-status-report.md)와 results/cleanup-20261029/summary.json을 따릅니다.

## 최종 결과

- 원본 삭제: 43,492개 파일, 22,853,982,213 바이트(약 21.28 GiB). 검사 중 다시 생성된 캐시도 마지막에 별도로 정리했습니다.
- 현재 전체 트리: 약 67 MB(압축 보관 기록 포함).
- Go race/vet/build, Rust 4개, Solidity 32개, wallet 10개, SDK·취소 7개, 감사 검사 통과.
- 재시작 후 계약·잔액·receipt hash/mtime 유지, 양방향 패키지 재계산·실제 SDK 재검증·브라우저 검증 통과. 새 증명과 사용자 자산 거래는 0개입니다.
- [종합 결과](../results/cleanup-20261029/summary.json), [소스 hash](../results/cleanup-20261029/source-sha256.json), [정리 후 화면](../results/cleanup-20261029/restored-ui.png).
