#![no_main]
risc0_zkvm::guest::entry!(main);
fn main(){let input:bridge_receipt_core::Input=risc0_zkvm::guest::env::read();let journal=bridge_receipt_core::verify(&input).expect("invalid receipt computation");risc0_zkvm::guest::env::commit(&journal);}
