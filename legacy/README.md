# 과거 기록 보관

2026-10-29 파일 정리로 실험 디렉터리·반복 바이너리·캐시를 제거하고 다음 기록만 보관합니다. 현재 앱의 실행 경로에는 연결하지 않습니다.

- `retired-source-20261029.tar.gz`: 정리 직전 소스·문서. 빌드 캐시와 반복 실행 바이너리는 제외합니다.
- `historical-sessions-20261029.tar.gz`: 이전 세션 29개의 체인 상태·설정·거래 receipt·감사 기록. 현재 세션은 이 압축 파일로 옮기지 않았으며 results/prototype-risc0에 그대로 있습니다.
- `historical-summaries.json`: 과거 실험 결과 요약 351개.

[검증한 SHA256과 파일 목록](../results/cleanup-20261029/checkpoints.json), [삭제 내역](../results/cleanup-20261029/removed-files.json)을 참고하세요. 예전 TEE 백업과 중복 RPC/MPT 백업은 정리했습니다. 과거 코드나 체인 상태를 확인할 때는 별도 빈 디렉터리에서 압축을 풀어야 하며 현재 실행 세션 위에 덮어쓰지 마세요.
