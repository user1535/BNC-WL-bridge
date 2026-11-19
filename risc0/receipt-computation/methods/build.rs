fn main() {
    let feature = if cfg!(feature = "vault-testnet") {
        Some("vault-testnet")
    } else if cfg!(feature = "vault") {
        Some("vault")
    } else {
        None
    };
    if let Some(feature) = feature {
        let options = risc0_build::GuestOptionsBuilder::default()
            .features(vec![feature.into()])
            .build()
            .expect("vault guest options");
        risc0_build::embed_methods_with_options([("bridge-receipt-guest", options)].into());
    } else {
        risc0_build::embed_methods();
    }
}
