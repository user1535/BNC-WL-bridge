package receipt

import (
	"encoding/hex"
	"encoding/json"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"os"
	"strings"
	"testing"
)

func TestV2CapturedBurnEventsAndDomainTampering(t *testing.T) {
	raw, err := os.ReadFile("../../../configs/burn-mint-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Inputs []struct {
			Action, SourceToken, DestinationToken, Sender, Recipient, Amount, ReceiptBytes string
			SourceChainID, DestinationChainID, Nonce                                       uint64
			LogIndex                                                                       int
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Inputs) == 0 {
		t.Fatal("missing captured events")
	}
	for _, v := range vectors.Inputs {
		encoded, err := hex.DecodeString(strings.TrimPrefix(v.ReceiptBytes, "0x"))
		if err != nil {
			t.Fatal(err)
		}
		var r types.Receipt
		if err := r.UnmarshalBinary(encoded); err != nil {
			t.Fatal(err)
		}
		log := *r.Logs[v.LogIndex]
		source, destination := common.HexToAddress(v.SourceToken), common.HexToAddress(v.DestinationToken)
		event, err := DecodeBridgeEvent(log, v.Action, v.SourceChainID, source, destination)
		if err != nil {
			t.Fatal(err)
		}
		if event.Sender.Hex() != common.HexToAddress(v.Sender).Hex() || event.Recipient.Hex() != common.HexToAddress(v.Recipient).Hex() || event.Amount.String() != v.Amount || event.Nonce != v.Nonce || event.DestinationChain != v.DestinationChainID {
			t.Fatal("V2 event differs")
		}
		for _, action := range []string{"lock", "burn", map[string]string{"burn-wl": "burn-bsc", "burn-bsc": "burn-wl"}[v.Action]} {
			if _, err := DecodeBridgeEvent(log, action, v.SourceChainID, source, destination); err == nil {
				t.Fatal("cross-version/direction event accepted")
			}
		}
		for _, mutate := range []func(*types.Log){
			func(l *types.Log) { l.Topics[3] = common.BytesToHash(common.HexToAddress("0xdead").Bytes()) },
			func(l *types.Log) { l.Data[31] ^= 1 }, func(l *types.Log) { l.Data[63] = 0 },
			func(l *types.Log) { l.Data[95] ^= 1 }, func(l *types.Log) { l.Topics[2][0] = 1 },
		} {
			changed := log
			changed.Topics = append([]common.Hash{}, log.Topics...)
			changed.Data = append([]byte{}, log.Data...)
			mutate(&changed)
			if _, err := DecodeBridgeEvent(changed, v.Action, v.SourceChainID, source, destination); err == nil {
				t.Fatal("altered V2 event accepted")
			}
		}
		if _, err := DecodeBridgeEvent(log, v.Action, v.SourceChainID, source, common.HexToAddress("0xdead")); err == nil {
			t.Fatal("wrong V2 asset accepted")
		}
	}
}
