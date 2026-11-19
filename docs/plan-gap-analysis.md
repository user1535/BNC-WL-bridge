# 현재 범위와 후속 작업

> **다음 개발 범위(2026-11-05).** WorldLand의 WL 소각·xWL 1:1 발행 계약, WorldLand에서의 WL·xWL 직접 전송 확인, 새 xWL/wWL 계약을 기존 V2 증명·청구 흐름에 연결하는 작업이다. WL 소각 방식은 협의 항목이다. 시장 견적·유동성 풀과 원자적 교환 계약은 후속 검토 범위다. 아래 절은 이전 V1 복구와 V2 검증의 범위를 기록한다. [개발계획서](bidirectional-burn-mint-direction-20261103.md)

2026-10-29 사용자 지시에 따라 서버 운영자·RPC를 신뢰하는 모델로 복구한다. 이전에 요구했던 운영자 입력 조작 방지와 TEE는 현재 완료 조건에서 제외했다.

## 복구 범위

- 기존 wallet/index.html·style.css의 웹페이지 형식, 체인별 탭, 잔액·이벤트·감사 이력, 지갑 검토/승인/재개 흐름.
- lock/mint/burn/unlock 사용자 직접 서명·제출.
- 실제 RISC0 receipt/MPT/event 연산 증명 생성·SDK 검증 및 패키지/API/지갑 연결.
- 누락·변조된 증명 거부, source 재확인, confirmation 대기, replay 거부.
- 기본 실행/문서 복구, 이전 TEE 서비스·UI·CI·worker 제거 및 자동 재개 중지.

## 현재 구현이 주장하지 않는 것

- 원본 체인 합의·최종성·RPC 응답 출처의 독립 인증.
- 서버 운영자가 악의적이어도 안전하다는 보장.
- 내부 연산 composite proof의 온체인 RISC0 검증.
- 실제 WorldLand/BSC 테스트넷·메인넷 자산 브리지 또는 외부 확장 지갑 실측 완료.
- 기존 과거 헤더 증명 성능 실험을 현재 내부 연산 증명의 성능으로 재해석하는 것.

운영 환경 적용에는 chain/RPC·자산·배포·운영자 인증 정책 검토와 외부 지갑 검증이 별도로 필요하다. 목적지에서 RISC0 연산 증명까지 필수로 검증하려면 guest journal 형식과 Groth16 변환·검증 계약·새 receiver를 별도 구현하고 실측해야 한다. 이번에는 기존의 SDK 검증 + 계약 MPT 경로를 복구한다.

실행 검증의 최신 결과는 current-status-report.md와 ../results/prototype-progress.json을 따른다. 이전 소스와 진행 문서는 ../legacy/retired-source-20261029.tar.gz에서 확인할 수 있다.

현재 실행 경로는 receipt-computation 하나로 정리했습니다. 이전 헤더 증명·네이티브 합의 진단·TEE·클라우드 템플릿은 활성 소스에 남기지 않습니다. [정리 기록](cleanup-report.md)을 참고하세요.

## V2 burn·mint 범위 — 2026-11-03

새 계획의 로컬 양방향 소각·발행, 일반 ERC20 양도/승인/대리 전송, 현재 보유자의 부분 반환, 실제 V2 composite·SDK·지갑·재시작 검증을 수행한다. 새 계약의 canonical 발행 권한 경계를 포함한 결과는 [체크리스트](burn-mint-checklist.md), [실행 문서](burn-mint-runtime.md), [현재 상태](current-status-report.md)를 따른다. 네이티브 WL의 시스템/합의 확장은 [사양과 상태 전이 모델](native-wl-burn-mint-spec.md)까지 검토하며 실제 노드 구현·네트워크 활성화는 수행하지 않았다.
