import {SignedClient,abi,api,rpc,read,recoverPending,same,validateManifest} from './signature-client.mjs';
import {DemoWallet} from './demo-wallet.mjs';
import {formatUnits,parseUnits} from './vendor/ethers-6.15.0.min.mjs';
const $=id=>document.getElementById(id);
const units=x=>formatUnits(BigInt(x),18);
const names={deposit:'WL 예치·xWL 발행',redeem:'xWL 소각·WL 상환',bridgeBurn:'브리지 소각',claim:'목적지 토큰 발행',transfer:'토큰 전송',approve:'사용 승인',transferFrom:'대리 전송'};
let manifest,client,owner,preview,pkg,busy=false;
const key=()=>`bnc-signed-${manifest.sessionId}-${owner.toLowerCase()}-pending`;
function pending(){try{return owner?JSON.parse(localStorage.getItem(key())):null;}catch{return null;}}
function save(value){if(value)localStorage.setItem(key(),JSON.stringify(value));else localStorage.removeItem(key());controls();}
function status(text,error=false){$('status').textContent=text;$('status').toggleAttribute('data-error',error);}
function clearReview(){preview=null;$('review').hidden=true;controls();}
function controls(){
 for(const button of document.querySelectorAll('button'))button.disabled=busy;
 for(const input of document.querySelectorAll('input,select'))input.disabled=busy;
 const p=pending();
 for(const id of ['prepare-wrap','prepare-burn','prepare-token'])$(id).disabled=busy||!client||!!p;
 $('attest').disabled=busy||!manifest;
 $('submit').disabled=busy||!preview||!!p;
 $('prepare-claim').disabled=busy||!client||!pkg||pkg.state==='claimed'||!!p;
 $('download-package').disabled=busy||!pkg;
 $('pending-panel').hidden=!p;
 $('pending-description').textContent=p?`${names[p.op]} · ${p.chain==='wl'?'체인 A':'체인 B'} · ${p.transactionHash||'지갑 응답 확인 필요'}`:'';
 $('recover').disabled=busy||!p;
}
async function task(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){status(e.shortMessage||e.message,true);}finally{busy=false;controls();}}
function tab(name){for(const panel of document.querySelectorAll('section.panel'))if(['wrap','bridge','transfer','records'].includes(panel.id))panel.hidden=panel.id!==name;for(const b of document.querySelectorAll('nav button'))b.classList.toggle('selected',b.dataset.tab===name);clearReview();}
function amount(id){const v=parseUnits($(id).value.trim(),18);if(v<0n||v>=2n**256n)throw Error('수량을 확인하세요.');return v.toString();}
async function balances(){
 if(!owner)return;
 const [wl,xwl,wwl]=await Promise.all([rpc('wl','eth_getBalance',[owner,'latest']),read('wl',manifest.contracts.xwl,'balanceOf',[owner]),read('bnb',manifest.contracts.wwl,'balanceOf',[owner])]);
 $('balances').textContent=`${units(wl)} WL · ${units(xwl)} xWL · ${units(wwl)} wWL`;
}
async function connect(demo){
 const provider=demo?new DemoWallet(manifest,Number($('demo-index').value)):window.ethereum;
 if(!provider)throw Error('확장 지갑을 찾을 수 없습니다.');
 client=new SignedClient(manifest,provider);owner=await client.connect();clearReview();
 provider.on?.('accountsChanged',()=>{client=null;preview=null;$('review').hidden=true;status('지갑 계정이 바뀌었습니다. 다시 연결하세요.');controls();});
 provider.on?.('chainChanged',()=>{preview=null;$('review').hidden=true;controls();});
 $('owner').textContent=owner;
 for(const id of ['wrap-recipient','bridge-recipient','token-recipient','token-from'])if(!$(id).value)$(id).value=owner;
 await balances();status('지갑이 연결됐습니다. 작업을 선택하세요.');
}
function showReview(value){
 preview=value;
 $('transaction-review').textContent=[names[value.op],value.chain==='wl'?'체인 A · WorldLand (31337)':'체인 B (31338)',`수량: ${units(value.amount)}`,`서명자: ${value.owner}`,`수령인: ${value.recipient}`,`대상 계약: ${value.transaction.to}`,value.op==='claim'?`소각 ID: ${value.pkg.message.burnId}`:''].filter(Boolean).join('\n');
 $('review').hidden=false;controls();
}
function displayPackage(value){
 pkg=value;$('package').hidden=false;$('package-review').replaceChildren();
 for(const [label,text] of [['방향',value.source==='wl'?'xWL → wWL':'wWL → xWL'],['수량',units(value.message.amount)],['수령인',value.message.recipient],['서명자',value.signer],['원본 거래',value.message.sourceTxHash],['상태',value.state==='claimed'?'발행 완료':value.state==='expired'?'만료 · 서명 다시 받기':'서명 발급 완료']]){
  const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=text;$('package-review').append(dt,dd);
 }
 $('package-json').textContent=JSON.stringify(value,null,2);controls();
}
async function attest(){
 const value=await api('/api/attest',{source:$('bridge-source').value,transactionHash:$('burn-hash').value.trim()});
 displayPackage(value);status(value.state==='claimed'?'이미 발행한 소각 건입니다.':'서명을 받았습니다. 원문을 확인하고 발행 청구를 검토하세요.');
}
async function finishPending(){
 const p=pending();if(!p)return false;
 const result=await recoverPending(p);
 if(!result){status('아직 확정되지 않았습니다. 자산 거래를 다시 보내지 말고 상태를 확인하세요.');return false;}
 save(null);clearReview();
 if(!result.success)throw Error('거래가 되돌려졌습니다. 잔액과 조건을 확인한 뒤 다시 검토하세요.');
 if(p.op==='bridgeBurn'){$('burn-hash').value=result.transactionHash;$('bridge-source').value=p.chain;pkg=null;$('package').hidden=true;tab('bridge');}
 if(p.op==='claim'&&pkg)displayPackage({...pkg,state:'claimed'});
 await balances();status(`거래 완료 · ${names[p.op]} · ${result.transactionHash}`);return true;
}
async function records(){
 const [a,b,packages]=await Promise.all([api('/api/events?chain=wl'),api('/api/events?chain=bnb'),api('/api/packages')]);
 $('records-list').replaceChildren();
 for(const [chain,values] of [['wl',a],['bnb',b]])for(const log of values.logs){
  let parsed;try{parsed=abi.parseLog(log);}catch{continue;}
  if(!parsed||!['Deposited','Redeemed','BridgeBurned','BridgeClaimed'].includes(parsed.name))continue;
  const node=document.createElement('div');node.className='record';const title=document.createElement('strong');title.textContent=`${chain==='wl'?'체인 A':'체인 B'} · ${{Deposited:'WL 예치',Redeemed:'WL 상환',BridgeBurned:'브리지 소각',BridgeClaimed:'토큰 발행'}[parsed.name]} · ${units(parsed.args.amount)}`;node.append(title);
  const hash=document.createElement('div');hash.textContent=log.transactionHash;node.append(hash);
  if(parsed.name==='BridgeBurned'){
   const signed=packages.packages.find(x=>same(x.message.burnId,parsed.args.burnId));
   const button=document.createElement('button');button.textContent=signed?.state==='claimed'?'발행 완료 · 원문 보기':'이어서 진행';
   button.addEventListener('click',()=>{tab('bridge');$('bridge-source').value=chain;$('burn-hash').value=log.transactionHash;if(signed)displayPackage(signed);else {pkg=null;$('package').hidden=true;}status('소각 기록을 불러왔습니다.');});node.append(button);
  }
  $('records-list').append(node);
 }
 if(!$('records-list').children.length)$('records-list').textContent='아직 거래 기록이 없습니다.';
}
for(const b of document.querySelectorAll('nav button'))b.addEventListener('click',()=>{tab(b.dataset.tab);if(b.dataset.tab==='records')task(records);});
for(const e of document.querySelectorAll('input,select'))e.addEventListener('input',()=>{clearReview();if(e.id==='bridge-source'){pkg=null;$('package').hidden=true;}});
$('connect-demo').onclick=()=>task(()=>connect(true));$('connect-extension').onclick=()=>task(()=>connect(false));
$('prepare-wrap').onclick=()=>task(async()=>showReview(await client.prepare($('wrap-op').value,amount('wrap-amount'),$('wrap-recipient').value.trim())));
$('prepare-burn').onclick=()=>task(async()=>showReview(await client.prepare('bridgeBurn',amount('bridge-amount'),$('bridge-recipient').value.trim(),$('bridge-source').value)));
$('prepare-token').onclick=()=>task(async()=>showReview(await client.prepare($('token-op').value,amount('token-amount'),$('token-recipient').value.trim(),$('token-chain').value,$('token-from').value.trim())));
$('attest').onclick=()=>task(attest);
$('prepare-claim').onclick=()=>task(async()=>showReview(await client.prepare('claim',null,null,null,null,pkg)));
$('cancel-review').onclick=clearReview;
$('recover').onclick=()=>task(finishPending);
$('refresh-records').onclick=()=>task(records);
$('submit').onclick=()=>task(async()=>{
 const reviewed=preview;await client.send(reviewed,save);
 for(let i=0;i<20;i++){if(await finishPending())return;await new Promise(r=>setTimeout(r,250));}
});
$('download-package').onclick=()=>{const blob=new Blob([JSON.stringify(pkg,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`bridge-${pkg.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
try{
 manifest=validateManifest(await api('/api/manifest'));
 $('contracts').textContent=`체인 A xWL · Vault ${manifest.contracts.xwl} / 체인 B wWL ${manifest.contracts.wwl}`;
 status('로컬 브리지가 준비됐습니다. 지갑을 연결하세요.');
}catch(e){status(e.message,true);}controls();
