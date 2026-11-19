// Reconstruct the receipt root of a public block using read-only RPC methods.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"time"

	"example.com/worldland-bnb-bridge/proof-generator/internal/chain"
	"example.com/worldland-bnb-bridge/proof-generator/internal/receipt"
	"github.com/ethereum/go-ethereum/core/types"
)

const bscTestnetRPC = "https://bsc-testnet-dataseed.bnbchain.org/"

func main() {
	network := flag.String("network", "seoul", "seoul, gwangju, or bsc-testnet")
	height := flag.String("block", "", "decimal or 0x-prefixed block number")
	flag.Parse()
	if err := check(*network, *height); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func check(network, height string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	var adapter chain.SourceChainAdapter
	var err error
	switch network {
	case "seoul":
		adapter, err = chain.NewOfficialWorldLand(ctx)
		if height == "" {
			height = "0x9beda5" // Captured non-empty official Seoul block.
		}
	case "gwangju", "bsc-testnet":
		rpcURL := os.Getenv("BNC_READ_RPC")
		chainID := uint64(10359)
		if network == "bsc-testnet" {
			chainID = 97
			if rpcURL == "" {
				rpcURL = bscTestnetRPC
			}
		}
		adapter, err = chain.NewVaultTestnetReader(ctx, rpcURL, chainID, 0)
	default:
		return errors.New("unknown RPC check network")
	}
	if err != nil {
		return errors.New("RPC connection or chain ID validation failed")
	}
	defer adapter.Close()
	chainID, err := adapter.ChainID(ctx)
	if err != nil {
		return errors.New("chain ID read failed")
	}
	header, err := adapter.LatestHeader(ctx)
	if err != nil {
		return errors.New("latest block read failed")
	}
	tip := header.Number
	if height != "" {
		number, err := strconv.ParseUint(height, 0, 64)
		if err != nil || number > tip {
			return errors.New("invalid sample block number")
		}
		header, err = adapter.HeaderByNumber(ctx, number)
		if err != nil {
			return errors.New("sample block read failed")
		}
	}
	hashes, err := adapter.BlockTransactions(ctx, header.Number)
	if err != nil || len(hashes) > 512 {
		return errors.New("cannot read sample block or exceeds 512-transaction probe cap")
	}
	receipts, err := adapter.BlockReceipts(ctx, header.Number)
	if err != nil {
		return errors.New("ordered receipt retrieval failed")
	}
	if err := receipt.VerifyBlockReceipts(*header, hashes, receipts); err != nil {
		return err
	}
	logs, logError := adapter.BlockLogs(ctx, header.Number)
	expected := make([]types.Log, 0)
	receiptTypes := make(map[uint8]int)
	for _, item := range receipts {
		receiptTypes[item.Type]++
		for _, entry := range item.Logs {
			expected = append(expected, *entry)
		}
	}
	current, err := adapter.HeaderByNumber(ctx, header.Number)
	if err != nil || *current != *header {
		return errors.New("sample header changed during the probe")
	}
	report := map[string]any{
		"checkedAt": time.Now().UTC().Format(time.RFC3339), "network": network, "chainId": chainID,
		"tip": tip, "blockNumber": header.Number, "blockHash": header.BlockHash, "receiptRoot": header.ReceiptRoot,
		"transactions": len(hashes), "receiptTypes": receiptTypes, "receiptRootReconstructed": true,
		"logsMethodAvailable": logError == nil, "logCount": len(logs), "receiptLogCount": len(expected),
		"logsMatchReceipts":   logError == nil && (len(logs) == 0 && len(expected) == 0 || reflect.DeepEqual(logs, expected)),
		"sourceAuthenticated": false, "transactionBroadcast": false,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}
