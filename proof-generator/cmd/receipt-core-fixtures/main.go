// Build synthetic receipt syntax fixtures with geth-proven MPT inclusion.
package main

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb/memorydb"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/ethereum/go-ethereum/trie"
)

func main() {
	fixtures := map[string]any{}
	emitter := common.HexToAddress("0x1234")
	topic := common.HexToHash("0xabcd")
	base := func() []any {
		return []any{uint64(1), uint64(21000), make([]byte, 256), []any{[]any{emitter, []any{topic}, []byte{1, 2, 3}}, []any{emitter, []any{topic}, []byte{4, 5, 6}}}}
	}
	add := func(name string, fields []any, prefix int, logIndex uint64, accepted bool) {
		payload, err := rlp.EncodeToBytes(fields)
		must(err)
		if prefix >= 0 {
			payload = append([]byte{byte(prefix)}, payload...)
		}
		tr := trie.NewEmpty(nil)
		key := rlp.AppendUint64(nil, 0)
		must(tr.Update(key, payload))
		it := trie.NewIterator(tr.MustNodeIterator(key))
		if !it.Next() {
			panic("missing leaf")
		}
		nodes := it.Prove()
		db := memorydb.New()
		encodedNodes := []string{}
		for _, node := range nodes {
			must(db.Put(crypto.Keccak256(node), node))
			encodedNodes = append(encodedNodes, hexutil.Encode(node))
		}
		value, err := trie.VerifyProof(tr.Hash(), key, db)
		must(err)
		if !bytes.Equal(value, payload) {
			panic("MPT mismatch")
		}
		fixtures[name] = map[string]any{"root": tr.Hash(), "proofNodes": encodedNodes, "txIndex": 0, "logIndex": logIndex, "receipt": hexutil.Encode(payload), "accepted": accepted, "gethMPTVerified": true, "emitter": emitter, "topic": topic, "data": "0x040506"}
	}
	for _, tc := range []struct {
		name   string
		prefix int
	}{{"legacy", -1}, {"access-list", 1}, {"dynamic-fee", 2}, {"blob", 3}, {"set-code", 4}} {
		add(tc.name, base(), tc.prefix, 1, true)
	}
	for _, prefix := range []int{0, 5, 127} {
		add("unsupported-type-"+big.NewInt(int64(prefix)).String(), base(), prefix, 1, false)
	}
	fields := base()
	fields[0] = uint64(0)
	add("failed-status", fields, -1, 1, false)
	fields = base()
	fields[0] = make([]byte, 32)
	add("pre-byzantium-root", fields, -1, 1, false)
	fields = base()
	fields[1] = new(big.Int).Lsh(big.NewInt(1), 64)
	add("gas-overflow", fields, -1, 1, false)
	fields = base()
	fields[1] = []byte{0}
	add("noncanonical-gas-zero", fields, -1, 1, false)
	fields = base()
	fields[2] = make([]byte, 255)
	add("short-bloom", fields, -1, 1, false)
	fields = base()
	fields = append(fields, []byte{})
	add("extra-field", fields, 2, 1, false)
	add("log-out-of-range", base(), 2, 2, false)
	fields = base()
	fields[3].([]any)[1].([]any)[0] = make([]byte, 21)
	add("wrong-emitter-width", fields, -1, 1, false)
	fields = base()
	fields[3].([]any)[1].([]any)[1] = []any{make([]byte, 31)}
	add("wrong-topic-width", fields, -1, 1, false)
	fields = base()
	fields[3].([]any)[1].([]any)[2] = []any{}
	add("data-is-list", fields, -1, 1, false)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	must(encoder.Encode(fixtures))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
