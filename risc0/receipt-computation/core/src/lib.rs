use serde::{Deserialize,Serialize};
use tiny_keccak::{Hasher,Keccak};
pub type Result<T> = std::result::Result<T,String>;
#[derive(Deserialize,Serialize,Clone)]
#[serde(rename_all="camelCase")]
pub struct Input {
 pub action:String,pub source_chain_id:u64,pub destination_chain_id:u64,
 pub source_token:String,pub destination_token:String,pub sender:String,pub recipient:String,
 pub amount:String,pub nonce:u64,pub transfer_id:String,pub block_number:u64,pub block_hash:String,
 pub receipt_root:String,pub tx_index:u64,pub log_index:usize,pub receipt_bytes:String,pub proof_nodes:Vec<String>,
}
#[derive(Deserialize,Serialize,Debug,PartialEq)]
#[serde(rename_all="camelCase")]
pub struct Journal {
 pub version:u32,pub statement:String,pub input_digest:String,pub action:String,
 pub source_chain_id:u64,pub destination_chain_id:u64,pub source_token:String,pub destination_token:String,
 pub recipient:String,pub amount:String,pub transfer_id:String,pub block_number:u64,pub block_hash:String,pub receipt_root:String,
 pub source_authenticated:bool,
}
fn check(ok:bool,msg:&str)->Result<()> {if ok {Ok(())} else {Err(msg.into())}}
pub fn keccak(data:&[u8])->Vec<u8>{let mut out=[0u8;32];let mut h=Keccak::v256();h.update(data);h.finalize(&mut out);out.to_vec()}
pub fn hex(data:&[u8])->String{format!("0x{}",data.iter().map(|x|format!("{x:02x}")).collect::<String>())}
fn bytes(s:&str)->Result<Vec<u8>>{let s=s.strip_prefix("0x").ok_or("missing hex prefix")?;check(s.is_ascii()&&s.len()%2==0,"invalid hex length/encoding")?;(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).map_err(|_|"bad hex".into())).collect()}
#[derive(Clone)]struct Rlp<'a>{list:bool,payload:&'a[u8],raw:&'a[u8]}
fn item(data:&[u8])->Result<(Rlp<'_>,usize)>{
 let p=*data.first().ok_or("empty RLP")?;
 if p<0x80{return Ok((Rlp{list:false,payload:&data[..1],raw:&data[..1]},1))}
 let list=p>=0xc0;let code=(p-if list{0xc0}else{0x80}) as usize;
 let (offset,len)=if code<=55{(1,code)}else{let n=code-55;let raw=data.get(1..1+n).ok_or("RLP length")?;check(raw[0]!=0,"noncanonical RLP length")?;let mut len=0usize;for b in raw{len=len.checked_mul(256).and_then(|v|v.checked_add(*b as usize)).ok_or("RLP overflow")?;}check(len>=56,"noncanonical long RLP")?;(1+n,len)};
 let end=offset.checked_add(len).ok_or("RLP overflow")?;let raw=data.get(..end).ok_or("truncated RLP")?;let payload=&raw[offset..];check(list||len!=1||payload[0]>=0x80,"noncanonical short RLP")?;
 Ok((Rlp{list,payload,raw},end))
}
fn list(data:&[u8])->Result<Vec<Rlp<'_>>>{let (root,n)=item(data)?;check(root.list&&n==data.len(),"expected exact RLP list")?;let mut rest=root.payload;let mut out=Vec::new();while !rest.is_empty(){let (v,n)=item(rest)?;out.push(v);rest=&rest[n..];}Ok(out)}
fn nibbles(data:&[u8])->Vec<u8>{data.iter().flat_map(|x|[x>>4,x&15]).collect()}
fn key(index:u64)->Vec<u8>{if index==0{return vec![0x80]}let raw=index.to_be_bytes();let raw=&raw[raw.iter().position(|x|*x!=0).unwrap()..];if raw.len()==1&&raw[0]<128{return raw.to_vec()}let mut v=vec![0x80+raw.len() as u8];v.extend(raw);v}
fn reference(v:&Rlp<'_>)->Result<Vec<u8>>{if v.list{check(v.raw.len()<32,"oversized inline node")?;Ok(v.raw.to_vec())}else{check(v.payload.len()==32,"invalid child reference")?;Ok(v.payload.to_vec())}}
fn receipt(i:&Input)->Result<Vec<u8>>{
 check(!i.proof_nodes.is_empty()&&i.proof_nodes.len()<=128,"proof node bounds")?;
 let mut expected=bytes(&i.receipt_root)?;check(expected.len()==32,"root size")?;let path=nibbles(&key(i.tx_index));let mut pos=0;
 for (number,text) in i.proof_nodes.iter().enumerate(){
  let node=bytes(text)?;check(node.len()<=65536,"node size")?;
  check(if expected.len()==32{keccak(&node)==expected}else{node==expected},"MPT node reference mismatch")?;
  let fields=list(&node)?;
  let value=if fields.len()==17{
   if pos==path.len(){check(!fields[16].list,"branch value list")?;Some(fields[16].payload.to_vec())}else{expected=reference(&fields[path[pos] as usize])?;pos+=1;None}
  }else{
   check(fields.len()==2&&!fields[0].list,"MPT node shape")?;let compact=nibbles(fields[0].payload);check(!compact.is_empty()&&compact[0]<=3,"compact path flag")?;
   let odd=compact[0]&1==1;let leaf=compact[0]&2==2;check(odd||(compact.len()>1&&compact[1]==0),"compact padding")?;
   let suffix=&compact[if odd{1}else{2}..];check(leaf||!suffix.is_empty(),"empty extension")?;check(path.get(pos..pos+suffix.len())==Some(suffix),"MPT path mismatch")?;pos+=suffix.len();
   if leaf{check(pos==path.len()&&!fields[1].list,"leaf termination")?;Some(fields[1].payload.to_vec())}else{expected=reference(&fields[1])?;None}
  };
  if let Some(value)=value{check(number+1==i.proof_nodes.len(),"unused proof nodes")?;return Ok(value)}
 }
 Err("incomplete MPT proof".into())
}
fn word(n:u64)->Vec<u8>{let mut v=vec![0;24];v.extend(n.to_be_bytes());v}
fn address(s:&str)->Result<Vec<u8>>{let raw=bytes(s)?;check(raw.len()==20,"address length")?;let mut v=vec![0;12];v.extend(raw);Ok(v)}
fn decimal(s:&str)->Result<Vec<u8>>{check(!s.is_empty()&&s.bytes().all(|x|x.is_ascii_digit()),"invalid decimal")?;let mut out=vec![0u8;32];for digit in s.bytes(){let mut carry=(digit-b'0')as u16;for v in out.iter_mut().rev(){let n=*v as u16*10+carry;*v=n as u8;carry=n>>8;}check(carry==0,"uint256 overflow")?;}Ok(out)}
pub fn verify(i:&Input)->Result<Journal>{
 let v2=i.action=="burn-wl"||i.action=="burn-bsc";
 let vault_lock=cfg!(feature="vault")&&i.action=="lock-vault";
 let vault= vault_lock||(cfg!(feature="vault")&&i.action=="burn-vault");
 let testnet=cfg!(feature="vault-testnet");
 if testnet {check(vault,"testnet Vault action required")?;}
 check(i.action=="lock"||i.action=="burn"||v2||vault,"action")?;
 if v2||vault {
  let forward=i.action=="burn-wl"||vault_lock;
  let (wl,bsc)=if testnet{(10359,97)}else{(31337,31338)};
  let (source,destination)=if forward{(wl,bsc)}else{(bsc,wl)};
  check((i.source_chain_id,i.destination_chain_id)==(source,destination),"local chain domain")?;
  check(i.nonce>0,"zero nonce")?;
 }
 check(i.source_chain_id!=i.destination_chain_id,"same chain")?;
 check(bytes(&i.block_hash)?.len()==32,"block hash size")?;
 check(v2||vault||i.sender.eq_ignore_ascii_case(&i.recipient),"same owner required")?;let sender=address(&i.sender)?;check(sender.iter().any(|x|*x!=0),"zero sender")?;let owner=address(&i.recipient)?;check(owner.iter().any(|x|*x!=0),"zero owner")?;
 let raw=receipt(i)?;check(raw==bytes(&i.receipt_bytes)?,"receipt bytes mismatch")?;
 let receipt=if raw.first().is_some_and(|x|*x<0x80){check(matches!(raw[0],1|2|3|4),"unsupported receipt type")?;&raw[1..]}else{&raw[..]};
 let fields=list(receipt)?;check(fields.len()==4&&!fields[0].list&&fields[0].payload==[1],"successful receipt required")?;check(!fields[1].list&&fields[1].payload.first()!=Some(&0),"receipt gas integer")?;check(!fields[2].list&&fields[2].payload.len()==256,"receipt bloom")?;
 let logs=list(fields[3].raw)?;let log=list(logs.get(i.log_index).ok_or("log index")?.raw)?;check(log.len()==3&&!log[0].list&&log[0].payload==bytes(&i.source_token)?,"event emitter")?;
 let topics=list(log[1].raw)?;check(topics.len()==4&&topics.iter().all(|x|!x.list&&x.payload.len()==32),"event topics")?;
 let lock=i.action=="lock";
 let signature=if vault_lock{"VaultLocked(bytes32,address,address,uint256,uint64,uint256)"}
 else if vault{"VaultBurned(bytes32,address,address,uint256,uint64,uint256)"}
 else if v2{"BridgeBurned(bytes32,address,address,uint256,uint64,uint256)"}
 else if lock{"Locked(bytes32,address,address,uint256,uint64,uint256)"}
 else{"Burned(bytes32,address,address,uint256,uint64,uint256)"};
 check(topics[0].payload==keccak(signature.as_bytes()),"event signature")?;
 let transfer=bytes(&i.transfer_id)?;check(transfer.len()==32&&topics[1].payload==transfer,"event id")?;check(topics[2].payload==sender&&topics[3].payload==owner,"event recipient")?;
 let amount=decimal(&i.amount)?;check(amount.iter().any(|x|*x!=0),"zero amount")?;let mut data=amount.clone();data.extend(word(i.nonce));data.extend(word(i.destination_chain_id));check(!log[2].list&&log[2].payload==data,"event amount/nonce/destination")?;
 let mut domain=keccak(if vault{b"WORLDLAND_BNB_NATIVE_VAULT_V1"}else if v2{b"WORLDLAND_BNB_BURN_MINT_V2"}else if lock{b"WORLDLAND_BNB_BRIDGE_LOCK_V2"}else{b"WORLDLAND_BNB_BRIDGE_BURN_V1"});domain.extend(word(i.source_chain_id));domain.extend(address(&i.source_token)?);
 if !lock{domain.extend(word(i.destination_chain_id))}domain.extend(address(&i.destination_token)?);domain.extend(sender);domain.extend(owner);domain.extend(amount);domain.extend(word(i.nonce));if !v2&&!vault{domain.extend(word(i.destination_chain_id))}check(keccak(&domain)==transfer,"transfer domain binding")?;
 Ok(Journal{version:if testnet{4}else if vault{3}else if v2{2}else{1},statement:"trusted-input-receipt-computation".into(),input_digest:hex(&keccak(&serde_json::to_vec(i).map_err(|x|x.to_string())?)),action:i.action.clone(),source_chain_id:i.source_chain_id,destination_chain_id:i.destination_chain_id,source_token:i.source_token.to_lowercase(),destination_token:i.destination_token.to_lowercase(),recipient:i.recipient.to_lowercase(),amount:i.amount.clone(),transfer_id:i.transfer_id.to_lowercase(),block_number:i.block_number,block_hash:i.block_hash.to_lowercase(),receipt_root:i.receipt_root.to_lowercase(),source_authenticated:false})
}
#[cfg(all(test, not(feature="vault-testnet")))]mod tests {
 use super::*;
 #[test]fn captured_v2_domains_and_mutations(){
  let vectors:serde_json::Value=serde_json::from_str(include_str!("../../../../configs/burn-mint-vectors.json")).unwrap();
  for value in vectors["inputs"].as_array().unwrap(){
   let input:Input=serde_json::from_value(value.clone()).unwrap();
   let journal=verify(&input).unwrap();assert_eq!(journal.version,2);assert!(!journal.source_authenticated);
   for field in ["action","sourceChainId","destinationChainId","sourceToken","destinationToken","sender","recipient","amount","nonce","transferId"]{
    let mut v=value.clone();v[field]=match field{
     "action"=>serde_json::json!("burn"),"sourceChainId"|"destinationChainId"=>serde_json::json!(56),"nonce"=>serde_json::json!(0),"amount"=>serde_json::json!("1"),"transferId"=>serde_json::json!(format!("0x{}","00".repeat(32))),_=>serde_json::json!("0x000000000000000000000000000000000000dead")};
    assert!(verify(&serde_json::from_value(v).unwrap()).is_err(),"{field}");
   }
  }
 }
 fn fixture()->Input{serde_json::from_str(include_str!("../fixture.json")).unwrap()}
 #[test]fn valid(){assert!(!verify(&fixture()).unwrap().source_authenticated);}
 #[test]fn valid_burn(){let i:Input=serde_json::from_str(include_str!("../fixture-burn.json")).unwrap();assert_eq!(verify(&i).unwrap().action,"burn");}
 #[test]fn mutations(){for field in ["receiptRoot","amount","recipient","destinationChainId","transferId","receiptBytes"]{let mut v=serde_json::to_value(fixture()).unwrap();v[field]=match field{"destinationChainId"=>serde_json::json!(999),"amount"=>serde_json::json!("1"),"recipient"=>serde_json::json!("0x0000000000000000000000000000000000000001"),"receiptBytes"=>serde_json::json!("0x01"),_=>serde_json::json!(format!("0x{}","00".repeat(32)))};assert!(verify(&serde_json::from_value(v).unwrap()).is_err(),"{field}");}}
 #[test]fn proof_and_nonce(){let mut v=fixture();v.proof_nodes.push(v.proof_nodes[0].clone());assert!(verify(&v).is_err());let mut v=fixture();v.nonce+=1;assert!(verify(&v).is_err());}
}
