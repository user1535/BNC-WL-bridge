package receipt

import (
	"errors"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

const receiverABI = `[{"type":"function","name":"submitLockProof","inputs":[{"name":"proof","type":"tuple","components":[{"name":"blockNumber","type":"uint256"},{"name":"blockHash","type":"bytes32"},{"name":"txIndex","type":"uint256"},{"name":"logIndex","type":"uint256"},{"name":"proofNodes","type":"bytes[]"}]}]},{"type":"function","name":"submitBurnProof","inputs":[{"name":"proof","type":"tuple","components":[{"name":"blockNumber","type":"uint256"},{"name":"blockHash","type":"bytes32"},{"name":"txIndex","type":"uint256"},{"name":"logIndex","type":"uint256"},{"name":"proofNodes","type":"bytes[]"}]}]}]`

type ClaimCall struct {
	BlockNumber *big.Int
	BlockHash   [32]byte
	TxIndex     *big.Int
	LogIndex    *big.Int
	ProofNodes  [][]byte
}

func ClaimMethod(action string) string {
	switch action {
	case "lock", "lock-vault":
		return "submitLockProof"
	case "burn", "burn-wl", "burn-bsc", "burn-vault":
		return "submitBurnProof"
	}
	return ""
}

func EncodeClaimCalldata(action string, blockNumber uint64, blockHash common.Hash, proof *Proof) ([]byte, error) {
	if proof == nil || len(proof.Nodes) == 0 || blockHash == (common.Hash{}) {
		return nil, errors.New("missing claim proof or block hash")
	}
	method := ClaimMethod(action)
	if method == "" {
		return nil, errors.New("unsupported claim action")
	}
	parsed, err := abi.JSON(strings.NewReader(receiverABI))
	if err != nil {
		return nil, err
	}
	return parsed.Pack(method, ClaimCall{new(big.Int).SetUint64(blockNumber), blockHash,
		new(big.Int).SetUint64(proof.TxIndex), new(big.Int).SetUint64(proof.LogIndex), proof.Nodes})
}
