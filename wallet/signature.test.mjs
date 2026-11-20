import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,AbiCoder,TypedDataEncoder,keccak256,id} from './vendor/ethers-6.15.0.min.mjs';
import {CLAIM_FIELDS,CLAIM_TYPES,abi,validateManifest,verifyPackage,SignedClient} from './signature-client.mjs';
const source='0x0000000000000000000000000000000000000011',dest='0x0000000000000000000000000000000000000022';
const sender='0x0000000000000000000000000000000000000033',recipient='0x0000000000000000000000000000000000000044';
async function fixture(t){
 const wallet=new Wallet('0x'+'71'.repeat(32));
 const manifest={version:1,protocol:'signed-xwl-bridge-v1',signer:wallet.address,confirmations:2,contracts:{xwl:source,wwl:dest},runtimeCode:{xwl:'0x6000',wwl:'0x6000'},chains:{wl:{id:31337,rpc:'http://127.0.0.1:8593'},bnb:{id:31338,rpc:'http://127.0.0.1:8594'}}};
 const message={sourceChainId:31337,sourceToken:source,sender,recipient,amount:'10',nonce:'1',sourceTxHash:'0x'+'ab'.repeat(32),sourceBlockHash:'0x'+'cd'.repeat(32),sourceBlockNumber:'10',logIndex:'1',deadline:'200'};
 message.burnId=keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32','uint256','address','uint256','address','address','address','uint256','uint64'],[id('BNC_SIGNED_BRIDGE_BURN_V1'),31337,source,31338,dest,sender,recipient,10,1]));
 const domain={name:'BNC Signed Bridge',version:'1',chainId:31338,verifyingContract:dest};
 const signature=await wallet.signTypedData(domain,CLAIM_TYPES,message);
 const pkg={version:1,protocol:manifest.protocol,source:'wl',destination:'bnb',domain,types:CLAIM_TYPES,message,signature,signer:wallet.address,digest:TypedDataEncoder.hash(domain,CLAIM_TYPES,message),claimData:abi.encodeFunctionData('claim',[CLAIM_FIELDS.map(([k])=>message[k]),signature])};
 const event=abi.encodeEventLog(abi.getEvent('BridgeBurned'),[message.burnId,sender,recipient,10,1,31338,dest]);
 const receipt={status:'0x1',transactionHash:message.sourceTxHash,blockHash:message.sourceBlockHash,blockNumber:'0xa',logs:[{...event,address:source,logIndex:'0x1',blockHash:message.sourceBlockHash,transactionHash:message.sourceTxHash}]};
 const state={receipt,used:false,canonical:message.sourceBlockHash,tip:'0xc',time:'0x64'};
 const before=globalThis.fetch;t.after(()=>{globalThis.fetch=before;});
 globalThis.fetch=async(url,options)=>{const {method,params}=JSON.parse(options.body);let result;
  if(method==='eth_getTransactionReceipt')result=state.receipt;
  else if(method==='eth_blockNumber')result=state.tip;
  else if(method==='eth_getBlockByNumber')result=params[0]==='latest'?{timestamp:state.time}:{hash:state.canonical};
  else if(method==='eth_call')result=abi.encodeFunctionResult('claimedBurn',[state.used]);
  else throw Error(method);
  return {ok:true,json:async()=>({result})};};
 return {manifest,pkg,state};
}
test('public package signature, event and destination calldata agree',async t=>{const f=await fixture(t);const result=await verifyPackage(f.manifest,f.pkg);assert.equal(result.token,dest);assert.equal(result.data,f.pkg.claimData);});
test('tampering recipient, amount, source, destination, signature and calldata fails',async t=>{
 const {manifest,pkg}=await fixture(t);
 for(const change of [p=>p.message.recipient=sender,p=>p.message.amount='11',p=>p.message.sourceTxHash='0x'+'aa'.repeat(32),p=>p.message.sourceBlockNumber='11',p=>p.domain.chainId=31337,p=>p.domain.verifyingContract=source,p=>p.signature='0x'+'00'.repeat(65),p=>p.claimData+='00',p=>p.types.BridgeClaim[0].type='uint256',p=>p.message.extra=1]){
  const copy=structuredClone(pkg);change(copy);await assert.rejects(verifyPackage(manifest,copy));
 }
});
test('reorg, insufficient confirmations, failed source and non-burn logs fail',async t=>{
 const {manifest,pkg,state}=await fixture(t);
 state.canonical='0x'+'ee'.repeat(32);await assert.rejects(verifyPackage(manifest,pkg));state.canonical=pkg.message.sourceBlockHash;
 state.tip='0xb';await assert.rejects(verifyPackage(manifest,pkg));state.tip='0xc';
 state.receipt.status='0x0';await assert.rejects(verifyPackage(manifest,pkg));state.receipt.status='0x1';
 const event=abi.encodeEventLog(abi.getEvent('Redeemed'),[sender,recipient,10]);Object.assign(state.receipt.logs[0],event);await assert.rejects(verifyPackage(manifest,pkg));
});
test('expired and already claimed packages fail',async t=>{const {manifest,pkg,state}=await fixture(t);state.used=true;await assert.rejects(verifyPackage(manifest,pkg));state.used=false;state.time='0xc9';await assert.rejects(verifyPackage(manifest,pkg));});
test('manifest rejects external chain and RPC endpoints',async t=>{const {manifest}=await fixture(t);for(const change of [m=>m.chains.wl.id=103,m=>m.chains.wl.rpc='https://example.com',m=>m.confirmations=0,m=>m.signer='0x'+'0'.repeat(40)]){const m=structuredClone(manifest);change(m);assert.throws(()=>validateManifest(m));}});
test('review invalidates on wallet account/chain change before signing',async t=>{
 const {manifest}=await fixture(t);let listener;
 const provider={on:(event,fn)=>{listener=fn;},request:async()=>{throw Error('must not request wallet');}};
 const client=new SignedClient(manifest,provider);client.owner=sender;
 const preview={epoch:client.epoch,owner:sender};listener();await assert.rejects(client.send(preview,()=>{}),/바뀌었습니다/);
});
