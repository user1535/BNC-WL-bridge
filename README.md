# BNC-WL-bridge

Vault 계좌와 relayer private key 없이 WorldLand와 BSC 사이에서 자산을
이동하기 위한 브리지입니다. 상세 요구사항과 단계별 완료 기준은
[`Private-Keyless Vaultless WorldLand–BSC Bridge 개발 계획서.md`](./Private-Keyless%20Vaultless%20WorldLand%E2%80%93BSC%20Bridge%20%EA%B0%9C%EB%B0%9C%20%EA%B3%84%ED%9A%8D%EC%84%9C.md)에 있습니다.

## 현재 구현 범위

proof generator의 read-only chain adapter와 vaultless token 기반을 제공합니다.

- WorldLand/BSC가 공유하는 `SourceChainAdapter`
- confirmation 수를 명시적으로 적용하는 safe-tip 정책
- `eth_getBlockReceipts` 우선 사용 및 미지원 노드의 per-transaction fallback
- bridge address와 event topic으로 제한한 log 조회
- signing, nonce 관리, transaction 전송 API를 포함하지 않는 RPC 경계
- 원본 balance를 이동하지 않고 일부를 잠그는 `BridgeLockableToken`
- receiver만 mint하고 사용자가 직접 burn하는 `BridgeWrappedToken`
- lock/unlock replay 및 transfer 가능 balance 제한

이 단계의 safe-tip은 운영 정책일 뿐 WorldLand ECCPoW 또는 BSC Parlia 합의를
검증한다는 의미가 아닙니다.

## 개발

Go 1.23 이상이 필요합니다. 현재 기반 모듈은 외부 Go dependency 없이 테스트할
수 있습니다.

```bash
go test ./...
go vet ./...
```

Foundry가 설치된 환경에서는 token unit test를 실행합니다.

```bash
forge test
```

## 로컬 체인

Foundry의 `anvil`을 설치한 뒤 아래 명령으로 서로 다른 chain ID와 block time을
사용하는 두 체인을 함께 실행할 수 있습니다.

```bash
./scripts/start-local-fast.sh
```

- WorldLand-like: `http://127.0.0.1:8545`, chain ID `31337`, 5초 block
- BSC-like: `http://127.0.0.1:8546`, chain ID `31338`, 1초 block

프로세스가 종료되면 두 Anvil child process도 함께 정리됩니다. 설정에는 의도적으로
private key나 mnemonic을 두지 않습니다.
