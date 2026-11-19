// UI regression using captured packages and simulated RPC/SDK responses.
// All mutation requests are intercepted so the running demo session is read-only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium, launchOptions} from './browser-runtime.mjs';
import {AbiCoder, Interface, id, toBeHex, zeroPadValue} from '../wallet/vendor/ethers-6.15.0.min.mjs';

const base = process.env.BNC_DEMO_URL || 'http://127.0.0.1:8581';
const manifest = await (await fetch(new URL('/api/manifest', base))).json();
const browser = await chromium.launch(launchOptions);
const abi = new Interface([
  'function claimedBurn(bytes32) view returns(bool)',
  'function getReceiptRoot(uint256,uint256,bytes32) view returns(bytes32)',
  ...['balanceOf(address)', 'totalSupply()', 'totalBridgeBurned()', 'totalBridgeMinted()'].map(method => 'function ' + method + ' view returns(uint256)')
]);
const coder = AbiCoder.defaultAbiCoder();
const topic = id('BridgeBurned(bytes32,address,address,uint256,uint64,uint256)');
const claimTopic = id('BurnClaimed(bytes32,address,uint256)');
const mintHash = '0x' + '15'.repeat(32);

async function verifyFlow(flow, burner, recipient) {
  const p = JSON.parse(await readFile(new URL('../wallet/testdata/' + flow + '-v2-package.json', import.meta.url)));
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  page.on('dialog', dialog => dialog.accept());
  const request = {action: flow, transferId: p.transferId, fromBlock: p.blockNumber};
  const burn = {
    address: p.sourceToken,
    topics: [topic, p.transferId, zeroPadValue(p.sender, 32), zeroPadValue(p.recipient, 32)],
    data: coder.encode(['uint256','uint64','uint256'], [p.amount, p.nonce, p.destinationChainId]),
    blockNumber: toBeHex(p.blockNumber)
  };
  const oldBurn = {...burn, blockNumber: '0x2', topics: [topic, '0x' + '24'.repeat(32), ...burn.topics.slice(2)]};
  const finishedBurn = {...burn, blockNumber: '0x1', topics: [topic, '0x' + '25'.repeat(32), ...burn.topics.slice(2)]};
  let burnSent = false, burnMined = false, proofReady = false, sdkFails = false;
  let mintSent = false, mintMined = false;
  let jobRequested = false;
  await context.route('**/api/**', async route => {
    const {pathname, searchParams} = new URL(route.request().url());
    if (pathname === '/api/manifest') return route.fulfill({json: manifest});
    const job = {id: 'test', request, state: proofReady ? 'ready' : 'running'};
    if (pathname === '/api/jobs' && route.request().method() === 'GET') {
      return route.fulfill({json: {jobs: jobRequested && searchParams.get('action') === flow ? [job] : []}});
    }
    if (pathname === '/api/jobs' || pathname === '/api/jobs/test') {
      if (pathname === '/api/jobs') {
        assert.deepEqual(route.request().postDataJSON(), request);
        jobRequested = true;
      }
      return route.fulfill({json: job});
    }
    if (pathname === '/api/jobs/test/package') return route.fulfill({json: p});
    if (pathname === '/api/computation/verify') {
      if (sdkFails) return route.fulfill({status: 422, json: {error: 'SDK 검증 실패'}});
      return route.fulfill({json: {...p.computationProof, verified: true, verificationLocation: 'server-risc0-sdk'}});
    }
    return route.abort();
  });
  await context.route('**/rpc/*', async route => {
    const req = route.request().postDataJSON();
    const {method, params} = req;
    const chain = new URL(route.request().url()).pathname.endsWith('/wl') ? 31337 : 31338;
    let result;
    switch (method) {
      case 'eth_chainId': result = toBeHex(chain); break;
      case 'eth_getCode': {
        const names = chain === 31337 ? ['original', 'unlock', 'wl_headers'] : ['wrapped', 'mint', 'bnb_headers'];
        const name = names.find(key => manifest.contracts[key].toLowerCase() === params[0].toLowerCase());
        result = manifest.runtimeCode[name];
        break;
      }
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_getBalance': result = '0xde0b6b3a7640000'; break;
      case 'eth_gasPrice': result = '0x1'; break;
      case 'eth_estimateGas': result = '0xf4240'; break;
      case 'eth_blockNumber': result = toBeHex(p.blockNumber + 2); break;
      case 'eth_getLogs': {
        const filter = params[0];
        const events = chain === p.sourceChainId ? [oldBurn, finishedBurn, ...(burnMined ? [burn] : [])] : [];
        result = events.filter(event => BigInt(event.blockNumber) >= BigInt(filter.fromBlock)
          && filter.topics.every((value, index) => value === null || value.toLowerCase() === event.topics[index].toLowerCase()));
        break;
      }
      case 'eth_sendRawTransaction':
        if (chain === p.sourceChainId) { burnSent = true; result = p.txHash; }
        else { mintSent = true; result = mintHash; }
        break;
      case 'eth_getTransactionReceipt':
        result = params[0] === p.txHash && burnMined ? {status: '0x1', logs: [burn]} :
          params[0] === mintHash && mintMined ? {status: '0x1', logs: [{address: p.claimTransaction.to, topics: [claimTopic, p.transferId]}]} : null;
        break;
      case 'eth_call': {
        const signature = abi.getFunction(params[0].data.slice(0, 10));
        if (signature?.name === 'claimedBurn') {
          const [burnId] = abi.decodeFunctionData(signature, params[0].data);
          result = abi.encodeFunctionResult(signature, [burnId === finishedBurn.topics[1] || burnId === p.transferId && mintMined]);
        }
        else if (signature?.name === 'getReceiptRoot') result = abi.encodeFunctionResult(signature, [p.receiptRoot]);
        else result = signature ? abi.encodeFunctionResult(signature, [100n * 10n ** 18n]) : '0x';
        break;
      }
      default: throw Error('Unexpected RPC ' + method);
    }
    assert.notEqual(result, undefined, method);
    return route.fulfill({json: {jsonrpc: '2.0', id: req.id, result}});
  });

  async function state(step, value) {
    try { await page.locator('#step-' + step + '[data-state="' + value + '"]').waitFor({timeout: 12000}); }
    catch (error) { throw Error(flow + ' ' + step + ' ' + value + ' · ' + await page.locator('#status').textContent(), {cause: error}); }
  }
  async function connect(index) {
    await page.selectOption('#account', String(index));
    await page.click('#demo-wallet');
    await state('wallet', 'done');
  }
  await page.goto(new URL('/burn-mint.html', base).href);
  await page.locator('a[href="' + flow + '.html"]').click();
  await connect(burner);
  await state('burn', 'current');
  const row = transferId => page.locator('#events button[data-transfer-id="' + transferId + '"]');
  assert.match(await row(oldBurn.topics[1]).textContent(), /증명 미요청/);
  assert.match(await row(finishedBurn.topics[1]).textContent(), /발행 완료/);
  const units = flow === 'burn-wl' ? ['WL', 'wWL'] : ['wWL', 'WL'];
  const amount = String(BigInt(p.amount) / (10n ** 18n)) + '.0';
  assert.equal(await row(oldBurn.topics[1]).locator('.history-amounts').textContent(), '소각 ' + amount + ' ' + units[0] + ' · 발행 0 ' + units[1]);
  assert.equal(await row(finishedBurn.topics[1]).locator('.history-amounts').textContent(), '소각 ' + amount + ' ' + units[0] + ' · 발행 ' + amount + ' ' + units[1]);
  assert.equal(await page.locator('#events li').count(), 2);
  assert(await page.locator('#request-proof').isDisabled());
  assert.equal(await page.locator('#chain').count(), 0);
  await row(oldBurn.topics[1]).click();
  await state('proof', 'current');
  assert.equal(await page.locator('#transfer-id').inputValue(), oldBurn.topics[1]);
  assert(!(await page.locator('#request-proof').isDisabled()));
  await page.click('#new-burn');
  await page.fill('#amount', String(BigInt(p.amount) / (10n ** 18n)));
  await page.fill('#recipient', p.recipient);
  await page.click('#prepare-action');
  await page.locator('#step-burn #submit').click();
  await page.getByText('거래를 전송했습니다. 체인 확인을 기다리는 중입니다.').waitFor();
  assert(burnSent);
  assert.equal(await page.locator('#step-burn').getAttribute('data-state'), 'current');
  burnMined = true;
  await page.locator('#step-burn #recover').click();
  await state('burn', 'done');
  await state('proof', 'current');

  await page.click('#request-proof');
  await page.getByText('증명을 준비하고 있습니다. 보통 몇 분 걸립니다.').waitFor();
  assert.match(await row(p.transferId).textContent(), /증명 생성 중/);
  assert(await page.locator('#prepare-claim').isDisabled());
  proofReady = true;
  sdkFails = true;
  await page.click('#poll-proof');
  await page.getByText('SDK 검증 실패', {exact: true}).waitFor();
  assert.equal(await page.locator('#step-proof').getAttribute('data-state'), 'current');
  assert(await page.locator('#prepare-claim').isDisabled());
  sdkFails = false;
  await page.click('#poll-proof');
  await state('proof', 'done');
  if (burner !== recipient) {
    assert(await page.locator('#prepare-claim').isDisabled());
    await connect(recipient);
  }
  await page.evaluate(({sessionId, flow, request}) => {
    const prefix = 'bnc-burn-mint-v2-' + sessionId + '-';
    const legacy = {...request, fromBlock: 0};
    localStorage.setItem(prefix + 'event', JSON.stringify(legacy));
    localStorage.setItem(prefix + 'job', JSON.stringify({id: 'test', request: legacy}));
    localStorage.removeItem(prefix + flow + '-event');
    localStorage.removeItem(prefix + flow + '-job');
  }, {sessionId: manifest.sessionId, flow, request});
  await page.reload();
  await connect(recipient);
  await state('burn', 'done');
  await state('proof', 'done');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await connect(recipient);
  assert.match(await row(p.transferId).textContent(), /증명 준비됨/);
  assert.match(await row(oldBurn.topics[1]).textContent(), /증명 미요청/);
  await row(p.transferId).click();
  await state('proof', 'done');
  await page.click('#prepare-claim');
  await page.locator('#step-mint #submit').click();
  await page.getByText('거래를 전송했습니다. 체인 확인을 기다리는 중입니다.').waitFor();
  assert(mintSent);
  assert.equal(await page.locator('#step-mint').getAttribute('data-state'), 'current');
  mintMined = true;
  await page.locator('#step-mint #recover').click();
  await state('mint', 'done');
  assert.match(await row(p.transferId).locator('.history-amounts').textContent(), new RegExp('발행 ' + amount + ' ' + units[1]));
  await page.reload();
  await connect(recipient);
  await state('mint', 'done');
  assert(await page.locator('#prepare-claim').isDisabled());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click('#return-direction');
  await connect(recipient);
  await state('burn', 'current');
  assert(await page.locator('#request-proof').isDisabled());
  assert.deepEqual(errors, []);
  await context.close();
  console.log(flow + ' steps, history, saved jobs in a clean browser, SDK error and mobile layout passed');
}
try {
  const smoke = await browser.newPage();
  await smoke.goto(new URL('/burn-mint-tools.html', base).href);
  await smoke.click('#demo-wallet');
  await smoke.locator('#step-wallet[data-state="done"]').waitFor();
  await smoke.getByText(/ WL · .* wWL/).waitFor();
  await smoke.click('#audit');
  await smoke.getByText(/onchainClaimStopSupported/).waitFor();
  await smoke.goto(new URL('/burn-wl.html', base).href);
  await smoke.click('#demo-wallet');
  await smoke.locator('#step-wallet[data-state="done"]').waitFor();
  const liveHistory = await smoke.locator('#history-status').textContent();
  assert.match(liveHistory, /전체 \d+건|소각 또는 수신 기록이 없습니다/);
  for (const quantities of await smoke.locator('.history-amounts').allTextContents()) {
    assert.match(quantities, /소각 [\d.]+ WL · 발행 [\d.]+ wWL/);
  }
  console.log('Live history: ' + liveHistory);
  await smoke.close();
  await verifyFlow('burn-wl', 1, 1);
  await verifyFlow('burn-bsc', 3, 2);
} finally {
  await browser.close();
}
