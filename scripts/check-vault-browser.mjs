// Local acceptance test. Asset transactions are prepared and signed in Chromium.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {chromium, launchOptions} from './browser-runtime.mjs';
import {Interface, parseUnits} from '../wallet/vendor/ethers-6.15.0.min.mjs';

const base = process.env.BNC_DEMO_URL || 'http://127.0.0.1:8584';
const folder = new URL('../results/wl-vault-validation/', import.meta.url);
const checkpoint = new URL('browser-resume.json', folder);
const abi = new Interface([
  'function lock(address)',
  'function transfer(address,uint256)',
  'function bridgeBurn(uint256,address,uint256)',
  'function balanceOf(address) view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function totalLocked() view returns(uint256)',
  'function totalReleased() view returns(uint256)',
  'function claimedTransfer(bytes32) view returns(bool)',
  'function claimedWithdrawal(bytes32) view returns(bool)',
  'event VaultLocked(bytes32 indexed transferId,address indexed sender,address indexed recipient,uint256 amount,uint64 nonce,uint256 destinationChainId)',
  'event VaultBurned(bytes32 indexed transferId,address indexed sender,address indexed recipient,uint256 amount,uint64 nonce,uint256 destinationChainId)',
  'event LockClaimed(bytes32 indexed transferId,address indexed recipient,uint256 amount)',
  'event BurnClaimed(bytes32 indexed transferId,address indexed recipient,uint256 amount)'
]);
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const headers = {'Content-Type': 'application/json', 'X-Bridge-Request': '1'};
async function api(path, body) {
  const response = await fetch(base + path, {
    ...(body ? {method: 'POST', headers, body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || response.statusText);
  return data;
}
async function rpc(chain, method, params = []) {
  const response = await api('/rpc/' + chain, {jsonrpc: '2.0', id: 1, method, params});
  if (response.error) throw Error(response.error.message);
  return response.result;
}
const manifest = await api('/api/manifest');
assert.equal(manifest.protocol, 'native-wl-vault-v1');
assert.deepEqual([manifest.chains.wl.id, manifest.chains.bnb.id], [31337, 31338]);
const [a, b, c] = manifest.users;
const {original: vault, wrapped} = manifest.contracts;
const ten = parseUnits('10', 18);
const state = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8'))
  : {sessionId: manifest.sessionId, transactions: {}, events: {}, proofs: {}};
assert.equal(state.sessionId, manifest.sessionId, 'the test checkpoint belongs to another session');

function write(file, value) {
  const temporary = new URL(file + '.tmp', folder);
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, new URL(file, folder));
}
function save() { write('browser-resume.json', state); }

async function wallet(page, route, index) {
  await page.goto(base + '/' + route);
  await page.locator('#account').selectOption(String(index));
  await page.locator('#demo-wallet').click();
  await page.waitForFunction(address => document.querySelector('#owner').textContent.toLowerCase() === address.toLowerCase(), manifest.users[index - 1]);
}
async function sign(page, button) {
  await page.locator(button).click();
  await page.locator('#submit').click();
  await page.locator('#transaction-panel').waitFor({state: 'hidden'});
}
async function waitDone(page, step) {
  await page.locator('#step-' + step + '[data-state="done"]').waitFor({timeout: 25000});
}
async function findTransaction(record) {
  const tip = Number(BigInt(await rpc(record.chain, 'eth_blockNumber')));
  for (let n = record.firstBlock; n <= tip; ++n) {
    const block = await rpc(record.chain, 'eth_getBlockByNumber', ['0x' + n.toString(16), true]);
    const found = block.transactions.find(tx => eq(tx.from, record.from) && BigInt(tx.nonce) === BigInt(record.nonce));
    if (found) return found;
  }
  return null;
}
async function signedReceipt(name, chain, from, to, value, data, send) {
  let record = state.transactions[name];
  if (!record) {
    const nonce = await rpc(chain, 'eth_getTransactionCount', [from, 'pending']);
    const firstBlock = Number(BigInt(await rpc(chain, 'eth_blockNumber')));
    record = state.transactions[name] = {chain, from, to, nonce, firstBlock, value: value.toString(), data};
    save();
  }
  assert.deepEqual([record.chain, record.from, record.to, record.value, record.data], [chain, from, to, value.toString(), data]);
  let tx = record.hash ? await rpc(chain, 'eth_getTransactionByHash', [record.hash]) : await findTransaction(record);
  if (!tx) {
    assert.equal(await rpc(chain, 'eth_getTransactionCount', [from, 'pending']), record.nonce,
      'the nonce is occupied; recover its receipt before attempting a new signature');
    await send();
    for (let i = 0; i < 25 && !tx; ++i) {
      tx = await findTransaction(record);
      if (!tx) await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  assert(tx && eq(tx.from, from) && eq(tx.to, to) && eq(tx.input, data), 'signed transaction identity differs');
  assert.equal(BigInt(tx.value), value);
  assert(BigInt(tx.r) && BigInt(tx.s), 'missing wallet signature');
  record.hash = tx.hash;
  save();
  const receipt = await rpc(chain, 'eth_getTransactionReceipt', [tx.hash]);
  assert(receipt && BigInt(receipt.status) === 1n, 'successful signed receipt required');
  write(name + '-receipt.json', receipt);
  return receipt;
}
function event(receipt, name, address) {
  const fragment = abi.getEvent(name);
  const log = receipt.logs.find(log => eq(log.address, address) && eq(log.topics[0], fragment.topicHash));
  assert(log, 'missing event ' + name);
  return {args: abi.parseLog(log).args, block: Number(BigInt(log.blockNumber))};
}
async function deposit(page) {
  const data = abi.encodeFunctionData('lock', [c]);
  const receipt = await signedReceipt('deposit', 'wl', a, vault, ten, data, async () => {
    await wallet(page, 'vault-deposit.html', 1);
    await page.locator('#amount').fill('10');
    await page.locator('#recipient').fill(c);
    await sign(page, '#prepare-action');
    await waitDone(page, 'burn');
    assert.match(await page.locator('.history-amounts').first().textContent(), /예치 10\.0 WL · 발행 0 wWL/);
  });
  const {args, block} = event(receipt, 'VaultLocked', vault);
  assert(eq(args.sender, a) && eq(args.recipient, c) && args.amount === ten);
  state.events.lock = {action: 'lock-vault', transferId: args.transferId, fromBlock: block};
  save();
  console.log('deposit recorded', state.events.lock);
}
async function readyProof(key) {
  const request = state.events[key];
  assert(request, 'source event missing');
  const deadline = Date.now() + 1840000;
  let job;
  while (Date.now() < deadline) {
    const {jobs} = await api('/api/jobs?action=' + request.action);
    job = jobs.find(item => item.request.transferId === request.transferId && item.request.fromBlock === request.fromBlock);
    assert(job, 'request the saved event before waiting for the proof');
    if (job.state === 'failed') throw Error(job.detail);
    if (job.state === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(job?.state, 'ready', 'proof did not finish within the runner deadline');
  const proof = await api('/api/jobs/' + job.id + '/package');
  assert.equal(proof.version, 3);
  assert.equal(proof.computationProof.imageId, manifest.computationProof.imageId);
  assert.equal(proof.computationProof.sdkVerified, true);
  assert.equal(proof.transferId, request.transferId);
  const verified = await api('/api/computation/verify', proof);
  assert.equal(verified.verified, true);
  assert.equal(verified.receiptSHA256, proof.computationProof.receiptSHA256);
  await assert.rejects(api('/api/computation/verify', {...proof, amount: '1'}));
  await assert.rejects(api('/api/computation/verify', {...proof, recipient: a}));
  await assert.rejects(api('/api/computation/verify', {...proof, sourceChainId: 56}));
  const receipt = Buffer.from(proof.computationProof.receiptBase64, 'base64');
  receipt[receipt.length - 1] ^= 1;
  const altered = {...proof.computationProof, receiptBase64: receipt.toString('base64'),
    receiptSHA256: createHash('sha256').update(receipt).digest('hex')};
  await assert.rejects(api('/api/computation/verify', {...proof, computationProof: altered}));
  state.proofs[key] = {jobId: job.id, imageId: verified.imageId, receiptSHA256: verified.receiptSHA256};
  save();
  return proof;
}
async function claim(page, key, proof) {
  const forward = key === 'lock';
  const chain = forward ? 'bnb' : 'wl';
  const signer = forward ? a : b;
  const recipient = c;
  const target = forward ? wrapped : vault;
  const name = forward ? 'mint' : 'release';
  const receipt = await signedReceipt(name, chain, signer, target, 0n, proof.calldata, async () => {
    await wallet(page, forward ? 'vault-deposit.html' : 'vault-release.html', forward ? 1 : 2);
    await page.locator('[data-transfer-id="' + proof.transferId + '"]').click();
    await waitDone(page, 'proof');
    await sign(page, '#prepare-claim');
    await waitDone(page, 'mint');
    const expected = forward ? /예치 10\.0 WL · 발행 10\.0 wWL/ : /소각 10\.0 wWL · 지급 10\.0 WL/;
    assert.match(await page.locator('.history-amounts').first().textContent(), expected);
  });
  const claimLog = event(receipt, forward ? 'LockClaimed' : 'BurnClaimed', target).args;
  assert(eq(claimLog.transferId, proof.transferId) && eq(claimLog.recipient, recipient) && claimLog.amount === ten);
  await assert.rejects(rpc(chain, 'eth_call', [{from: signer, to: target, data: proof.calldata}, 'latest']));
}
async function call(chain, target, method, args = []) {
  const raw = await rpc(chain, 'eth_call', [{to: target, data: abi.encodeFunctionData(method, args)}, 'latest']);
  return abi.decodeFunctionResult(method, raw)[0];
}
async function prepareReturn(page) {
  await claim(page, 'lock', await readyProof('lock'));
  if (!state.transactions.transferWrapped) assert.equal(await call('bnb', wrapped, 'balanceOf', [c]), ten);
  await signedReceipt('transferWrapped', 'bnb', c, wrapped, 0n, abi.encodeFunctionData('transfer', [b, ten]), async () => {
    await wallet(page, 'vault-tools.html', 3);
    await page.locator('#amount').fill('10');
    await page.locator('#recipient').fill(b);
    await sign(page, '#prepare-action');
    await waitDone(page, 'tools');
  });
  if (!state.transactions.burn) assert.equal(await call('bnb', wrapped, 'balanceOf', [b]), ten);
  const receipt = await signedReceipt('burn', 'bnb', b, wrapped, 0n, abi.encodeFunctionData('bridgeBurn', [ten, c, 31337]), async () => {
    await wallet(page, 'vault-release.html', 2);
    await page.locator('#amount').fill('10');
    await page.locator('#recipient').fill(c);
    await sign(page, '#prepare-action');
    await waitDone(page, 'burn');
    assert.match(await page.locator('.history-amounts').first().textContent(), /소각 10\.0 wWL · 지급 0 WL/);
  });
  const {args, block} = event(receipt, 'VaultBurned', wrapped);
  assert(eq(args.sender, b) && eq(args.recipient, c) && args.amount === ten);
  state.events.burn = {action: 'burn-vault', transferId: args.transferId, fromBlock: block};
  save();
  console.log('burn recorded', state.events.burn);
}
async function balance(address) {
  return BigInt(await rpc('wl', 'eth_getBalance', [address, 'latest']));
}
async function finish(page) {
  const proof = await readyProof('burn');
  if (!state.releaseBalanceBefore) {
    state.releaseBalanceBefore = String(await balance(c));
    state.nativeRecipientBalanceBefore = String(await balance(b));
    save();
  }
  await claim(page, 'burn', proof);
  if (!state.transactions.transferNative) assert.equal(await balance(c), BigInt(state.releaseBalanceBefore) + ten);
  const two = parseUnits('2', 18);
  await signedReceipt('transferNative', 'wl', c, b, two, '0x', async () => {
    await wallet(page, 'vault-tools.html', 3);
    await page.locator('#chain').selectOption('31337');
    await page.locator('#amount').fill('2');
    await page.locator('#recipient').fill(b);
    await sign(page, '#prepare-action');
    await waitDone(page, 'tools');
  });
  const nativeReceipt = JSON.parse(fs.readFileSync(new URL('transferNative-receipt.json', folder), 'utf8'));
  const claimReceipt = JSON.parse(fs.readFileSync(new URL('release-receipt.json', folder), 'utf8'));
  const gas = receipt => BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  assert.equal(await balance(b), BigInt(state.nativeRecipientBalanceBefore) - gas(claimReceipt) + two);
  assert.equal(await balance(c), BigInt(state.releaseBalanceBefore) + ten - two - gas(nativeReceipt));
  assert.equal(await balance(vault), 0n);
  assert.equal(await call('wl', vault, 'totalLocked'), ten);
  assert.equal(await call('wl', vault, 'totalReleased'), ten);
  assert.equal(await call('bnb', wrapped, 'totalSupply'), 0n);
  assert.equal(await call('bnb', wrapped, 'claimedTransfer', [state.events.lock.transferId]), true);
  assert.equal(await call('wl', vault, 'claimedWithdrawal', [state.events.burn.transferId]), true);
  write('browser-summary.json', {
    status: 'passed', sessionId: manifest.sessionId, browserSignedTransactions: Object.keys(state.transactions).length,
    events: state.events, proofs: state.proofs,
    transactions: Object.fromEntries(Object.entries(state.transactions).map(([key, value]) => [key, value.hash])),
    lockedWL: '10', releasedWL: '10', vaultWL: '0', wWLSupply: '0', postReleaseNativeTransferWL: '2'
  });
  console.log('Vault browser acceptance passed');
}
const phase = process.argv[2];
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({viewport: {width: 900, height: 800}});
  page.setDefaultTimeout(15000);
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => console.error('browser page error', error.message));
  if (phase === 'deposit') await deposit(page);
  else if (phase === 'forward-and-burn') await prepareReturn(page);
  else if (phase === 'release') await finish(page);
  else throw Error('choose a Vault test phase');
} finally {
  await browser.close();
}
