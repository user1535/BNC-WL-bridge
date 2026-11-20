import {Interface, AbiCoder, TypedDataEncoder, verifyTypedData, keccak256, id, toQuantity} from './vendor/ethers-6.15.0.min.mjs';
export const CLAIM_FIELDS=[['burnId','bytes32'],['sourceChainId','uint256'],['sourceToken','address'],['sender','address'],['recipient','address'],['amount','uint256'],['nonce','uint64'],['sourceTxHash','bytes32'],['sourceBlockHash','bytes32'],['sourceBlockNumber','uint256'],['logIndex','uint256'],['deadline','uint256']];
export const CLAIM_TYPES={BridgeClaim:CLAIM_FIELDS.map(([name,type])=>({name,type}))};
const tuple='(bytes32,uint256,address,address,address,uint256,uint64,bytes32,bytes32,uint256,uint256,uint256)';
export const abi=new Interface([
 'function deposit(address) payable','function redeem(uint256,address)','function bridgeBurn(uint256,address)',
 'function claim('+tuple+',bytes)','function claimedBurn(bytes32) view returns(bool)',
 'function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)',
 'function totalDeposited() view returns(uint256)','function totalRedeemed() view returns(uint256)',
 'function transfer(address,uint256)','function approve(address,uint256)','function transferFrom(address,address,uint256)',
 'event Deposited(address indexed sender,address indexed recipient,uint256 amount)',
 'event Redeemed(address indexed sender,address indexed recipient,uint256 amount)',
 'event BridgeBurned(bytes32 indexed burnId,address indexed sender,address indexed recipient,uint256 amount,uint64 nonce,uint256 destinationChainId,address destinationToken)',
 'event BridgeClaimed(bytes32 indexed burnId,address indexed recipient,uint256 amount,bytes32 sourceTxHash)',
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event Approval(address indexed owner,address indexed spender,uint256 value)'
]);
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const address=x=>/^0x[0-9a-fA-F]{40}$/.test(x)&&BigInt(x)!==0n;
const hash=x=>/^0x[0-9a-fA-F]{64}$/.test(x);
export function validateManifest(m){
 check(m?.protocol==='signed-xwl-bridge-v1'&&m.version===1,'내부 서명 브리지 설정이 아닙니다.');
 check(m.chains?.wl?.id===31337&&m.chains?.bnb?.id===31338,'로컬 체인만 사용할 수 있습니다.');
 check(address(m.signer)&&address(m.contracts?.xwl)&&address(m.contracts?.wwl),'계약·서명자 주소가 없습니다.');
 check(Number.isInteger(m.confirmations)&&m.confirmations>0&&m.confirmations<=100,'확정 기준이 없습니다.');
 for(const chain of ['wl','bnb']){const u=new URL(m.chains[chain].rpc);check(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','로컬 RPC 설정이 아닙니다.');}
 return m;
}
export async function rpc(chain,method,params=[]){
 const r=await fetch('/rpc/'+chain,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
 const v=await r.json();check(r.ok&&!v.error,v.error?.message||v.error||'RPC 요청 실패');return v.result;
}
export async function api(path,body){
 const r=await fetch(path,{...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(40000)});
 const v=await r.json();check(r.ok&&!v.error,v.error||'요청 실패');return v;
}
export async function read(chain,token,method,args=[]){
 return abi.decodeFunctionResult(method,await rpc(chain,'eth_call',[{to:token,data:abi.encodeFunctionData(method,args)},'latest']))[0];
}
export async function verifyPackage(m,p){
 validateManifest(m);check(p?.protocol===m.protocol&&p.version===1,'지원하지 않는 서명 패키지입니다.');
 check(['wl','bnb'].includes(p.source)&&p.destination===(p.source==='wl'?'bnb':'wl'),'교환 방향이 다릅니다.');
 const c=p.message,sourceToken=m.contracts[p.source==='wl'?'xwl':'wwl'],destinationToken=m.contracts[p.destination==='wl'?'xwl':'wwl'];
 check(c&&Object.keys(c).length===CLAIM_FIELDS.length&&CLAIM_FIELDS.every(([k])=>Object.hasOwn(c,k)),'서명 내용이 누락됐습니다.');
 check(JSON.stringify(p.types)===JSON.stringify(CLAIM_TYPES),'서명 형식이 다릅니다.');
 check(p.domain?.name==='BNC Signed Bridge'&&p.domain.version==='1'&&Number(p.domain.chainId)===m.chains[p.destination].id&&same(p.domain.verifyingContract,destinationToken),'서명 도메인이 다릅니다.');
 check(Number(c.sourceChainId)===m.chains[p.source].id&&same(c.sourceToken,sourceToken)&&address(c.sender)&&address(c.recipient),'출발 자산·수령인이 다릅니다.');
 check(hash(c.burnId)&&hash(c.sourceTxHash)&&hash(c.sourceBlockHash)&&BigInt(c.amount)>0n&&BigInt(c.amount)<2n**256n&&BigInt(c.nonce)>0n&&BigInt(c.nonce)<2n**64n,'소각 내용이 잘못됐습니다.');
 const burn=keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32','uint256','address','uint256','address','address','address','uint256','uint64'],[id('BNC_SIGNED_BRIDGE_BURN_V1'),c.sourceChainId,c.sourceToken,m.chains[p.destination].id,destinationToken,c.sender,c.recipient,c.amount,c.nonce]));
 check(same(burn,c.burnId),'소각 ID가 다릅니다.');
 check(same(verifyTypedData(p.domain,CLAIM_TYPES,c,p.signature),m.signer)&&same(p.signer,m.signer),'등록된 서버의 서명이 아닙니다.');
 check(same(TypedDataEncoder.hash(p.domain,CLAIM_TYPES,c),p.digest),'서명 해시가 다릅니다.');
 const data=abi.encodeFunctionData('claim',[CLAIM_FIELDS.map(([k])=>c[k]),p.signature]);check(same(data,p.claimData),'청구 데이터가 서명과 다릅니다.');
 const receipt=await rpc(p.source,'eth_getTransactionReceipt',[c.sourceTxHash]);
 check(receipt&&BigInt(receipt.status)===1n&&same(receipt.transactionHash,c.sourceTxHash)&&same(receipt.blockHash,c.sourceBlockHash)&&BigInt(receipt.blockNumber)===BigInt(c.sourceBlockNumber),'원본 소각 영수증이 다릅니다.');
 const log=receipt.logs.find(x=>BigInt(x.logIndex)===BigInt(c.logIndex));
 check(log&&!log.removed&&same(log.address,sourceToken)&&same(log.blockHash,c.sourceBlockHash)&&same(log.transactionHash,c.sourceTxHash),'원본 소각 로그가 다릅니다.');
 const event=abi.parseLog(log);check(event?.name==='BridgeBurned'&&same(event.args.burnId,c.burnId)&&same(event.args.sender,c.sender)&&same(event.args.recipient,c.recipient)&&event.args.amount===BigInt(c.amount)&&event.args.nonce===BigInt(c.nonce)&&Number(event.args.destinationChainId)===m.chains[p.destination].id&&same(event.args.destinationToken,destinationToken),'원본 브리지 소각 내용이 다릅니다.');
 const [block,tip,destBlock,used]=await Promise.all([rpc(p.source,'eth_getBlockByNumber',[toQuantity(BigInt(c.sourceBlockNumber)),false]),rpc(p.source,'eth_blockNumber'),rpc(p.destination,'eth_getBlockByNumber',['latest',false]),read(p.destination,destinationToken,'claimedBurn',[c.burnId])]);
 check(block&&same(block.hash,c.sourceBlockHash)&&BigInt(tip)>=BigInt(c.sourceBlockNumber)+BigInt(m.confirmations),'원본 확정 기준이 충족되지 않았습니다.');
 check(!used,'이미 발행한 소각 건입니다.');check(BigInt(destBlock.timestamp)<=BigInt(c.deadline),'서명이 만료됐습니다. 다시 발급받으세요.');
 return {chain:p.destination,token:destinationToken,data};
}
export class SignedClient {
 constructor(manifest,provider){this.manifest=validateManifest(manifest);this.provider=provider;this.epoch=0;for(const event of ['chainChanged','accountsChanged'])provider.on?.(event,()=>{this.epoch++;});}
 async connect(){const accounts=await this.provider.request({method:'eth_requestAccounts'});check(address(accounts[0]),'지갑 주소가 없습니다.');this.owner=accounts[0];return this.owner;}
 async context(chain){
  const chainId=this.manifest.chains[chain].id;
  if(Number(BigInt(await this.provider.request({method:'eth_chainId'})))!==chainId)await this.provider.request({method:'wallet_switchEthereumChain',params:[{chainId:toQuantity(chainId)}]});
  const accounts=await this.provider.request({method:'eth_accounts'});
  check(same(accounts[0],this.owner)&&Number(BigInt(await this.provider.request({method:'eth_chainId'})))===chainId,'지갑 계정 또는 체인이 바뀌었습니다. 다시 연결하세요.');
  const name=chain==='wl'?'xwl':'wwl';
  check(same(await this.provider.request({method:'eth_getCode',params:[this.manifest.contracts[name],'latest']}),this.manifest.runtimeCode[name]),'계약 코드가 바뀌었습니다.');
 }
 async prepare(op,amount,recipient,chain='wl',from=this.owner,pkg=null){
  check(['deposit','redeem','bridgeBurn','transfer','approve','transferFrom','claim'].includes(op),'지원하지 않는 작업입니다.');
  if(op==='deposit'||op==='redeem')chain='wl';
  if(op==='claim')chain=pkg?.destination;
  check(['wl','bnb'].includes(chain),'체인 선택이 필요합니다.');await this.context(chain);
  const token=this.manifest.contracts[chain==='wl'?'xwl':'wwl'];
  let data,value=0n;
  if(op==='claim'){({data}=await verifyPackage(this.manifest,pkg));amount=pkg.message.amount;recipient=pkg.message.recipient;}
  else {
   check(address(recipient),'수령인 주소를 확인하세요.');check(/^\d+$/.test(amount)&&BigInt(amount)<2n**256n&&(op==='approve'||BigInt(amount)>0n),'수량을 확인하세요.');
   if(op==='deposit'){data=abi.encodeFunctionData(op,[recipient]);value=BigInt(amount);}
   else {if(op==='transferFrom')check(address(from),'원소유자 주소를 확인하세요.');data=abi.encodeFunctionData(op,op==='transferFrom'?[from,recipient,amount]:op==='transfer'||op==='approve'?[recipient,amount]:[amount,recipient]);}
  }
  const transaction={from:this.owner,to:token,data,value:toQuantity(value),chainId:toQuantity(this.manifest.chains[chain].id)};
  await this.provider.request({method:'eth_call',params:[transaction,'latest']});
  transaction.gas=toQuantity(BigInt(await this.provider.request({method:'eth_estimateGas',params:[transaction]}))*120n/100n);
  const [balance,price]=await Promise.all([this.provider.request({method:'eth_getBalance',params:[this.owner,'latest']}),this.provider.request({method:'eth_gasPrice'})]);
  check(BigInt(balance)>=value+BigInt(price)*BigInt(transaction.gas),'수량과 가스비를 지불할 잔액이 부족합니다.');
  await this.context(chain);return {op,amount,recipient,chain,from,pkg,owner:this.owner,epoch:this.epoch,transaction};
 }
 async send(preview,save){
  check(preview.epoch===this.epoch&&same(preview.owner,this.owner),'검토 후 지갑이 바뀌었습니다. 다시 검토하세요.');
  const fresh=await this.prepare(preview.op,preview.amount,preview.recipient,preview.chain,preview.from,preview.pkg);
  check(same(fresh.transaction.data,preview.transaction.data)&&same(fresh.transaction.to,preview.transaction.to)&&fresh.transaction.value===preview.transaction.value,'검토한 거래 내용이 바뀌었습니다.');
  const nonce=await this.provider.request({method:'eth_getTransactionCount',params:[this.owner,'pending']});
  const startBlock=await rpc(fresh.chain,'eth_blockNumber');
  await this.context(fresh.chain);check(preview.epoch===this.epoch,'검토 후 지갑이 바뀌었습니다.');
  const pending={op:fresh.op,owner:fresh.owner,chain:fresh.chain,nonce,startBlock,transaction:{...fresh.transaction,nonce},status:'awaiting_wallet'};
  await save(pending);
  try {
   const txHash=await this.provider.request({method:'eth_sendTransaction',params:[pending.transaction]});check(hash(txHash),'지갑에서 거래 해시를 받지 못했습니다. 기록을 확인하세요.');
   pending.transactionHash=txHash;pending.status='submitted';await save(pending);return pending;
  } catch(error){if(error.code===4001)await save(null);throw error;}
 }
}

export async function recoverPending(pending){
 let hashValue=pending.transactionHash;
 if(!hashValue){
  const tip=BigInt(await rpc(pending.chain,'eth_blockNumber')),start=BigInt(pending.startBlock);
  check(tip-start<=2000n,'조회 범위가 큽니다. 지갑 기록에서 거래 해시를 확인하세요.');
  for(let block=start;block<=tip;block++){
   const b=await rpc(pending.chain,'eth_getBlockByNumber',[toQuantity(block),true]);
   const tx=b.transactions.find(x=>same(x.from,pending.owner)&&BigInt(x.nonce)===BigInt(pending.nonce));
   if(tx){check(same(tx.to,pending.transaction.to)&&same(tx.input,pending.transaction.data)&&BigInt(tx.value)===BigInt(pending.transaction.value),'같은 nonce의 다른 거래가 확인됐습니다. 지갑 기록을 확인하세요.');hashValue=tx.hash;break;}
  }
 }
 if(!hashValue)return null;
 const receipt=await rpc(pending.chain,'eth_getTransactionReceipt',[hashValue]);
 if(!receipt)return null;
 check(same(receipt.from,pending.owner)&&same(receipt.to,pending.transaction.to),'거래 영수증의 계정·계약이 다릅니다.');
 return {transactionHash:hashValue,receipt,success:BigInt(receipt.status)===1n};
}
