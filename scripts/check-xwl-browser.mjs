// Isolated browser-signed xWL scenario. Each completed stage is checkpointed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Interface} from '../wallet/vendor/ethers-6.15.0.min.mjs';
import {chromium, launchOptions, runLocalPython} from './browser-runtime.mjs';

const base = 'http://127.0.0.1:8583';
const out = fileURLToPath(new URL('../results/xwl-entry-validation/', import.meta.url));
const checkpoint = path.join(out, 'browser-resume.json');
const abi = new Interface([
  'function totalSupply() view returns(uint256)', 'function totalEntryMinted() view returns(uint256)',
  'function totalNativeSent() view returns(uint256)', 'function totalBridgeBurned() view returns(uint256)',
  'function totalBridgeMinted() view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function claimedBurn(bytes32) view returns(bool)'
]);
const ten = 10n * 10n**18n, eight = 8n * 10n**18n;
await fs.mkdir(out, {recursive:true});
let result = {passed:false, stages:[], signatures:0};
try { result = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch(error) { if(error.code!=='ENOENT')throw error; }
const save = async () => {
  await fs.writeFile(checkpoint + '.tmp', JSON.stringify(result, null, 2)+'\n');
  await fs.rename(checkpoint + '.tmp', checkpoint);
};
async function api(route, body) {
  const res = await fetch(base+route, body ? {method:'POST', headers:{'Content-Type':'application/json','X-Bridge-Request':'1'}, body:JSON.stringify(body)} : {});
  const value = await res.json();
  if(!res.ok)throw Error(value.error || res.statusText);
  return value;
}
async function rpc(chain, method, params = []) {
  const r = await api('/rpc/'+chain, {jsonrpc:'2.0', id:1, method, params});
  if(r.error)throw Error(r.error.message);
  return r.result;
}
const m = await api('/api/manifest');
assert.equal(m.assetProfile, 'xwl-entry-v1');
if (result.sessionId) assert.equal(result.sessionId, m.sessionId, 'checkpoint belongs to another session');
result.sessionId = m.sessionId;
const old = JSON.parse(await fs.readFile(new URL('../results/burn-mint-v2-guarded/session.json', import.meta.url)));
for(const name of ['original','wrapped','mint','unlock']) assert.notEqual(m.contracts[name].toLowerCase(),old.contracts[name].toLowerCase());
const [A,B] = m.users;
async function view(chain, to, method, args = []) {
  return abi.decodeFunctionResult(method, await rpc(chain,'eth_call',[{to,data:abi.encodeFunctionData(method,args)},'latest']))[0];
}
async function snapshot() {
  const values = {};
  for(const [chain,token] of [['wl','original'],['bnb','wrapped']]) {
    const to=m.contracts[token];
    values[chain]={A:String(await view(chain,to,'balanceOf',[A])),B:String(await view(chain,to,'balanceOf',[B]))};
    for(const method of ['totalSupply','totalBridgeBurned','totalBridgeMinted'])values[chain][method]=String(await view(chain,to,method));
  }
  values.nativeA=String(BigInt(await rpc('wl','eth_getBalance',[A,'latest'])));
  values.nativeB=String(BigInt(await rpc('wl','eth_getBalance',[B,'latest'])));
  values.entryMinted=String(await view('wl',m.contracts.original,'totalEntryMinted'));
  values.nativeSent=String(await view('wl',m.contracts.original,'totalNativeSent'));
  return values;
}
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({viewport:{width:1080,height:900}});
const pageErrors=[];
page.on('pageerror', error => { pageErrors.push(error.message); console.error(error); });
page.on('dialog', async d => { result.signatures++; await d.accept(); });
async function stage(name, action) {
  if(result.stages.includes(name))return;
  console.log('START '+name);
  await action();
  result.stages.push(name);
  delete result.error;
  await save();
  console.log('PASS '+name);
}
async function open(name, account = 1, reload = false) {
  const url=base+'/'+name+'.html';
  if(page.url()!==url || reload)await page.goto(url);
  await page.selectOption('#account',String(account));
  await page.click('#demo-wallet');
  await page.waitForFunction(address => document.getElementById('owner')?.textContent.toLowerCase()===address, m.users[account-1].toLowerCase());
  await page.waitForFunction(() => !document.getElementById('demo-wallet').disabled);
}
async function confirmed() {
  await page.waitForFunction(() => /거래가 (수락|확인)됐습니다/.test(document.getElementById('status').textContent),{},{timeout:30000});
}
async function sign(button) {
  await page.click(button);
  await page.click('#submit');
  await confirmed();
}
async function burn(flow, key) {
  await open(flow);
  assert.equal(await page.locator('#events li').count(),0,'existing burn requires recovery, not a repeat');
  await page.fill('#amount','10');
  await page.fill('#recipient',A);
  await sign('#prepare-action');
  result[key]={action:flow, transferId:await page.locator('#transfer-id').inputValue(),fromBlock:Number(await page.locator('#from-block').inputValue())};
  assert.match(result[key].transferId,/^0x[0-9a-f]{64}$/i);
}
async function loadBurn(request, reload = false) {
  await open(request.action,1,reload);
  const row = page.locator('#events button[data-transfer-id="'+request.transferId+'"]');
  await row.click();
  await page.waitForFunction(()=>!document.getElementById('discover').disabled);
}
async function prove(request) {
  await loadBurn(request);
  const existing=(await api('/api/jobs?action='+request.action)).jobs.find(job=>job.request.transferId===request.transferId.toLowerCase());
  if(!existing || existing.state==='failed')await page.click('#request-proof');
  await page.waitForFunction(() => document.querySelector('#step-proof[data-state="done"]')
    || document.getElementById('proof-status').textContent.includes('실패'),{},{timeout:1830000});
  if((await page.locator('#proof-status').textContent()).includes('실패'))throw Error(await page.locator('#proof-status').textContent());
  const ready=(await api('/api/jobs?action='+request.action)).jobs.find(j=>j.request.transferId===request.transferId.toLowerCase()&&j.state==='ready');
  assert(ready);
  const p=await api('/api/jobs/'+ready.id+'/package');
  assert.equal(p.amount,String(ten));
  assert.equal(p.computationProof.sdkVerified,true);
  assert.equal(p.computationProof.imageId,m.computationProof.imageId);
  await fs.writeFile(path.join(out,request.action+'-package.json'),JSON.stringify(p,null,2)+'\n');
  result.proofs??={};
  result.proofs[request.action]={jobId:ready.id,receiptSHA256:p.computationProof.receiptSHA256,sourceBlock:p.blockNumber,transferId:p.transferId};
}
async function claim(request) {
  await loadBurn(request);
  await page.locator('#step-proof[data-state="done"]').waitFor();
  await sign('#prepare-claim');
  await page.locator('#step-mint[data-state="done"]').waitFor();
}
async function verifyEntry() {
  const hash=(await page.locator('#status').textContent()).match(/0x[0-9a-f]{64}/i)[0];
  const receipt=await rpc('wl','eth_getTransactionReceipt',[hash]);
  const block=await rpc('wl','eth_getBlockByNumber',[receipt.blockNumber,false]);
  assert.deepEqual(block.transactions,[hash],'entry evidence needs an isolated transaction block');
  const parent='0x'+(BigInt(receipt.blockNumber)-1n).toString(16);
  const sink=m.entryPolicy.sink;
  const [before,after]=await Promise.all([rpc('wl','eth_getBalance',[sink,parent]),rpc('wl','eth_getBalance',[sink,receipt.blockNumber])]);
  const tip=block.miner.toLowerCase()===sink.toLowerCase()?BigInt(receipt.gasUsed)*(BigInt(receipt.effectiveGasPrice)-BigInt(block.baseFeePerGas)):0n;
  assert.equal(BigInt(after)-BigInt(before)-tip,ten);
  result.entry={transactionHash:hash,blockNumber:receipt.blockNumber,blockHash:block.hash,receiptsRoot:block.receiptsRoot,
    gasUsed:receipt.gasUsed,logs:receipt.logs.length,nativeSinkDeltaWithoutTips:String(ten)};
  const afterEntry=await snapshot();
  assert.equal(afterEntry.wl.A,String(ten));
  assert.equal(afterEntry.entryMinted,String(ten));
  assert.equal(afterEntry.nativeSent,String(ten));
  assert.equal(afterEntry.wl.totalBridgeMinted,'0');
}
try {
  await stage('entry',async()=>{
    assert.equal((await snapshot()).entryMinted,'0','entry already exists; inspect transaction before retry');
    await open('xwl-entry');
    await sign('#entry-preview');
    await page.getByText('✓ 소각·발행 완료',{exact:true}).waitFor();
    await verifyEntry();
  });
  await stage('outbound burn',()=>burn('burn-wl','outbound'));
  await stage('outbound composite',()=>prove(result.outbound));
  await stage('outbound claim',async()=>{
    await claim(result.outbound);
    const s=await snapshot();
    assert.equal(s.bnb.A,String(ten));
    assert.equal(s.wl.A,'0');
  });
  await stage('return burn',()=>burn('burn-bsc','inbound'));
  await stage('return composite',()=>prove(result.inbound));
  await stage('restart with unclaimed return',async()=>{
    const report=JSON.parse(runLocalPython(['scripts/check-burn-mint-restart.py','--xwl'],90000).toString().trim().split('\n').at(-1));
    assert.equal(report.passed,true);
    assert.equal(report.freshProofsGenerated,0);
    assert.equal(report.sdkReceiptsVerified,2);
    result.restart=report;
    await loadBurn(result.inbound,true);
    await page.locator('#step-proof[data-state="done"]').waitFor();
    assert(await page.locator('#prepare-claim').isEnabled());
  });
  await stage('return claim',async()=>{
    await claim(result.inbound);
    const s=await snapshot();
    assert.equal(s.wl.A,String(ten));
    assert.equal(s.bnb.A,'0');
    for(const chain of ['wl','bnb']) {
      assert.equal(s[chain].totalBridgeBurned,String(ten));
      assert.equal(s[chain].totalBridgeMinted,String(ten));
    }
    result.beforeTrade=s;
  });
  await stage('xWL trade leg',async()=>{
    await open('xwl-trade');
    await page.click('#save-terms');
    await sign('#xwl-preview');
    await page.getByText('한 건만 확인됨 · 상대 전송 대기',{exact:true}).waitFor();
    result.xwlTransfer=await page.inputValue('#xwl-hash');
    const mid=await snapshot();
    assert.equal(mid.wl.B,String(ten));
    assert.equal(mid.nativeB,result.beforeTrade.nativeB);
  });
  await stage('WL trade leg',async()=>{
    await open('xwl-trade',2,true);
    await page.getByText('한 건만 확인됨 · 상대 전송 대기',{exact:true}).waitFor();
    await sign('#wl-preview');
    await page.getByText('✓ 거래 완료 · 두 전송 확인',{exact:true}).waitFor();
    result.wlTransfer=await page.inputValue('#wl-hash');
    result.final=await snapshot();
    assert.equal(result.final.wl.B,String(ten));
    assert.equal(result.final.wl.A,'0');
    assert.equal(BigInt(result.final.nativeA)-BigInt(result.beforeTrade.nativeA)+await fee(result.xwlTransfer),eight);
    assert.equal(BigInt(result.beforeTrade.nativeB)-BigInt(result.final.nativeB)-await fee(result.wlTransfer),eight);
    for(const chain of ['wl','bnb'])for(const name of ['totalSupply','totalBridgeBurned','totalBridgeMinted']) {
      assert.equal(result.final[chain][name],result.beforeTrade[chain][name]);
    }
    assert.equal(result.final.entryMinted,result.beforeTrade.entryMinted);
    await page.fill('#wl-hash',result.xwlTransfer);
    await page.click('#verify-trade');
    await page.getByText('한 건만 확인됨 · 상대 전송 대기',{exact:true}).waitFor();
    await page.fill('#wl-hash',result.wlTransfer);
    await page.click('#verify-trade');
    await page.getByText('✓ 거래 완료 · 두 전송 확인',{exact:true}).waitFor();
  });
  await stage('domain, proof and replay rejection',async()=>{
    const v2Fixture = JSON.parse(await fs.readFile(new URL('../wallet/testdata/burn-wl-v2-package.json', import.meta.url)));
    const proofs = await Promise.all(['burn-wl','burn-bsc'].map(async direction=>JSON.parse(await fs.readFile(path.join(out,direction+'-package.json')))));
    result.negative=await page.evaluate(async ({proofs,old})=>{
      const {validatePackage}=await import('/client.mjs');
      const m=await(await fetch('/api/manifest')).json();
      const rejects=[];
      function reject(p,label) {
        try { validatePackage(p,m); } catch { rejects.push(label); return; }
        throw Error(label+' accepted');
      }
      reject(old,'old V2 asset addresses');
      for(const p of proofs) {
        for(const [field,value] of [['sourceChainId',56],['sourceToken',old.sourceToken],['amount','1'],['recipient',m.users[1]],['transferId','0x'+'34'.repeat(32)]]) {
          reject({...p,[field]:value},p.action+' '+field);
        }
      }
      return rejects;
    },{proofs,old:v2Fixture});
    for(const p of proofs) {
      const invalid=structuredClone(p);
      const raw=Buffer.from(invalid.computationProof.receiptBase64,'base64');
      raw[raw.length-1]^=1;
      invalid.computationProof.receiptBase64=raw.toString('base64');
      invalid.computationProof.receiptSHA256=createHash('sha256').update(raw).digest('hex');
      await assert.rejects(()=>api('/api/computation/verify',invalid));
      const chain=p.destinationChainId===31337?'wl':'bnb';
      assert.equal(await view(chain,p.claimTransaction.to,'claimedBurn',[p.transferId]),true);
      await assert.rejects(()=>rpc(chain,'eth_call',[{from:p.recipient,to:p.claimTransaction.to,data:p.claimTransaction.data},'latest']));
      result.negative.push(p.action+' actual SDK tamper',p.action+' actual contract replay');
    }
  });
  assert.deepEqual(pageErrors,[]);
  result.passed=true;
  await save();
  console.log('PASS xWL browser roundtrip, trade and restart');
} catch(error) {
  result.error=String(error.stack || error);
  try { result.lastStatus=await page.locator('#status').textContent({timeout:2000}); } catch {}
  await save();
  throw error;
} finally {
  await fs.writeFile(path.join(out,'browser-summary.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();
}
async function fee(hash) {
  const r=await rpc('wl','eth_getTransactionReceipt',[hash]);
  return BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice);
}
