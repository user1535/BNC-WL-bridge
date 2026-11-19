package receipt

import (
	"bytes"
	"errors"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
)

// SetCodeReceiptType is the EIP-7702 receipt envelope (0x04). Its consensus
// payload is status, cumulative gas, bloom, logs; authorization is transaction
// data and is not inserted into a receipt. Legacy SDK v1.14.12 handles 0..3.
const SetCodeReceiptType = uint8(4)

func EncodeReceipt(item *types.Receipt) ([]byte, error) {
	if item == nil || item.Type > SetCodeReceiptType {
		return nil, errors.New("unsupported receipt type")
	}
	if len(item.PostState) == 0 && item.Status > types.ReceiptStatusSuccessful {
		return nil, errors.New("receipt status must be 0/1")
	}
	if item.Type != 0 && len(item.PostState) != 0 {
		return nil, errors.New("typed receipt cannot contain a pre-Byzantium state root")
	}
	if item.Type != SetCodeReceiptType {
		var output bytes.Buffer
		types.Receipts{item}.EncodeIndex(0, &output)
		if output.Len() == 0 {
			return nil, errors.New("empty receipt encoding")
		}
		return output.Bytes(), nil
	}
	if len(item.PostState) != 0 || item.Status > types.ReceiptStatusSuccessful {
		return nil, errors.New("set-code receipt requires status 0/1")
	}
	for _, log := range item.Logs {
		if log == nil {
			return nil, errors.New("nil receipt log")
		}
	}
	// Independent implementation of the explicit EIP-7702 ReceiptPayload. Log's
	// pinned geth RLP encoder emits only address/topics/data, not RPC metadata.
	payload, err := rlp.EncodeToBytes([]any{item.Status, item.CumulativeGasUsed, item.Bloom, item.Logs})
	if err != nil {
		return nil, err
	}
	return append([]byte{SetCodeReceiptType}, payload...), nil
}

// EncodedReceipts implements geth's derivable-list API over already validated
// byte strings, so old SDK EncodeIndex never silently emits an empty type4.
type EncodedReceipts [][]byte

func (list EncodedReceipts) Len() int                                { return len(list) }
func (list EncodedReceipts) EncodeIndex(i int, output *bytes.Buffer) { output.Write(list[i]) }
