package chain

import (
	"context"
	"errors"
	"testing"
)

type fakeBackend struct {
	chainID       uint64
	latest        uint64
	hashes        []Hash
	receipts      map[Hash]*Receipt
	batchReceipts []*Receipt
	batchErr      error
	from, to      uint64
	addresses     []Address
	topics        []Hash
}

func (f *fakeBackend) ChainID(context.Context) (uint64, error) { return f.chainID, nil }
func (f *fakeBackend) HeaderByNumber(_ context.Context, n *uint64) (*Header, error) {
	if n == nil {
		return &Header{Number: f.latest}, nil
	}
	return &Header{Number: *n}, nil
}
func (f *fakeBackend) BlockTransactions(context.Context, uint64) ([]Hash, error) {
	return f.hashes, nil
}
func (f *fakeBackend) TransactionReceipt(_ context.Context, h Hash) (*Receipt, error) {
	return f.receipts[h], nil
}
func (f *fakeBackend) BlockReceipts(context.Context, uint64) ([]*Receipt, error) {
	return f.batchReceipts, f.batchErr
}
func (f *fakeBackend) FilterLogs(_ context.Context, from, to uint64, a []Address, t []Hash) ([]Log, error) {
	f.from, f.to, f.addresses, f.topics = from, to, a, t
	return []Log{{BlockNumber: from}}, nil
}

func TestSafeHeaderAppliesConfirmationPolicy(t *testing.T) {
	a := NewEVMAdapter(&fakeBackend{latest: 20}, EVMConfig{Confirmations: 7})
	h, e := a.SafeHeader(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if h.Number != 13 {
		t.Fatalf("safe header = %d, want 13", h.Number)
	}
}
func TestSafeHeaderRejectsInsufficientHistory(t *testing.T) {
	a := NewEVMAdapter(&fakeBackend{latest: 2}, EVMConfig{Confirmations: 3})
	if _, e := a.SafeHeader(context.Background()); e == nil {
		t.Fatal("SafeHeader() error = nil")
	}
}
func TestBlockReceiptsPrefersBatchAndSortsCanonicalOrder(t *testing.T) {
	b := &fakeBackend{batchReceipts: []*Receipt{{TransactionIndex: 2}, {TransactionIndex: 0}, {TransactionIndex: 1}}}
	rs, e := NewEVMAdapter(b, EVMConfig{}).BlockReceipts(context.Background(), 9)
	if e != nil {
		t.Fatal(e)
	}
	for i, r := range rs {
		if r.TransactionIndex != uint64(i) {
			t.Fatalf("receipt[%d] index = %d", i, r.TransactionIndex)
		}
	}
}
func TestBlockReceiptsFallsBackToPerTransactionRPC(t *testing.T) {
	b := &fakeBackend{hashes: []Hash{"0x1", "0x2"}, batchErr: errors.New("method not found"), receipts: map[Hash]*Receipt{"0x1": {TransactionHash: "0x1", TransactionIndex: 0}, "0x2": {TransactionHash: "0x2", TransactionIndex: 1}}}
	rs, e := NewEVMAdapter(b, EVMConfig{}).BlockReceipts(context.Background(), 9)
	if e != nil {
		t.Fatal(e)
	}
	if len(rs) != 2 || rs[1].TransactionHash != "0x2" {
		t.Fatalf("unexpected receipts: %#v", rs)
	}
}
func TestFindBridgeEventsConstrainsAddressTopicAndRange(t *testing.T) {
	b := &fakeBackend{}
	a := NewEVMAdapter(b, EVMConfig{BridgeAddresses: []Address{"0x1234"}, BridgeTopics: []Hash{"0xabcd"}})
	if _, e := a.FindBridgeEvents(context.Background(), 10, 12); e != nil {
		t.Fatal(e)
	}
	if b.from != 10 || b.to != 12 || b.addresses[0] != "0x1234" || b.topics[0] != "0xabcd" {
		t.Fatalf("unexpected filter: %#v", b)
	}
}
