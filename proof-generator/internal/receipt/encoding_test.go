package receipt

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/trie"
)

func TestExplicitSetCodeReceiptPayloadAndLegacySDKAgreement(t *testing.T) {
	for kind := uint8(0); kind <= 4; kind++ {
		r := &types.Receipt{Type: kind, Status: 1, CumulativeGasUsed: 21000, Logs: []*types.Log{{Address: common.HexToAddress("0x1234"), Data: []byte{1, 2}}}}
		r.Bloom = types.CreateBloom(types.Receipts{r})
		encoded, err := EncodeReceipt(r)
		if err != nil {
			t.Fatal(err)
		}
		legacy := *r
		if kind == 4 {
			legacy.Type = 2
		}
		expected, err := legacy.MarshalBinary()
		if err != nil {
			t.Fatal(err)
		}
		if kind == 4 {
			expected[0] = 4
		}
		if !bytes.Equal(encoded, expected) {
			t.Fatal("consensus payload changed")
		}
		if kind == 4 {
			var unsupported bytes.Buffer
			types.Receipts{r}.EncodeIndex(0, &unsupported)
			// The pinned SDK writes the type prefix before its unsupported
			// switch branch, leaving an incomplete one-byte receipt.
			if !bytes.Equal(unsupported.Bytes(), []byte{SetCodeReceiptType}) {
				t.Fatal("legacy SDK behavior changed; review explicit codec")
			}
		}
	}
	for _, r := range []*types.Receipt{nil, {Type: 5}, {Type: 4, Status: 2}, {Type: 4, PostState: make([]byte, 32)}, {Type: 4, Logs: []*types.Log{nil}}, {Type: 2, Status: 2}} {
		if _, err := EncodeReceipt(r); err == nil {
			t.Fatal("invalid receipt accepted")
		}
	}
}
func TestCapturedBNB121ReceiptsRootIncludingSetCode(t *testing.T) {
	raw, err := os.ReadFile("testdata/native-bnb-receipts.json")
	if err != nil {
		t.Fatal(err)
	}
	var response struct{ Result types.Receipts }
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Result) != 121 {
		t.Fatal("unexpected captured block")
	}
	encoded := make(EncodedReceipts, len(response.Result))
	counts := map[uint8]int{}
	for i, r := range response.Result {
		encoded[i], err = EncodeReceipt(r)
		if err != nil {
			t.Fatal(err)
		}
		counts[r.Type]++
	}
	expected := common.HexToHash("0x5ac9b5419a23cae87df540f45b86535b0c5ec5e2ba484b71a4e4bbada0bd0320")
	if types.DeriveSha(encoded, trie.NewStackTrie(nil)) != expected || counts[4] != 2 {
		t.Fatal("captured native root/type matrix mismatch")
	}
	if types.DeriveSha(response.Result, trie.NewStackTrie(nil)) == expected {
		t.Fatal("old unsupported SDK root unexpectedly matched")
	}
}
