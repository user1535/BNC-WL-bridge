import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Interface,zeroPadValue,toBeHex,keccak256,encodeRlp,id} from './vendor/ethers-6.15.0.min.mjs';
import {validatePackage,validateManifest,WalletClient,verifyReceiptProof} from './client.mjs';
import {BurnMintClient} from './burn-mint-client.mjs';
const read = name => JSON.parse(fs.readFileSync(new URL('./testdata/'+name,import.meta.url)));
const lock=read('lock-package.json'),burn=read('burn-package.json');
const policy=JSON.parse(fs.readFileSync(new URL('../configs/receipt-computation.json',import.meta.url)));
const m={version:1,mode:'dev',headerBinding:'minimal-link',chainAuthenticated:false,realAssetDeploymentAllowed:false,
 proofPolicy:'trusted-rpc-receipt-root',computationPolicy:'risc0-receipt-computation',
 computationProof:{...policy,verificationLocation:'server-risc0-sdk'},
 chains:{wl:{id:31337,rpc:'http://127.0.0.1:8565'},bnb:{id:31338,rpc:'http://127.0.0.1:8566'}},
 contracts:{"original": "0x5FbDB2315678afecb367f032d93F642f64180aa3", "wrapped": "0x5FbDB2315678afecb367f032d93F642f64180aa3", "mint": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", "unlock": "0x0165878A594ca255338adfa4d48449f69242Eb8F", "wl_headers": "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707", "bnb_headers": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"},
 runtimeCode:Object.fromEntries(['original','wrapped','mint','unlock','wl_headers','bnb_headers'].map(k=>[k,'0x6000']))};
// The HTTP transport is stubbed here; actual SDK receipt verification and rejection
// are exercised separately by check-receipt-computation.py and the browser tests.
const sdk={verifyComputation:async p=>({verified:true,imageId:p.computationProof.imageId,
 receiptSHA256:p.computationProof.receiptSHA256,journal:p.computationProof.journal,
 sourceAuthenticated:false,onchainVerified:false,verificationLocation:'server-risc0-sdk'})};
const h=new Interface(['function getReceiptRoot(uint256,uint256,bytes32) view returns(bytes32)']);
const r=new Interface(['function claimedTransfer(bytes32) view returns(bool)']);
const token=new Interface(['function balanceOf(address) view returns(uint256)','function availableBalanceOf(address) view returns(uint256)']);
class Provider {
  constructor(){this.chain='0x7a6a';this.account=lock.recipient;this.root=lock.receiptRoot;this.claimed=false;this.code='0x6000';this.events={};this.sent=0;this.requested=[];this.rpcError=false;this.gasBalance='0xde0b6b3a7640000';}
  on(event,callback){this.events[event]=callback;}
  async request({method,params}) {
    this.requested.push(method);
    if(method==='eth_chainId') return this.chain;
    if(method==='eth_accounts'||method==='eth_requestAccounts') return [this.account];
    if(method==='eth_getCode') return this.code;
    if(method==='eth_call') {
      const data=params[0].data;
      if(data.startsWith(h.getFunction('getReceiptRoot').selector)) {
        if(this.rpcError) throw new Error('transport failed');
        if(this.root===null) throw Object.assign(new Error('unknown'),{data:id('UnknownHeader()').slice(0,10)});
        return h.encodeFunctionResult('getReceiptRoot',[this.root]);
      }
      if(data.startsWith(r.getFunction('claimedTransfer').selector)) return r.encodeFunctionResult('claimedTransfer',[this.claimed]);
      for(const method of ['balanceOf','availableBalanceOf']) if(data.startsWith(token.getFunction(method).selector)) return token.encodeFunctionResult(method,[100n*10n**18n]);
      return '0x';
    }
    if(method==='eth_estimateGas') return '0xf4240';
    if(method==='eth_getBalance') return this.gasBalance;
    if(method==='eth_gasPrice') return '0x1';
    if(method==='eth_getTransactionCount') return '0x0';
    if(method==='eth_sendTransaction'){this.sent++;return '0x'+'12'.repeat(32);}
    throw new Error('unexpected '+method);
  }
}
test('actual receipt-computation lock/burn package MPT, event, ABI match',()=>{
  assert.equal(validatePackage(lock,m).amount,1000000000000000000n);
  assert.equal(validatePackage(burn,m).amount,1000000000000000000n);
});
test('reject tampered metadata, receipt, ABI, root, domain, destination and proof suffix',()=>{
  for(const mutate of [p=>p.amount='1',p=>p.recipient=m.contracts.original,p=>p.nonce=2,p=>p.sourceChainId=56,p=>p.receiptRoot='0x'+'44'.repeat(32),p=>p.claimTransaction.to=m.contracts.original,p=>p.claimTransaction.value='1',p=>p.calldata='0x1234',p=>p.receiptBytes='0x01',p=>p.proofNodes.push(p.proofNodes[0]),p=>p.computationProof.imageId='44'.repeat(32),p=>p.headerTransaction={data:'0x1234'},p=>p.txIndex=Number.MAX_SAFE_INTEGER+1]) {
    const p=structuredClone(lock);mutate(p);assert.throws(()=>validatePackage(p,m));
  }
  assert.throws(()=>validateManifest({...m,realAssetDeploymentAllowed:true}));
});
test('geth receipt core multi-node format fixtures and wrong key',()=>{
  const rows=JSON.parse(fs.readFileSync(new URL('../contracts/test/fixtures/receipt-core.json',import.meta.url)));
  for(const row of Object.values(rows)) {
    const value=verifyReceiptProof(row.root,BigInt(row.txIndex),row.proofNodes);
    assert.equal(value.toLowerCase(),row.receipt.toLowerCase());
    assert.throws(()=>verifyReceiptProof(row.root,BigInt(row.txIndex)+1n,row.proofNodes));
  }
});
test('MPT inline child, extension and branch shapes, canonical compact path',()=>{
  const leaf=['0x30','0x12'], branch=Array.from({length:17},()=> '0x');branch[8]=leaf;
  const raw=encodeRlp(branch),root=keccak256(raw);
  assert.equal(verifyReceiptProof(root,0n,[raw]),'0x12');
  const bad=encodeRlp(['0x2180','0x12']);assert.throws(()=>verifyReceiptProof(keccak256(bad),0n,[bad]));
});
test('captured native BNB type4 receipts verify against the full 121-receipt root',()=>{
  for(const index of [16,107]) {
    const row=JSON.parse(fs.readFileSync(new URL('../contracts/test/fixtures/native-type4-index'+index+'.json',import.meta.url)));
    assert.equal(row.receiptBytes.slice(0,4),'0x04');
    assert.equal(verifyReceiptProof(row.root,BigInt(row.txIndex),row.proofNodes).toLowerCase(),row.receiptBytes.toLowerCase());
    assert.throws(()=>verifyReceiptProof(row.root,BigInt(row.txIndex)+1n,row.proofNodes));
  }
});
test('wallet actual coverage preview and fresh validated send, saves intent before send',async()=>{
  const provider=new Provider(),client=new WalletClient(provider,m,sdk);
  const preview=await client.preview(lock);
  assert.equal(preview.headerRequired,false);assert.equal(provider.sent,0);
  const saved=[];await client.submit(preview,async row=>{assert.equal(provider.sent,saved.length?1:0);saved.push(row);});
  assert.equal(provider.sent,1);assert.equal(saved[0].status,'awaiting_wallet');assert.equal(saved[1].status,'submitted');
});
test('changed account, chain, code, replay, root and RPC errors block wallet send',async()=>{
  for(const mutate of [p=>p.account=m.contracts.original,p=>p.chain='0x38',p=>p.code='0x6001',p=>p.claimed=true,p=>p.root='0x'+'33'.repeat(32),p=>p.rpcError=true]) {
    const provider=new Provider(),client=new WalletClient(provider,m,sdk);mutate(provider);
    await assert.rejects(client.preview(lock));assert.equal(provider.sent,0);
  }
  const provider=new Provider(),client=new WalletClient(provider,m,sdk),preview=await client.preview(lock);
  provider.events.accountsChanged();await assert.rejects(client.submit(preview,async()=>{}));assert.equal(provider.sent,0);
});
test('unregistered roots and retired header operations never authorize wallet send',async()=>{
  const provider=new Provider(),client=new WalletClient(provider,m,sdk);provider.root=null;
  await assert.rejects(client.preview(lock,'claim'));
  await assert.rejects(client.preview(lock,'header'));
  provider.rpcError=true;await assert.rejects(client.preview(lock,'header'));assert.equal(provider.sent,0);
});
test('source action uses owner and available tokens, rejects insufficient gas or amount',async()=>{
  const provider=new Provider(),client=new WalletClient(provider,m,sdk);provider.chain='0x7a69';
  const action=await client.action('lock','25000000000000000000',lock.recipient);
  assert.equal(action.recipient,lock.recipient);assert.equal(action.chain,31337);
  await assert.rejects(client.action('lock','101000000000000000000',lock.recipient));
  provider.gasBalance='0x0';await assert.rejects(client.action('lock','1',lock.recipient));assert.equal(provider.sent,0);
});

test('1 WL deposit and native transfer send canonical JSON-RPC quantities',async()=>{
  const provider=new Provider();
  provider.chain='0x7a69';
  provider.gasBalance='0x1bc16d674ec80000';
  const baseRequest=provider.request.bind(provider);
  provider.request=async request=>{
    if(request.params?.[0]?.value) assert.equal(request.params[0].value,'0xde0b6b3a7640000');
    return baseRequest(request);
  };
  const vaultPolicy=JSON.parse(fs.readFileSync(new URL('../configs/vault-computation.json',import.meta.url)));
  const contracts={...m.contracts,mint:m.contracts.wrapped,unlock:m.contracts.original};
  const client=new BurnMintClient(provider,{...m,contracts,protocol:'native-wl-vault-v1',
    computationProof:{...vaultPolicy,verificationLocation:'server-risc0-sdk'}});
  const amount='1000000000000000000';
  const deposit=await client.action('lock-vault',amount,lock.recipient);
  await client.submitAction(deposit,async()=>{});
  const transfer=await client.nativeAction('nativeTransfer',amount,lock.recipient,m.contracts.original);
  await client.submitNativeAction(transfer,async()=>{});
  assert.equal(provider.sent,2);
});

test('missing computation proof or native-only/retired manifest is rejected',()=>{
 const p=structuredClone(lock);delete p.computationProof;assert.throws(()=>validatePackage(p,m));
 for(const policy of ['native-receipt-computation',undefined])assert.throws(()=>validateManifest({...m,computationPolicy:policy}));
 assert.throws(()=>validateManifest({...m,mode:'risc0_batch'}));
});
