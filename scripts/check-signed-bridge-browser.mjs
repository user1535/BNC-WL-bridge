import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Interface} from '../wallet/vendor/ethers-6.15.0.min.mjs';
const {chromium}=await import(process.env.BNC_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),out=process.env.BNC_SIGNED_VALIDATION_DIR||path.join(root,'results/signed-bridge-validation');
await fs.mkdir(out,{recursive:true});
const base=process.env.BNC_SIGNED_URL||'http://127.0.0.1:8580',phase=process.argv[2]||'forward';
const manifest=await (await fetch(base+'/api/manifest')).json();
let report;try{report=JSON.parse(await fs.readFile(path.join(out,'browser-summary.json'),'utf8'));}catch{report={protocol:manifest.protocol,steps:{},negative:[],phases:{}};}
if(report.sessionId&&report.sessionId!==manifest.sessionId)throw Error('validation belongs to a different session');
report.sessionId=manifest.sessionId;
if(report.phases[phase]==='passed'){console.log(JSON.stringify({phase,alreadyCompleted:true,assetTransactionsSent:0}));process.exit(0);}
const save=()=>fs.writeFile(path.join(out,'browser-summary.json'),JSON.stringify(report,null,2)+'\n');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage();
let dialogs=0,reject=false;const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',async d=>{dialogs++;if(reject){reject=false;await d.dismiss();}else await d.accept();});
async function ready(){await page.goto(base+'/signature.html');await page.waitForFunction(()=>document.getElementById('status').textContent.includes('준비됐습니다'));}
async function connect(index){await page.locator('#demo-index').selectOption(String(index));await page.locator('#connect-demo').click();await page.waitForFunction(address=>document.getElementById('owner').textContent.toLowerCase()===address.toLowerCase()&&!document.getElementById('connect-demo').disabled,manifest.users[index-1]);}
async function tab(value){await page.locator(`[data-tab="${value}"]`).click();}
async function fields(values){for(const [id,value] of Object.entries(values)){const input=page.locator('#'+id);if(await input.evaluate(e=>e.tagName==='SELECT'))await input.selectOption(String(value));else await input.fill(String(value));}}
async function perform(name,index,tabName,values,prepare){
 if(report.steps[name])return report.steps[name];
 await connect(index);await tab(tabName);await fields(values);await page.locator('#'+prepare).click();
 await page.waitForFunction(()=>!document.getElementById('review').hidden||document.getElementById('status').hasAttribute('data-error'));
 if(await page.locator('#status').getAttribute('data-error')!==null)throw Error(name+': '+await page.locator('#status').innerText());
 await page.locator('#submit').click();
 await page.waitForFunction(()=>document.getElementById('status').hasAttribute('data-error')||document.getElementById('review').hidden&&document.getElementById('pending-panel').hidden&&document.getElementById('status').textContent.startsWith('거래 완료'),null,{timeout:30000});
 const status=await page.locator('#status').innerText();if(await page.locator('#status').getAttribute('data-error')!==null)throw Error(name+': '+status);
 const transactionHash=status.match(/0x[0-9a-fA-F]{64}/)?.[0];if(!transactionHash)throw Error(name+': missing receipt hash');
 const result={transactionHash,index,values};report.steps[name]=result;await save();return result;
}
async function attest(source,hash){await tab('bridge');await fields({'bridge-source':source,'burn-hash':hash});await page.locator('#attest').click();await page.waitForFunction(()=>!document.getElementById('package').hidden||document.getElementById('status').hasAttribute('data-error'));if(await page.locator('#status').getAttribute('data-error')!==null)throw Error(await page.locator('#status').innerText());return JSON.parse(await page.locator('#package-json').textContent());}
async function claim(name,index,pkg){
 if(report.steps[name])return report.steps[name];
 await connect(index);await attest(pkg.source,pkg.message.sourceTxHash);
 await page.locator('#prepare-claim').click();await page.waitForFunction(()=>!document.getElementById('review').hidden||document.getElementById('status').hasAttribute('data-error'));
 if(await page.locator('#status').getAttribute('data-error')!==null)throw Error(name+': '+await page.locator('#status').innerText());
 await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('status').hasAttribute('data-error')||document.getElementById('review').hidden&&document.getElementById('pending-panel').hidden&&document.getElementById('status').textContent.startsWith('거래 완료'));
 if(await page.locator('#status').getAttribute('data-error')!==null)throw Error(name+': '+await page.locator('#status').innerText());
 report.steps[name]={transactionHash:(await page.locator('#status').textContent()).match(/0x[0-9a-fA-F]{64}/)[0],index};await save();
}
try{
 await ready();const [A,B,C]=manifest.users;
 if(phase==='forward'){
  await perform('deposit',1,'wrap',{'wrap-op':'deposit','wrap-amount':'10','wrap-recipient':A},'prepare-wrap');
  await perform('xwl-transfer',1,'transfer',{'token-chain':'wl','token-op':'transfer','token-amount':'4','token-recipient':B},'prepare-token');
  await perform('xwl-approve',2,'transfer',{'token-chain':'wl','token-op':'approve','token-amount':'4','token-recipient':C},'prepare-token');
  await perform('xwl-transferFrom',3,'transfer',{'token-chain':'wl','token-op':'transferFrom','token-amount':'4','token-recipient':C,'token-from':B},'prepare-token');
  await perform('local-redeem',3,'wrap',{'wrap-op':'redeem','wrap-amount':'1','wrap-recipient':A},'prepare-wrap');
  const burn=await perform('burn-xwl',3,'bridge',{'bridge-source':'wl','bridge-amount':'3','bridge-recipient':B},'prepare-burn');
  const p=await attest('wl',burn.transactionHash);report.forwardPackage=p;await save();
  await claim('mint-wwl',1,p);
  await perform('wwl-transfer',2,'transfer',{'token-chain':'bnb','token-op':'transfer','token-amount':'1','token-recipient':A},'prepare-token');
  const returning=await perform('burn-wwl-pending',1,'bridge',{'bridge-source':'bnb','bridge-amount':'1','bridge-recipient':C},'prepare-burn');
  report.returnPackage=await attest('bnb',returning.transactionHash);await save();
  // A transfer/local redemption must never authorize cross-chain issuance.
  for(const name of ['xwl-transfer','local-redeem']){
   const r=await fetch(base+'/api/attest',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({source:'wl',transactionHash:report.steps[name].transactionHash})});
   if(r.ok)throw Error('non-bridge transaction was signed');report.negative.push(name+':not-a-bridge-burn');
  }
 }else if(phase==='return'){
  await connect(3);await tab('records');await page.waitForSelector('.record button');
  const pending=report.returnPackage;
  if(!pending)throw Error('forward phase must finish first');
  await claim('return-xwl',2,pending);
  await perform('redeem-returned-xwl',3,'wrap',{'wrap-op':'redeem','wrap-amount':'1','wrap-recipient':B},'prepare-wrap');
  const burn=await perform('burn-remaining-wwl',2,'bridge',{'bridge-source':'bnb','bridge-amount':'2','bridge-recipient':A},'prepare-burn');
  const p=await attest('bnb',burn.transactionHash);await claim('mint-remaining-xwl',3,p);
  await perform('redeem-all-xwl',1,'wrap',{'wrap-op':'redeem','wrap-amount':'8','wrap-recipient':C},'prepare-wrap');
 }else if(phase==='recovery'){
  if(!report.steps['lost-response-deposit']){
  await connect(1);await page.evaluate(async()=>{
   const {DemoWallet}=await import('/demo-wallet.mjs');const original=DemoWallet.prototype.request;
   DemoWallet.prototype.request=async function(args){const result=await original.call(this,args);if(args.method==='eth_sendTransaction'){DemoWallet.prototype.request=original;throw Error('검증용: 전송 후 지갑 응답 손실');}return result;};
  });
  await tab('wrap');await fields({'wrap-op':'deposit','wrap-amount':'1','wrap-recipient':A});await page.locator('#prepare-wrap').click();await page.locator('#submit').click();
  await page.waitForFunction(()=>document.getElementById('status').hasAttribute('data-error')&&!document.getElementById('pending-panel').hidden);
  await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('준비됐습니다'));await connect(1);
  if(await page.locator('#prepare-wrap').isEnabled())throw Error('pending transaction can be resent after refresh');
  await page.locator('#recover').click();await page.waitForFunction(()=>document.getElementById('pending-panel').hidden&&document.getElementById('status').textContent.startsWith('거래 완료'));
  report.steps['lost-response-deposit']={transactionHash:(await page.locator('#status').textContent()).match(/0x[0-9a-fA-F]{64}/)[0]};await save();
  }
  await perform('recovery-redeem',1,'wrap',{'wrap-op':'redeem','wrap-amount':'1','wrap-recipient':A},'prepare-wrap');
  await connect(1);await tab('wrap');await fields({'wrap-op':'deposit','wrap-amount':'0','wrap-recipient':A});await page.locator('#prepare-wrap').click();await page.waitForFunction(()=>document.getElementById('status').hasAttribute('data-error'));
  if(await page.locator('#review').isVisible())throw Error('zero deposit can be signed');report.negative.push('zero-deposit');
  await fields({'wrap-amount':'1'});await page.locator('#prepare-wrap').click();await page.waitForSelector('#submit:not([disabled])');reject=true;await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('status').hasAttribute('data-error'));
  if(await page.locator('#pending-panel').isVisible())throw Error('wallet rejection leaves pending transaction');report.negative.push('wallet-rejection');
 }else if(phase==='expiry'){
  await perform('expiry-deposit',1,'wrap',{'wrap-op':'deposit','wrap-amount':'1','wrap-recipient':A},'prepare-wrap');
  const burn=await perform('expiry-burn-xwl',1,'bridge',{'bridge-source':'wl','bridge-amount':'1','bridge-recipient':B},'prepare-burn');
  let p=await attest('wl',burn.transactionHash);
  if(!report.expiryRenewal){
   report.expiredPackage=p;await save();
   const send=async(method,params)=>{const r=await fetch(manifest.chains.bnb.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
   await send('evm_setNextBlockTimestamp',[Number(p.message.deadline)+1]);await send('evm_mine',[]);
   const rejected=await page.evaluate(async({m,p})=>{const {verifyPackage}=await import('/signature-client.mjs');try{await verifyPackage(m,p);return false;}catch(e){return e.message.includes('만료');}},{m:manifest,p});
   if(!rejected)throw Error('expired package not rejected by browser');
   const renewed=await attest('wl',burn.transactionHash);
   if(renewed.message.burnId!==p.message.burnId||renewed.signature===p.signature||BigInt(renewed.message.deadline)<=BigInt(p.message.deadline))throw Error('expiry renewal changed burn or did not renew signature');
   report.expiryRenewal={sameBurnId:true,freshSignature:true,expiredSignatureRejected:true};report.negative.push('expired-package');p=renewed;await save();
  }
  await claim('expiry-mint-wwl',1,p);
  const back=await perform('expiry-burn-wwl',2,'bridge',{'bridge-source':'bnb','bridge-amount':'1','bridge-recipient':A},'prepare-burn');
  const returning=await attest('bnb',back.transactionHash);await claim('expiry-return-xwl',3,returning);
  await perform('expiry-redeem',1,'wrap',{'wrap-op':'redeem','wrap-amount':'1','wrap-recipient':A},'prepare-wrap');
 }else throw Error('unknown phase');
 if(errors.length)throw Error('browser errors: '+errors.join('; '));
 await tab('records');await page.waitForSelector('.record');
 await page.screenshot({path:path.join(out,'wallet-'+phase+'.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await tab('bridge');await page.screenshot({path:path.join(out,'wallet-mobile-'+phase+'.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow)throw Error('mobile page overflows');
 report.phases[phase]='passed';report.negative=[...new Set(report.negative)];report.browserSignedTransactions=Object.keys(report.steps).length;report.browserErrors=errors;delete report.lastFailure;await save();console.log(JSON.stringify({phase,steps:Object.keys(report.steps).length,dialogs,negative:report.negative}));
}catch(e){report.phases[phase]='failed';report.lastFailure={phase,message:e.message};await save();await page.screenshot({path:path.join(out,'browser-failure.png'),fullPage:true});throw e;}
finally{await browser.close();}
