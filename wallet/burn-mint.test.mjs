import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Interface,toBeHex,keccak256} from './vendor/ethers-6.15.0.min.mjs';
import {validatePackage,WalletClient} from './client.mjs';
import {BurnMintClient} from './burn-mint-client.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const forward=read('./testdata/burn-wl-v2-package.json'),reverse=read('./testdata/burn-bsc-v2-package.json');
const policy=read('../configs/burn-mint-computation.json');
const manifest={version:1,protocol:'burn-mint-v2',mode:'dev',headerBinding:'minimal-link',chainAuthenticated:false,realAssetDeploymentAllowed:false,
  proofPolicy:'trusted-rpc-receipt-root',computationPolicy:'risc0-receipt-computation',computationProof:{...policy,verificationLocation:'server-risc0-sdk'},
  chains:{wl:{id:31337,rpc:'http://127.0.0.1:8575'},bnb:{id:31338,rpc:'http://127.0.0.1:8576'}},
  contracts:{original:forward.sourceToken,wrapped:forward.destinationToken,mint:forward.claimTransaction.to,unlock:reverse.claimTransaction.to,
    wl_headers:'0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',bnb_headers:'0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'},
  runtimeCode:Object.fromEntries(['original','wrapped','mint','unlock','wl_headers','bnb_headers'].map(k=>[k,'0x6000']))};
const sdk={verifyComputation:async p=>({verified:true,imageId:p.computationProof.imageId,receiptSHA256:p.computationProof.receiptSHA256,journal:p.computationProof.journal,
  sourceAuthenticated:false,onchainVerified:false,verificationLocation:'server-risc0-sdk'})};
const abi=new Interface(['function claimedBurn(bytes32) view returns(bool)','function getReceiptRoot(uint256,uint256,bytes32) view returns(bytes32)',
  'function balanceOf(address) view returns(uint256)','function bridgeBurn(uint256,address,uint256)','function transfer(address,uint256)','function approve(address,uint256)','function transferFrom(address,address,uint256)']);
class Provider {
  constructor(p){this.chain=toBeHex(p.destinationChainId);this.account=p.recipient;this.root=p.receiptRoot;this.claimed=false;this.sent=0;this.callbacks={};}
  on(event,callback){this.callbacks[event]=callback;}
  async request({method,params}) {
    if(method==='eth_chainId')return this.chain;
    if(['eth_accounts','eth_requestAccounts'].includes(method))return [this.account];
    if(method==='eth_getCode')return '0x6000';
    if(method==='eth_call') {
      const data=params[0].data;
      if(data.startsWith(abi.getFunction('claimedBurn').selector))return abi.encodeFunctionResult('claimedBurn',[this.claimed]);
      if(data.startsWith(abi.getFunction('getReceiptRoot').selector))return abi.encodeFunctionResult('getReceiptRoot',[this.root]);
      if(data.startsWith(abi.getFunction('balanceOf').selector))return abi.encodeFunctionResult('balanceOf',[100n*10n**18n]);
      return '0x';
    }
    if(method==='eth_estimateGas')return '0x100000';
    if(method==='eth_getBalance')return '0xde0b6b3a7640000';
    if(method==='eth_gasPrice')return '0x1';
    if(method==='eth_getTransactionCount')return '0x0';
    if(method==='eth_sendTransaction'){this.sent++;this.transaction=params[0];return '0x'+'12'.repeat(32);}
    throw Error('unexpected '+method);
  }
}
test('V2 captured MPT/domain vectors permit holder C burn to recipient B',()=>{
  assert.notEqual(reverse.sender.toLowerCase(),reverse.recipient.toLowerCase());
  for(const p of [forward,reverse]){assert.equal(validatePackage(p,manifest).owner,p.recipient);assert.equal(p.computationProof.journal.version,2);}
});
test('V2 rejects altered event metadata even with a recomputed input commitment',()=>{
  const fields=['action','sourceChainId','destinationChainId','sourceToken','destinationToken','sender','recipient','amount','nonce','transferId','blockNumber','blockHash','receiptRoot','txIndex','logIndex','receiptBytes','proofNodes'];
  for(const p of [forward,reverse])for(const mutate of [p=>p.recipient=manifest.contracts.original,p=>p.amount='1',p=>p.nonce=0,p=>p.action=p.action==='burn-wl'?'burn-bsc':'burn-wl',p=>p.sourceChainId=56,p=>p.destinationToken=reverse.sender]) {
    const copy=structuredClone(p);mutate(copy);const journal=copy.computationProof.journal;
    for(const key of ['action','sourceChainId','destinationChainId','sourceToken','destinationToken','recipient','amount','transferId'])journal[key]=copy[key];
    journal.inputDigest=keccak256(new TextEncoder().encode(JSON.stringify(Object.fromEntries(fields.map(k=>[k,copy[k]])))));
    assert.throws(()=>validatePackage(copy,manifest));
  }
});
test('V1/V2 packages and pinned guest policies cannot be exchanged',()=>{
  const old=read('./testdata/lock-package.json');assert.throws(()=>validatePackage(old,manifest));
  assert.throws(()=>validatePackage(forward,{...manifest,protocol:'lock-mint-v1'}));
  assert.throws(()=>validatePackage({...forward,version:1},manifest));
  const copy=structuredClone(forward);copy.computationProof.imageId=old.computationProof.imageId;assert.throws(()=>validatePackage(copy,manifest));
});
test('V2 claim uses designated recipient and blocks replay/account changes before signing',async()=>{
  const provider=new Provider(reverse),client=new WalletClient(provider,manifest,sdk);
  const preview=await client.preview(reverse);assert.equal(preview.owner,reverse.recipient);assert.equal(provider.sent,0);
  provider.claimed=true;await assert.rejects(()=>client.submit(preview,async()=>{}),/already accepted/);assert.equal(provider.sent,0);
  provider.claimed=false;provider.account=reverse.sender;await assert.rejects(()=>client.submit(preview,async()=>{}),/account mismatch/);assert.equal(provider.sent,0);
});
test('V2 fresh burn preview preserves a different recipient and persists before send',async()=>{
  const provider=new Provider(reverse);provider.chain=toBeHex(31338);provider.account=reverse.sender;
  const client=new WalletClient(provider,manifest,sdk),preview=await client.action('burn-bsc','4000000000000000000',reverse.sender,reverse.recipient);
  assert.equal(preview.recipient,reverse.recipient);const rows=[];
  await client.submitAction(preview,async row=>{if(!rows.length)assert.equal(provider.sent,0);rows.push(row);});
  assert.equal(abi.decodeFunctionData('bridgeBurn',provider.transaction.data)[1].toLowerCase(),reverse.recipient.toLowerCase());
  assert.equal(rows[0].status,'awaiting_wallet');assert.equal(rows[1].status,'submitted');
});
test('ERC20 delegated transfer preview binds holder, recipient, amount and signer',async()=>{
  const provider=new Provider(reverse);provider.chain=toBeHex(31338);provider.account=reverse.sender;
  const client=new BurnMintClient(provider,manifest),preview=await client.tokenAction('transferFrom','7',reverse.sender,reverse.recipient,31338,forward.sender);
  const args=abi.decodeFunctionData('transferFrom',preview.transaction.data);assert.equal(args[0].toLowerCase(),forward.sender.toLowerCase());assert.equal(args[1].toLowerCase(),reverse.recipient.toLowerCase());assert.equal(args[2],7n);
  provider.account=forward.sender;await assert.rejects(()=>client.submitTokenAction(preview,async()=>{}),/account mismatch/);assert.equal(provider.sent,0);
});
