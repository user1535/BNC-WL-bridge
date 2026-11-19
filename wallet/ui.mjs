import {DemoWallet} from './demo-wallet.mjs';
import {id,parseUnits,formatUnits,Interface} from './vendor/ethers-6.15.0.min.mjs';
import {WalletClient,validateManifest,validatePackage} from './client.mjs';
const $=id=>document.getElementById(id);
let storage='worldland-bnb-local-pending-v1';
let client, manifest, packageData, preview, busy=false;
let selectedChain='wl';
let auditHalted=false;
function computationStatus(p) {
  const label=$('computation-status');
  if(!label)return;
  label.textContent=p?.computationProof?'RISC0 연산 증명 · SDK 재검증 통과 · 블록 '+p.blockNumber:'RISC0 연산 증명 · 잠금 또는 소각 후 증명을 요청하세요.';
}
const status=value=>{$('status').textContent=value;$('action-feedback').textContent=value;$('claim-feedback').textContent=value;};
function clearPreview() {preview=null;$('submit').disabled=true;}
function controls() {
  computationStatus(packageData);
  $('download-package').disabled=!packageData||busy;
  for (const id of ['connect','switch-wl','switch-bnb','prepare-action','request-proof']) $(id).disabled=!client||busy;
  $('prepare-claim').disabled=!client||!packageData||busy;
  if(packageData?.destinationChainId&&packageData.destinationChainId!==(selectedChain==='wl'?31337:31338))$('prepare-claim').disabled=true;
  $('claim-direction').textContent=packageData?.destinationChainId?(packageData.destinationChainId===(selectedChain==='wl'?31337:31338)?'수신한 패키지를 이 체인에서 청구할 수 있습니다.':'패키지가 준비됐습니다. 목적지 화면으로 이동해 청구하세요.'):'반대 체인에서 받은 패키지를 이 체인에서 청구합니다.';
  $('go-destination').hidden=!packageData?.destinationChainId||packageData.destinationChainId===(selectedChain==='wl'?31337:31338);
  $('submit').disabled=!preview||busy||!!localStorage.getItem(storage);
  if(auditHalted)for(const id of ['prepare-action','request-proof','prepare-claim','submit'])$(id).disabled=true;
}
async function task(fn) {
  if (busy) return; busy=true;controls();
  try {await fn();} catch(error) {clearPreview(); status(error.code===4001?'지갑에서 요청을 거절했습니다.':error.message);
  } finally {busy=false;controls();}
}
async function loadFile(input) {
  const file=input.files[0];if(!file) throw new Error('파일을 선택하세요.');
  if(file.size>16*1024*1024) throw new Error('파일은16MiB 이하여야 합니다.');
  return JSON.parse(await file.text());
}
function review(p) {
  preview=p;$('review').replaceChildren();
  for(const [title,value] of [['거래',p.action||p.kind],['네트워크',p.chain],['금액 (최소 단위)',p.amount],['수신자',p.recipient],['거래 대상',p.transaction.to],['가스 한도',BigInt(p.transaction.gas).toString()],['calldata 크기',(p.transaction.data.length-2)/2+' bytes']]) {
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=title;dd.textContent=value;$('review').append(dt,dd);
  }
  status('거래 확인 완료. 검토 내용을 확인한 뒤 지갑에서 승인 요청을 누르세요.');controls();$('review').closest('section').scrollIntoView({behavior:'smooth',block:'start'});
}
$('manifest').addEventListener('change',()=>task(async()=>{useManifest(await loadFile($('manifest')));status('공개 세션을 불러왔습니다. 지갑 연결 안내를 확인하세요.');}));
$('connect').onclick=()=>task(async()=>{$('account').textContent=(await client.connect())[0]||'계정 접근이 거절되었습니다.';clearPreview();});
for(const [button,chain] of [['switch-wl',31337],['switch-bnb',31338]]) $(button).onclick=()=>task(async()=>{
  clearPreview();await client.switchChain(chain);
  status('네트워크를 전환했습니다.');
});
$('package').addEventListener('change',()=>task(async()=>{
  clearPreview();if(!manifest) throw new Error('세션 manifest를 먼저 로드하세요.');
  packageData=null;
  const p=await loadFile($('package'));validatePackage(p,manifest);
  if(manifest.computationPolicy==='risc0-receipt-computation') {
    if(!client)throw new Error('SDK 검증을 위해 지갑을 먼저 연결하세요.');
    await client.verifyComputation(p);
  }
  packageData=p;computationStatus(p);status('MPT·이벤트·금액·수신자·거래 내용 대조와 필요한 RISC0 SDK 재검증을 통과했습니다.');
}));
$('prepare-action').onclick=()=>task(async()=>{
  status('잔액과 거래 가능 여부를 확인 중입니다…');
  clearPreview();if(localStorage.getItem(storage)) throw new Error('저장된 거래 상태를 먼저 조회하세요.');
  await client.switchChain(selectedChain==='wl'?31337:31338);
  const owner=(await client.rpc('eth_accounts'))[0];review(await client.action($('action').value,parseUnits($('amount').value.trim(),18).toString(),owner));
});
$('prepare-claim').onclick=()=>task(async()=>{
  clearPreview();if(localStorage.getItem(storage)) throw new Error('저장된 거래 상태를 먼저 조회하세요.');
  status('목적지 네트워크 전환 및 청구 가능 여부를 확인 중입니다…');
  const destinationChain=packageData?.destinationChainId;
  if(destinationChain)await client.switchChain(destinationChain);
  review(await client.preview(packageData));
});
for(const input of ['amount','action']) $(input).addEventListener('input',()=>{clearPreview();controls();});
$('submit').onclick=()=>task(async()=>{
  if(!navigator.locks) throw new Error('이 브라우저는 로컬 거래 잠금을 지원하지 않습니다.');
  await navigator.locks.request(storage,async()=>{
    if(!preview||localStorage.getItem(storage)) throw new Error('거래 확인 또는 저장된 거래 상태 조회가 필요합니다.');
    const p=preview;clearPreview();let savedHere=false;
    const save=async value=>{localStorage.setItem(storage,JSON.stringify(value));savedHere=true;};
    try {
      const hash=p.action?await client.submitAction(p,save):await client.submit(p,save);
      status('지갑이 전송한 거래: '+hash+'\n거래 상태 조회로 수락 여부를 확인하세요.');
    } catch(error) {
      // A rejection of another operation must never erase an unresolved send.
      if(error.code===4001 && savedHere) localStorage.removeItem(storage);
      throw error;
    }
  });
});
window.addEventListener('storage',event=>{if(event.key===storage){clearPreview();controls();}});
$('recover').onclick=()=>task(async()=>{
  const raw=localStorage.getItem(storage);if(!raw){status('미확인 거래가 없습니다.');return;}
  if(!client) throw new Error('세션과 지갑을 연결하세요.');
  const pending=JSON.parse(raw);await client.switchChain(pending.chain);await client.context(pending.chain,pending.owner);
  if(!pending.transactionHash) throw new Error('지갑 요청의 결과를 확인하지 못했습니다. 지갑 거래 기록과 nonce를 확인하세요. 자동 재전송하지 않습니다.');
  const receipt=await client.rpc('eth_getTransactionReceipt',[pending.transactionHash]);
  if(!receipt){status('아직 수락되지 않았습니다. 나중에 다시 조회하세요.');return;}
  if(BigInt(receipt.status)===1n) {
    const isLock=pending.chain===31337;
    const token=manifest.contracts[isLock?'original':'wrapped'].toLowerCase();
    const signature=id(isLock?'Locked(bytes32,address,address,uint256,uint64,uint256)':'Burned(bytes32,address,address,uint256,uint64,uint256)');
    const event=receipt.logs?.find(log=>log.address.toLowerCase()===token&&log.topics?.length===4&&log.topics[0].toLowerCase()===signature);
    if(event) {
      $('proof-action').value=isLock?'lock':'burn';
      $('transfer-id').value=event.topics[1];$('from-block').value=Number(BigInt(receipt.blockNumber));saveEventInputs();
    }
  }
  localStorage.removeItem(storage);clearPreview();status(BigInt(receipt.status)===1n?'거래가 수락됐습니다.':'거래가 되돌려졌습니다. 다시 실행하기 전에 원인을 확인하세요.');
});
if(localStorage.getItem(storage)) status('이 브라우저에 미확인 거래가 있습니다. 상태를 조회하세요.');
controls();

let serviceStorage='worldland-bnb-proof-request-v1';
function scopeSession(){
 const trusted=manifest?.proofPolicy==='trusted-rpc-receipt-root';
 storage=trusted?'worldland-bnb-local-pending-trusted-v1':'worldland-bnb-local-pending-v1';
 serviceStorage=trusted?'worldland-bnb-proof-request-trusted-v1':'worldland-bnb-proof-request-v1';
 if(manifest?.sessionId){storage+='-'+manifest.sessionId;serviceStorage+='-'+manifest.sessionId;}
 const saved=JSON.parse(localStorage.getItem(serviceStorage)||'null')||JSON.parse(localStorage.getItem(serviceStorage+'-event')||'null');
 $('transfer-id').value=saved?.request.transferId||'';$('from-block').value=saved?.request.fromBlock||0;
 if(saved)$('proof-action').value=saved.request.action;
 applyChainView();
}
async function api(path, body) {
  const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Bridge-Request':'1'}:{},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok) throw new Error(data.error||'증명 서버 요청 실패');return data;
}
function useManifest(data) {
  clearPreview();manifest=validateManifest(data);scopeSession();packageData=null;client=null;
  if(manifest.proofPolicy==='trusted-rpc-receipt-root')$('proof-status').textContent='신뢰 RPC 모드: 대상 블록 root 자동 등록 · 헤더 승인 없이 청구 가능';
  if(manifest.computationPolicy==='risc0-receipt-computation')$('proof-status').textContent='RISC0 연산 증명 필수 · 거래 root 자동 등록 · 사용자 직접 청구';
  if(!window.ethereum || typeof window.ethereum.request!=='function') {
    $('account').textContent='확장 지갑을 감지하지 못했습니다. 일반 Chrome·Edge의 지갑 확장이 활성화된 창에서 이 페이지를 열고 새로고침하세요. 앱 내장 브라우저에서는 확장 지갑을 사용할 수 없을 수 있습니다.';
    $('wallet-help').hidden=false;controls();return;
  }
  $('wallet-help').hidden=true;$('account').textContent='지갑 감지됨 · 지갑 연결 버튼을 누르세요.';
  client=new WalletClient(window.ethereum,manifest);
  for(const event of ['chainChanged','accountsChanged','disconnect']) client.provider.on?.(event,()=>{clearPreview();controls();});
}
$('load-service').onclick=()=>task(async()=>{
  useManifest(await api('/api/manifest'));status(client?'서버 세션을 불러왔습니다. 지갑을 연결하세요.':'서버 세션은 정상입니다. 아래 지갑 연결 안내를 확인하세요.');
});
$('request-proof').onclick=()=>task(async()=>{
  if(!client) throw new Error('서버 세션과 지갑을 먼저 연결하세요.');
  clearPreview();packageData=null;
  const request={action:$('proof-action').value,transferId:$('transfer-id').value.trim(),fromBlock:Number($('from-block').value)};
  const job=await api('/api/jobs',request);localStorage.setItem(serviceStorage,JSON.stringify({id:job.id,request}));
  $('proof-status').textContent=job.detail;status('요청을 저장했습니다. 준비되면 패키지를 자동으로 불러옵니다.');
  $('poll-proof').click();
});
let proofPollBusy=false;
$('poll-proof').onclick=()=>task(async()=>{
  if(proofPollBusy)return;
  proofPollBusy=true;
  try {
  clearPreview();packageData=null;
  const saved=JSON.parse(localStorage.getItem(serviceStorage)||'null');
  if(!saved) throw new Error('저장된 증명 요청이 없습니다.');
  const job=await api('/api/jobs/'+saved.id);$('proof-status').textContent=job.state+' · '+job.detail;
  if(job.state==='ready') {
    if(!manifest) throw new Error('서버 세션을 먼저 불러오세요.');
    const p=await api('/api/jobs/'+saved.id+'/package');
    {
      validatePackage(p,manifest);
      if(manifest.computationPolicy==='risc0-receipt-computation') {
        if(!client)throw new Error('지갑을 먼저 연결하세요.');
        await client.verifyComputation(p);
      }
    }
    packageData=p;computationStatus(p);
    $('proof-status').textContent='패키지 수신 완료 · 블록 '+(p.blockNumber??'')+' · JSON 다운로드 또는 자산 청구 가능';
    status('RISC0 연산 증명 준비 완료. 목적지로 전환하고 자산 청구 확인을 누르세요.');
  } else if(job.state==='failed') throw new Error(job.detail);
  } finally {proofPollBusy=false;}
});
const savedProof=JSON.parse(localStorage.getItem(serviceStorage)||'null');
if(savedProof) {
  $('proof-action').value=savedProof.request.action;$('transfer-id').value=savedProof.request.transferId;
  $('from-block').value=savedProof.request.fromBlock;$('proof-status').textContent='저장된 요청이 있습니다. 상태를 조회하세요.';
}

async function checkService(){
  try{const h=await api('/api/health');$('service-health').textContent=h.status==='ok'?'● 서버 연결됨':'서버 상태 확인 필요';$('service-health').className=h.status==='ok'?'online':'';}
  catch{$('service-health').textContent='서버 연결 실패 · 세션 서버를 확인하세요.';}
}
checkService();

let chainPolling=false;
async function refreshChains(){
 if(chainPolling||document.hidden)return;chainPolling=true;
 try{
  const data=await api('/api/chains');
  for(const key of ['wl','bnb']){
   const c=data.chains[key];$(key+'-id').textContent=c.chainId;
   $(key+'-connection').textContent=c.connected?'● 연결 정상':'● 연결 오류';
   $('chain-'+key).classList.toggle('offline',!c.connected);
   if(c.connected){$(key+'-height').textContent=c.blockNumber.toLocaleString();$(key+'-hash').textContent=c.blockHash;$(key+'-detail').textContent='블록 시간 '+new Date(c.blockTimestamp*1000).toLocaleTimeString('ko-KR')+' · 블록 내 거래 '+c.transactions+'건';}
   else $(key+'-detail').textContent=c.error+' · 표시된 블록은 마지막 조회값입니다.';
  }
  $('chain-updated').textContent='확인 '+new Date(data.checkedAt*1000).toLocaleTimeString('ko-KR')+' · 5초마다 갱신';
 }catch{
  $('chain-updated').textContent='상태 조회 실패 · 자동 재시도 중';
  for(const key of ['wl','bnb']){$(key+'-connection').textContent='● 상태 확인 불가';$('chain-'+key).classList.add('offline');$(key+'-detail').textContent='서버 연결을 확인하세요. 표시된 블록은 마지막 조회값입니다.';}
 }finally{chainPolling=false;}
}
refreshChains();setInterval(refreshChains,5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshChains();});

$('copy-wallet-url').onclick=()=>task(async()=>{await navigator.clipboard.writeText(location.origin+'/');status('주소를 복사했습니다. 확장 지갑이 있는 일반 브라우저 주소창에 붙여넣으세요.');});

$('demo-wallet').onclick=()=>task(async()=>{
 if(!manifest)manifest=validateManifest(await api('/api/manifest'));
 scopeSession();
 const provider=new DemoWallet(manifest);clearPreview();packageData=null;client=new WalletClient(provider,manifest);
 provider.on('chainChanged',()=>{clearPreview();controls();});
 $('account').textContent='로컬 데모 계정 · '+(await client.connect())[0];await client.switchChain(selectedChain==='wl'?31337:31338);$('wallet-help').hidden=true;
 status(localStorage.getItem(storage)?'데모 지갑 연결 완료. 미확인 거래가 있습니다. 저장된 거래 상태 조회를 먼저 누르세요.':'데모 지갑 연결 완료. 체인 탭을 선택하고 보낼 토큰 수량 입력 → 거래 확인을 진행하세요.');
 refreshWallet();
});

function saveEventInputs(){
 if(!manifest)return;
 localStorage.setItem(serviceStorage+'-event',JSON.stringify({request:{action:$('proof-action').value,transferId:$('transfer-id').value,fromBlock:Number($('from-block').value)}}));
}
for(const field of ['proof-action','transfer-id','from-block'])$(field).addEventListener('input',saveEventInputs);
$('recover-event').onclick=()=>task(async()=>{
 if(!client)throw Error('먼저 지갑을 연결하세요.');
 const action=$('proof-action').value,chain=action==='lock'?31337:31338;
 await client.switchChain(chain);const owner=(await client.rpc('eth_accounts'))[0];await client.context(chain,owner);
 const height=Number(BigInt(await client.rpc('eth_blockNumber')));
 const topic=id(action==='lock'?'Locked(bytes32,address,address,uint256,uint64,uint256)':'Burned(bytes32,address,address,uint256,uint64,uint256)');
 $('event-list').replaceChildren();let count=0;
 for(let end=height;end>=0;end-=2000){
  await client.context(chain,owner);
  const start=Math.max(0,end-1999);
  $('event-progress').textContent='전체 이벤트 조회 중 · 블록 '+start+'–'+end+' · 찾은 거래 '+count+'건';
  const logs=await client.rpc('eth_getLogs',[{address:manifest.contracts[action==='lock'?'original':'wrapped'],fromBlock:'0x'+start.toString(16),toBlock:'0x'+end.toString(16),topics:[topic,null,'0x'+'0'.repeat(24)+owner.slice(2)]}]);
  await client.context(chain,owner);
  for(const event of logs.filter(x=>!x.removed).reverse()){
   count++;const block=Number(BigInt(event.blockNumber));
   const row=document.createElement('article');row.className='chain-card';
   const title=document.createElement('p');title.textContent=(action==='lock'?'잠금':'소각')+' · 블록 '+block+' · 수량 '+formatUnits(BigInt('0x'+event.data.slice(2,66)),18);
   const code=document.createElement('code');code.textContent=event.topics[1];
   const tx=document.createElement('p');tx.textContent='거래 '+event.transactionHash;
   const select=document.createElement('button');select.textContent='이 거래 선택';
   const claimStatus=document.createElement('p');claimStatus.className='event-claim-status';claimStatus.textContent='청구 여부 확인 중';
   try{
    const method=action==='lock'?'claimedTransfer':'claimedWithdrawal';
    const abi=new Interface(['function '+method+'(bytes32) view returns (bool)']);
    const response=await fetch('/rpc/'+(action==='lock'?'bnb':'wl'),{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:manifest.contracts[action==='lock'?'mint':'unlock'],data:abi.encodeFunctionData(method,[event.topics[1]])},'latest']}),signal:AbortSignal.timeout(10000)});
    const data=await response.json();if(!response.ok||data.error)throw Error('청구 조회 실패');
    const claimed=abi.decodeFunctionResult(method,data.result)[0];
    claimStatus.textContent=claimed?'청구 완료':'미청구';claimStatus.dataset.state=claimed?'claimed':'unclaimed';
    if(claimed){select.disabled=true;select.textContent='청구 완료';}
   }catch{claimStatus.textContent='청구 여부 확인 불가 · 다시 조회하세요';claimStatus.dataset.state='unknown';select.disabled=true;}

   select.onclick=()=>{clearPreview();packageData=null;$('proof-action').value=action;$('transfer-id').value=event.topics[1];$('from-block').value=block;saveEventInputs();controls();status('이벤트를 선택했습니다. 블록 '+block+' · 증명 요청을 누르세요. 이미 청구한 거래는 다시 청구할 수 없습니다.');};
   row.append(title,claimStatus,code,tx,select);$('event-list').append(row);
  }
 }
 $('event-progress').textContent='블록 0–'+height+' 전체 조회 완료 · '+count+'건 · 원하는 거래를 선택하세요.';
 status('전체 '+(action==='lock'?'잠금':'소각')+' 이벤트 '+count+'건을 조회했습니다.');
});

// Poll pending requests after connection and stop once the package is loaded.
setInterval(()=>{
 if(proofPollBusy||!manifest||packageData||document.hidden||!localStorage.getItem(serviceStorage))return;
 $('poll-proof').click();
},3000);

$('download-package').onclick=()=>{
 if(!packageData)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(packageData,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='bridge-proof-'+(packageData.transferId||'header')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

const balanceInterface=new Interface(['function balanceOf(address) view returns (uint256)','function availableBalanceOf(address) view returns (uint256)']);
let walletRefreshBusy=false;
async function refreshWallet(){
 if(walletRefreshBusy||document.hidden||!client||!manifest)return;
 walletRefreshBusy=true;
 try{
  const activeClient=client,activeManifest=manifest;
  const accounts=await client.rpc('eth_accounts');const owner=accounts[0];
  if(!owner){$('wallet-summary').textContent='지갑 미연결';return;}
  const network=Number(BigInt(await client.rpc('eth_chainId')));
  const read=async(chain,method,params)=>{const response=await fetch('/rpc/'+chain,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok||data.error)throw Error(data.error?.message||'잔액 조회 실패');return data.result;};
  const token=async(chain,name,method)=>balanceInterface.decodeFunctionResult(method,await read(chain,'eth_call',[{to:activeManifest.contracts[name],data:balanceInterface.encodeFunctionData(method,[owner])},'latest']))[0];
  const [original,available,wrapped,wlGas,bnbGas]=await Promise.all([token('wl','original','balanceOf'),token('wl','original','availableBalanceOf'),token('bnb','wrapped','balanceOf'),read('wl','eth_getBalance',[owner,'latest']),read('bnb','eth_getBalance',[owner,'latest'])]);
  if(client!==activeClient||manifest!==activeManifest||(await client.rpc('eth_accounts'))[0]?.toLowerCase()!==owner.toLowerCase())return;
  $('wallet-summary').textContent=owner+' · 현재 네트워크 '+(network===31337?'WorldLand':network===31338?'BNB':network);
  for(const [element,value] of [['wallet-original',original],['wallet-available',available],['wallet-locked',original-available],['wallet-wrapped',wrapped],['wallet-wl-gas',BigInt(wlGas)],['wallet-bnb-gas',BigInt(bnbGas)]])$(element).textContent=formatUnits(value,18);
  $('wallet-updated').textContent='갱신 '+new Date().toLocaleTimeString()+' · 5초마다 자동 갱신';
 }catch(error){$('wallet-updated').textContent='잔액 조회 실패 · 이전 값은 최신 상태가 아닙니다: '+error.message;}
 finally{walletRefreshBusy=false;}
}
setInterval(refreshWallet,5000);

function applyChainView(){
 const wl=selectedChain==='wl';
 for(const name of ['wl','bnb']){const active=name===selectedChain;$('tab-'+name).setAttribute('aria-pressed',String(active));$('chain-'+name).hidden=false;$('balance-'+name).hidden=false;}
 $('chain-view-title').textContent=wl?'WorldLand · 원본 잠금과 반환 청구':'BNB · wrapped 소각과 발행 청구';
 $('action-title').textContent=wl?'2. 원본 잠금 → BNB로 보내기':'2. wrapped 소각 → WorldLand로 반환';
 $('claim-title').textContent=wl?'4. BNB에서 소각한 자산 반환 청구':'4. WorldLand에서 잠근 자산 발행 청구';
 $('action').value=wl?'lock':'burn';$('proof-action').value=wl?'lock':'burn';
 $('go-destination').textContent=wl?'BNB 화면에서 청구하기':'WorldLand 화면에서 청구하기';
 controls();
}
async function selectChain(name){
 clearPreview();selectedChain=name;applyChainView();$('transfer-id').value='';$('from-block').value=0;$('event-list').replaceChildren();$('event-progress').textContent='';
 if(client)await client.switchChain(name==='wl'?31337:31338);
 refreshWallet();
}
for(const name of ['wl','bnb'])$('tab-'+name).onclick=()=>task(()=>selectChain(name));
$('go-destination').onclick=()=>task(()=>selectChain(packageData.destinationChainId===31337?'wl':'bnb'));
applyChainView();

let auditRecords=[],transactionRecords=[],auditSnapshot=null,auditRefreshBusy=false;
async function refreshAudit(){
 if(auditRefreshBusy)return;auditRefreshBusy=true;
 try{
  auditRecords=[];transactionRecords=[];let after=0;
  for(;;){const data=await api('/api/audit?after='+after+'&limit=200');auditSnapshot=data;auditRecords.push(...data.records);if(!data.records.length||data.nextAfter>=data.total)break;after=data.nextAfter;}
  auditHalted=!!auditSnapshot.halted;if(auditHalted)clearPreview();controls();
  const state=$('audit-state');state.textContent=(auditSnapshot.halted?'긴급 정지 · 신규 증명 제공 중단':'감사 감시 중')+' · '+(auditSnapshot.onchainClaimStopSupported?'계약 청구 정지 지원':'기존 계약: 직접 청구 정지 미지원 · 새 배포에서 적용')+(auditSnapshot.anchorPending?' · 체인 감사 해시 등록 대기':'')+(auditSnapshot.monitorError?' · 감시/등록 오류: '+auditSnapshot.monitorError:'');
  $('audit-log').replaceChildren();
  for(const row of auditRecords.slice().reverse()){const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='#'+row.sequence+' · '+new Date(row.time*1000).toLocaleString()+' · '+row.kind+' · '+(row.data.state||'');pre.textContent=JSON.stringify(row,null,2);detail.append(summary,pre);$('audit-log').append(detail);}
  $('transaction-log').replaceChildren();
  for(const chain of ['wl','bnb']){let from=0;for(;;){const data=await api('/api/transactions?chain='+chain+'&from='+from);transactionRecords.push(...data.logs.map(log=>({chain,...log})));if(data.nextBlock>data.latestBlock)break;from=data.nextBlock;}}
  const eventNames=new Map([
   ['Locked(bytes32,address,address,uint256,uint64,uint256)','원본 잠금'],['Burned(bytes32,address,address,uint256,uint64,uint256)','wrapped 소각'],['LockClaimed(bytes32,address,uint256)','발행 청구 완료'],['BurnClaimed(bytes32,address,uint256)','반환 청구 완료'],['HeaderRegistered(uint256,uint256,bytes32,bytes32)','신뢰 root 등록'],['AuditCommitted(uint256,bytes32,bytes32)','감사 해시 등록'],['EmergencyStopped(bytes32)','긴급 정지'],['Transfer(address,address,uint256)','토큰 잔액 이동'],['Approval(address,address,uint256)','토큰 승인']
  ].map(([signature,label])=>[id(signature),label]));
  for(const row of transactionRecords.slice().reverse()){const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=(row.chain==='wl'?'WorldLand':'BNB')+' · 블록 '+Number(BigInt(row.blockNumber))+' · 거래 '+row.transactionHash+' · '+(eventNames.get(row.topics[0])||'계약 이벤트')+' #'+Number(BigInt(row.logIndex));pre.textContent=JSON.stringify(row,null,2);detail.append(summary,pre);$('transaction-log').append(detail);}
  $('export-audit').disabled=false;
 }catch(error){$('audit-state').textContent='감사 조회 실패 · '+error.message;}
 finally{auditRefreshBusy=false;}
}
$('refresh-audit').onclick=refreshAudit;
$('export-audit').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({snapshot:auditSnapshot,audit:auditRecords,transactions:transactionRecords},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bridge-audit-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
refreshAudit();setInterval(()=>{if(!document.hidden)refreshAudit();},15000);
