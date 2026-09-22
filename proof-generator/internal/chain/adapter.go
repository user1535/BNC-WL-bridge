// Package chain provides read-only source-chain adapters for the keyless proof
// generator. Signing and transaction broadcasting deliberately have no API here.
package chain

import (
	"context"
	"encoding/json"
)

type Hash string
type Address string

type Header struct {
	Number       uint64
	Hash         Hash
	ParentHash   Hash
	ReceiptsRoot Hash
}

type Receipt struct {
	TransactionHash  Hash
	TransactionIndex uint64
	BlockHash        Hash
	BlockNumber      uint64
	Logs             []Log
	Raw              json.RawMessage
}

type Log struct {
	Address     Address
	Topics      []Hash
	Data        string
	BlockNumber uint64
	TxHash      Hash
	Index       uint64
}

type SourceChainAdapter interface {
	ChainID(context.Context) (uint64, error)
	LatestHeader(context.Context) (*Header, error)
	SafeHeader(context.Context) (*Header, error)
	HeaderByNumber(context.Context, uint64) (*Header, error)
	BlockTransactions(context.Context, uint64) ([]Hash, error)
	TransactionReceipt(context.Context, Hash) (*Receipt, error)
	BlockReceipts(context.Context, uint64) ([]*Receipt, error)
	FindBridgeEvents(context.Context, uint64, uint64) ([]Log, error)
}

type readBackend interface {
	ChainID(context.Context) (uint64, error)
	HeaderByNumber(context.Context, *uint64) (*Header, error)
	BlockTransactions(context.Context, uint64) ([]Hash, error)
	TransactionReceipt(context.Context, Hash) (*Receipt, error)
	FilterLogs(context.Context, uint64, uint64, []Address, []Hash) ([]Log, error)
}

type blockReceiptsBackend interface {
	BlockReceipts(context.Context, uint64) ([]*Receipt, error)
}
