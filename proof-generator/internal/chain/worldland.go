package chain

import "context"

// DialWorldLand creates a WorldLand adapter using the configured confirmation
// policy. It does not claim to validate ECCPoW consensus.
func DialWorldLand(ctx context.Context, rawURL string, config EVMConfig) (*EVMAdapter, func(), error) {
	return DialEVM(ctx, rawURL, config)
}

// GetWorldLandSafeTip returns the confirmation-policy safe header.
func GetWorldLandSafeTip(ctx context.Context, adapter SourceChainAdapter) (*Header, error) {
	return adapter.SafeHeader(ctx)
}
