import {AbiCoder, Interface, decodeRlp, encodeRlp, getBytes, hexlify, keccak256, id, toBeHex, toQuantity, zeroPadValue} from './vendor/ethers-6.15.0.min.mjs';
const abi = AbiCoder.defaultAbiCoder();
const interfaces = {
  lock: new Interface(['function bridgeLock(uint256,address,uint256)', 'function submitLockProof((uint256 blockNumber,bytes32 blockHash,uint256 txIndex,uint256 logIndex,bytes[] proofNodes))', 'function claimedTransfer(bytes32) view returns(bool)']),
  burn: new Interface(['function bridgeBurn(uint256,address,uint256)', 'function submitBurnProof((uint256 blockNumber,bytes32 blockHash,uint256 txIndex,uint256 logIndex,bytes[] proofNodes))', 'function claimedWithdrawal(bytes32) view returns(bool)']),
  headers: new Interface(['function getReceiptRoot(uint256,uint256,bytes32) view returns(bytes32)']),
  token: new Interface(['function balanceOf(address) view returns(uint256)', 'function availableBalanceOf(address) view returns(uint256)']),
};
for(const action of ['burn-wl','burn-bsc']) interfaces[action]=new Interface(['function bridgeBurn(uint256,address,uint256)','function submitBurnProof((uint256 blockNumber,bytes32 blockHash,uint256 txIndex,uint256 logIndex,bytes[] proofNodes))','function claimedBurn(bytes32) view returns(bool)']);
interfaces['lock-vault']=new Interface(['function lock(address) payable','function submitLockProof((uint256 blockNumber,bytes32 blockHash,uint256 txIndex,uint256 logIndex,bytes[] proofNodes))','function claimedTransfer(bytes32) view returns(bool)']);
interfaces['burn-vault']=interfaces.burn;
const redirectedClaim = new Interface(['function submitBurnProofTo((uint256,bytes32,uint256,uint256,bytes[]),address)']);
const forward = action => ['lock','burn-wl','lock-vault'].includes(action);
const isTestnetVault = manifest => manifest.protocol === 'native-wl-vault-testnet-v1';
const isVault = manifest => manifest.protocol === 'native-wl-vault-v1' || isTestnetVault(manifest);
const actionsFor = manifest => isVault(manifest) ? ['lock-vault','burn-vault'] : manifest.protocol==='burn-mint-v2' ? ['burn-wl','burn-bsc'] : ['lock','burn'];
const address = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (test, reason) => {if (!test) throw new Error(reason);};
const bytes = v => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
const hash = v => bytes(v) && v.length === 66;
const integer = v => {check(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, 'unsafe integer'); return BigInt(v);};
const computationInputFields=['action','sourceChainId','destinationChainId','sourceToken','destinationToken','sender','recipient','amount','nonce','transferId','blockNumber','blockHash','receiptRoot','txIndex','logIndex','receiptBytes','proofNodes'];
export function validateComputationProof(p,m) {
  const proof=p.computationProof,policy=m.computationProof,journal=proof?.journal;
  check(proof?.sdkVerified===true && proof.receiptFormat===policy.receiptFormat && proof.imageId===policy.imageId,'RISC Zero receipt missing or wrong guest');
  check(proof.sourceAuthenticated===false && proof.onchainVerified===false && journal?.sourceAuthenticated===false,'incorrect computation proof scope');
  check(typeof proof.receiptBase64==='string' && proof.receiptBase64.length>0 && proof.receiptBase64.length%4===0 && proof.receiptBase64.length<=11184812 && /^[A-Za-z0-9+/]*={0,2}$/.test(proof.receiptBase64),'invalid computation receipt encoding');
  check(typeof proof.receiptSHA256==='string' && /^[0-9a-f]{64}$/.test(proof.receiptSHA256),'invalid computation receipt digest');
  check(journal.version===p.version && journal.statement===policy.statement,'invalid computation statement');
  for(const key of ['action','sourceChainId','destinationChainId','amount','blockNumber'])check(journal[key]===p[key],'computation journal mismatch: '+key);
  for(const key of ['sourceToken','destinationToken','recipient','transferId','blockHash','receiptRoot'])check(equal(journal[key],p[key]),'computation journal mismatch: '+key);
  const input=Object.fromEntries(computationInputFields.map(key=>[key,p[key]]));
  check(equal(journal.inputDigest,keccak256(new TextEncoder().encode(JSON.stringify(input)))),'computation input commitment mismatch');
}
function uint(raw, max=2n**256n-1n) {
  check(bytes(raw) && (raw === '0x' || !raw.startsWith('0x00')), 'noncanonical integer');
  const n = raw === '0x' ? 0n : BigInt(raw);
  check(n <= max, 'integer overflow'); return n;
}
function canonicalRlp(raw) {
  check(bytes(raw), 'invalid RLP bytes');
  const item=decodeRlp(raw);
  check(equal(encodeRlp(item),raw), 'noncanonical RLP'); return item;
}
export function verifyReceiptProof(root, txIndex, nodes) {
  check(hash(root) && Array.isArray(nodes) && nodes.length > 0 && nodes.length <= 64, 'invalid proof bounds');
  check(nodes.every(n=>bytes(n) && n.length <= 2*1024*1024), 'oversized proof node');
  const key=encodeRlp(txIndex===0n?'0x':toBeHex(txIndex)).slice(2).split('').map(c=>parseInt(c,16));
  let reference=root, offset=0, consumed=0;
  for (let steps=0; steps<128; steps++) {
    let node;
    if (Array.isArray(reference)) {node=reference; check(getBytes(encodeRlp(node)).length<32,'oversized inline node');}
    else {
      check(hash(reference) && consumed<nodes.length,'missing hashed node');
      const raw=nodes[consumed++]; check(equal(keccak256(raw),reference),'proof hash mismatch');
      if (consumed>1) check(getBytes(raw).length>=32,'hashed short child');
      node=canonicalRlp(raw);
    }
    check(Array.isArray(node),'proof node is not list');
    if (node.length===17) {
      if (offset===key.length) {check(consumed===nodes.length && bytes(node[16]),'trailing proof nodes'); return node[16];}
      reference=node[key[offset++]];
    } else if (node.length===2) {
      check(bytes(node[0]) && node[0].length>2,'empty compact path');
      const compact=node[0].slice(2).split('').map(c=>parseInt(c,16));
      const flag=compact[0]; check(flag<=3 && ((flag&1)!==0 || compact[1]===0),'invalid compact path');
      const path=compact.slice((flag&1)?1:2);
      check((flag&2)!==0 || path.length>0,'empty extension');
      check(path.every((v,i)=>key[offset+i]===v),'proof path mismatch'); offset+=path.length;
      if (flag&2) {check(offset===key.length && consumed===nodes.length && bytes(node[1]),'invalid leaf or trailing nodes'); return node[1];}
      reference=node[1];
    } else {throw new Error('invalid trie node arity');}
  }
  throw new Error('proof step limit');
}
export function validateManifest(m) {
  check(m?.version===1 && m.chainAuthenticated===false && m.realAssetDeploymentAllowed===false,'local manifest required');
  check(m.mode==='dev' && m.proofPolicy==='trusted-rpc-receipt-root' && m.computationPolicy==='risc0-receipt-computation','trusted-root RISC Zero computation mode required');
  if(m.sessionId!==undefined)check(typeof m.sessionId==='string' && /^[0-9a-f]{32}$/.test(m.sessionId),'invalid wallet session identity');
  check(m.headerBinding==='minimal-link','unexpected registry metadata');
  const testnet=isTestnetVault(m);
  const [wl,bnb]=testnet?[10359,97]:[31337,31338];
  check(m.chains?.wl?.id===wl && m.chains?.bnb?.id===bnb,'configured chain pair required');
  check(testnet ? m.readOnlyTestnet===true && !m.publicOrigin : !m.readOnlyTestnet,'invalid testnet mode');
  if(m.assetProfile!==undefined) {
    const policy=m.entryPolicy;
    check(m.protocol==='burn-mint-v2' && m.assetProfile==='xwl-entry-v1' && !m.publicOrigin,'local xWL entry profile required');
    check(policy?.assetProfile===m.assetProfile && policy.worldLandChainId===31337 && policy.bscChainId===31338
      && policy.decimals===18 && policy.initialSupply==='0' && /^0x0{40}$/.test(policy.sink)
      && typeof policy.entryCap==='string' && /^[1-9][0-9]{0,77}$/.test(policy.entryCap)
      && BigInt(policy.entryCap)<2n**256n,'invalid local xWL entry policy');
  }
  if(m.publicOrigin) {
    const base=new URL(m.publicOrigin);
    check(base.origin===m.publicOrigin && !base.username && !base.password && (base.protocol==='https:' || (base.protocol==='http:' && ['localhost','127.0.0.1'].includes(base.hostname))),'invalid public origin');
    for(const name of ['wl','bnb']) check(m.chains[name].rpc===m.publicOrigin+'/rpc/'+name,'public RPC origin mismatch');
  } else {
    for(const name of ['wl','bnb']) {
      const rpc=new URL(m.chains[name].rpc);
      const path=testnet?'/rpc/'+name:'/';
      check(rpc.protocol==='http:' && rpc.hostname==='127.0.0.1' && Number(rpc.port)>=1024 && Number(rpc.port)<=65535 && rpc.pathname===path && !rpc.username && !rpc.password && !rpc.search && !rpc.hash,'owned loopback RPC required');
      if(testnet) check(Number.isSafeInteger(m.chains[name].historyStartBlock) && m.chains[name].historyStartBlock>0,'invalid testnet history start block');
    }
  }
  for (const name of ['original','wrapped','mint','unlock','wl_headers','bnb_headers']) {
    check(address(m.contracts?.[name]) && bytes(m.runtimeCode?.[name]) && m.runtimeCode[name].length>2,'missing contract identity');
  }
  if(isVault(m)) {
    check(!m.publicOrigin && !m.assetProfile && equal(m.contracts.original,m.contracts.unlock)
      && equal(m.contracts.wrapped,m.contracts.mint),'invalid local Vault profile');
  }
  if(m.computationPolicy==='risc0-receipt-computation') {
    const p=m.computationProof;
    check(m.mode==='dev' && m.proofPolicy==='trusted-rpc-receipt-root','invalid computation mode');
    check(typeof p?.imageId==='string' && /^[0-9a-f]{64}$/.test(p.imageId) && p.receiptFormat==='risc0-sdk-bincode-3.0.5','missing computation guest policy');
    check(p.statement==='trusted-input-receipt-computation' && p.sourceAuthenticated===false && p.onchainVerified===false && p.verificationLocation==='server-risc0-sdk','invalid computation verification scope');
  }
  return m;
}
export function validatePackage(p,m) {
  validateManifest(m);
  const v2=m.protocol==='burn-mint-v2', vault=isVault(m), transferable=v2||vault;
  check(p?.version===(isTestnetVault(m)?4:vault?3:v2?2:1) && actionsFor(m).includes(p.action) && p.chainAuthenticated===false,'invalid bridge package');
  check(p.headerMode===m.mode && p.coverageChecked===true,'package mode/coverage mismatch');
  validateComputationProof(p,m);
  const lock=forward(p.action), source=lock?'wl':'bnb', destination=lock?'bnb':'wl';
  const token=m.contracts[lock?'original':'wrapped'], remote=m.contracts[lock?'wrapped':'original'];
  const receiver=m.contracts[lock?'mint':'unlock'], updater=m.contracts[destination+'_headers'];
  check(p.sourceChainId===m.chains[source].id && p.destinationChainId===m.chains[destination].id,'package chain mismatch');
  check(equal(p.sourceToken,token) && equal(p.destinationToken,remote),'token identity mismatch');
  check(address(p.sender) && address(p.recipient) && (transferable || equal(p.sender,p.recipient)) && hash(p.transferId) && hash(p.blockHash),'invalid owner/event identity');
  check(hash(p.receiptRoot),'invalid receipt root');
  const txIndex=integer(p.txIndex), block=integer(p.blockNumber), logIndex=integer(p.logIndex);
  const raw=verifyReceiptProof(p.receiptRoot,txIndex,p.proofNodes);
  check(equal(raw,p.receiptBytes),'receipt differs from proof');
  const receiptBytes=getBytes(raw), type=receiptBytes[0];
  check(type>=0xc0 || [1,2,3,4].includes(type),'unsupported receipt type');
  const receipt=canonicalRlp(type<0xc0?hexlify(receiptBytes.slice(1)):raw);
  check(Array.isArray(receipt) && receipt.length===4 && receipt[0]==='0x01','unsuccessful receipt');
  uint(receipt[1],2n**64n-1n);
  check(bytes(receipt[2]) && getBytes(receipt[2]).length===256 && Array.isArray(receipt[3]),'invalid receipt format');
  const log=receipt[3][Number(logIndex)];
  check(Array.isArray(log) && log.length===3 && equal(log[0],token) && Array.isArray(log[1]) && log[1].length===4,'event emitter/topics mismatch');
  const topics=log[1];
  const eventName=vault?(lock?'VaultLocked':'VaultBurned'):v2?'BridgeBurned':lock?'Locked':'Burned';
  const signature=eventName+'(bytes32,address,address,uint256,uint64,uint256)';
  check(topics.every(hash) && equal(topics[0],id(signature)) && equal(topics[1],p.transferId),'event topic mismatch');
  check(equal(topics[2],zeroPadValue(p.sender,32)) && equal(topics[3],zeroPadValue(p.recipient,32)),'event owner mismatch');
  check(bytes(log[2]) && getBytes(log[2]).length===96,'invalid event data');
  const [amount,nonce,dest]=abi.decode(['uint256','uint64','uint256'],log[2]);
  check(equal(abi.encode(['uint256','uint64','uint256'],[amount,nonce,dest]),log[2]),'noncanonical event ABI');
  check(amount>0n && amount.toString()===p.amount && nonce===integer(p.nonce) && dest===BigInt(p.destinationChainId),'event amount/nonce/chain mismatch');
  const values=transferable?[id(vault?'WORLDLAND_BNB_NATIVE_VAULT_V1':'WORLDLAND_BNB_BURN_MINT_V2'),p.sourceChainId,token,dest,remote,p.sender,p.recipient,amount,nonce]:lock?[id('WORLDLAND_BNB_BRIDGE_LOCK_V2'),p.sourceChainId,token,remote,p.sender,p.recipient,amount,nonce,dest]:[id('WORLDLAND_BNB_BRIDGE_BURN_V1'),p.sourceChainId,token,dest,remote,p.sender,p.recipient,amount,nonce,dest];
  const types=transferable?['bytes32','uint256','address','uint256','address','address','address','uint256','uint64']:lock?['bytes32','uint256','address','address','address','address','uint256','uint64','uint256']:['bytes32','uint256','address','uint256','address','address','address','uint256','uint64','uint256'];
  check(equal(keccak256(abi.encode(types,values)),p.transferId),'event ID mismatch');
  check(!transferable || nonce>0n,'zero bridge nonce');
  const method=lock&&!v2?'submitLockProof':'submitBurnProof';
  const claim=interfaces[p.action].encodeFunctionData(method,[[block,p.blockHash,txIndex,logIndex,p.proofNodes]]);
  check(equal(claim,p.calldata),'claim ABI mismatch');
  validateTransaction(p.claimTransaction,p.destinationChainId,receiver,claim,method);
  check(!p.headerTransaction && !p.headerProof && !p.kind,'retired header proof package');
  return {source,destination,receiver,updater,amount,claim,owner:p.recipient};
}
function validateTransaction(tx,chain,to,data,action) {
  check(tx?.role==='user' && tx.action===action && tx.chainId===chain && equal(tx.to,to) && equal(tx.data,data) && tx.value==='0','unsigned transaction mismatch');
}
export class WalletClient {
  constructor(provider,manifest,options={}) {
    check(provider && typeof provider.request==='function','EIP-1193 wallet required');
    this.provider=provider; this.manifest=structuredClone(validateManifest(manifest)); this.epoch=0;
    this.computationVerifier=options.verifyComputation;
    for (const event of ['chainChanged','accountsChanged','disconnect']) provider.on?.(event,()=>{this.epoch++;});
  }
  rpc(method,params=[]) {return this.provider.request({method,params});}
  connect() {return this.rpc('eth_requestAccounts');}
  async verifyComputation(p) {
    validatePackage(p,this.manifest);
    const proof=p.computationProof;
    const raw=Uint8Array.from(atob(proof.receiptBase64),c=>c.charCodeAt(0));
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
    check(digest===proof.receiptSHA256,'computation receipt digest mismatch');
    let verified;
    if(this.computationVerifier)verified=await this.computationVerifier(p);
    else {
      check(typeof location!=='undefined' && ['http:','https:'].includes(location.protocol),'SDK verification service required');
      const response=await fetch(new URL('/api/computation/verify',location.origin),{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify(p),signal:AbortSignal.timeout(40000)});
      verified=await response.json();check(response.ok,verified.error||'RISC Zero SDK verification failed');
    }
    check(verified?.verified===true && verified.imageId===this.manifest.computationProof.imageId && verified.receiptSHA256===digest,'RISC Zero SDK verification rejected');
    check(verified.sourceAuthenticated===false && verified.onchainVerified===false && verified.verificationLocation==='server-risc0-sdk','invalid SDK verification scope');
    check(verified.journal && Object.keys(proof.journal).length===Object.keys(verified.journal).length && Object.entries(proof.journal).every(([key,value])=>verified.journal[key]===value),'verified computation journal mismatch');
    return verified;
  }
  async switchChain(chain) {
    const network=Object.entries(this.manifest.chains).find(([,v])=>v.id===chain);
    check(network,'unknown configured chain');
    try{return await this.rpc('wallet_switchEthereumChain',[{chainId:toBeHex(chain)}]);}
    catch(error){
      if(error.code!==4902)throw error;
      check(!isTestnetVault(this.manifest),'테스트넷 네트워크를 확장 지갑에 먼저 추가하세요.');
      const [name,config]=network;
      await this.rpc('wallet_addEthereumChain',[{chainId:toBeHex(chain),chainName:'BNC-WL '+name+' prototype',nativeCurrency:{name:'Test gas',symbol:'TEST',decimals:18},rpcUrls:[config.rpc]}]);
      return this.rpc('wallet_switchEthereumChain',[{chainId:toBeHex(chain)}]);
    }
  }
  async context(chain,owner,epoch=this.epoch) {
    const id=await this.rpc('eth_chainId'), accounts=await this.rpc('eth_accounts');
    check(BigInt(id)===BigInt(chain) && address(accounts[0]) && equal(accounts[0],owner),'wallet chain/account mismatch');
    check(epoch===this.epoch,'wallet changed during validation'); return accounts[0];
  }
  async identity(chain,names) {
    const actual=await this.rpc('eth_chainId'); check(BigInt(actual)===BigInt(chain),'wallet chain mismatch');
    for (const name of names) {
      const code=await this.rpc('eth_getCode',[this.manifest.contracts[name],'latest']);
      check(equal(code,this.manifest.runtimeCode[name]),'contract runtime mismatch: '+name);
    }
  }
  async call(to,iface,method,args) {
    const raw=await this.rpc('eth_call',[{to,data:iface.encodeFunctionData(method,args)},'latest']);
    return iface.decodeFunctionResult(method,raw)[0];
  }
  async preview(p,kind='claim',payout) {
    check(kind==='claim','only direct asset claims are supported');
    const packageCopy=structuredClone(p), m=this.manifest, validated=validatePackage(packageCopy,m), epoch=this.epoch;
    await this.verifyComputation(packageCopy);
    const chain=m.chains[validated.destination].id;
    const signer=isVault(m)?(await this.rpc('eth_accounts'))[0]:validated.owner;
    if (payout) {
      check(isTestnetVault(m) && packageCopy.action==='burn-vault' && equal(signer,validated.owner),
        'only the original testnet payout recipient may redirect');
      check(address(payout) && !equal(payout,validated.receiver),'invalid recovery payout address');
    }
    await this.context(chain,signer,epoch);
    await this.identity(chain,[validated.destination+'_headers',forward(packageCopy.action)?'mint':'unlock',forward(packageCopy.action)?'wrapped':'original']);
    const replay=m.protocol==='burn-mint-v2'?'claimedBurn':forward(packageCopy.action)?'claimedTransfer':'claimedWithdrawal';
    check(await this.call(validated.receiver,interfaces[packageCopy.action],replay,[packageCopy.transferId])===false,'claim already accepted');
    let root;
    try {root=await this.call(validated.updater,interfaces.headers,'getReceiptRoot',[packageCopy.sourceChainId,packageCopy.blockNumber,packageCopy.blockHash]);}
    catch (error) {
      // Only the contract's exact UnknownHeader revert means missing coverage.
      // A transport/provider failure leaves coverage unknown and blocks signing.
      const data=typeof error.data==='string'?error.data:error.data?.data;
      check(equal(data,id('UnknownHeader()').slice(0,10)),'coverage lookup failed'); root=null;
    }
    const covered=equal(root,packageCopy.receiptRoot);
    if (root && !/^0x0{64}$/.test(root)) check(covered,'accepted receipt root mismatch');
    const tx=packageCopy.claimTransaction;
    check(tx,'missing unsigned transaction');
    check(covered,'operator receipt root is not registered');
    const data=payout?redirectedClaim.encodeFunctionData('submitBurnProofTo',[
      [packageCopy.blockNumber,packageCopy.blockHash,packageCopy.txIndex,packageCopy.logIndex,packageCopy.proofNodes],payout
    ]):tx.data;
    const request={from:signer,to:tx.to,data,value:'0x0',chainId:toQuantity(chain)};
    await this.rpc('eth_call',[request,'latest']);
    const gas=await this.rpc('eth_estimateGas',[request]);
    const [balance,gasPrice]=await Promise.all([this.rpc('eth_getBalance',[signer,'latest']),this.rpc('eth_gasPrice')]);
    check(BigInt(balance)>=BigInt(gas)*BigInt(gasPrice),'insufficient local gas balance');
    await this.context(chain,signer,epoch);
    return {kind,chain,owner:signer,amount:validated.amount.toString(),recipient:payout||validated.owner,payout,
            headerRequired:!covered,transaction:{...request,gas},epoch,package:packageCopy};
  }
  async submit(preview,recordPending) {
    check(preview?.epoch===this.epoch,'preview expired after wallet change');
    // Recheck coverage/code/simulation immediately before the wallet prompt.
    const fresh=await this.preview(preview.package,preview.kind,preview.payout);
    check(equal(fresh.owner,preview.owner) && equal(fresh.transaction.to,preview.transaction.to)
      && equal(fresh.transaction.data,preview.transaction.data),'preview transaction changed');
    const nonce=await this.rpc('eth_getTransactionCount',[fresh.owner,'pending']);
    await this.context(fresh.chain,fresh.owner,fresh.epoch);
    await recordPending({chain:fresh.chain,owner:fresh.owner,nonce,transaction:fresh.transaction,status:'awaiting_wallet'});
    const transactionHash=await this.rpc('eth_sendTransaction',[{...fresh.transaction,nonce}]);
    check(hash(transactionHash),'wallet returned invalid transaction hash');
    await recordPending({chain:fresh.chain,owner:fresh.owner,nonce,transaction:fresh.transaction,status:'submitted',transactionHash});
    return transactionHash;
  }
  async action(action,amount,owner,recipient=owner) {
    const v2=this.manifest.protocol==='burn-mint-v2';
    const vault=isVault(this.manifest), deposit=action==='lock-vault';
    check(address(recipient) && (v2 || vault || equal(recipient,owner)),'invalid destination recipient');
    check(actionsFor(this.manifest).includes(action) && typeof amount==='string' && /^[1-9][0-9]*$/.test(amount),'positive amount in base units required');
    const n=BigInt(amount); check(n<2n**256n,'amount overflow');
    const lock=forward(action), source=lock?'wl':'bnb', destination=lock?'bnb':'wl', chain=this.manifest.chains[source].id;
    const token=this.manifest.contracts[lock?'original':'wrapped'], epoch=this.epoch;
    await this.context(chain,owner,epoch); await this.identity(chain,[lock?'original':'wrapped']);
    if (!deposit) {
      const available=await this.call(token,interfaces.token,lock&&!v2?'availableBalanceOf':'balanceOf',[owner]);
      check(n<=available,'insufficient available token balance');
    }
    const data=deposit?interfaces[action].encodeFunctionData('lock',[recipient])
      :interfaces[action].encodeFunctionData(lock&&!v2?'bridgeLock':'bridgeBurn',[n,recipient,this.manifest.chains[destination].id]);
    const transaction={from:owner,to:token,data,value:deposit?toQuantity(n):'0x0',chainId:toQuantity(chain)};
    await this.rpc('eth_call',[transaction,'latest']);
    transaction.gas=await this.rpc('eth_estimateGas',[transaction]);
    const [gasBalance,gasPrice]=await Promise.all([this.rpc('eth_getBalance',[owner,'latest']),this.rpc('eth_gasPrice')]);
    check(BigInt(gasBalance)>=BigInt(transaction.value)+BigInt(transaction.gas)*BigInt(gasPrice),'insufficient local gas balance');
    await this.context(chain,owner,epoch);
    return {action,amount,recipient,chain,owner,epoch,transaction};
  }
  async submitAction(preview,recordPending) {
    check(preview?.epoch===this.epoch,'action preview expired');
    const fresh=await this.action(preview.action,preview.amount,preview.owner,preview.recipient);
    check(equal(fresh.transaction.to,preview.transaction.to) && equal(fresh.transaction.data,preview.transaction.data)
      && fresh.transaction.value===preview.transaction.value,'action preview changed');
    const nonce=await this.rpc('eth_getTransactionCount',[fresh.owner,'pending']);
    await this.context(fresh.chain,fresh.owner,fresh.epoch);
    await recordPending({chain:fresh.chain,owner:fresh.owner,nonce,transaction:fresh.transaction,status:'awaiting_wallet'});
    const transactionHash=await this.rpc('eth_sendTransaction',[{...fresh.transaction,nonce}]);
    check(hash(transactionHash),'wallet returned invalid transaction hash');
    await recordPending({chain:fresh.chain,owner:fresh.owner,nonce,transaction:fresh.transaction,status:'submitted',transactionHash});
    return transactionHash;
  }
}
