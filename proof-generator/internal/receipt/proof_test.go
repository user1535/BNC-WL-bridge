package receipt

import (
	"bytes"
	"math/big"
	"testing"

	"example.com/worldland-bnb-bridge/proof-generator/internal/chain"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb/memorydb"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/ethereum/go-ethereum/trie"
)

func blockFixture(count, txIndex int) (chain.Header, []common.Hash, types.Receipts, types.Log) {
	header := chain.Header{Number: 7, BlockHash: common.HexToHash("0x7777")}
	hashes := make([]common.Hash, count)
	receipts := make(types.Receipts, count)
	for index := 0; index < count; index++ {
		hashes[index] = common.BigToHash(big.NewInt(int64(index + 1)))
		log := &types.Log{Address: common.HexToAddress("0x1234"), Topics: []common.Hash{common.HexToHash("0xaaaa")}, Data: []byte{1, 2, 3},
			BlockNumber: header.Number, BlockHash: header.BlockHash, TxHash: hashes[index], TxIndex: uint(index), Index: uint(index * 2)}
		other := *log
		other.Index++
		other.Topics = []common.Hash{common.HexToHash("0xbbbb")}
		other.Data = []byte{4, 5, 6}
		r := &types.Receipt{Type: uint8(index % 4), Status: 1, CumulativeGasUsed: uint64(index+1) * 21000,
			TxHash: hashes[index], BlockHash: header.BlockHash, BlockNumber: new(big.Int).SetUint64(header.Number), TransactionIndex: uint(index), Logs: []*types.Log{log, &other}}
		r.Bloom = types.CreateBloom(types.Receipts{r})
		receipts[index] = r
	}
	header.ReceiptRoot = types.DeriveSha(receipts, trie.NewStackTrie(nil))
	target := *receipts[txIndex].Logs[1]
	target.Topics = append([]common.Hash{}, target.Topics...)
	target.Data = append([]byte{}, target.Data...)
	return header, hashes, receipts, target
}

func TestReceiptProofIndependentStackTrieAndVerifyProof(t *testing.T) {
	for _, spec := range [][2]int{{1, 0}, {2, 1}, {3, 2}, {101, 31}} {
		h, hx, receipts, target := blockFixture(spec[0], spec[1])
		proof, err := BuildReceiptProof(h, hx, receipts, target)
		if err != nil {
			t.Fatal(err)
		}
		if proof.TxIndex != uint64(spec[1]) || proof.LogIndex != 1 || proof.Root != h.ReceiptRoot {
			t.Fatal("wrong proof position")
		}
		db := memorydb.New()
		for _, n := range proof.Nodes {
			db.Put(crypto.Keccak256(n), n)
		}
		value, err := trie.VerifyProof(h.ReceiptRoot, rlp.AppendUint64(nil, uint64(spec[1])), db)
		var expected bytes.Buffer
		receipts.EncodeIndex(spec[1], &expected)
		if err != nil || !bytes.Equal(value, expected.Bytes()) || !bytes.Equal(value, proof.ReceiptBytes) {
			t.Fatal("proof value mismatch")
		}
	}
}

func TestFilteredLogMustExactlyMatchReceipt(t *testing.T) {
	for _, mutate := range []func(*types.Log){
		func(l *types.Log) { l.Topics[0] = common.HexToHash("0xdead") },
		func(l *types.Log) { l.Data[0] ^= 1 }, func(l *types.Log) { l.Address = common.HexToAddress("0x4321") },
		func(l *types.Log) { l.TxHash = common.HexToHash("0x4321") }, func(l *types.Log) { l.TxIndex++ },
		func(l *types.Log) { l.Index++ }, func(l *types.Log) { l.BlockNumber++ }, func(l *types.Log) { l.BlockHash = common.HexToHash("0x4321") },
		func(l *types.Log) { l.Removed = true },
	} {
		h, hx, receipts, target := blockFixture(2, 1)
		mutate(&target)
		if _, err := BuildReceiptProof(h, hx, receipts, target); err == nil {
			t.Fatal("forged filtered log accepted")
		}
	}
}

func TestReceiptMetadataFailuresAndRootMismatch(t *testing.T) {
	for _, mutate := range []func(*types.Receipt){
		func(r *types.Receipt) { r.BlockNumber = nil }, func(r *types.Receipt) { r.BlockNumber = big.NewInt(8) },
		func(r *types.Receipt) { r.TransactionIndex = 1 }, func(r *types.Receipt) { r.TxHash = common.HexToHash("0xdead") },
		func(r *types.Receipt) { r.BlockHash = common.HexToHash("0xdead") }, func(r *types.Receipt) { r.Type = 127 },
		func(r *types.Receipt) { r.Logs[0] = nil }, func(r *types.Receipt) { r.Logs[0].Removed = true },
	} {
		h, hx, receipts, target := blockFixture(1, 0)
		mutate(receipts[0])
		if _, err := BuildReceiptProof(h, hx, receipts, target); err == nil {
			t.Fatal("malformed receipt accepted")
		}
	}
	h, hx, receipts, target := blockFixture(2, 1)
	if _, err := BuildReceiptProof(h, hx, receipts[:1], target); err == nil {
		t.Fatal("missing receipt accepted")
	}
	h.ReceiptRoot = common.HexToHash("0xdead")
	if _, err := BuildReceiptProof(h, hx, receipts, target); err == nil {
		t.Fatal("root mismatch accepted")
	}
}

func TestFailedPreByzantiumAndDuplicateGlobalLogIndexRejected(t *testing.T) {
	for _, mutate := range []func(*types.Receipt){
		func(r *types.Receipt) { r.Status = 0 }, func(r *types.Receipt) { r.PostState = make([]byte, 32) },
		func(r *types.Receipt) { r.Logs[0].Index = r.Logs[1].Index },
	} {
		h, hx, receipts, target := blockFixture(1, 0)
		mutate(receipts[0])
		h.ReceiptRoot = types.DeriveSha(receipts, trie.NewStackTrie(nil))
		if _, err := BuildReceiptProof(h, hx, receipts, target); err == nil {
			t.Fatal("unsupported target receipt accepted")
		}
	}
}
