# 계좌 분리 및 Scan 정보 수집 설계도 — v2

결과: [bridge-architecture-accounts-scan-v2.png](bridge-architecture-accounts-scan-v2.png)

내장 image_gen 도구로 기존 이미지를 편집했다. 이전 현재 구현 이미지도 보존했다.

## 요청 반영
- User 내부를 WorldLand 계좌(lock)와 BNB 계좌(청구·mint 수신)로 분리.
- 정보 수집 경로를 외부 Scan 사이트 → Bridge Server로 변경.
- 상단 운영자 root 등록 / 등록된 receipt root 박스와 연결선 제거.

## 구현과 설계 구분
이번 변경은 발표 이미지 편집이며 코드 또는 활성 세션을 변경하지 않았다. 현재 실행 경로는 여전히 RPC를 사용하므로 새 그림은 ‘요청 설계도 · Scan 연동 예정’으로 표시했다. 하단 수치는 Scan 연동 이전의 저장된 로컬 검증 기록이다. 구체적인 외부 Scan 사이트와 API 지원 여부는 이번 작업에서 선택하거나 검증하지 않았다.

계좌 카드는 체인별 계좌를 분리해 표현한다. 서로 다른 주소를 지원한다는 뜻은 아니다. 현재 계약은 source sender와 destination recipient의 주소 값이 같도록 요구한다. root 등록 상자를 그림에서 생략했지만, 현재 계약이 운영자 등록 root에 의존한다는 구현 사실은 유지된다.

## 프롬프트
- [주 편집 프롬프트](bridge-architecture-accounts-scan-prompt.txt)
- [연결선 수정 프롬프트](bridge-architecture-accounts-scan-revision-prompt.txt)
- [화살표 마감 프롬프트](bridge-architecture-accounts-scan-final-touch-prompt.txt)

기존 실행 근거: [복구 검증 결과](../../results/restoration-20261029/summary.json), [현재 구현](../../docs/implementation-details.md).

