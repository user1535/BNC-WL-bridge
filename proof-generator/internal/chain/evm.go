package chain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
)

type EVMConfig struct {
	Confirmations   uint64
	BridgeAddresses []Address
	BridgeTopics    []Hash
}

type EVMAdapter struct {
	backend readBackend
	config  EVMConfig
}

func DialEVM(_ context.Context, rawURL string, config EVMConfig) (*EVMAdapter, func(), error) {
	if rawURL == "" {
		return nil, nil, errors.New("EVM RPC URL is empty")
	}
	backend := &jsonRPCBackend{url: rawURL, client: http.DefaultClient}
	return NewEVMAdapter(backend, config), func() {}, nil
}
func NewEVMAdapter(backend readBackend, config EVMConfig) *EVMAdapter {
	return &EVMAdapter{backend, config}
}
func (a *EVMAdapter) ChainID(ctx context.Context) (uint64, error) { return a.backend.ChainID(ctx) }
func (a *EVMAdapter) LatestHeader(ctx context.Context) (*Header, error) {
	h, err := a.backend.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("read latest header: %w", err)
	}
	return h, nil
}
func (a *EVMAdapter) SafeHeader(ctx context.Context) (*Header, error) {
	h, err := a.LatestHeader(ctx)
	if err != nil {
		return nil, err
	}
	if h.Number < a.config.Confirmations {
		return nil, fmt.Errorf("safe tip unavailable: latest=%d confirmations=%d", h.Number, a.config.Confirmations)
	}
	return a.HeaderByNumber(ctx, h.Number-a.config.Confirmations)
}
func (a *EVMAdapter) HeaderByNumber(ctx context.Context, n uint64) (*Header, error) {
	h, err := a.backend.HeaderByNumber(ctx, &n)
	if err != nil {
		return nil, fmt.Errorf("read header %d: %w", n, err)
	}
	return h, nil
}
func (a *EVMAdapter) BlockTransactions(ctx context.Context, n uint64) ([]Hash, error) {
	return a.backend.BlockTransactions(ctx, n)
}
func (a *EVMAdapter) TransactionReceipt(ctx context.Context, h Hash) (*Receipt, error) {
	return a.backend.TransactionReceipt(ctx, h)
}
func (a *EVMAdapter) BlockReceipts(ctx context.Context, n uint64) ([]*Receipt, error) {
	if b, ok := a.backend.(blockReceiptsBackend); ok {
		if receipts, err := b.BlockReceipts(ctx, n); err == nil {
			sort.Slice(receipts, func(i, j int) bool { return receipts[i].TransactionIndex < receipts[j].TransactionIndex })
			return receipts, nil
		}
	}
	hashes, err := a.BlockTransactions(ctx, n)
	if err != nil {
		return nil, err
	}
	receipts := make([]*Receipt, len(hashes))
	for i, hash := range hashes {
		receipts[i], err = a.TransactionReceipt(ctx, hash)
		if err != nil {
			return nil, err
		}
		if receipts[i].TransactionIndex != uint64(i) {
			return nil, fmt.Errorf("receipt order mismatch: position=%d transactionIndex=%d", i, receipts[i].TransactionIndex)
		}
	}
	return receipts, nil
}
func (a *EVMAdapter) FindBridgeEvents(ctx context.Context, from, to uint64) ([]Log, error) {
	if from > to {
		return nil, fmt.Errorf("invalid event range %d..%d", from, to)
	}
	return a.backend.FilterLogs(ctx, from, to, a.config.BridgeAddresses, a.config.BridgeTopics)
}

type jsonRPCBackend struct {
	url    string
	client *http.Client
	id     atomic.Uint64
}
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}
type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (b *jsonRPCBackend) call(ctx context.Context, method string, params any, out any) error {
	body, _ := json.Marshal(rpcRequest{"2.0", b.id.Add(1), method, params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("RPC HTTP %s: %s", resp.Status, data)
	}
	var envelope rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return err
	}
	if envelope.Error != nil {
		return fmt.Errorf("RPC error %d: %s", envelope.Error.Code, envelope.Error.Message)
	}
	return json.Unmarshal(envelope.Result, out)
}
func parseQuantity(value string) (uint64, error) {
	return strconv.ParseUint(strings.TrimPrefix(value, "0x"), 16, 64)
}

type rpcHeader struct{ Number, Hash, ParentHash, ReceiptsRoot string }

func (b *jsonRPCBackend) ChainID(ctx context.Context) (uint64, error) {
	var s string
	if err := b.call(ctx, "eth_chainId", []any{}, &s); err != nil {
		return 0, err
	}
	return parseQuantity(s)
}
func (b *jsonRPCBackend) HeaderByNumber(ctx context.Context, n *uint64) (*Header, error) {
	tag := "latest"
	if n != nil {
		tag = fmt.Sprintf("0x%x", *n)
	}
	var r rpcHeader
	if err := b.call(ctx, "eth_getBlockByNumber", []any{tag, false}, &r); err != nil {
		return nil, err
	}
	number, err := parseQuantity(r.Number)
	if err != nil {
		return nil, err
	}
	return &Header{number, Hash(r.Hash), Hash(r.ParentHash), Hash(r.ReceiptsRoot)}, nil
}
func (b *jsonRPCBackend) BlockTransactions(ctx context.Context, n uint64) ([]Hash, error) {
	var r struct {
		Transactions []Hash `json:"transactions"`
	}
	err := b.call(ctx, "eth_getBlockByNumber", []any{fmt.Sprintf("0x%x", n), false}, &r)
	return r.Transactions, err
}

type rpcReceipt struct {
	TransactionHash  Hash     `json:"transactionHash"`
	TransactionIndex string   `json:"transactionIndex"`
	BlockHash        Hash     `json:"blockHash"`
	BlockNumber      string   `json:"blockNumber"`
	Logs             []rpcLog `json:"logs"`
}
type rpcLog struct {
	Address         Address `json:"address"`
	Topics          []Hash  `json:"topics"`
	Data            string  `json:"data"`
	BlockNumber     string  `json:"blockNumber"`
	TransactionHash Hash    `json:"transactionHash"`
	LogIndex        string  `json:"logIndex"`
}

func decodeReceipt(raw json.RawMessage) (*Receipt, error) {
	var r rpcReceipt
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	ti, e := parseQuantity(r.TransactionIndex)
	if e != nil {
		return nil, e
	}
	bn, e := parseQuantity(r.BlockNumber)
	if e != nil {
		return nil, e
	}
	out := &Receipt{TransactionHash: r.TransactionHash, TransactionIndex: ti, BlockHash: r.BlockHash, BlockNumber: bn, Raw: append(json.RawMessage(nil), raw...)}
	for _, l := range r.Logs {
		ln, e := parseQuantity(l.LogIndex)
		if e != nil {
			return nil, e
		}
		out.Logs = append(out.Logs, Log{l.Address, l.Topics, l.Data, bn, l.TransactionHash, ln})
	}
	return out, nil
}
func (b *jsonRPCBackend) TransactionReceipt(ctx context.Context, h Hash) (*Receipt, error) {
	var raw json.RawMessage
	if err := b.call(ctx, "eth_getTransactionReceipt", []any{h}, &raw); err != nil {
		return nil, err
	}
	return decodeReceipt(raw)
}
func (b *jsonRPCBackend) BlockReceipts(ctx context.Context, n uint64) ([]*Receipt, error) {
	var raws []json.RawMessage
	if err := b.call(ctx, "eth_getBlockReceipts", []any{fmt.Sprintf("0x%x", n)}, &raws); err != nil {
		return nil, err
	}
	out := make([]*Receipt, len(raws))
	for i := range raws {
		r, e := decodeReceipt(raws[i])
		if e != nil {
			return nil, e
		}
		out[i] = r
	}
	return out, nil
}
func (b *jsonRPCBackend) FilterLogs(ctx context.Context, from, to uint64, addresses []Address, topics []Hash) ([]Log, error) {
	filter := map[string]any{"fromBlock": fmt.Sprintf("0x%x", from), "toBlock": fmt.Sprintf("0x%x", to), "address": addresses}
	if len(topics) > 0 {
		filter["topics"] = []any{topics}
	}
	var raw []rpcLog
	if err := b.call(ctx, "eth_getLogs", []any{filter}, &raw); err != nil {
		return nil, err
	}
	out := make([]Log, len(raw))
	for i, l := range raw {
		bn, e := parseQuantity(l.BlockNumber)
		if e != nil {
			return nil, e
		}
		li, e := parseQuantity(l.LogIndex)
		if e != nil {
			return nil, e
		}
		out[i] = Log{l.Address, l.Topics, l.Data, bn, l.TransactionHash, li}
	}
	return out, nil
}
