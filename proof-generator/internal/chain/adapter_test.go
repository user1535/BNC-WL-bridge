package chain

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type readRequest struct {
	ID     json.RawMessage   `json:"id"`
	Method string            `json:"method"`
	Params []json.RawMessage `json:"params"`
}

func respond(w http.ResponseWriter, request readRequest, result any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
}

func TestTemporaryRPCFailureRetriesButCancellationDoesNot(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var request readRequest
		json.NewDecoder(r.Body).Decode(&request)
		respond(w, request, "0x7a69")
	}))
	defer server.Close()
	adapter, err := NewLocalWorldLand(context.Background(), server.URL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	if reads.Load() != 2 {
		t.Fatalf("requests %d", reads.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.ChainID(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if reads.Load() != 2 {
		t.Fatal("cancelled read sent a request")
	}
}

func TestLogPaginationPreservesFiltersAndBlockRanges(t *testing.T) {
	var pages [][2]uint64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request readRequest
		json.NewDecoder(r.Body).Decode(&request)
		if request.Method == "eth_chainId" {
			respond(w, request, "0x7a69")
			return
		}
		var filter struct {
			From    string     `json:"fromBlock"`
			To      string     `json:"toBlock"`
			Address []string   `json:"address"`
			Topics  [][]string `json:"topics"`
		}
		if err := json.Unmarshal(request.Params[0], &filter); err != nil {
			t.Error(err)
			return
		}
		if len(filter.Address) != 1 || len(filter.Topics) != 2 || len(filter.Topics[1]) != 1 {
			t.Error("filters lost")
		}
		first, _ := strconv.ParseUint(strings.TrimPrefix(filter.From, "0x"), 16, 64)
		last, _ := strconv.ParseUint(strings.TrimPrefix(filter.To, "0x"), 16, 64)
		if last-first > 1 {
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32005, "message": "block range too wide"}})
			return
		}
		pages = append(pages, [2]uint64{first, last})
		respond(w, request, []types.Log{})
	}))
	defer server.Close()
	adapter, err := NewLocalWorldLand(context.Background(), server.URL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = adapter.FindBridgeEvents(ctx, common.HexToAddress("0x01"), common.HexToHash("0x02"), common.HexToHash("0x03"), 0, 7)
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]uint64{{0, 1}, {2, 3}, {4, 5}, {6, 7}}
	if len(pages) != len(want) {
		t.Fatalf("pages: %v", pages)
	}
	for i := range want {
		if pages[i] != want[i] {
			t.Fatalf("pages: %v", pages)
		}
	}
}

func TestReceiptPartialResponseFallsBackAndMismatchesReject(t *testing.T) {
	for _, mode := range []string{"partial", "reordered", "wrong-block", "wrong-index"} {
		t.Run(mode, func(t *testing.T) {
			block := common.HexToHash("0x10")
			hashes := []common.Hash{common.HexToHash("0x11"), common.HexToHash("0x12")}
			receipts := []*types.Receipt{}
			for i, hash := range hashes {
				receipts = append(receipts, &types.Receipt{Type: 2, Status: 1, CumulativeGasUsed: uint64((i + 1) * 21000), Logs: []*types.Log{}, TxHash: hash, TransactionIndex: uint(i), BlockHash: block, BlockNumber: big.NewInt(1), GasUsed: 21000})
			}
			var individual atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request readRequest
				json.NewDecoder(r.Body).Decode(&request)
				switch request.Method {
				case "eth_chainId":
					respond(w, request, "0x7a69")
				case "eth_getBlockByNumber":
					respond(w, request, map[string]any{"number": "0x1", "hash": block, "parentHash": common.HexToHash("0x01"), "receiptsRoot": common.HexToHash("0x02"), "transactions": hashes})
				case "eth_getBlockReceipts":
					switch mode {
					case "partial":
						respond(w, request, receipts[:1])
					case "reordered":
						respond(w, request, []*types.Receipt{receipts[1], receipts[0]})
					case "wrong-block":
						altered := *receipts[1]
						altered.BlockHash = common.HexToHash("0x99")
						respond(w, request, []*types.Receipt{receipts[0], &altered})
					case "wrong-index":
						altered := *receipts[1]
						altered.TransactionIndex = 0
						respond(w, request, []*types.Receipt{receipts[0], &altered})
					}
				case "eth_getTransactionReceipt":
					individual.Add(1)
					var hash common.Hash
					json.Unmarshal(request.Params[0], &hash)
					for _, receipt := range receipts {
						if receipt.TxHash == hash {
							respond(w, request, receipt)
							return
						}
					}
				default:
					t.Errorf("unexpected RPC %s", request.Method)
				}
			}))
			defer server.Close()
			adapter, err := NewLocalWorldLand(context.Background(), server.URL, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer adapter.Close()
			result, err := adapter.BlockReceipts(context.Background(), 1)
			if mode == "partial" {
				if err != nil || len(result) != 2 || individual.Load() != 2 {
					t.Fatalf("partial fallback: %v, %d", err, individual.Load())
				}
			} else if err == nil {
				t.Fatal("mismatched receipts accepted")
			}
		})
	}
}
