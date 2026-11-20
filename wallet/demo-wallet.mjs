import {HDNodeWallet,id} from './vendor/ethers-6.15.0.min.mjs';
const entrySelector=id('enter(address)').slice(0,10);
const lockSelector=id('lock(address)').slice(0,10);
const depositSelector=id('deposit(address)').slice(0,10);
// Public Anvil fixture, never a personal wallet. Kept in browser memory only.
export class DemoWallet {
 constructor(manifest,index=1){
  if(!Number.isInteger(index)||index<1||index>3)throw Error('테스트 계정 범위 불일치');
  if(!['localhost','127.0.0.1'].includes(location.hostname)||manifest.publicOrigin)throw Error('데모 지갑은 로컬 화면에서만 사용할 수 있습니다.');
  this.wallet=HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,`m/44'/60'/0'/0/${index}`);
  if(!manifest.users.some(x=>x.toLowerCase()===this.wallet.address.toLowerCase()))throw Error('이 세션에는 기본 Anvil 테스트 계정이 없습니다.');
  this.chain=31337;this.listeners={};this.allowed=new Set(Object.values(manifest.contracts).filter(x=>typeof x==='string').map(x=>x.toLowerCase()));
  this.entryToken=manifest.assetProfile==='xwl-entry-v1'?manifest.contracts.original.toLowerCase():null;
  this.vault=manifest.protocol==='native-wl-vault-v1'?manifest.contracts.original.toLowerCase():null;
  this.signedVault=manifest.protocol==='signed-xwl-bridge-v1'?manifest.contracts.xwl.toLowerCase():null;
 }
 on(event,fn){(this.listeners[event]??=[]).push(fn);}
 async rpc(method,params=[]){
  const response=await fetch('/rpc/'+(this.chain===31337?'wl':'bnb'),{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok||data.error)throw Error(data.error?.message||data.error||'로컬 RPC 오류');return data.result;
 }
 async request({method,params=[]}){
  if(['eth_accounts','eth_requestAccounts'].includes(method))return [this.wallet.address];
  if(method==='wallet_switchEthereumChain'){
   const chain=Number(BigInt(params[0].chainId));if(![31337,31338].includes(chain))throw Error('로컬 체인만 허용됩니다.');
   this.chain=chain;for(const fn of this.listeners.chainChanged||[])fn(params[0].chainId);return null;
  }
  if(method==='eth_sendTransaction'){
   const t=params[0],to=t.to.toLowerCase(),value=BigInt(t.value||0);
   const tokenCall=value===0n&&this.allowed.has(to);
   const nativeCall=(this.entryToken||this.vault||this.signedVault)&&this.chain===31337&&value>0n&&(
     t.data==='0x'&&/^0x[0-9a-f]{40}$/.test(to)&&!/^0x0{40}$/.test(to)
     || to===this.entryToken&&t.data.startsWith(entrySelector)&&t.data.length===74
     || to===this.vault&&t.data.startsWith(lockSelector)&&t.data.length===74
     || to===this.signedVault&&t.data.startsWith(depositSelector)&&t.data.length===74);
   if(Number(BigInt(t.chainId))!==this.chain||t.from.toLowerCase()!==this.wallet.address.toLowerCase()||!(tokenCall||nativeCall))throw Error('데모 거래 범위 불일치');
   if(!window.confirm('로컬 테스트 거래를 승인할까요?\n체인: '+this.chain+'\n대상: '+t.to+'\n공개 테스트 계정만 사용합니다.')){const e=Error('거래 승인 거절');e.code=4001;throw e;}
   if(Number(BigInt(await this.rpc('eth_chainId')))!==this.chain)throw Error('RPC 체인 ID 불일치');
   const raw=await this.wallet.signTransaction({to:t.to,data:t.data,value,chainId:this.chain,nonce:Number(BigInt(t.nonce)),gasLimit:BigInt(t.gas),gasPrice:BigInt(await this.rpc('eth_gasPrice')),type:0});
   return this.rpc('eth_sendRawTransaction',[raw]);
  }
  return this.rpc(method,params);
 }
}
