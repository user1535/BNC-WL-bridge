use bridge_receipt_methods::{BRIDGE_RECEIPT_GUEST_ELF,BRIDGE_RECEIPT_GUEST_ID};
use risc0_zkvm::{ExecutorEnv,ProverOpts,InnerReceipt};
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args:Vec<_>=std::env::args().collect();if args.len()!=4{return Err("usage: host execute|prove|verify input.json output-directory".into())}
 if std::env::var("RISC0_DEV_MODE").is_ok_and(|v|v!="0"){return Err("dev mode forbidden".into())}
 let path=std::path::Path::new(&args[2]);if path.metadata()?.len()>16*1024*1024{return Err("input oversized".into())}
 let input:bridge_receipt_core::Input=serde_json::from_slice(&std::fs::read(path)?)?;
 let expected=bridge_receipt_core::verify(&input)?;
 let env=ExecutorEnv::builder().segment_limit_po2(19).write(&input)?.build()?;
 let started=std::time::Instant::now();let mut bytes=0;
 let journal:bridge_receipt_core::Journal;
 let output=std::path::Path::new(&args[3]);std::fs::create_dir_all(output)?;
 if args[1]=="verify"{let receipt:risc0_zkvm::Receipt=bincode::deserialize(&std::fs::read(output.join("receipt.bin"))?)?;if !matches!(receipt.inner,InnerReceipt::Composite(_)){return Err("real composite receipt required".into())}receipt.verify(BRIDGE_RECEIPT_GUEST_ID)?;journal=receipt.journal.decode()?;bytes=std::fs::metadata(output.join("receipt.bin"))?.len() as usize;}
 else if args[1]=="execute"{let execution=risc0_zkvm::default_executor().execute(env,BRIDGE_RECEIPT_GUEST_ELF)?;journal=execution.journal.decode()?;}
 else if args[1]=="prove"{
  let proof=risc0_zkvm::default_prover().prove_with_opts(env,BRIDGE_RECEIPT_GUEST_ELF,&ProverOpts::composite())?;
  if !matches!(proof.receipt.inner,InnerReceipt::Composite(_)){return Err("real composite receipt required".into())}
  proof.receipt.verify(BRIDGE_RECEIPT_GUEST_ID)?;
  journal=proof.receipt.journal.decode()?;
  if journal!=expected{return Err("guest journal mismatch".into())}
  let encoded=bincode::serialize(&proof.receipt)?;
  bytes=encoded.len();
  if bytes>64*1024*1024{return Err("receipt cap exceeded".into())}
  let temporary=output.join("receipt.bin.tmp");
  std::fs::write(&temporary,encoded)?;
  std::fs::rename(temporary,output.join("receipt.bin"))?;
 }
 else{return Err("invalid operation".into())}
 if journal!=expected{return Err("guest journal mismatch".into())}
 std::fs::write(output.join("summary.json"),serde_json::to_vec_pretty(&serde_json::json!({"mode":args[1],"imageId":risc0_zkvm::sha::Digest::from(BRIDGE_RECEIPT_GUEST_ID).to_string(),"journal":journal,"sdkVerified":args[1]!="execute","elapsedSeconds":started.elapsed().as_secs_f64(),"receiptBytes":bytes,"sourceAuthenticated":false,"onchainVerified":false}))?)?;
 println!("{} PASS",args[1]);Ok(())
}
