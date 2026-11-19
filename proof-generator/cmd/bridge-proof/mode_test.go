package main

import "testing"

func TestRetiredHeaderModesCannotSilentlyFallback(t *testing.T) {
	for _, mode := range []string{"checkpoint", "risc0_batch", "risc0_composite", "zk", ""} {
		if (modeOptions{Mode: mode, Receiver: "0x0000000000000000000000000000000000000001"}).validate() == nil {
			t.Fatalf("retired mode %q accepted", mode)
		}
	}
	if err := (modeOptions{Mode: "dev", Receiver: "0x0000000000000000000000000000000000000001"}).validate(); err != nil {
		t.Fatal(err)
	}
	for _, receiver := range []string{"invalid", "0x0000000000000000000000000000000000000000"} {
		if (modeOptions{Mode: "dev", Receiver: receiver}).validate() == nil {
			t.Fatal("invalid receiver accepted")
		}
	}
}
