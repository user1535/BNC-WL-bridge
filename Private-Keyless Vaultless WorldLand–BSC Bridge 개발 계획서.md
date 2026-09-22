# Private-Keyless Vaultless WorldLand ↔ BSC Bridge 개발 계획서

## 0. 프로젝트 목표

본 프로젝트의 1차 목표는 WorldLand와 BSC 사이에서 실제로 동작하는 최소 양방향 브리지를 구현하는 것이다.

핵심은 연구용으로 복잡한 영지식 기능을 확대하는 것이 아니라 다음 조건을 만족하는 실제 시스템을 먼저 만드는 것이다.

1. WorldLand와 BSC 사이에서 자산을 양방향 이동할 수 있어야 한다.
2. 별도의 자산 보관 Vault 계좌를 사용하지 않는다.
3. source asset은 사용자 계정에 남은 상태에서 일부 수량만 transfer 불가능하게 lock한다.
4. off-chain Proof Generator는 private key를 가지지 않는다.
5. Proof Generator는 transaction을 생성하거나 broadcast하지 않는다.
6. destination transaction은 사용자가 직접 서명한다.
7. destination gas도 사용자가 직접 부담한다.
8. receipt/event 검증에는 MPT proof를 사용한다.
9. RISC0는 최소한의 header authentication 기능에만 사용한다.
10. RISC0 proving은 source chain의 block production을 장기적으로 따라갈 수 있어야 한다.
11. BSC와 WorldLand의 consensus 전체를 RISC0 안에서 재구현하지 않는다.
12. 초기 개발은 테스트넷 없이 두 개의 로컬 EVM chain에서 완료한다.

---

# 1. 대상 네트워크

## 1.1 실제 목표

```text
WorldLand
    ↕
BSC
```

주요 자산 흐름은 우선 WorldLand origin 자산을 기준으로 한다.

```text
WorldLand
WL-compatible lockable asset
        ↓ lock

BSC
wrapped WL
        ↓ burn

WorldLand
original asset unlock
```

이 왕복이 완성된 뒤 필요하면 BSC-origin 자산에 대해서도 동일한 대칭 구조를 적용한다.

---

# 2. 중요한 체인 특성

## 2.1 WorldLand

WorldLand는 EVM-compatible chain으로 취급한다.

초기 구현에서는 ECCPoW 전체 검증을 하지 않는다.

필요한 데이터는 최소한 다음과 같다.

```text
block number
block hash
parent hash
receiptsRoot
transaction receipts
event logs
```

---

## 2.2 BSC

BSC 역시 EVM-compatible chain이므로 Solidity contract, receipt MPT, Ethereum 계열 RPC tooling을 최대한 공통화한다.

다만 BSC는 WorldLand보다 훨씬 빠른 block production을 가지므로 다음 가정을 한다.

```text
BSC:
high-frequency source chain

WorldLand:
lower-frequency source chain
```

따라서 proof subsystem은 두 체인에서 동일한 설정을 강제하지 않는다.

---

# 3. 가장 중요한 성능 원칙

RISC0 성능 목표를 다음처럼 정의한다.

잘못된 목표:

```text
모든 block의 proof가
다음 block 생성 전에 반드시 완료되어야 한다.
```

실제 목표:

```text
average proof processing throughput
>=
average source block production rate
```

즉 batching을 허용한다.

예:

```text
BSC

H100
H101
H102
H103
H104
H105
H106
H107

        ↓

one RISC0 header batch proof
```

Proof 하나가 block interval보다 오래 걸려도 한 proof가 여러 block을 처리하여 전체 backlog가 증가하지 않는다면 허용한다.

---

# 4. BSC 고속 블록 대응 원칙

BSC 방향에서는 기본적으로 block-by-block proving을 설계하지 않는다.

다음 3개의 mode를 구현 가능하게 만든다.

```text
HEADER_MODE=dev
HEADER_MODE=risc0_batch
HEADER_MODE=checkpoint
```

## dev

로컬 기능 개발 전용.

RISC0 없이 trusted local header registry 사용.

## risc0_batch

여러 header를 하나의 RISC0 proof로 처리.

실제 목표 구조.

## checkpoint

RISC0 처리량이 BSC block production을 따라가지 못할 경우 사용하는 대안.

일정 간격의 checkpoint까지만 RISC0로 인증한다.

---

# 5. 전체 시스템 구조

```text
                SOURCE CHAIN
         WorldLand 또는 BSC
                    │
                  User
                    │
                 lock()
                    │
                    ▼
                Locked Event
                    │
                    ▼
          Keyless Proof Generator
                    │
          ┌─────────┼─────────┐
          │         │         │
       Header     Receipt    Event
       Data       Trie       Decode
          │         │         │
          └─────────┼─────────┘
                    │
           optional RISC0
                    │
                    ▼
              Proof Package
                    │
                    ▼
                  User
                    │
             직접 tx 서명
             직접 gas 지불
                    │
                    ▼
             DESTINATION CHAIN
                    │
         Header authentication
                    │
          Receipt MPT verify
                    │
           Locked event verify
                    │
             replay verify
                    │
                    ▼
             wrapped mint
```

귀환:

```text
wrapped burn
    ↓
Burned event
    ↓
Proof Generator
    ↓
User submit
    ↓
original locked balance unlock
```

---

# 6. 로컬 개발 토폴로지

실제 테스트넷 연결 전에 다음 두 개의 독립 EVM chain을 사용한다.

```text
LOCAL_WORLDLAND
RPC: 127.0.0.1:8545
Chain ID: 31337

LOCAL_BSC
RPC: 127.0.0.1:8546
Chain ID: 31338
```

실제 chain ID를 로컬에 그대로 사용하지 않는다.

이를 통해 코드가 chain ID를 잘못 hardcode하는 것을 방지한다.

---

# 7. 로컬 실행 프로필

## 7.1 local-fast

목적:

```text
contract
receipt MPT
event validation
user-submit flow
```

빠른 개발.

RISC0 사용하지 않음.

Header source:

```text
DevHeaderRegistry
```

---

## 7.2 local-zk

목적:

실제 RISC0 E2E 검증.

```text
DevHeaderRegistry
        ↓ 교체
Risc0HeaderUpdater
```

asset bridge 코드는 변경하지 않는다.

---

## 7.3 local-paced

목적:

실제 block generation 상황과 proof backlog 실험.

WorldLand-like chain과 BSC-like chain의 block 생성 속도를 다르게 설정한다.

BSC의 sub-second interval을 Anvil이 정확히 재현하기 어려울 경우 로컬 초기 실험에서는 약 1초 interval로 근사한다.

이후 필요할 경우 실제 BSC client 또는 BSC testnet으로 성능 검증을 수행한다.

---

# 8. Module A — BridgeLockableToken

## 목적

Vault 없이 사용자의 balance 일부를 lock한다.

자산은 별도 계좌로 이동하지 않는다.

---

## A.1 State

```solidity
mapping(address => uint256) lockedBalance;
mapping(address => uint64) bridgeNonce;
mapping(bytes32 => bool) unlockedTransfer;
```

---

## A.2 `lockedBalanceOf`

```solidity
function lockedBalanceOf(
    address account
) external view returns (uint256)
```

사용자의 lock 상태 반환.

---

## A.3 `availableBalanceOf`

```solidity
function availableBalanceOf(
    address account
) public view returns (uint256)
```

계산:

```text
balanceOf(account)
-
lockedBalance[account]
```

---

## A.4 `_checkAvailableBalance`

```solidity
function _checkAvailableBalance(
    address from,
    uint256 amount
) internal view
```

검증:

```text
availableBalanceOf(from) >= amount
```

---

## A.5 ERC-20 transfer restriction

OpenZeppelin ERC-20의 transfer state transition 부분을 override한다.

모든 일반 transfer에서:

```text
actual balance
-
locked balance
>=
transfer amount
```

을 강제한다.

---

# 9. Module B — Lock

## B.1 `bridgeLock`

```solidity
function bridgeLock(
    uint256 amount,
    address recipient,
    uint256 destinationChainId
) external returns (bytes32 transferId)
```

검증:

```text
amount > 0
recipient != zero
destinationChainId supported
availableBalance >= amount
```

처리:

```text
nonce 증가
transferId 계산
lockedBalance += amount
Locked event
```

실제 token transfer는 발생하지 않는다.

---

## B.2 `_computeLockId`

```solidity
function _computeLockId(
    address sender,
    address recipient,
    uint256 amount,
    uint64 nonce,
    uint256 destinationChainId
) internal view returns (bytes32)
```

transfer ID는 최소 다음을 묶는다.

```text
event domain
source chain ID
source token
sender
recipient
amount
nonce
destination chain ID
```

---

# 10. Module C — Unlock

## C.1 `bridgeUnlock`

```solidity
function bridgeUnlock(
    bytes32 withdrawalId,
    address account,
    uint256 amount
) external
```

호출 권한:

```text
authorized BurnUnlockReceiver only
```

처리:

```text
replay check
lockedBalance check
lockedBalance -= amount
```

실제 transfer 없음.

기존 balance가 다시 transferable 상태가 된다.

---

# 11. Module D — Wrapped Token

## D.1 State

```solidity
uint256 originChainId;
address originToken;
address mintReceiver;

mapping(address => uint64) burnNonce;
```

---

## D.2 `bridgeMint`

```solidity
function bridgeMint(
    address recipient,
    uint256 amount
) external
```

Receiver만 호출 가능.

---

## D.3 `bridgeBurn`

```solidity
function bridgeBurn(
    uint256 amount,
    address sourceRecipient,
    uint256 destinationChainId
) external returns (bytes32 withdrawalId)
```

처리:

```text
withdrawalId 계산
token burn
Burned event
```

---

# 12. Module E — Event ABI

## Locked

```solidity
event Locked(
    bytes32 indexed transferId,
    address indexed sender,
    address indexed recipient,
    uint256 amount,
    uint64 nonce,
    uint256 destinationChainId
);
```

## Burned

```solidity
event Burned(
    bytes32 indexed withdrawalId,
    address indexed sender,
    address indexed recipient,
    uint256 amount,
    uint64 nonce,
    uint256 destinationChainId
);
```

---

# 13. Module F — Chain Adapter Layer

WorldLand와 BSC의 차이를 bridge core에서 제거한다.

```go
type SourceChainAdapter interface {
    ChainID(ctx context.Context) (uint64, error)

    LatestHeader(
        ctx context.Context,
    ) (*Header, error)

    SafeHeader(
        ctx context.Context,
    ) (*Header, error)

    HeaderByNumber(
        ctx context.Context,
        number uint64,
    ) (*Header, error)

    BlockTransactions(
        ctx context.Context,
        number uint64,
    ) ([]Hash, error)

    TransactionReceipt(
        ctx context.Context,
        hash Hash,
    ) (*Receipt, error)

    BlockReceipts(
        ctx context.Context,
        number uint64,
    ) ([]Receipt, error)

    FindBridgeEvents(
        ctx context.Context,
        from uint64,
        to uint64,
    ) ([]BridgeEvent, error)
}
```

---

# 14. Module G — WorldLand Adapter

구현:

```text
WorldLandAdapter
```

필요 기능:

```text
RPC capability detection
header decoding
receipt retrieval
confirmation policy
event polling
```

---

## G.1 `GetWorldLandSafeTip`

```go
func GetWorldLandSafeTip(
    ctx context.Context,
    confirmations uint64,
) (*Header, error)
```

초기에는 confirmation policy 사용.

ECCPoW validation을 의미하지 않는다.

---

# 15. Module H — BSC Adapter

구현:

```text
BSCAdapter
```

BSC RPC를 독립 adapter로 처리한다.

---

## H.1 `GetBSCSafeTip`

```go
func GetBSCSafeTip(
    ctx context.Context,
) (*Header, error)
```

실제 BSC 연결 단계에서 지원되는 finality RPC 또는 사전에 정의한 confirmation/finality policy를 사용한다.

Proof Generator는 정책을 자체적으로 임의 변경하지 않는다.

---

## H.2 `GetBSCBlockReceipts`

```go
func GetBSCBlockReceipts(
    ctx context.Context,
    blockNumber uint64,
) ([]Receipt, error)
```

RPC가 일괄 receipt 조회를 지원하지 않는 경우 per-transaction fallback을 사용한다.

---

# 16. Module I — Receipt Collector

## I.1 `GetBlockReceipts`

```go
func GetBlockReceipts(
    ctx context.Context,
    adapter SourceChainAdapter,
    blockNumber uint64,
) ([]*types.Receipt, error)
```

처리:

```text
batch receipt RPC 시도
        ↓
실패
        ↓
block tx hashes 조회
        ↓
receipt 개별 조회
```

---

# 17. Module J — Receipt Trie Builder

## J.1 `BuildReceiptTrie`

```go
func BuildReceiptTrie(
    receipts []*types.Receipt,
) (*ReceiptTrieResult, error)
```

---

## J.2 `VerifyReceiptRoot`

```go
func VerifyReceiptRoot(
    calculated Hash,
    expected Hash,
) error
```

불일치하면 proof 생성 중단.

---

## J.3 `BuildReceiptProof`

```go
func BuildReceiptProof(
    receipts []*types.Receipt,
    targetIndex uint,
) (*ReceiptProof, error)
```

---

# 18. Module K — Bridge Event Decoder

## K.1 `DecodeLockedEvent`

```go
func DecodeLockedEvent(
    receipt *types.Receipt,
    logIndex uint,
) (*LockedEvent, error)
```

검증:

```text
emitter
topic0
topic count
ABI data
chain
recipient
amount
```

---

## K.2 `DecodeBurnedEvent`

```go
func DecodeBurnedEvent(
    receipt *types.Receipt,
    logIndex uint,
) (*BurnedEvent, error)
```

---

# 19. Module L — Minimal RISC0 Header Guest

목표:

RISC0가 consensus 전체를 검증하지 않고 최소 header relation만 검증한다.

Input:

```rust
struct MinimalHeader {
    number: u64,
    block_hash: [u8; 32],
    parent_hash: [u8; 32],
    receipt_root: [u8; 32],
}
```

---

## L.1 `verify_number_continuity`

```rust
fn verify_number_continuity(
    headers: &[MinimalHeader]
)
```

---

## L.2 `verify_parent_continuity`

```rust
fn verify_parent_continuity(
    headers: &[MinimalHeader]
)
```

---

## L.3 `verify_anchor`

```rust
fn verify_anchor(
    anchor_hash: [u8; 32],
    first: &MinimalHeader,
)
```

---

## L.4 `hash_header_leaf`

```rust
fn hash_header_leaf(
    header: &MinimalHeader
) -> [u8; 32]
```

commit:

```text
chain ID
number
block hash
parent hash
receipt root
```

---

## L.5 `compute_batch_root`

```rust
fn compute_batch_root(
    headers: &[MinimalHeader]
) -> [u8; 32]
```

---

# 20. Module M — Header Benchmark

BSC 때문에 이 Module을 bridge 구현의 필수 Gate로 둔다.

테스트 batch size:

```text
1
2
4
8
16
32
64
128
```

BSC 방향은 필요하면 더 크게 확장한다.

---

## M.1 `RunHeaderBenchmark`

```go
func RunHeaderBenchmark(
    headers []MinimalHeader,
    batchSize int,
) (*BenchmarkResult, error)
```

기록:

```text
execute time
prove time
total time
proof bytes
journal bytes
peak memory
headers/sec
```

---

## M.2 `CalculateHeaderThroughput`

```go
func CalculateHeaderThroughput(
    headerCount int,
    proofDuration time.Duration,
) float64
```

결과:

```text
headers per second
```

---

## M.3 `CalculateRequiredThroughput`

```go
func CalculateRequiredThroughput(
    averageBlockInterval time.Duration,
) float64
```

계산:

```text
1 / averageBlockInterval
```

---

## M.4 `EvaluateBacklogRisk`

```go
func EvaluateBacklogRisk(
    proofThroughput float64,
    blockThroughput float64,
) BacklogRisk
```

판정:

```text
proof > block
    PASS

proof ~= block
    MARGINAL

proof < block
    FAIL
```

---

# 21. BSC 전용 RISC0 판정 Gate

BSC는 block interval이 매우 짧기 때문에 다음 원칙을 적용한다.

### Case A

```text
batch proof throughput > BSC block throughput
```

실시간 `risc0_batch` 사용.

### Case B

```text
큰 batch에서만 throughput 확보
```

큰 batch 사용.

단 latency 증가 기록.

### Case C

```text
batch를 크게 해도 backlog 증가
```

RISC0를 모든 BSC header에 적용하지 않는다.

대신:

```text
periodic RISC0 checkpoint
+
checkpoint 사이 header authentication policy
```

구조를 검토한다.

성능 결과를 무시하고 RISC0를 강제로 매 block 적용하지 않는다.

---

# 22. Module N — Adaptive Batch Planner

두 chain에 서로 다른 설정 사용.

```go
type ChainBatchConfig struct {
    MaxBatchSize int
    MaxBatchAge  time.Duration
}
```

예:

```text
WorldLand:
smaller batch
latency 중심

BSC:
larger batch
throughput 중심
```

---

## N.1 `PlanBatch`

```go
func PlanBatch(
    pending []Header,
    config ChainBatchConfig,
) []Header
```

조건:

```text
pending >= MaxBatchSize

OR

oldestHeaderAge >= MaxBatchAge
```

---

# 23. Module O — Header Coverage Store

중요 개념:

Proof는 사용자별로 생성하지 않는다.

이미 인증된 header range를 여러 bridge transfer가 공유한다.

예:

```text
BSC batch
1000 ───────── 1063
       accepted

Lock A = block 1014
Lock B = block 1021
Lock C = block 1055
```

세 transfer 모두 같은 header batch를 재사용한다.

---

## O.1 `IsBlockCovered`

```go
func IsBlockCovered(
    chainID uint64,
    blockNumber uint64,
    blockHash Hash,
) bool
```

---

## O.2 `FindCoveringBatch`

```go
func FindCoveringBatch(
    chainID uint64,
    blockNumber uint64,
) (*HeaderBatch, error)
```

---

# 24. Module P — Header Proof Generator

## P.1 `GenerateHeaderProof`

```go
func GenerateHeaderProof(
    ctx context.Context,
    headers []MinimalHeader,
) (*HeaderProofPackage, error)
```

---

## P.2 `GetOrGenerateHeaderProof`

```go
func GetOrGenerateHeaderProof(
    ctx context.Context,
    range HeaderRange,
) (*HeaderProofPackage, error)
```

먼저 cache 조회.

동일 header range를 반복 prove하지 않는다.

---

# 25. Module Q — Header Authentication Interface

Receiver가 Header implementation에 의존하지 않게 한다.

```solidity
interface IHeaderSource {
    function getReceiptRoot(
        uint256 sourceChainId,
        uint256 blockNumber,
        bytes32 blockHash
    ) external view returns (
        bytes32 receiptRoot
    );
}
```

두 구현을 준비한다.

```text
DevHeaderRegistry
Risc0HeaderUpdater
```

향후 checkpoint mode도 같은 interface 구현.

---

# 26. Module R — DevHeaderRegistry

로컬 `local-fast` 전용.

RISC0 없이 receipt/MPT/application logic 개발에 사용한다.

production deployment에 포함하지 않는다.

---

# 27. Module S — Risc0HeaderUpdater

Header proof를 사용하는 경우 permissionless submission.

## S.1 `submitHeaderProof`

```solidity
function submitHeaderProof(
    bytes calldata seal,
    bytes calldata journal,
    bytes calldata batchData
) external
```

누구나 제출 가능.

제출자 identity는 security condition이 아니다.

---

# 28. Header proof 사용자 제출 구조

Proof Generator는 header proof transaction을 보내지 않는다.

Flow:

```text
Proof Generator
    ↓
HeaderProofPackage
    ↓
User
    ↓
submitHeaderProof()
    ↓
destination chain
```

하지만 이미 같은 batch가 등록되어 있다면 사용자에게 다시 제출시키지 않는다.

Client는 먼저:

```text
isBlockCovered(eventBlock)
```

를 확인한다.

true이면:

```text
header submit 생략
```

false이면:

```text
header proof submit
```

---

# 29. Module T — LockMintReceiver

## T.1 `submitLockProof`

```solidity
function submitLockProof(
    LockProof calldata proof
) external
```

permissionless.

---

검증 hierarchy:

```text
_verifySourceChain
    ↓
_verifyAuthenticatedHeader
    ↓
_verifyReceiptMPT
    ↓
_verifyLockedEvent
    ↓
_verifyDestinationChain
    ↓
_verifyReplay
    ↓
_executeMint
```

---

## T.2 `_executeMint`

recipient는 절대 `msg.sender`를 사용하지 않는다.

```text
recipient =
source Locked event recipient
```

따라서 다른 사용자가 proof를 front-run해도 공격자가 token을 받지 못한다.

---

# 30. Module U — BurnUnlockReceiver

## U.1 `submitBurnProof`

```solidity
function submitBurnProof(
    BurnProof calldata proof
) external
```

검증:

```text
source chain
authenticated header
receipt MPT
Burned event
destination chain
replay
```

후:

```text
BridgeLockableToken.bridgeUnlock()
```

---

# 31. Module V — Proof Package

```go
type BridgeProofPackage struct {
    Version uint32

    Action BridgeAction

    SourceChainID      uint64
    DestinationChainID uint64

    SourceToken      Address
    DestinationToken Address

    TransferID Hash

    Sender    Address
    Recipient Address
    Amount    BigInt
    Nonce     uint64

    BlockNumber uint64
    BlockHash   Hash

    TxHash   Hash
    TxIndex  uint
    LogIndex uint

    HeaderMode string

    HeaderProof *HeaderProofPackage

    ReceiptRoot  Hash
    ReceiptBytes []byte
    ReceiptProof [][]byte
}
```

---

# 32. Module W — Keyless Proof Generator

Proof Generator는 다음만 수행한다.

```text
read
verify
compute
prove
package
cache
```

절대 수행하지 않는다.

```text
sign
send transaction
broadcast transaction
hold gas balance
manage nonce
```

---

## W.1 `GenerateLockPackage`

```go
func GenerateLockPackage(
    ctx context.Context,
    transferID Hash,
) (*BridgeProofPackage, error)
```

Hierarchy:

```text
FindLockedEvent
    ↓
CheckSafeTip
    ↓
GetHeaderCoverage
    ↓
GenerateHeaderProof if needed
    ↓
CollectReceipts
    ↓
BuildReceiptTrie
    ↓
VerifyReceiptRoot
    ↓
BuildReceiptProof
    ↓
DecodeLockedEvent
    ↓
BuildPackage
```

---

## W.2 `GenerateBurnPackage`

동일 구조.

---

# 33. Module X — User Client

사용자가 다음 transaction을 직접 수행한다.

```text
source bridgeLock
destination submitHeaderProof if required
destination submitLockProof
destination bridgeBurn
source submitHeaderProof if required
source submitBurnProof
```

모든 transaction은 사용자 wallet에서 서명한다.

---

# 34. User gas model

WorldLand → BSC:

```text
lock:
user pays WL-side gas

claim:
user pays BNB-side gas
```

BSC → WorldLand:

```text
burn:
user pays BNB-side gas

unlock claim:
user pays WL-side gas
```

Proof Generator는 어느 체인의 native gas token도 필요하지 않는다.

---

# 35. Module Y — Local Development Environment

## Chain A

```text
LOCAL_WORLDLAND
127.0.0.1:8545
chainId 31337
```

## Chain B

```text
LOCAL_BSC
127.0.0.1:8546
chainId 31338
```

---

# 36. Local-fast 배포

LOCAL_WORLDLAND:

```text
BridgeLockableToken
BurnUnlockReceiver
DevHeaderRegistry
```

LOCAL_BSC:

```text
BridgeWrappedToken
LockMintReceiver
DevHeaderRegistry
```

---

# 37. Local-zk 배포

양 체인:

```text
RISC0 verifier
RISC0 adapter
Risc0HeaderUpdater
```

를 추가한다.

Receiver의 interface는 바꾸지 않는다.

---

# 38. Local-paced 환경

## WorldLand-like

실제 WorldLand 예상 block interval을 기준으로 설정.

## BSC-like

약 1초 block interval로 시작.

목표:

```text
BSC-like high-frequency header stream
        ↓
batch planner
        ↓
RISC0 prover
        ↓
backlog measurement
```

---

# 39. Module Z — Backlog Monitor

BSC 지원 때문에 필수.

## Z.1 `GetProofHead`

```go
func GetProofHead(
    chainID uint64,
) uint64
```

마지막으로 proof 완료된 source block.

---

## Z.2 `GetSourceHead`

```go
func GetSourceHead(
    chainID uint64,
) uint64
```

---

## Z.3 `GetHeaderLag`

```go
func GetHeaderLag(
    chainID uint64,
) uint64
```

계산:

```text
sourceHead - proofHead
```

---

## Z.4 `MeasureLagGrowth`

일정 시간 동안:

```text
lag(t+1) > lag(t)
```

이 지속되면 proof subsystem이 source chain을 따라가지 못하는 것으로 판정한다.

---

# 40. 가장 중요한 BSC 성능 테스트

최소 5분 이상 BSC-like local chain을 지속 생성한다.

측정:

```text
source generated blocks
proofed blocks
accepted blocks
current header lag
maximum header lag
average headers/sec
proving CPU
peak RAM
```

성공 조건:

```text
header lag가 장기적으로 증가하지 않는다.
```

단순히 proof 하나의 시간을 기준으로 성공/실패를 판단하지 않는다.

---

# 41. Receipt Stress Test

BSC는 transaction throughput도 높을 수 있으므로 block 안에 다수 tx가 있는 fixture를 만든다.

예:

```text
Block N

tx[0]
tx[1]
tx[2]
...
tx[30]
tx[31] = Locked event
tx[32]
...
tx[100]
```

검증:

```text
all receipts collected
correct order
reconstructed receiptsRoot match
target tx index > 0
MPT proof valid
```

---

# 42. Front-running Test

시나리오:

```text
Alice locks
recipient = Alice

Bob obtains Alice proof

Bob submits proof first
```

기대:

```text
Alice gets wrapped token
Bob gets nothing
Bob only pays gas
```

---

# 43. Multi-user Header Sharing Test

```text
Alice lock block 100
Bob lock block 104
Charlie lock block 107

Header batch = 96~111
```

한 번의 accepted header proof를 세 사용자가 공유해야 한다.

추가 RISC0 proving 금지.

---

# 44. Proof Generator Cache

Cache key:

```text
sourceChainId
startBlock
endBlock
startAnchorHash
endBlockHash
```

Block hash가 달라지면 기존 cache를 재사용하지 않는다.

---

# 45. 저장소 구조

```text
bridge/
│
├── contracts/
│   ├── src/
│   │   ├── token/
│   │   │   ├── BridgeLockableToken.sol
│   │   │   └── BridgeWrappedToken.sol
│   │   │
│   │   ├── bridge/
│   │   │   ├── LockMintReceiver.sol
│   │   │   ├── BurnUnlockReceiver.sol
│   │   │   ├── MPTReceiptProofCore.sol
│   │   │   ├── DevHeaderRegistry.sol
│   │   │   └── Risc0HeaderUpdater.sol
│   │   │
│   │   └── interfaces/
│   │       ├── IHeaderSource.sol
│   │       ├── IBridgeLockableToken.sol
│   │       └── IBridgeWrappedToken.sol
│   │
│   └── test/
│       ├── token/
│       ├── receipt/
│       ├── receiver/
│       ├── frontend/
│       └── integration/
│
├── risc0/
│   ├── guest/
│   └── host/
│
├── proof-generator/
│   ├── cmd/
│   │   ├── bridge-proof/
│   │   └── benchmark-header/
│   │
│   ├── internal/
│   │   ├── chain/
│   │   │   ├── adapter.go
│   │   │   ├── worldland.go
│   │   │   └── bsc.go
│   │   │
│   │   ├── source/
│   │   ├── receipt/
│   │   ├── mpt/
│   │   ├── event/
│   │   ├── header/
│   │   ├── batch/
│   │   ├── risc0/
│   │   ├── package/
│   │   ├── cache/
│   │   └── benchmark/
│   │
│   └── pkg/
│
├── configs/
│   ├── local-fast.env
│   ├── local-zk.env
│   ├── local-paced.env
│   ├── worldland-to-bsc.env.example
│   └── bsc-to-worldland.env.example
│
├── scripts/
│   ├── start-local-fast.sh
│   ├── start-local-zk.sh
│   ├── start-local-paced.sh
│   ├── deploy-local.sh
│   ├── local-lock.sh
│   ├── local-mint-claim.sh
│   ├── local-burn.sh
│   ├── local-unlock-claim.sh
│   ├── local-roundtrip.sh
│   └── benchmark-bsc-rate.sh
│
├── fixtures/
├── results/
└── docs/
```

---

# 46. Config

```dotenv
SOURCE_NETWORK=
DESTINATION_NETWORK=

SOURCE_RPC_URL=
DESTINATION_RPC_URL=

SOURCE_CHAIN_ID=
DESTINATION_CHAIN_ID=

SOURCE_TOKEN=
DESTINATION_WRAPPED_TOKEN=

DESTINATION_HEADER_SOURCE=
DESTINATION_LOCK_MINT_RECEIVER=
DESTINATION_BURN_UNLOCK_RECEIVER=

HEADER_MODE=dev

MAX_BATCH_SIZE=
MAX_BATCH_AGE_SECONDS=

SOURCE_CONFIRMATIONS=

RISC0_HOST_BIN=
RISC0_IMAGE_ID=

PROOF_CACHE_DIR=
RESULT_DIR=
```

금지:

```text
PRIVATE_KEY
RELAYER_PRIVATE_KEY
MNEMONIC
```

Proof Generator binary는 해당 config를 지원하지 않는다.

---

# 47. 구현 Milestone

## Milestone 0 — 기존 코드 조사

확인:

```text
existing RISC0 guest
existing Groth16 host
existing HeaderUpdater
existing MPT verifier
existing Go receipt trie builder
existing Anvil scripts
```

재사용 범위 결정.

---

## Milestone 1 — Vaultless Asset

구현:

```text
BridgeLockableToken
BridgeWrappedToken
```

완료:

```text
lock
transfer restriction
unlock
mint
burn
```

---

## Milestone 2 — Local Mock Roundtrip

RISC0/MPT 없이:

```text
WLD local lock
→ BSC local mint
→ BSC local burn
→ WLD local unlock
```

완료.

---

## Milestone 3 — Real Receipt MPT

DevHeaderRegistry 사용.

```text
Locked receipt MPT
→ mint

Burned receipt MPT
→ unlock
```

완료.

---

## Milestone 4 — WorldLand Header Benchmark

```text
1
2
4
8
16
32
64
```

---

## Milestone 5 — BSC Header Benchmark

```text
1
2
4
8
16
32
64
128
```

고속 source 처리량 측정.

---

## Milestone 6 — Header Mode 결정

각 chain별로 독립 결정.

예:

```text
WorldLand:
risc0_batch

BSC:
risc0_batch
```

또는:

```text
WorldLand:
risc0_batch

BSC:
checkpoint
```

두 체인이 같은 mode일 필요가 없다.

---

## Milestone 7 — Keyless Proof Generator

입력:

```text
transfer ID
```

출력:

```text
proof package
unsigned calldata
```

---

## Milestone 8 — User-submitted Local Bridge

사용자가 직접:

```text
lock
header submit if needed
mint claim
burn
header submit if needed
unlock claim
```

실행.

---

## Milestone 9 — Local BSC-rate Stress

빠른 local source 생성.

측정:

```text
proof throughput
header lag
batch efficiency
memory
CPU
```

---

## Milestone 10 — WorldLand ↔ BSC Live Compatibility

이 단계에서 처음 실제 RPC 사용.

WorldLand:

```text
header decode
receipt reconstruction
receiptsRoot
RISC0 verifier
```

BSC:

```text
header decode
receipt reconstruction
receiptsRoot
finality/safe policy
RISC0 verifier
```

---

## Milestone 11 — Live Roundtrip

```text
WorldLand
lock

↓

BSC
mint

↓

BSC
burn

↓

WorldLand
unlock
```

성공.

그다음 필요 시 BSC-origin asset을 반대로 추가.

---

# 48. 필수 불변식

## Asset

```text
availableBalance
=
balance
-
lockedBalance
```

---

## Supply

```text
total source locked
>=
remote wrapped supply
+
burned but not unlocked
```

---

## Authorization

```text
proof submitter
does not determine
asset recipient
```

---

## Proof Generator

```text
private key = none
gas balance = none
nonce management = none
transaction broadcast = none
```

---

## Header

```text
Receipt proof
→ authenticated receiptRoot
→ authenticated source header
```

---

## Throughput

```text
long-term authenticated header throughput
>=
source block production throughput
```

또는 header lag가 장기적으로 bounded 상태여야 한다.

---

# 49. Codex 금지사항

Codex는 다음을 임의로 추가하지 않는다.

1. Vault contract.
2. Relayer private key.
3. Relayer transaction sender.
4. Gas sponsoring.
5. Automatic transaction broadcasting.
6. ECCPoW full verification.
7. BSC Parlia consensus full verification.
8. Ethereum beacon light client.
9. Per-user duplicate header proving.
10. Per-block RISC0 proving을 성능 검증 없이 강제.
11. Source event의 recipient 대신 `msg.sender` 사용.
12. Receipt root mismatch 무시.
13. Mock proof를 production proof 성공으로 취급.

---

# 50. Codex 첫 작업 순서

```text
1. 현재 repository 전체 구조 조사.

2. 기존 RISC0/MPT/HeaderUpdater 코드 목록 작성.

3. reusable / replace / remove로 분류.

4. dual local Anvil 환경 구축.
   LOCAL_WORLDLAND :8545 / 31337
   LOCAL_BSC       :8546 / 31338

5. ChainAdapter interface 작성.

6. LocalWorldLandAdapter 작성.

7. LocalBSCAdapter 작성.

8. BridgeLockableToken 구현.

9. BridgeWrappedToken 구현.

10. lock/unlock/mint/burn unit test.

11. DevHeaderRegistry 구현.

12. local mock
    WLD lock
    → BSC mint
    → BSC burn
    → WLD unlock.

13. 기존 MPT receipt verifier를
    Locked/Burned event에 연결.

14. 실제 Anvil receiptsRoot reconstruction.

15. multi-transaction block fixture 작성.

16. local real MPT roundtrip 완성.

17. Minimal RISC0 header guest 분리.

18. WorldLand-like header benchmark.

19. BSC-like high-frequency header benchmark.

20. CSV:
    batch size
    headers/sec
    proving time
    RAM
    lag 기록.

21. benchmark 결과에 따라
    chain별 HEADER_MODE 결정.

22. Risc0HeaderUpdater 연결.

23. Proof Generator에서 signing 관련 코드 완전 제거.

24. Proof package + unsigned calldata 출력.

25. user key를 사용한 별도 script로
    full local roundtrip 수행.
```

---

# 51. 첫 완성 기준

다음 명령 하나로 전체 로컬 왕복이 재현되어야 한다.

```bash
./scripts/local-roundtrip.sh
```

결과:

```text
WorldLand-local balance:
initial = final

lockedBalance:
0

BSC wrapped supply:
0

lock:
success

mint:
success

burn:
success

unlock:
success

receipt MPT:
real verification

header:
configured mode verification

proof generator:
no private key

transaction signer:
user only
```

---

# 52. BSC 대응 완료 기준

추가로 다음 benchmark가 반드시 존재해야 한다.

```bash
./scripts/benchmark-bsc-rate.sh
```

출력:

```text
source block interval
generated block count
proofed block count
accepted block count
headers per second
average header lag
maximum header lag
batch size
prove time
peak memory
```

최종 판정:

```text
PASS:
lag bounded

FAIL:
lag continuously increases
```

FAIL이면 batch size를 무작정 키우기 전에 BSC 방향 header authentication architecture를 재검토한다.

---

# 53. 최종 아키텍처 목표

```text
                 WorldLand
                    │
                 user lock
                    │
                    ▼
          ┌──────────────────┐
          │ Proof Generator  │
          │                  │
          │ no private key   │
          │ no transaction   │
          │ receipt MPT      │
          │ minimal RISC0    │
          └────────┬─────────┘
                   │
              proof package
                   │
                  User
                   │
              pays BNB gas
                   │
                   ▼
                  BSC
                   │
                wWL mint
                   │
                  burn
                   │
                   ▼
          ┌──────────────────┐
          │ Proof Generator  │
          └────────┬─────────┘
                   │
                  User
                   │
               pays WL gas
                   │
                   ▼
                WorldLand
                   │
                 unlock
```

Proof Generator는 양방향 모두 동일한 binary를 사용하고 `SourceChainAdapter`만 변경한다.

---

# 54. 프로젝트 최종 목표 문장

> Build a vaultless and private-keyless bidirectional bridge between WorldLand and BSC in which source assets remain associated with the user's account under an enforceable locked-balance state, an untrusted off-chain proof generator produces receipt and optional RISC0 header proofs without transaction authority, and users independently submit proof-carrying transactions while paying execution costs on each destination chain. The header proof subsystem must be batching-aware and capable of maintaining bounded synchronization lag even when operating against a high-frequency source chain such as BSC.