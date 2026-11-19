# 랩미팅 아키텍처 이미지 — 2026-10-29

- 결과: [bridge-architecture-current.png](bridge-architecture-current.png)
- 편집 방식: 내장 image_gen 도구, 원본 이미지 편집 후 제목의 양방향 화살표만 재수정.
- 최초 편집 프롬프트: [bridge-architecture-prompt.txt](bridge-architecture-prompt.txt)
- 마지막 수정 프롬프트: [bridge-architecture-revision-prompt.txt](bridge-architecture-revision-prompt.txt)

## 현재 구현 반영

- WorldLand ↔ BNB 브리지의 로컬 Anvil 역할(31337/31338)을 표시했다.
- 사용자 자산 거래의 브라우저 직접 서명과 운영자의 receipt root 등록을 구분했다.
- RISC Zero composite 연산 증명의 서버 SDK 검증과 계약의 MPT·이벤트·도메인·중복 청구 검증을 구분했다.
- 기존 헤더 증명, NativeVault, Ethereum Sepolia 및 운영자 전체 무키 가정을 제거했다.
- 주 흐름은 lock → mint이며, burn → unlock 역방향은 하단에 요약했다.
- 실제 WorldLand/BNB 배포, 온체인 RISC Zero 검증, 합의·최종성 인증을 완료했다고 표현하지 않았다.

## 근거

프로젝트 파일을 읽어 반영했으며 이번 이미지 편집 중 새 증명 생성이나 사용자 자산 거래를 수행하지 않았다.

- [현재 상태](../../docs/current-status-report.md)
- [구현 상세](../../docs/implementation-details.md)
- [진행 기록](../../results/prototype-progress.json)
- [실행 결과](../../results/restoration-20261029/summary.json)
- [브라우저 왕복 기록](../../results/restoration-20261029/browser-summary.json)
- [LockMintReceiver](../../contracts/src/bridge/LockMintReceiver.sol)
- [BridgeLockableToken](../../contracts/src/token/BridgeLockableToken.sol)

하단 증명 생성 시간 261.74초 / 271.78초, 최대 RSS 4.93 GB(십진), CPU 상한 12개, 실제 증명 2개와 사용자 서명 4건은 복구 시점의 저장된 실행 기록이다. 새 벤치마크나 처리량 보장을 뜻하지 않는다.

