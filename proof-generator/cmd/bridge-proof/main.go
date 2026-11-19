package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"example.com/worldland-bnb-bridge/proof-generator/internal/chain"
	headercoverage "example.com/worldland-bnb-bridge/proof-generator/internal/header"
	receiptproof "example.com/worldland-bnb-bridge/proof-generator/internal/receipt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

type output struct {
	Version            uint32           `json:"version"`
	HeaderMode         string           `json:"headerMode"`
	HeaderCovered      bool             `json:"headerCovered"`
	CoverageChecked    bool             `json:"coverageChecked"`
	DestinationChain   uint64           `json:"destinationChainId"`
	DestinationToken   string           `json:"destinationToken"`
	Sender             string           `json:"sender"`
	Recipient          string           `json:"recipient"`
	Amount             string           `json:"amount"`
	Nonce              uint64           `json:"nonce"`
	Action             string           `json:"action"`
	SourceChain        uint64           `json:"sourceChainId"`
	Token              string           `json:"sourceToken"`
	TransferID         string           `json:"transferId"`
	BlockNumber        uint64           `json:"blockNumber"`
	BlockHash          string           `json:"blockHash"`
	ReceiptRoot        string           `json:"receiptRoot"`
	TxHash             string           `json:"txHash"`
	TxIndex            uint             `json:"txIndex"`
	ReceiptCount       int              `json:"receiptCount"`
	LogIndex           int              `json:"logIndex"`
	ReceiptBytes       string           `json:"receiptBytes"`
	ProofNodes         []string         `json:"proofNodes"`
	Calldata           string           `json:"calldata"`
	ClaimTransaction   *userTransaction `json:"claimTransaction,omitempty"`
	ChainAuthenticated bool             `json:"chainAuthenticated"`
}

func main() {
	options := modeOptions{}
	flag.StringVar(&options.Mode, "header-mode", "dev", "dev (operator-registered receipt root)")
	flag.StringVar(&options.Receiver, "receiver", "", "destination mint/unlock receiver for unsigned user transaction")
	flag.StringVar(&options.NetworkProfile, "network-profile", "", "optional read-only vault-testnet profile")
	flag.BoolVar(&options.PreviewRoot, "preview-root", false, "reconstruct a testnet root before operator registration")
	var rpcURL, destinationRPC, headerSourceHex, tokenHex, destinationTokenHex, idHex, action string
	var expectedChain, confirmations, fromBlock uint64
	flag.StringVar(&rpcURL, "rpc", "", "source JSON-RPC URL")
	flag.StringVar(&destinationRPC, "destination-rpc", "", "destination JSON-RPC URL for read-only coverage check")
	flag.StringVar(&headerSourceHex, "header-source", "", "destination header source contract for read-only coverage check")
	flag.StringVar(&tokenHex, "token", "", "source token contract")
	flag.StringVar(&destinationTokenHex, "destination-token", "", "destination token contract")
	flag.StringVar(&idHex, "id", "", "transfer or withdrawal ID")
	flag.StringVar(&action, "action", "", "lock or burn")
	flag.Uint64Var(&expectedChain, "chain-id", 0, "required source chain ID")
	flag.Uint64Var(&confirmations, "confirmations", 0, "source confirmations")
	flag.Uint64Var(&fromBlock, "from-block", 0, "first source block to scan for the transfer ID")
	flag.Parse()
	if options.NetworkProfile == "vault-testnet" {
		rpcURL = os.Getenv("BNC_TESTNET_SOURCE_RPC")
		destinationRPC = os.Getenv("BNC_TESTNET_DESTINATION_RPC")
	}
	if err := runWithOptions(rpcURL, destinationRPC, headerSourceHex, tokenHex, destinationTokenHex, idHex, action, expectedChain, confirmations, fromBlock, options); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(rpcURL, destinationRPC, headerSourceHex, tokenHex, destinationTokenHex, idHex, action string, expectedChain, confirmations, fromBlock uint64) error {
	return runWithOptions(rpcURL, destinationRPC, headerSourceHex, tokenHex, destinationTokenHex, idHex, action, expectedChain, confirmations, fromBlock, modeOptions{Mode: "dev"})
}

func runWithOptions(rpcURL, destinationRPC, headerSourceHex, tokenHex, destinationTokenHex, idHex, action string, expectedChain, confirmations, fromBlock uint64, options modeOptions) error {
	if err := options.validate(); err != nil {
		return err
	}
	if rpcURL == "" || !common.IsHexAddress(tokenHex) || !common.IsHexAddress(destinationTokenHex) || len(idHex) != 66 || !strings.HasPrefix(idHex, "0x") || expectedChain == 0 {
		return errors.New("required: --rpc, --token, --destination-token, --id (bytes32), --chain-id")
	}
	if (destinationRPC == "") != (headerSourceHex == "") {
		return errors.New("--destination-rpc and --header-source must be provided together")
	}
	if headerSourceHex != "" && !common.IsHexAddress(headerSourceHex) {
		return errors.New("invalid header source address")
	}
	topicSig, method := receiptproof.EventSignature(action), receiptproof.ClaimMethod(action)
	if topicSig == "" || method == "" {
		return errors.New("unsupported --action")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(idHex, "0x")); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var adapter chain.SourceChainAdapter
	var err error
	testnet := options.NetworkProfile == "vault-testnet"
	if testnet {
		if (action != "lock-vault" && action != "burn-vault") || destinationRPC == "" || options.Receiver == "" {
			return errors.New("testnet requires a Vault action and destination registry and receiver")
		}
		adapter, err = chain.NewVaultTestnetReader(ctx, rpcURL, expectedChain, confirmations)
	} else {
		switch expectedChain {
		case 31337:
			adapter, err = chain.NewLocalWorldLand(ctx, rpcURL, confirmations)
		case 31338:
			adapter, err = chain.NewLocalBNB(ctx, rpcURL, confirmations)
		default:
			return errors.New("only local chain IDs 31337 and 31338 are supported")
		}
	}
	if err != nil {
		return err
	}
	defer adapter.Close()
	safeHeader, err := adapter.SafeHeader(ctx)
	if err != nil {
		return err
	}
	safe := safeHeader.Number
	if fromBlock > safe {
		return fmt.Errorf("from-block %d exceeds safe source height %d", fromBlock, safe)
	}
	token := common.HexToAddress(tokenHex)
	destinationToken := common.HexToAddress(destinationTokenHex)
	id := common.HexToHash(idHex)
	logs, err := adapter.FindBridgeEvents(ctx, token, crypto.Keccak256Hash([]byte(topicSig)), id, fromBlock, safe)
	if err != nil {
		return fmt.Errorf("filter event: %w", err)
	}
	if len(logs) != 1 {
		return fmt.Errorf("expected exactly one safe event, found %d", len(logs))
	}
	target := logs[0]
	decode := decodeBridgeEvent
	if testnet {
		decode = receiptproof.DecodeVaultTestnetEvent
	}
	event, err := decode(target, action, expectedChain, token, destinationToken)
	if err != nil {
		return err
	}
	if target.Topics[1] != id {
		return errors.New("RPC event does not match the requested transfer ID")
	}
	header, err := adapter.HeaderByNumber(ctx, target.BlockNumber)
	if err != nil {
		return err
	}
	if header.BlockHash != target.BlockHash {
		return errors.New("event block hash differs from RPC block hash")
	}
	txHashes, err := adapter.BlockTransactions(ctx, target.BlockNumber)
	if err != nil {
		return err
	}
	receipts, err := adapter.BlockReceipts(ctx, target.BlockNumber)
	if err != nil {
		return err
	}
	proof, err := receiptproof.BuildReceiptProof(*header, txHashes, receipts, target)
	if err != nil {
		return err
	}
	root, localLogIndex, nodes := proof.Root, proof.LogIndex, proof.Nodes
	calldata, err := receiptproof.EncodeClaimCalldata(action, target.BlockNumber, target.BlockHash, proof)
	if err != nil {
		return err
	}
	proofHex := make([]string, len(nodes))
	for i, node := range nodes {
		proofHex[i] = "0x" + hex.EncodeToString(node)
	}
	headerCovered := false
	coverageChecked := destinationRPC != ""
	if destinationRPC != "" {
		readCoverage := headercoverage.NewEVMHeaderCoverageReader
		if testnet {
			readCoverage = headercoverage.NewTestnetCoverageReader
		}
		reader, err := readCoverage(ctx, destinationRPC, common.HexToAddress(headerSourceHex))
		if err != nil {
			return err
		}
		defer reader.Close()
		destinationChainID, err := reader.ChainID(ctx)
		if err != nil {
			return err
		}
		if destinationChainID != event.DestinationChain {
			return fmt.Errorf("destination RPC chain ID %d differs from event destination %d", destinationChainID, event.DestinationChain)
		}
		headerCovered, err = reader.IsBlockCovered(ctx, expectedChain, target.BlockNumber, target.BlockHash)
		if err != nil {
			return err
		}
		if headerCovered {
			registeredRoot, err := reader.ReceiptRoot(ctx, expectedChain, target.BlockNumber, target.BlockHash)
			if err != nil {
				return err
			}
			if registeredRoot != root {
				return fmt.Errorf("destination receipt root %s differs from reconstructed source root %s", registeredRoot, root)
			}
		}
		if testnet && !headerCovered && !options.PreviewRoot {
			return errors.New("testnet destination receipt root must be registered by the operator first")
		}
		err = validateReceiver(ctx, reader, options.Receiver, expectedChain, action, token, destinationToken, common.HexToAddress(headerSourceHex))
		if err != nil {
			return err
		}
	}
	checkCtx, checkCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer checkCancel()
	// Reject a package if the source changed while receipts and destination coverage were read.
	canonicalHeader, err := adapter.HeaderByNumber(checkCtx, target.BlockNumber)
	if err != nil {
		return err
	}
	if canonicalHeader.BlockHash != header.BlockHash || canonicalHeader.ReceiptRoot != root {
		return errors.New("source block changed during proof generation")
	}
	currentSafeHeader, err := adapter.SafeHeader(checkCtx)
	if err != nil {
		return err
	}
	if currentSafeHeader.Number < target.BlockNumber {
		return errors.New("source block no longer satisfies confirmations")
	}
	result := output{Version: 1, HeaderMode: options.Mode, HeaderCovered: headerCovered, CoverageChecked: coverageChecked, DestinationChain: event.DestinationChain,
		DestinationToken: destinationToken.Hex(), Sender: event.Sender.Hex(), Recipient: event.Recipient.Hex(),
		Amount: event.Amount.String(), Nonce: event.Nonce,
		Action: action, SourceChain: expectedChain, Token: token.Hex(), TransferID: id.Hex(),
		BlockNumber: target.BlockNumber, BlockHash: target.BlockHash.Hex(), ReceiptRoot: root.Hex(),
		TxHash: target.TxHash.Hex(), TxIndex: target.TxIndex, ReceiptCount: len(receipts), LogIndex: int(localLogIndex),
		ReceiptBytes: "0x" + hex.EncodeToString(proof.ReceiptBytes), ProofNodes: proofHex,
		Calldata: "0x" + hex.EncodeToString(calldata)}
	if action == "burn-wl" || action == "burn-bsc" {
		result.Version = 2
	}
	if action == "lock-vault" || action == "burn-vault" {
		result.Version = 3
	}
	if testnet {
		result.Version = 4
	}
	if options.Receiver != "" {
		result.ClaimTransaction = &userTransaction{Role: "user", Action: method, ChainID: event.DestinationChain, To: common.HexToAddress(options.Receiver), Data: result.Calldata, Value: "0"}
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

// Compatibility wrapper for existing CLI mode tests; event decoding is reusable.
type bridgeEvent = receiptproof.Event

func decodeBridgeEvent(log types.Log, action string, sourceChain uint64, sourceToken, destinationToken common.Address) (*bridgeEvent, error) {
	return receiptproof.DecodeBridgeEvent(log, action, sourceChain, sourceToken, destinationToken)
}
