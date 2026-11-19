package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	"golang.org/x/sync/errgroup"
)

type Header struct {
	Number      uint64
	BlockHash   common.Hash
	ParentHash  common.Hash
	ReceiptRoot common.Hash
}

type SourceChainAdapter interface {
	ChainID(ctx context.Context) (uint64, error)
	LatestHeader(ctx context.Context) (*Header, error)
	SafeHeader(ctx context.Context) (*Header, error)
	HeaderByNumber(ctx context.Context, number uint64) (*Header, error)
	BlockTransactions(ctx context.Context, number uint64) ([]common.Hash, error)
	TransactionReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error)
	BlockReceipts(ctx context.Context, number uint64) ([]*types.Receipt, error)
	BlockLogs(ctx context.Context, number uint64) ([]types.Log, error)
	FindBridgeEvents(ctx context.Context, token common.Address, signature, id common.Hash, from, to uint64) ([]types.Log, error)
	Close()
}

type rpcAdapter struct {
	client          *ethclient.Client
	expectedChainID uint64
	confirmations   uint64
}

const OfficialSeoulRPC = "https://seoul.worldland.foundation/"

// Read-only compatibility probe. The source is fixed to the official Seoul endpoint.
func NewOfficialWorldLand(ctx context.Context) (SourceChainAdapter, error) {
	return dial(ctx, OfficialSeoulRPC, 103, 0, DialReadHTTPS)
}

// NewVaultTestnetReader exposes only read methods for the two testnet roles.
func NewVaultTestnetReader(ctx context.Context, rpcURL string, chainID, confirmations uint64) (SourceChainAdapter, error) {
	if chainID != 10359 && chainID != 97 {
		return nil, errors.New("testnet reader requires chain ID 10359 or 97")
	}
	return dial(ctx, rpcURL, chainID, confirmations, DialReadHTTPS)
}

func DialReadHTTPS(ctx context.Context, rpcURL string) (*ethclient.Client, error) {
	endpoint, err := url.Parse(rpcURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("RPC requires an HTTPS URL without userinfo or a fragment")
	}
	client, err := rpc.DialOptions(ctx, rpcURL, rpc.WithHTTPClient(&http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}))
	if err != nil {
		return nil, err
	}
	return ethclient.NewClient(client), nil
}

// These constructors intentionally accept only the two ephemeral local chain IDs.
// Live finality and consensus policies require a separate reviewed adapter.
func NewLocalWorldLand(ctx context.Context, rpcURL string, confirmations uint64) (SourceChainAdapter, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return dialLocal(ctx, rpcURL, 31337, confirmations)
}
func NewLocalBNB(ctx context.Context, rpcURL string, confirmations uint64) (SourceChainAdapter, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return dialLocal(ctx, rpcURL, 31338, confirmations)
}

func dialLocal(ctx context.Context, rpcURL string, expected uint64, confirmations uint64) (SourceChainAdapter, error) {
	return dial(ctx, rpcURL, expected, confirmations, ethclient.DialContext)
}

func dial(ctx context.Context, rpcURL string, expected, confirmations uint64,
	connect func(context.Context, string) (*ethclient.Client, error)) (SourceChainAdapter, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	client, err := connect(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	a := &rpcAdapter{client: client, expectedChainID: expected, confirmations: confirmations}
	id, err := a.ChainID(ctx)
	if err != nil || id != expected {
		client.Close()
		if err != nil {
			return nil, fmt.Errorf("read chain ID: %w", err)
		}
		return nil, fmt.Errorf("wrong chain ID: got %d, expected %d", id, expected)
	}
	return a, nil
}
func (a *rpcAdapter) Close() { a.client.Close() }
func (a *rpcAdapter) ChainID(ctx context.Context) (uint64, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	id, err := retryRead(ctx, func() (*big.Int, error) { return a.client.ChainID(ctx) })
	if err != nil {
		return 0, err
	}
	if !id.IsUint64() {
		return 0, errors.New("chain ID exceeds uint64")
	}
	return id.Uint64(), nil
}
func (a *rpcAdapter) LatestHeader(ctx context.Context) (*Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	latest, err := retryRead(ctx, func() (uint64, error) { return a.client.BlockNumber(ctx) })
	if err != nil {
		return nil, err
	}
	return a.HeaderByNumber(ctx, latest)
}
func (a *rpcAdapter) SafeHeader(ctx context.Context) (*Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	latest, err := retryRead(ctx, func() (uint64, error) { return a.client.BlockNumber(ctx) })
	if err != nil {
		return nil, err
	}
	if latest < a.confirmations {
		return nil, errors.New("confirmations exceed current height")
	}
	return a.HeaderByNumber(ctx, latest-a.confirmations)
}
func (a *rpcAdapter) HeaderByNumber(ctx context.Context, number uint64) (*Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var raw struct {
		Number       *hexutil.Big `json:"number"`
		Hash         common.Hash  `json:"hash"`
		ParentHash   common.Hash  `json:"parentHash"`
		ReceiptsRoot common.Hash  `json:"receiptsRoot"`
	}
	_, err := retryRead(ctx, func() (bool, error) {
		return true, a.client.Client().CallContext(ctx, &raw, "eth_getBlockByNumber", hexutil.EncodeUint64(number), false)
	})
	if err != nil {
		return nil, err
	}
	if raw.Number == nil || !(*big.Int)(raw.Number).IsUint64() || (*big.Int)(raw.Number).Uint64() != number || raw.Hash == (common.Hash{}) {
		return nil, errors.New("missing or invalid RPC header")
	}
	return &Header{Number: number, BlockHash: raw.Hash, ParentHash: raw.ParentHash, ReceiptRoot: raw.ReceiptsRoot}, nil
}
func (a *rpcAdapter) BlockTransactions(ctx context.Context, number uint64) ([]common.Hash, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Hash-only RPC avoids downloading and decoding every full transaction in a busy block.
	var raw struct {
		Number       *hexutil.Big  `json:"number"`
		Hash         common.Hash   `json:"hash"`
		Transactions []common.Hash `json:"transactions"`
	}
	_, err := retryRead(ctx, func() (bool, error) {
		return true, a.client.Client().CallContext(ctx, &raw, "eth_getBlockByNumber", hexutil.EncodeUint64(number), false)
	})
	if err != nil {
		return nil, err
	}
	if raw.Number == nil || !(*big.Int)(raw.Number).IsUint64() || (*big.Int)(raw.Number).Uint64() != number || raw.Hash == (common.Hash{}) {
		return nil, errors.New("missing or invalid transaction block")
	}
	for i, hash := range raw.Transactions {
		if hash == (common.Hash{}) {
			return nil, fmt.Errorf("zero transaction hash at index %d", i)
		}
	}
	return raw.Transactions, nil
}
func (a *rpcAdapter) TransactionReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return retryRead(ctx, func() (*types.Receipt, error) { return a.client.TransactionReceipt(ctx, hash) })
}
func (a *rpcAdapter) BlockReceipts(ctx context.Context, number uint64) ([]*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	hashes, err := a.BlockTransactions(ctx, number)
	if err != nil {
		return nil, err
	}
	var receipts []*types.Receipt
	if os.Getenv("BRIDGE_FORCE_PER_TX_RECEIPTS") != "1" {
		batchCtx, stopBatch := context.WithTimeout(ctx, 5*time.Second)
		receipts, err = retryRead(batchCtx, func() ([]*types.Receipt, error) {
			return a.client.BlockReceipts(batchCtx, rpc.BlockNumberOrHashWithNumber(rpc.BlockNumber(number)))
		})
		stopBatch()
	}
	if err != nil || len(receipts) != len(hashes) {
		receipts = make([]*types.Receipt, len(hashes))
		group, fallbackCtx := errgroup.WithContext(ctx)
		group.SetLimit(6)
		for i, hash := range hashes {
			i, hash := i, hash
			group.Go(func() error {
				item, err := a.TransactionReceipt(fallbackCtx, hash)
				if err != nil {
					return fmt.Errorf("fetch receipt %d: %w", i, err)
				}
				receipts[i] = item
				return nil
			})
		}
		if err := group.Wait(); err != nil {
			return nil, err
		}
	}
	header, err := a.HeaderByNumber(ctx, number)
	if err != nil {
		return nil, err
	}
	for i, receipt := range receipts {
		if receipt == nil || receipt.TxHash != hashes[i] || receipt.BlockHash != header.BlockHash || receipt.TransactionIndex != uint(i) {
			return nil, fmt.Errorf("receipt order or block mismatch at index %d", i)
		}
	}
	return receipts, nil
}
func (a *rpcAdapter) FindBridgeEvents(ctx context.Context, token common.Address, signature, id common.Hash, from, to uint64) ([]types.Log, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if from > to {
		return nil, errors.New("invalid log query range")
	}
	// Split only provider-declared range limits; cap work independently of uint64 range size.
	queries := 0
	var query func(uint64, uint64) ([]types.Log, error)
	query = func(first, last uint64) ([]types.Log, error) {
		queries++
		if queries > 256 {
			return nil, errors.New("log pagination exceeded 256 queries; provide --from-block")
		}
		logs, err := retryRead(ctx, func() ([]types.Log, error) {
			return a.client.FilterLogs(ctx, ethereum.FilterQuery{FromBlock: new(big.Int).SetUint64(first), ToBlock: new(big.Int).SetUint64(last),
				Addresses: []common.Address{token}, Topics: [][]common.Hash{{signature}, {id}}})
		})
		if err == nil || !logRangeError(err) || first == last {
			return logs, err
		}
		middle := first + (last-first)/2
		left, err := query(first, middle)
		if err != nil {
			return nil, err
		}
		right, err := query(middle+1, last)
		if err != nil {
			return nil, err
		}
		return append(left, right...), nil
	}
	return query(from, to)
}

func (a *rpcAdapter) BlockLogs(ctx context.Context, number uint64) ([]types.Log, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	height := new(big.Int).SetUint64(number)
	return retryRead(ctx, func() ([]types.Log, error) {
		return a.client.FilterLogs(ctx, ethereum.FilterQuery{FromBlock: height, ToBlock: height})
	})
}
