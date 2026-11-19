// Real local chains, fresh RISC Zero proofs and the original browser wallet UI.
import {chromium,launchOptions} from './browser-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const output=process.env.BNC_EVIDENCE_DIR||fileURLToPath(new URL('../results/restoration-20261029',import.meta.url));
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(launchOptions);
const result={passed:false,trustModel:'trusted-server-and-rpc',sourceAuthenticated:false,onchainVerified:false,steps:[],dialogs:0};
let page;
try {
  page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.on('dialog',async dialog=>{result.dialogs++;await dialog.accept();});
  page.on('pageerror',error=>console.log('PAGE ERROR:',error.message));
  await page.goto(process.env.BNC_DEMO_URL||'http://127.0.0.1:8580/');
  await page.locator('#demo-wallet').click();
  await page.waitForFunction(()=>document.getElementById('wallet-original').textContent!=='—',{},{timeout:20000});
  const manifest=await page.evaluate(async()=>await (await fetch('/api/manifest')).json());
  if(manifest.computationPolicy!=='risc0-receipt-computation')throw Error('RISC Zero is not required');
  result.imageId=manifest.computationProof.imageId;
  async function balances() {
    return page.evaluate(async()=>{
      const {Interface}=await import('/vendor/ethers-6.15.0.min.mjs');
      const m=await (await fetch('/api/manifest')).json();
      const iface=new Interface(['function balanceOf(address) view returns(uint256)','function availableBalanceOf(address) view returns(uint256)']);
      async function read(chain,to,method) {
        const response=await fetch('/rpc/'+chain,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data:iface.encodeFunctionData(method,[m.users[0]])},'latest']})});
        const v=await response.json();if(v.error)throw Error(v.error.message);return iface.decodeFunctionResult(method,v.result)[0].toString();
      }
      return {original:await read('wl',m.contracts.original,'balanceOf'),available:await read('wl',m.contracts.original,'availableBalanceOf'),wrapped:await read('bnb',m.contracts.wrapped,'balanceOf')};
    });
  }
  result.before=await balances();
  for(const action of ['lock','burn']) {
    await page.locator(action==='lock'?'#tab-wl':'#tab-bnb').click();
    await page.locator('#amount').fill('1');
    await page.locator('#prepare-action').click();
    await page.waitForFunction(()=>!document.getElementById('submit').disabled);
    await page.locator('#submit').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('지갑이 전송한 거래'));
    await page.locator('#recover').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('거래가 수락됐습니다'));
    await page.waitForFunction(()=>document.getElementById('transfer-id').value.length===66);
    await page.locator('#request-proof').click();
    console.log(action+': source transaction confirmed; waiting for fresh RISC Zero proof');
    await page.waitForFunction(()=>!document.getElementById('download-package').disabled||document.getElementById('proof-status').textContent.startsWith('failed'),{},{timeout:1850000});
    if((await page.locator('#proof-status').innerText()).startsWith('failed'))throw Error(await page.locator('#proof-status').innerText());
    const evidence=await page.evaluate(async()=>{
      const {WalletClient,validatePackage}=await import('/client.mjs');
      const {DemoWallet}=await import('/demo-wallet.mjs');
      const m=await (await fetch('/api/manifest')).json();
      const saved=JSON.parse(localStorage.getItem('worldland-bnb-proof-request-trusted-v1'+(m.sessionId?'-'+m.sessionId:'')));
      const response=await fetch('/api/jobs/'+saved.id+'/package'),p=await response.json();
      if(!response.ok)throw Error(p.error);validatePackage(p,m);
      const client=new WalletClient(new DemoWallet(m),m);
      await client.verifyComputation(p);
      const negative=[];
      for(const [name,mutate] of [
        ['missing-proof',p=>delete p.computationProof],
        ['wrong-guest',p=>p.computationProof.imageId='00'.repeat(32)],
        ['wrong-journal',p=>p.computationProof.journal.amount='2'],
        ['wrong-scope',p=>p.computationProof.onchainVerified=true],
        ['wrong-input-commitment',p=>p.computationProof.journal.inputDigest='0x'+'00'.repeat(32)],
      ]) {
        const copy=structuredClone(p);mutate(copy);let rejected=false;
        try{validatePackage(copy,m);}catch{rejected=true;}
        if(!rejected)throw Error(name+' accepted');negative.push(name);
      }
      const altered=structuredClone(p),raw=Uint8Array.from(atob(altered.computationProof.receiptBase64),c=>c.charCodeAt(0));
      raw[raw.length-1]^=1;
      let encoded='';for(let i=0;i<raw.length;i+=8192)encoded+=String.fromCharCode(...raw.slice(i,i+8192));
      altered.computationProof.receiptBase64=btoa(encoded);
      altered.computationProof.receiptSHA256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
      // Recompute the transport checksum: only the real SDK can reject this.
      const invalid=await fetch('/api/computation/verify',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify(altered)});
      if(invalid.ok)throw Error('altered composite seal accepted by SDK');
      negative.push('altered-receipt-with-recomputed-sha256');
      window.restoredTestPackage=p;
      return {action:p.action,job:saved.id,sourceBlock:p.blockNumber,transferId:p.transferId,receiptSHA256:p.computationProof.receiptSHA256,receiptBytes:p.computationProof.receiptBytes,sdkVerified:true,negativeChecks:negative};
    });
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-package').click()]);
    const savedPackage=path.join(output,action+'-package.json');await download.saveAs(savedPackage);
    const exported=JSON.parse(await fs.readFile(savedPackage,'utf8'));
    if(exported.computationProof.receiptSHA256!==evidence.receiptSHA256)throw Error('download changed proof');
    await page.locator('#package').setInputFiles(savedPackage);
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('SDK 재검증'));
    await page.locator('#go-destination').click();
    await page.locator('#prepare-claim').click();
    await page.waitForFunction(()=>!document.getElementById('submit').disabled);
    await page.locator('#submit').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('지갑이 전송한 거래'));
    await page.locator('#recover').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('거래가 수락됐습니다'));
    evidence.replayRejected=await page.evaluate(async()=>{
      const {WalletClient}=await import('/client.mjs');const {DemoWallet}=await import('/demo-wallet.mjs');
      const m=await (await fetch('/api/manifest')).json(),client=new WalletClient(new DemoWallet(m),m);
      await client.switchChain(window.restoredTestPackage.destinationChainId);
      try{await client.preview(window.restoredTestPackage);}catch(error){if(error.message.includes('already accepted'))return true;throw error;}
      return false;
    });
    if(!evidence.replayRejected)throw Error('replay allowed');
    result.steps.push(evidence);console.log(action+': browser claim, SDK rejection checks and replay prevention PASS');
  }
  result.after=await balances();
  if(JSON.stringify(result.before)!==JSON.stringify(result.after))throw Error('roundtrip balance conservation failed');
  if(result.dialogs!==4)throw Error('expected four browser signing approvals');
  await page.reload();await page.locator('#demo-wallet').click();
  await page.waitForFunction(()=>document.getElementById('wallet-original').textContent!=='—');
  result.reloadVerified=true;
  await page.screenshot({path:path.join(output,'restored-ui.png'),fullPage:true});
  result.passed=true;
}catch(error) {
  result.error=error.stack;
  if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
}finally {
  await fs.writeFile(path.join(output,'browser-summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));await browser.close();
}
