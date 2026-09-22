package chain

import (
	"context"
)

// GetBSCSafeTip returns the safe header selected by the configured BSC policy.
func GetBSCSafeTip(ctx context.Context, adapter SourceChainAdapter) (*Header, error) {
	return adapter.SafeHeader(ctx)
}

// GetBSCBlockReceipts uses the batch RPC when available and the adapter's
// per-transaction fallback otherwise.
func GetBSCBlockReceipts(ctx context.Context, adapter SourceChainAdapter, blockNumber uint64) ([]*Receipt, error) {
	return adapter.BlockReceipts(ctx, blockNumber)
}
