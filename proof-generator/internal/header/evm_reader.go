package header

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"strings"
	"time"

	"example.com/worldland-bnb-bridge/proof-generator/internal/chain"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const coverageABI = `[{"type":"function","name":"isBlockCovered","stateMutability":"view","inputs":[{"name":"sourceChainId","type":"uint256"},{"name":"blockNumber","type":"uint256"},{"name":"blockHash","type":"bytes32"}],"outputs":[{"name":"","type":"bool"}]},{"type":"function","name":"getReceiptRoot","stateMutability":"view","inputs":[{"name":"sourceChainId","type":"uint256"},{"name":"blockNumber","type":"uint256"},{"name":"blockHash","type":"bytes32"}],"outputs":[{"name":"receiptRoot","type":"bytes32"}]}]`

type EVMHeaderCoverageReader struct {
	client   *ethclient.Client
	contract common.Address
	parsed   abi.ABI
}

func (r *EVMHeaderCoverageReader) ViewHash(ctx context.Context, contract common.Address, signature string) (common.Hash, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	code, err := r.client.CodeAt(ctx, contract, nil)
	if err != nil {
		return common.Hash{}, err
	}
	if len(code) == 0 {
		return common.Hash{}, errors.New("view target has no contract code")
	}
	raw, err := r.client.CallContract(ctx, ethereum.CallMsg{To: &contract, Data: crypto.Keccak256([]byte(signature))[:4]}, nil)
	if err != nil {
		return common.Hash{}, err
	}
	if len(raw) != 32 {
		return common.Hash{}, errors.New("invalid static contract view response")
	}
	return common.BytesToHash(raw), nil
}

func (r *EVMHeaderCoverageReader) ViewAddress(ctx context.Context, contract common.Address, signature string) (common.Address, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	word, err := r.ViewHash(ctx, contract, signature)
	if err != nil {
		return common.Address{}, err
	}
	if !bytes.Equal(word[:12], make([]byte, 12)) {
		return common.Address{}, errors.New("invalid address view padding")
	}
	return common.BytesToAddress(word[12:]), nil
}

func (r *EVMHeaderCoverageReader) ViewUint(ctx context.Context, contract common.Address, signature string) (*big.Int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	word, err := r.ViewHash(ctx, contract, signature)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(word[:]), nil
}

func NewEVMHeaderCoverageReader(ctx context.Context, rpcURL string, contract common.Address) (*EVMHeaderCoverageReader, error) {
	return newCoverageReader(ctx, rpcURL, contract, ethclient.DialContext)
}

func NewTestnetCoverageReader(ctx context.Context, rpcURL string, contract common.Address) (*EVMHeaderCoverageReader, error) {
	return newCoverageReader(ctx, rpcURL, contract, chain.DialReadHTTPS)
}

func newCoverageReader(ctx context.Context, rpcURL string, contract common.Address,
	connect func(context.Context, string) (*ethclient.Client, error)) (*EVMHeaderCoverageReader, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if rpcURL == "" || contract == (common.Address{}) {
		return nil, errors.New("destination RPC and header contract required")
	}
	parsed, err := abi.JSON(strings.NewReader(coverageABI))
	if err != nil {
		return nil, err
	}
	client, err := connect(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	return &EVMHeaderCoverageReader{client: client, contract: contract, parsed: parsed}, nil
}
func (r *EVMHeaderCoverageReader) Close() { r.client.Close() }
func (r *EVMHeaderCoverageReader) ChainID(ctx context.Context) (uint64, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	id, err := r.client.ChainID(ctx)
	if err != nil {
		return 0, err
	}
	if !id.IsUint64() {
		return 0, errors.New("destination chain ID exceeds uint64")
	}
	return id.Uint64(), nil
}
func (r *EVMHeaderCoverageReader) IsBlockCovered(ctx context.Context, chainID, number uint64, hash common.Hash) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := r.parsed.Pack("isBlockCovered", new(big.Int).SetUint64(chainID), new(big.Int).SetUint64(number), hash)
	if err != nil {
		return false, err
	}
	result, err := r.client.CallContract(ctx, ethereum.CallMsg{To: &r.contract, Data: data}, nil)
	if err != nil {
		return false, err
	}
	decoded, err := r.parsed.Unpack("isBlockCovered", result)
	if err != nil {
		return false, err
	}
	if len(decoded) != 1 {
		return false, errors.New("invalid header coverage response")
	}
	covered, ok := decoded[0].(bool)
	if !ok {
		return false, errors.New("invalid header coverage type")
	}
	return covered, nil
}

func (r *EVMHeaderCoverageReader) ReceiptRoot(ctx context.Context, chainID, number uint64, hash common.Hash) (common.Hash, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := r.parsed.Pack("getReceiptRoot", new(big.Int).SetUint64(chainID), new(big.Int).SetUint64(number), hash)
	if err != nil {
		return common.Hash{}, err
	}
	result, err := r.client.CallContract(ctx, ethereum.CallMsg{To: &r.contract, Data: data}, nil)
	if err != nil {
		return common.Hash{}, err
	}
	decoded, err := r.parsed.Unpack("getReceiptRoot", result)
	if err != nil {
		return common.Hash{}, err
	}
	if len(decoded) != 1 {
		return common.Hash{}, errors.New("invalid receipt root response")
	}
	root, ok := decoded[0].([32]byte)
	if !ok {
		return common.Hash{}, errors.New("invalid receipt root type")
	}
	return common.Hash(root), nil
}
