# WL 공용 Vault 개발 체크리스트

기준은 [2026-11-10 Word 설계안](wl-vault-bridge-brief-20261110.docx)이다. 새 시제품은 로컬 31337/31338에서만 실행한다. 기존 V1/V2/xWL 계약·상태·증거는 별도 기록으로 유지한다.

- [x] 설계 및 기존 구현 확인. WorldLand에서 네이티브 WL을 공용 Vault에 예치하고, BSC에서 자유롭게 거래되는 wWL을 1:1 발행한다. wWL 보유자는 예치자와 관계없이 소각 시 지정한 WorldLand 주소로 상환받는다.
- [x] 계약 구현. 양방향의 수신자 지정, 실제 예치량과 발행량 일치, 자유 ERC-20 전송, 등록 루트 기반 검증, 중복 청구 및 권한 우회 차단, 지급 실패 시 원자적 복구를 확인했다. Foundry 52개 검사에 Vault 검사 5개가 포함됐다.
- [x] 증명 연결. 방향별 이벤트·주소·체인·수량·수신자·ID가 Go, 계약, RISC Zero guest, 브라우저에서 일치했다. Vault 정책과 Image ID를 별도로 고정하고 기존 V1/V2 composite도 원래 호스트로 재검증했다.
- [x] 격리 실행기와 지갑. 두 방향의 세로 단계·완료 상태와 예치·소각 ID별 수량·발행·지급량·증명 상태를 표시했다. 새 브라우저에서 기록으로 미청구 건을 복구하고 직접 서명했다.
- [x] 로컬 왕복. A 예치 → C 발행 → C의 wWL을 B에게 전송 → B 소각 → C에게 10 WL 지급 → C가 2 WL 재전송을 검증했다. 브라우저 서명 6건과 양방향 실제 composite 2건을 기록했다.
- [x] 실패·재시작·회귀. 중복 청구, 잘못된 도메인, 수량·수신자·composite 변조, 담보 부족과 지급 실패를 검사했다. API와 두 노드를 재시작해 같은 증명으로 지급했고, 복구 요청 2건은 기존 작업 ID를 반환했다. 기존 상태 63개 파일은 SHA256이 일치했다.
- [x] 마감. 실행 명령, 종합 근거, 외부 운영 범위를 기록했다.

## 재개 지점

- 재개 시 이 파일과 `results/prototype-progress.json`을 먼저 읽는다. 실행 중인 서비스·증명과 세션 lock을 확인하고, 새 증명은 최대 CPU 12개, 가용/cgroup 메모리 70%, 1,800초, 파일당 64 MiB 안에서 실행한다. 다음 단계·ID·파일·명령을 이곳에 남긴다.
- 2026-11-10 초기 조사. 이전 기본 시제품은 동일 지갑만 허용하고 wrapped 전송을 제한한다. 별도 Vault 프로필을 추가한다. 새 세션과 거래 ID는 아직 없다. 먼저 계약과 증명 정책을 설계하고 로컬 빌드 도구를 확인한다.
- 2026-11-10 계약·증명 기반 연결. `NativeWLVault`, `VaultWrappedWL`, 새 Go 생성기와 Vault guest를 빌드했다. 정책은 `configs/vault-computation.json`에 고정했다. 기존 상태 63개 파일의 기준 SHA256은 `results/wl-vault-validation/historical-evidence.sha256`에 저장했다.
- 재개 단계는 격리 세션 초기 배포와 지갑 연결이다. 명령은 `bash scripts/run-vault.sh`이고 상태는 `results/wl-vault-v1`이다. 기본 샌드박스에서 소켓이 차단되어 로컬 루프백 실행 권한이 필요하다. 예치·소각 ID는 아직 없다.
- 2026-11-10 실브라우저 예치 완료. A가 C의 BSC 주소에 10 wWL을 발행하도록 10 WL을 예치했다. 예치 ID는 `0x095d071b0ab134d30693831904d52770837bb7b3fac250fe489fdc8f564703b6`, WL 블록은 6이다. 서명 영수증과 다음 단계는 `results/wl-vault-validation/deposit-receipt.json`, `results/wl-vault-validation/browser-resume.json`에 저장했다. 다음은 이 ID의 `lock-vault` 증명 요청과 브라우저 발행 청구다.
- 2026-11-10 예치 증명·발행·전송·소각 확인. 예치 증명 작업 `05718d26430c3d69fe683ee9e9ca4d591d467372f35139625323c5b247ac69b2`의 실제 composite를 검증했다. A가 C에게 발행을 청구하고, C는 받은 10 wWL을 B에게 전송했다. B가 C의 WorldLand 주소를 지정해 10 wWL을 소각했다. 소각 ID는 `0x175f1a4751efa70b27c52ce61a418f71eef647f8915f0a3ab816c3d6b139254f`, BSC 블록은 12다.
- 재개할 다음 단계는 `python3 scripts/check-vault-restart.py prove-burn`으로 기존 소각의 증명을 요청하는 것이다. 완료 후 `snapshot` → 이 Vault 런처와 두 노드만 정상 종료·재시작 → `compare` → 브라우저 검사 `release`를 실행한다. 이미 서명한 예치·발행·전송·소각은 다시 보내지 않는다.
- 소각 증명 작업 `e35f23a1b5d4746a5d8d62143f74ba49ec4cd5ec9806a2fc602a9dc2399d9af9`을 시작했다. 상태 파일은 `results/wl-vault-v1/proof-jobs/<작업 ID>.json`이고 composite와 실행 계측은 해당 작업의 `*-receipt-*` 폴더에 저장된다. 예치 증명은 이미 준비 상태이므로 다시 생성하지 않는다.
- 재시작 직전 체크포인트는 위 예치·소각 ID와 `results/wl-vault-validation/browser-resume.json`이다. 두 증명 작업이 `ready`이고 전역 lock이 비어 있을 때 `python3 scripts/check-vault-restart.py snapshot`으로 `restart-before.json`을 남긴다. 현재 Vault API에만 SIGTERM을 보내면 런처가 소유 노드 두 개를 정리한다. 이후 `bash scripts/run-vault.sh`로 같은 세션을 다시 열고 `compare`를 실행한다.
- 2026-11-10 로컬 완료. `restart-result.json`에서 노드 PID 변경, 출발 블록·잔액·receipt SHA256·파일 수정 시각 유지, 새 증명 0건을 확인했다. 브라우저에서 같은 소각의 청구를 완료했고 Vault 잔액과 wWL 공급량은 모두 0이 됐다. [종합 근거](../results/wl-vault-validation/summary.json)

## 검증 범위

- 예치 증명은 248.63초, 소각 증명은 258.70초가 걸렸다. 두 receipt는 각각 537,340바이트이며 최대 RSS는 약 4.94 GB였다. CPU·메모리·실행 시간·파일 크기 제한 안에서 완료했다.
- 계약 52개, 지갑 16개, Go 회귀, Rust core 5개씩, 기존 V1 SDK 7개와 V2 SDK 4개, 자원 제한 4개가 통과했다. V2 브라우저의 양방향 단계·기록·SDK 오류·모바일 흐름은 모의 RPC로 따로 확인했다.
- 실제 WorldLand/BSC 운영 RPC·영수증 조회, 운영자 권한과 루트 등록 정책, 실배포와 실자산 검증은 후속 범위다. 이 시제품은 서버와 RPC를 신뢰하고, RISC Zero 검증은 서버 SDK에서 수행한다.

## 실행과 이어가기

1. `bash scripts/run-vault.sh`로 로컬 지갑을 열고 [127.0.0.1:8584](http://127.0.0.1:8584/)에 접속한다. 기본 RPC는 8569/8570이다. 지갑에서 각 방향과 전송 메뉴를 선택한다.
2. 데모 브라우저 검사는 `node scripts/check-vault-browser.mjs deposit` → `python3 scripts/check-vault-restart.py prove-lock` → `node scripts/check-vault-browser.mjs forward-and-burn` → `python3 scripts/check-vault-restart.py prove-burn` 순서다. Chromium과 Playwright가 필요하다. 같은 세션의 `browser-resume.json`에 이미 있는 거래는 서명을 반복하지 않는다.
3. 소각 작업이 `ready`가 된 뒤 `python3 scripts/check-vault-restart.py snapshot`을 실행한다. 런처를 정상 종료하고 같은 명령으로 다시 연 뒤 `python3 scripts/check-vault-restart.py compare`와 `node scripts/check-vault-browser.mjs release`를 실행한다. 스냅샷은 청구 전에 생성한다.
4. 기본 호스트와 증명 생성기는 `.bin/bridge-vault-receipt-host`와 `.bin/bridge-vault-proof`다. 재빌드가 필요하면 아래 명령을 실행하고, 새 호스트를 복사하기 전에 guest Image ID를 `configs/vault-computation.json`과 대조한다.

```bash
go -C proof-generator build -buildvcs=false -o ../.bin/bridge-vault-proof ./cmd/bridge-proof
cargo build --release --locked --manifest-path risc0/receipt-computation/Cargo.toml -p bridge-receipt-host --features vault
```
