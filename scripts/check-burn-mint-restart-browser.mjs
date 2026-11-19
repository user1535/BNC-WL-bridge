import {chromium,launchOptions,runLocalPython} from './browser-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const output=fileURLToPath(new URL('../results/burn-mint-guarded-validation',import.meta.url));
const browser=await chromium.launch(launchOptions),page=await browser.newPage({viewport:{width:1440,height:1100}});
const result={passed:false};
try {
  await page.goto('http://127.0.0.1:8581/burn-wl.html');
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('V2 준비 완료'));
  const p=JSON.parse(await fs.readFile(path.join(output,'burn-wl-package.json'),'utf8'));
  result.storage=await page.evaluate(async p=>{
    const m=await(await fetch('/api/manifest')).json(),prefix='bnc-burn-mint-v2-'+m.sessionId+'-';
    const pendingKey=prefix+'pending-'+m.users[0].toLowerCase(),value=JSON.stringify({chain:31337,owner:m.users[0],status:'submitted',transactionHash:p.txHash});
    localStorage.setItem(pendingKey,value);
    localStorage.setItem('worldland-bnb-local-pending-trusted-v1','v1-storage-sentinel');
    const job=await(await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Request':'1'},body:JSON.stringify({action:p.action,transferId:p.transferId,fromBlock:p.blockNumber})})).json();
    localStorage.setItem(prefix+'job',JSON.stringify(job));
    return {pendingKey,value,sessionId:m.sessionId};
  },p);
  // Resubmission revalidates a cached proof, never generates a second proof.
  await page.waitForTimeout(3000);
  const args=['scripts/check-burn-mint-restart.py'];if(process.env.BNC_SERVICE_PID)args.push('--service-pid',process.env.BNC_SERVICE_PID);
  result.restart=JSON.parse(runLocalPython(args,90000).toString().trim().split('\n').at(-1));
  await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('V2 준비 완료'));
  result.preserved=await page.evaluate(s=>localStorage.getItem(s.pendingKey)===s.value&&localStorage.getItem('worldland-bnb-local-pending-trusted-v1')==='v1-storage-sentinel',result.storage);
  if(!result.preserved)throw Error('pending or V1 storage changed');
  await page.locator('#demo-wallet').click();await page.locator('#step-mint[data-state="done"]').waitFor();
  result.pendingRecovered=await page.evaluate(s=>localStorage.getItem(s.pendingKey)===null,result.storage);
  result.replayRejected=await page.locator('#prepare-claim').isDisabled();
  await page.goto('http://127.0.0.1:8581/burn-mint-tools.html');
  await page.locator('#audit').click();await page.waitForFunction(()=>document.getElementById('audit-view').textContent.includes('onchainClaimStopSupported'));
  result.rootRedirect=await page.evaluate(async()=> (await fetch('/')).url.endsWith('/burn-mint.html'));
  await page.screenshot({path:path.join(output,'restart-ui.png'),fullPage:true});
  result.passed=result.pendingRecovered&&result.preserved&&result.rootRedirect&&result.replayRejected;
  if(!result.passed)throw Error('restart browser checks failed');
}catch(e){result.error=e.stack;throw e;}
finally {await fs.writeFile(path.join(output,'restart-browser-summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));await browser.close();}
