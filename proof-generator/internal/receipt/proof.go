package receipt

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"

	"example.com/worldland-bnb-bridge/proof-generator/internal/chain"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb/memorydb"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/ethereum/go-ethereum/trie"
)

type Proof struct {
	Root         common.Hash
	TxIndex      uint64
	LogIndex     uint64 // Receipt-local index, not the RPC's block-global log index.
	Nodes        [][]byte
	ReceiptBytes []byte
}

func rebuildReceiptTrie(header chain.Header, txHashes []common.Hash, receipts types.Receipts) (*trie.Trie, error) {
	if header.BlockHash == (common.Hash{}) || len(receipts) != len(txHashes) {
		return nil, errors.New("incomplete block receipts")
	}
	tr := trie.NewEmpty(nil)
	for index, item := range receipts {
		if item == nil || item.BlockNumber == nil || !item.BlockNumber.IsUint64() || item.BlockNumber.Uint64() != header.Number || item.TransactionIndex != uint(index) || item.TxHash != txHashes[index] || item.BlockHash != header.BlockHash {
			return nil, fmt.Errorf("receipt order or block metadata mismatch at index %d", index)
		}
		// Explicit receipt codec supports legacy SDK types0..3 and EIP-7702 type4.
		if item.Type > SetCodeReceiptType {
			return nil, fmt.Errorf("unsupported receipt type %d", item.Type)
		}
		for _, entry := range item.Logs {
			if entry == nil || entry.Removed || entry.BlockHash != header.BlockHash || entry.BlockNumber != header.Number || entry.TxHash != item.TxHash || entry.TxIndex != uint(index) {
				return nil, fmt.Errorf("receipt log metadata mismatch at transaction %d", index)
			}
		}
		encoded, err := EncodeReceipt(item)
		if err != nil {
			return nil, err
		}
		if err := tr.Update(rlp.AppendUint64(nil, uint64(index)), encoded); err != nil {
			return nil, err
		}
	}
	root := tr.Hash()
	if root != header.ReceiptRoot {
		return nil, fmt.Errorf("receipt root mismatch: built %s header %s", root, header.ReceiptRoot)
	}
	return tr, nil
}

// VerifyBlockReceipts reconstructs the consensus receipt root without requiring a bridge event.
func VerifyBlockReceipts(header chain.Header, txHashes []common.Hash, receipts types.Receipts) error {
	_, err := rebuildReceiptTrie(header, txHashes, receipts)
	return err
}

// BuildReceiptProof is independent of RPC, wallets and header authentication.
// It checks source metadata and full filtered-log equality before proving.
func BuildReceiptProof(header chain.Header, txHashes []common.Hash, receipts types.Receipts, target types.Log) (*Proof, error) {
	if target.Removed || target.BlockHash != header.BlockHash || target.BlockNumber != header.Number {
		return nil, errors.New("event does not belong to the supplied block")
	}
	tr, err := rebuildReceiptTrie(header, txHashes, receipts)
	if err != nil {
		return nil, err
	}
	root := header.ReceiptRoot
	txIndex := uint64(target.TxIndex)
	if txIndex >= uint64(len(receipts)) || receipts[txIndex].TxHash != target.TxHash || receipts[txIndex].Status != types.ReceiptStatusSuccessful || len(receipts[txIndex].PostState) != 0 {
		return nil, errors.New("target receipt missing, failed or pre-Byzantium")
	}
	localIndex := -1
	for index, log := range receipts[txIndex].Logs {
		if log == nil {
			return nil, errors.New("nil log in target receipt")
		}
		if log.Index != target.Index {
			continue
		}
		if localIndex != -1 {
			return nil, errors.New("duplicate global log index in receipt")
		}
		if log.Removed || log.BlockHash != target.BlockHash || log.BlockNumber != target.BlockNumber || log.TxHash != target.TxHash || log.TxIndex != target.TxIndex || log.Address != target.Address || !reflect.DeepEqual(log.Topics, target.Topics) || !bytes.Equal(log.Data, target.Data) {
			return nil, errors.New("filtered event differs from the receipt log")
		}
		localIndex = index
	}
	if localIndex < 0 {
		return nil, errors.New("event not found in target receipt")
	}
	key := rlp.AppendUint64(nil, txIndex)
	iterator := trie.NewIterator(tr.MustNodeIterator(key))
	if !iterator.Next() || !bytes.Equal(iterator.Key, key) {
		return nil, errors.New("target receipt not found in trie")
	}
	nodes := iterator.Prove()
	if len(nodes) == 0 {
		return nil, errors.New("empty MPT proof")
	}
	encoded, err := EncodeReceipt(receipts[txIndex])
	if err != nil {
		return nil, err
	}
	db := memorydb.New()
	for _, node := range nodes {
		if err := db.Put(crypto.Keccak256(node), node); err != nil {
			return nil, err
		}
	}
	verified, err := trie.VerifyProof(root, key, db)
	if err != nil || !bytes.Equal(verified, encoded) {
		return nil, errors.New("generated MPT proof did not reverify")
	}
	return &Proof{root, txIndex, uint64(localIndex), nodes, encoded}, nil
}
