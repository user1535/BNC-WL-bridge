package receipt

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

func TestCalldataMatchesActuallyAcceptedSolidityClaims(t *testing.T) {
	raw, err := os.ReadFile("testdata/actual-claim-calldata.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		ActualEVMClaimsAccepted bool
		Fixtures                []struct {
			Action            string
			BlockNumber       uint64
			BlockHash         common.Hash
			TxIndex, LogIndex uint64
			ProofNodes        []hexutil.Bytes
			Calldata          hexutil.Bytes
		}
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if !file.ActualEVMClaimsAccepted || len(file.Fixtures) != 2 {
		t.Fatal("missing actual calldata reference")
	}
	for _, fixture := range file.Fixtures {
		proof := &Proof{TxIndex: fixture.TxIndex, LogIndex: fixture.LogIndex}
		for _, node := range fixture.ProofNodes {
			proof.Nodes = append(proof.Nodes, node)
		}
		actual, err := EncodeClaimCalldata(fixture.Action, fixture.BlockNumber, fixture.BlockHash, proof)
		if err != nil || !bytes.Equal(actual, fixture.Calldata) {
			t.Fatal("calldata changed from actual accepted fixture")
		}
	}
	for _, action := range []string{"", "automatic", "checkpoint"} {
		if _, err := EncodeClaimCalldata(action, 1, common.HexToHash("0x1"), &Proof{Nodes: [][]byte{{1}}}); err == nil {
			t.Fatal("unknown claim action accepted")
		}
	}
	if _, err := EncodeClaimCalldata("lock", 1, common.HexToHash("0x1"), nil); err == nil {
		t.Fatal("nil claim proof accepted")
	}
}
