// Local browser-signed V2 roundtrip with real composite proofs. Resumable between stages.
import {chromium,launchOptions} from './browser-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const output=process.env.BNC_EVIDENCE_DIR||fileURLToPath(new URL('../results/burn-mint-guarded-validation',import.meta.url));
await fs.mkdir(output,{recursive:true});
const checkpoint=path.join(output,'browser-resume.json');
let result;try{result=JSON.parse(await fs.readFile(checkpoint,'utf8'));}catch{result={passed:false,stages:[],proofs:[],dialogs:0};}
const browser=await chromium.launch(launchOptions),page=await browser.newPage({viewport:{width:1440,height:1100}});
const save=()=>fs.writeFile(checkpoint,JSON.stringify(result,null,2)+'\n');
page.on('dialog',async d=>{result.dialogs++;await d.accept();});
page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
const url=process.env.BNC_DEMO_URL||'http://127.0.0.1:8581/burn-mint.html';
async function open(name) {
  const target=new URL(name+'.html',url).href;
  if(page.url()!==target)await page.goto(target);
  await page.waitForFunction(()=>document.getElementById('status')?.textContent.includes('V2 준비 완료')||document.querySelector('#step-wallet[data-state="done"]'));
}
async function connect(index) {await page.locator('#account').selectOption(String(index));await page.locator('#demo-wallet').click();await page.waitForFunction(()=>/^0x[0-9a-f]{40}$/i.test(document.getElementById('owner').textContent));}
async function accepted() {
  await page.waitForFunction(()=>/거래가 (수락|확인)됐습니다/.test(document.getElementById('status').textContent),{},{timeout:30000});
}
async function transact(index,chain,method,amount,recipient,from) {
  await open(method==='burn'?(chain===31337?'burn-wl':'burn-bsc'):'burn-mint-tools');
  await connect(index);
  if(method!=='burn'){await page.locator('#chain').selectOption(String(chain));await page.locator('#action').selectOption(method);}
  await page.locator('#amount').fill(amount);await page.locator('#recipient').fill(recipient);if(from)await page.locator('#from').fill(from);
  await page.locator('#prepare-action').click();await page.waitForFunction(()=>!document.getElementById('submit').disabled,{},{timeout:30000});
  await page.locator('#submit').click();await accepted();
}
async function restore(request) {
  const details=page.locator('#proof-recovery');
  if(await details.getAttribute('open')===null)await details.locator('summary').click();
  await page.locator('#transfer-id').fill(request.transferId);
  await page.locator('#from-block').fill(String(request.fromBlock));
  await page.locator('#restore-burn').click();
  await page.locator('#step-burn[data-state="done"]').waitFor();
}
async function proof(action) {
  const burn={action,transferId:await page.locator('#transfer-id').inputValue(),fromBlock:Number(await page.locator('#from-block').inputValue())};
  result.pendingBurn=burn;await save();
  await page.locator('#request-proof').click();console.log(action+': waiting for real composite proof');
  await page.waitForFunction(()=>!document.getElementById('download-package').disabled||document.getElementById('proof-status').textContent.includes('실패'),{},{timeout:1850000});
  if((await page.locator('#proof-status').innerText()).includes('실패'))throw Error(await page.locator('#proof-status').innerText());
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-package').click()]);
  const file=path.join(output,action+'-package.json');await download.saveAs(file);const p=JSON.parse(await fs.readFile(file,'utf8'));
  result.proofs=result.proofs.filter(row=>row.action!==action);
  result.proofs.push({action,file,transferId:p.transferId,sourceBlock:p.blockNumber,receiptSHA256:p.computationProof.receiptSHA256,imageId:p.computationProof.imageId});await save();
  await page.locator('#package').setInputFiles(file);await page.waitForFunction(()=>document.getElementById('status').textContent.includes('SDK 재검증'));
  return p;
}
async function claim(index) {await connect(index);await page.locator('#prepare-claim').click();await page.waitForFunction(()=>!document.getElementById('submit').disabled,{},{timeout:30000});await page.locator('#submit').click();await accepted();}
async function stage(name,fn) {
  if(result.stages.includes(name))return;
  console.log('START '+name);await fn();result.stages.push(name);delete result.pendingBurn;await save();console.log('PASS '+name);
}
try {
  await open('burn-wl');
  const m=await page.evaluate(async()=>await(await fetch('/api/manifest')).json());result.sessionId=m.sessionId;
  const [A,B,C]=m.users;
  await stage('wl-burn',async()=>{await transact(1,31337,'burn','10',A);result.forwardRequest={action:'burn-wl',transferId:await page.locator('#transfer-id').inputValue(),fromBlock:Number(await page.locator('#from-block').inputValue())};});
  await stage('bsc-mint',async()=>{
    await open('burn-wl');await connect(1);await restore(result.forwardRequest);
    await proof('burn-wl');await claim(1);
  });
  await stage('A-transfer-B',()=>transact(1,31338,'transfer','3',B));
  await stage('A-approve-C',()=>transact(1,31338,'approve','7',C));
  await stage('C-transferFrom-A',()=>transact(3,31338,'transferFrom','7',C,A));
  await stage('B-transfer-C',()=>transact(2,31338,'transfer','3',C));
  await stage('C-partial-burn-recipient-B',async()=>{await transact(3,31338,'burn','4',B);result.reverseRequest={action:'burn-bsc',transferId:await page.locator('#transfer-id').inputValue(),fromBlock:Number(await page.locator('#from-block').inputValue())};});
  await stage('wl-mint-B',async()=>{
    await open('burn-bsc');await connect(3);await restore(result.reverseRequest);
    await proof('burn-bsc');await claim(2);
  });
  result.checks=await page.evaluate(async proofs=>{
    const {Interface}=await import('/vendor/ethers-6.15.0.min.mjs');const {validatePackage,WalletClient}=await import('/client.mjs');const {DemoWallet}=await import('/demo-wallet.mjs');
    const m=await(await fetch('/api/manifest')).json(),abi=new Interface(['function totalSupply() view returns(uint256)','function totalBridgeBurned() view returns(uint256)','function totalBridgeMinted() view returns(uint256)','function balanceOf(address) view returns(uint256)']);
    async function read(chain,name,args=[]) {const to=m.contracts[chain==='wl'?'original':'wrapped'];const r=await(await fetch('/rpc/'+chain,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data:abi.encodeFunctionData(name,args)},'latest']})})).json();if(r.error)throw Error(r.error.message);return abi.decodeFunctionResult(name,r.result)[0].toString();}
    const checks={negative:[],balances:{wl:[],bnb:[]},supply:{}};
    for(const chain of ['wl','bnb']){for(const user of m.users)checks.balances[chain].push(await read(chain,'balanceOf',[user]));checks.supply[chain]={};for(const method of ['totalSupply','totalBridgeBurned','totalBridgeMinted'])checks.supply[chain][method]=await read(chain,method);}
    if(checks.balances.wl.join(',')!==['90000000000000000000','104000000000000000000','100000000000000000000'].join(',')||checks.balances.bnb.join(',')!==['0','0','6000000000000000000'].join(','))throw Error('holder balances differ');
    if(BigInt(checks.supply.wl.totalSupply)+BigInt(checks.supply.bnb.totalSupply)!==1000n*10n**18n)throw Error('supply conservation failed');
    if(checks.supply.wl.totalBridgeBurned!==checks.supply.bnb.totalBridgeMinted||checks.supply.bnb.totalBridgeBurned!==checks.supply.wl.totalBridgeMinted)throw Error('cumulative accounting failed');
    for(const p of proofs) {
      for(const [label,mutate] of [['recipient',p=>p.recipient=m.users[2]],['amount',p=>p.amount='1'],['chain',p=>p.destinationChainId=56],['asset',p=>p.destinationToken=m.users[0]],['missing-proof',p=>delete p.computationProof],['old-image',p=>p.computationProof.imageId='1d2847d6a7fa72e1a9b5d20444ec043818da086c2ed952493243499702021d21']]){const copy=structuredClone(p);mutate(copy);let rejected=false;try{validatePackage(copy,m);}catch{rejected=true;}if(!rejected)throw Error(label+' accepted');checks.negative.push(p.action+':'+label);}
      const wallet=new DemoWallet(m,p.action==='burn-wl'?1:2),client=new WalletClient(wallet,m);await client.switchChain(p.destinationChainId);let replay=false;try{await client.preview(p);}catch(e){if(e.message.includes('already accepted'))replay=true;else throw e;}if(!replay)throw Error('replay accepted');checks.negative.push(p.action+':replay');
      const copy=structuredClone(p),raw=Uint8Array.from(atob(copy.computationProof.receiptBase64),c=>c.charCodeAt(0));raw[raw.length-1]^=1;let encoded='';for(let i=0;i<raw.length;i+=8192)encoded+=String.fromCharCode(...raw.slice(i,i+8192));copy.computationProof.receiptBase64=btoa(encoded);copy.computationProof.receiptSHA256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');const r=await fetch('/api/computation/verify',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify(copy)});if(r.ok)throw Error('tampered receipt accepted');checks.negative.push(p.action+':SDK-seal-tamper');
    }
    return checks;
  },await Promise.all(['burn-wl','burn-bsc'].map(async action=>JSON.parse(await fs.readFile(path.join(output,action+'-package.json'),'utf8')))));
  await page.goto(new URL('burn-bsc.html',url).href);await connect(3);await page.locator('#proof-recovery summary').click();await page.locator('#discover').click();await page.waitForFunction(()=>document.querySelector('#events button')?.textContent.includes('발행 완료'));
  await page.screenshot({path:path.join(output,'burn-mint-ui.png'),fullPage:true});result.reloadAndHistoryVerified=true;result.passed=true;delete result.error;await save();
}catch(e){result.error=e.stack;await page.screenshot({path:path.join(output,'browser-failure.png'),fullPage:true}).catch(()=>{});await save();throw e;}
finally{await fs.writeFile(path.join(output,'browser-summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));await browser.close();}
