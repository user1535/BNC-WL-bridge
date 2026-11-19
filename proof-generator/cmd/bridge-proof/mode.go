package main

import (
	"context"
	"errors"
	"fmt"

	"example.com/worldland-bnb-bridge/proof-generator/internal/header"
	"github.com/ethereum/go-ethereum/common"
)

// Receipt computation is proved separately by the pinned RISC Zero guest.
// This generator only reads the operator-authenticated destination registry.
type modeOptions struct {
	Mode, Receiver, NetworkProfile string
	PreviewRoot                    bool
}

func (o modeOptions) validate() error {
	if o.Mode != "dev" {
		return errors.New("only operator-registered receipt roots are supported; header proving modes were retired")
	}
	if o.NetworkProfile != "" && o.NetworkProfile != "vault-testnet" {
		return errors.New("unsupported network profile")
	}
	if o.PreviewRoot && o.NetworkProfile != "vault-testnet" {
		return errors.New("root preview is available only for the testnet profile")
	}
	if o.Receiver != "" && (!common.IsHexAddress(o.Receiver) || common.HexToAddress(o.Receiver) == (common.Address{})) {
		return errors.New("invalid receiver address")
	}
	return nil
}

type userTransaction struct {
	Role    string         `json:"role"`
	Action  string         `json:"action"`
	ChainID uint64         `json:"chainId"`
	To      common.Address `json:"to"`
	Data    string         `json:"data"`
	Value   string         `json:"value"`
}

func validateReceiver(ctx context.Context, reader *header.EVMHeaderCoverageReader, receiverHex string,
	source uint64, action string, sourceToken, destinationToken, registry common.Address) error {
	if receiverHex == "" {
		return nil
	}
	receiver := common.HexToAddress(receiverHex)
	bound, err := reader.ViewAddress(ctx, receiver, "headerSource()")
	if err != nil || bound != registry {
		return fmt.Errorf("receiver header source binding mismatch: %v", err)
	}
	id, err := reader.ViewUint(ctx, receiver, "sourceChainId()")
	if err != nil || !id.IsUint64() || id.Uint64() != source {
		return errors.New("receiver source chain binding mismatch")
	}
	if action == "lock-vault" || action == "burn-vault" {
		bound, err := reader.ViewAddress(ctx, receiver, "sourceToken()")
		if err != nil || bound != sourceToken || receiver != destinationToken {
			return errors.New("vault receiver asset binding mismatch")
		}
		return nil
	}
	sourceView, destinationView := "sourceToken()", "wrappedToken()"
	if action == "burn" {
		sourceView, destinationView = "sourceWrappedToken()", "originalToken()"
	}
	if action == "burn-wl" || action == "burn-bsc" {
		sourceView, destinationView = "sourceToken()", "destinationToken()"
	}
	for signature, expected := range map[string]common.Address{sourceView: sourceToken, destinationView: destinationToken} {
		bound, err := reader.ViewAddress(ctx, receiver, signature)
		if err != nil || bound != expected {
			return fmt.Errorf("receiver token binding mismatch for %s: %v", signature, err)
		}
	}
	return nil
}
