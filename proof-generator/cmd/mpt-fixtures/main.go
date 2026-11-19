// Generate Solidity differential fixtures using geth's trie and proof verifier.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/ethdb/memorydb"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/ethereum/go-ethereum/trie"
)

type collector struct {
	nodes [][]byte
	db    *memorydb.Database
}

func (c *collector) Put(key, value []byte) error {
	c.nodes = append(c.nodes, bytes.Clone(value))
	return c.db.Put(key, value)
}
func (c *collector) Delete(key []byte) error { return c.db.Delete(key) }

func main() {
	definitions := []struct {
		name         string
		keys, values [][]byte
		target       []byte
		missing      bool
	}{
		{"inline-branch", [][]byte{{0x12}, {0x23}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x12}, false},
		{"inline-extension", [][]byte{{0x12, 0x34}, {0x12, 0x56}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x12, 0x34}, false},
		{"branch-value", [][]byte{{0x12}, {0x12, 0x34}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x12}, false},
		{"hashed-branch", [][]byte{{0x12}, {0x23}}, [][]byte{bytes.Repeat([]byte{0x76}, 100), bytes.Repeat([]byte{0x77}, 100)}, []byte{0x12}, false},
		{"hashed-extension", [][]byte{{0x12, 0x34}, {0x12, 0x56}}, [][]byte{bytes.Repeat([]byte{0x76}, 100), bytes.Repeat([]byte{0x77}, 100)}, []byte{0x12, 0x34}, false},
		{"missing-branch-value", [][]byte{{0x12, 0x34}, {0x12, 0x56}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x12}, true},
		{"missing-branch-slot", [][]byte{{0x12}, {0x13}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x14}, true},
		{"missing-leaf", [][]byte{{0x12}}, [][]byte{[]byte("v")}, []byte{0x13}, true},
		{"missing-extension", [][]byte{{0x12, 0x34}, {0x12, 0x56}}, [][]byte{[]byte("v"), []byte("w")}, []byte{0x22, 0x34}, true},
		{"missing-short-key", [][]byte{{0x12, 0x34}}, [][]byte{[]byte("v")}, []byte{0x12}, true},
		{"missing-long-key", [][]byte{{0x12}}, [][]byte{[]byte("v")}, []byte{0x12, 0x34}, true},
	}
	// Deterministic geth witnesses span inline/hash and RLP size boundaries,
	// receipt-index keys, deep extensions, branch values and single leaves.
	lengths := []int{1, 2, 27, 28, 29, 30, 31, 32, 33, 55, 56, 127, 128, 255}
	for index := 0; index < 128; index++ {
		d := definitions[0]
		d.name = fmt.Sprintf("differential-%03d", index)
		d.values = [][]byte{bytes.Repeat([]byte{byte(index + 1)}, lengths[index%len(lengths)]), bytes.Repeat([]byte{0x77}, lengths[(index+3)%len(lengths)])}
		switch index % 5 {
		case 0:
			d.keys = [][]byte{rlp.AppendUint64(nil, uint64(index)), rlp.AppendUint64(nil, uint64(index+128))}
		case 1:
			d.keys = [][]byte{{0x12, 0x34, 0x56, 0x70}, {0x12, 0x34, 0x56, 0x71}}
		case 2:
			d.keys = [][]byte{{0x12}, {0x12, 0x34}}
		case 3:
			d.keys = [][]byte{{0x12, 0x34}, {0x12, 0x56}}
		case 4:
			d.keys = [][]byte{{byte(index), 0x12, 0x34}}
			d.values = d.values[:1]
		}
		d.target = d.keys[0]
		definitions = append(definitions, d)
	}
	fixtures := map[string]any{}
	for _, d := range definitions {
		t := trie.NewEmpty(nil)
		for i, key := range d.keys {
			if err := t.Update(key, d.values[i]); err != nil {
				panic(err)
			}
		}
		proof := collector{db: memorydb.New()}
		if err := t.Prove(d.target, &proof); err != nil {
			panic(err)
		}
		value, err := trie.VerifyProof(t.Hash(), d.target, proof.db)
		if err != nil || (d.missing && value != nil) || (!d.missing && !bytes.Equal(value, d.values[0])) {
			panic(fmt.Sprintf("geth verification: %v", err))
		}
		nodes := []string{}
		for _, node := range proof.nodes {
			nodes = append(nodes, hexutil.Encode(node))
		}
		fixtures[d.name] = map[string]any{"key": hexutil.Encode(d.target), "value": hexutil.Encode(value), "root": t.Hash(), "proofNodes": nodes, "gethVerified": true, "gethMember": value != nil}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(fixtures); err != nil {
		panic(err)
	}
}
