package receipt

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type eventFixture struct {
	Action           string
	SourceChain      uint64
	SourceToken      common.Address
	DestinationToken common.Address
	Log              types.Log
	Expected         struct {
		Sender, Recipient         common.Address
		Amount                    string
		Nonce, DestinationChainID uint64
	}
}

func localEventFixtures(t *testing.T) []eventFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/actual-local-events.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Synthetic          bool
		ChainAuthenticated bool
		Fixtures           []eventFixture
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.Synthetic || file.ChainAuthenticated || len(file.Fixtures) != 2 {
		t.Fatal("invalid local event provenance")
	}
	return file.Fixtures
}

func TestDecodeActualSolidityLockAndBurnEvents(t *testing.T) {
	for _, fixture := range localEventFixtures(t) {
		event, err := DecodeBridgeEvent(fixture.Log, fixture.Action, fixture.SourceChain, fixture.SourceToken, fixture.DestinationToken)
		if err != nil {
			t.Fatal(err)
		}
		if event.Sender != fixture.Expected.Sender || event.Recipient != fixture.Expected.Recipient || event.Amount.String() != fixture.Expected.Amount || event.Nonce != fixture.Expected.Nonce || event.DestinationChain != fixture.Expected.DestinationChainID {
			t.Fatal("actual event decoding mismatch")
		}
	}
}

func TestRejectAlteredEventTopicDomainMetadataAndABI(t *testing.T) {
	for _, fixture := range localEventFixtures(t) {
		for _, mutate := range []func(*types.Log){
			func(l *types.Log) { l.Topics[0] = common.HexToHash("0xdead") }, func(l *types.Log) { l.Topics[1][0] ^= 1 },
			func(l *types.Log) { l.Topics[2][0] = 1 }, func(l *types.Log) { l.Topics[3][31] ^= 1 },
			func(l *types.Log) { l.Topics = l.Topics[:3] }, func(l *types.Log) { l.Data = l.Data[:95] },
			func(l *types.Log) {
				for i := 0; i < 32; i++ {
					l.Data[i] = 0
				}
			},
			func(l *types.Log) { l.Data[31] ^= 1 }, func(l *types.Log) { l.Data[32] = 1 },
			func(l *types.Log) { l.Data[64] = 1 }, func(l *types.Log) { l.Data[95] = 56 },
			func(l *types.Log) { l.Address = common.HexToAddress("0xdead") }, func(l *types.Log) { l.Removed = true },
		} {
			log := fixture.Log
			log.Data = append([]byte{}, log.Data...)
			log.Topics = append([]common.Hash{}, log.Topics...)
			mutate(&log)
			if _, err := DecodeBridgeEvent(log, fixture.Action, fixture.SourceChain, fixture.SourceToken, fixture.DestinationToken); err == nil {
				t.Fatal("altered event accepted")
			}
		}
		if _, err := DecodeBridgeEvent(fixture.Log, "automatic", fixture.SourceChain, fixture.SourceToken, fixture.DestinationToken); err == nil {
			t.Fatal("unknown action interpreted as burn")
		}
		if _, err := DecodeBridgeEvent(fixture.Log, fixture.Action, 56, fixture.SourceToken, fixture.DestinationToken); err == nil {
			t.Fatal("live domain accepted")
		}
		if _, err := DecodeBridgeEvent(fixture.Log, fixture.Action, fixture.SourceChain, fixture.SourceToken, common.HexToAddress("0xdead")); err == nil {
			t.Fatal("wrong destination token accepted")
		}
	}
}
