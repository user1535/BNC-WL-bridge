// Read-only UI checks after restarting the restored service; no new transactions.
import {chromium,launchOptions} from './browser-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const output=process.env.BNC_EVIDENCE_DIR||fileURLToPath(new URL('../results/restoration-20261029',import.meta.url));
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.BNC_DEMO_URL||'http://127.0.0.1:8580/');
  await page.evaluate(()=>localStorage.setItem('worldland-bnb-local-pending-trusted-v1',JSON.stringify({preservedLegacy:true})));
  await page.locator('#demo-wallet').click();
  await page.waitForFunction(()=>document.getElementById('wallet-original').textContent!=='—');
  const manifest=await page.evaluate(async()=>await (await fetch('/api/manifest')).json());
  if(!/^[0-9a-f]{32}$/.test(manifest.sessionId))throw Error('missing persistent session identity');
  await page.locator('#recover').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('미확인 거래가 없습니다'));
  if(!await page.evaluate(()=>JSON.parse(localStorage.getItem('worldland-bnb-local-pending-trusted-v1')).preservedLegacy))throw Error('legacy browser pending data overwritten');
  await page.locator('#package').setInputFiles(path.join(output,'lock-package.json'));
  await page.waitForFunction(()=>document.getElementById('computation-status').textContent.includes('SDK 재검증 통과'));
  await page.locator('#go-destination').click();
  await page.locator('#prepare-claim').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('already accepted'));
  if(!await page.locator('#submit').isDisabled())throw Error('claimed package can be signed after restart');
  await page.locator('#refresh-audit').click();
  await page.waitForFunction(()=>document.getElementById('audit-state').textContent.includes('감사 감시 중')&&!document.getElementById('export-audit').disabled);
  await page.locator('#tab-wl').click();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'restored-ui.png')});
  await page.goto(new URL('/manual.html',process.env.BNC_DEMO_URL||'http://127.0.0.1:8580/').href);
  if(!(await page.locator('body').innerText()).includes('RISC0'))throw Error('manual not restored');
  if(errors.length)throw Error(errors.join('; '));
  const result={passed:true,transactionsSigned:0,newProofsGenerated:0,sessionId:manifest.sessionId,legacyPendingPreserved:true,downloadedReceiptReverified:true,replayBlockedAfterRestart:true,manualAndAuditVerified:true};
  await fs.writeFile(path.join(output,'restart-browser-summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally {await browser.close();}
