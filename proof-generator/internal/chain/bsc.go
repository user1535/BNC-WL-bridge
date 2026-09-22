package chain

import "context"

// DialBSC creates a BSC adapter. Configured confirmations are treated as a
// deployment policy, not as proof of Parlia consensus.
func DialBSC(ctx context.Context, rawURL string, config EVMConfig) (*EVMAdapter, func(), error) {
	return DialEVM(ctx, rawURL, config)
}
