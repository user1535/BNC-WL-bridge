import {BurnMintClient} from './burn-mint-client.mjs';
import {validateManifest, validatePackage} from './client.mjs';
import {DemoWallet} from './demo-wallet.mjs';
import {Interface, parseUnits, formatUnits, id} from './vendor/ethers-6.15.0.min.mjs';

const $ = name => document.getElementById(name);
const flow = document.body.dataset.flow;
const vault = document.body.dataset.profile === 'vault';
const bridge = flow !== 'tools';
const forward = flow === 'burn-wl' || flow === 'lock-vault';
const source = forward ? 'wl' : 'bnb';
const destination = forward ? 'bnb' : 'wl';
const sourceToken = forward ? 'original' : 'wrapped';
const receiver = forward ? 'mint' : 'unlock';
let sourceUnit = forward ? 'WL' : 'wWL';
let destinationUnit = forward ? 'wWL' : 'WL';
const actionLabel = flow === 'lock-vault' ? '예치' : '소각';
const claimLabel = flow === 'burn-vault' ? '지급' : '발행';
const eventName = vault ? forward ? 'VaultLocked' : 'VaultBurned' : 'BridgeBurned';
const topic = id(eventName + '(bytes32,address,address,uint256,uint64,uint256)');
const claimEvent = vault && forward ? 'LockClaimed' : 'BurnClaimed';
const claimTopic = id(claimEvent + '(bytes32,address,uint256)');
const claimedMethod = vault ? forward ? 'claimedTransfer' : 'claimedWithdrawal' : 'claimedBurn';
const pageFor = {
  tools: vault ? 'vault-tools.html' : 'burn-mint-tools.html',
  'lock-vault': 'vault-deposit.html', 'burn-vault': 'vault-release.html',
  'burn-wl': 'burn-wl.html', 'burn-bsc': 'burn-bsc.html'
};
const abi = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function totalBridgeBurned() view returns(uint256)',
  'function totalBridgeMinted() view returns(uint256)',
  'function totalLocked() view returns(uint256)',
  'function totalReleased() view returns(uint256)',
  'function active() view returns(bool)',
  `function ${claimedMethod}(bytes32) view returns(bool)`,
  `event ${eventName}(bytes32 indexed burnId,address indexed burner,address indexed recipient,uint256 amount,uint64 nonce,uint256 destinationChainId)`
]);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
let manifest, client, owner, preview, selected, burn, job, packageData;
let busy = false, minted = false, proofPhase = '', tokenDone = false;
let history = new Map();
let proofJobs = [];
let proofJobsAvailable = false;
let lastHistoryPoll = 0;
let renderedHistory = '';

const key = suffix => 'bnc-' + (vault ? 'native-wl-vault-v1' : 'burn-mint-v2') + '-' + manifest.sessionId + '-' + suffix;
const flowKey = suffix => key(flow + '-' + suffix);
const pendingKey = () => key('pending-' + owner.toLowerCase());
function load(name) {
  try { return JSON.parse(localStorage.getItem(name)); }
  catch { return null; }
}
function pending() { return owner ? load(pendingKey()) : null; }
function status(text, step, error = false) {
  const element = $('status');
  if (step) $('feedback-' + step).append(element);
  element.textContent = text;
  element.toggleAttribute('data-error', error);
}
function focusStep(step) {
  $(step === 'history' ? 'burn-history' : 'step-' + step).scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
}
async function api(path, body) {
  const response = await fetch(path, {
    ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Bridge-Request': '1'}, body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(45000)
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'API 오류');
  return value;
}
async function rpc(chain, method, params = []) {
  const result = await api('/rpc/' + chain, {jsonrpc: '2.0', id: 1, method, params});
  if (result.error) throw Error(result.error.message || String(result.error));
  return result.result;
}
async function checkTestnetSource(recipient, confirmContract = false) {
  if (!manifest.readOnlyTestnet) return;
  for (const chain of ['wl','bnb']) {
    const raw = await rpc(chain,'eth_call',[
      {to:manifest.contracts[chain+'_headers'],data:abi.encodeFunctionData('active')},'latest'
    ]);
    if (!abi.decodeFunctionResult('active',raw)[0]) throw Error('두 테스트넷 레지스트리가 활성화돼야 합니다.');
  }
  const asset = manifest.contracts[forward?'wrapped':'original'];
  if (equal(recipient,asset)) throw Error('목적지 자산 계약 자체는 수신자로 지정할 수 없습니다.');
  if (!forward && confirmContract && /^0x[0-9a-f]{40}$/i.test(recipient)
      && await rpc('wl','eth_getCode',[recipient,'latest']) !== '0x'
      && !window.confirm('수신자가 계약입니다. WL을 받거나 이 계약에서 다른 주소로 지급을 청구할 수 있는지 확인하셨나요?')) {
    throw Error('수신 주소를 다시 확인하세요.');
  }
}
function clearPreview() {
  preview = null;
  $('transaction-panel').hidden = true;
  $('submit').disabled = true;
}
function transactionStep(value) {
  return value.tokenMethod || value.nativeMethod ? 'tools' : value.action ? 'burn' : 'mint';
}
function pendingStep(value) {
  if (value.flow === flow && value.step) return value.step;
  return bridge ? 'burn' : 'tools';
}
function setStep(step, state, label) {
  const element = $('step-' + step);
  element.dataset.state = state;
  if (state === 'current') element.setAttribute('aria-current', 'step');
  else element.removeAttribute('aria-current');
  element.querySelector('.step-badge').textContent = label;
}
function controls() {
  const saved = pending();
  const foreign = saved?.flow && saved.flow !== flow;
  const blocked = saved && (foreign || !saved.retry);
  for (const element of document.querySelectorAll('button,input,select')) {
    element.disabled = busy;
  }
  for (const name of ['demo-wallet', 'extension-wallet']) $(name).disabled = busy || !manifest;
  $('demo-wallet').disabled ||= Boolean(manifest?.readOnlyTestnet);
  $('balances').disabled = busy || !client;
  $('prepare-action').disabled = busy || !client || Boolean(blocked);
  $('submit').disabled = busy || !preview || Boolean(blocked);
  $('pending-panel').hidden = !saved;
  if (saved) {
    $('pending-' + (foreign ? 'wallet' : pendingStep(saved))).append($('pending-panel'));
    $('pending-link').hidden = !foreign;
    if (foreign) $('pending-link').href = pageFor[saved.flow];
    $('recover').hidden = Boolean(foreign);
    $('recover').disabled = busy;
    $('recovery-hash-field').hidden = Boolean(foreign);
    $('retry-pending').hidden = Boolean(foreign || saved.retry || saved.transactionHash);
    $('pending-note').textContent = foreign ? '다른 작업에 미확인 거래가 있습니다.'
      : saved.retry ? '같은 체인·nonce·거래 내용으로만 다시 서명할 수 있습니다.'
      : '지갑에서 확인한 거래 해시를 입력해 원본 또는 대체 거래를 조회할 수 있습니다.';
  }
  setStep('wallet', client ? 'done' : 'current', client ? '✓ 연결 완료' : '지금 할 단계');
  if (!bridge) {
    const native = vault && Number($('chain').value) === manifest?.chains.wl.id;
    $('action-field').hidden = native;
    $('from-field').hidden = native || $('action').value !== 'transferFrom';
    setStep('tools', tokenDone ? 'done' : client ? 'current' : 'waiting', tokenDone ? '✓ 거래 완료' : client ? '지금 할 단계' : '대기');
    return;
  }

  const doneProof = Boolean(packageData || minted);
  const waitingBurn = saved && !foreign && pendingStep(saved) === 'burn';
  const waitingMint = saved && !foreign && pendingStep(saved) === 'mint';
  const active = client && !foreign && (!burn ? 'burn' : !doneProof ? 'proof' : !minted ? 'mint' : null);
  setStep('burn', burn ? 'done' : active === 'burn' ? 'current' : 'waiting', burn ? `✓ ${actionLabel} 완료` : waitingBurn ? '거래 확인 중' : active === 'burn' ? '지금 할 단계' : '대기');
  setStep('proof', doneProof ? 'done' : active === 'proof' ? 'current' : 'waiting', packageData ? '✓ 증명 검증 완료' : minted ? `✓ ${claimLabel}에 사용됨` : proofPhase === 'running' ? '증명 생성 중' : active === 'proof' ? '지금 할 단계' : '대기');
  setStep('mint', minted ? 'done' : active === 'mint' ? 'current' : 'waiting', minted ? `✓ ${claimLabel} 완료` : waitingMint ? '거래 확인 중' : active === 'mint' ? '지금 할 단계' : '대기');
  $('burn-summary').hidden = !burn;
  $('burn-form').hidden = Boolean(burn);
  $('new-burn').hidden = !burn;
  $('new-burn').disabled = busy || Boolean(saved) || !client;
  const jobInProgress = job && ['queued', 'waiting_confirmations', 'waiting_root', 'waiting_registry', 'running'].includes(job.state);
  $('root-registration').hidden = !job?.rootRegistration || Boolean(minted);
  $('root-registration-data').textContent = job?.rootRegistration ? JSON.stringify(job.rootRegistration,null,2) : '';
  $('request-proof').disabled = busy || !client || !burn || doneProof || proofPhase === 'running' || jobInProgress && proofPhase !== 'failed';
  $('request-proof').textContent = proofPhase === 'failed' ? '증명 다시 요청' : '증명 요청';
  $('poll-proof').disabled = busy || !client || !job || doneProof;
  $('download-package').disabled = busy || !packageData;
  $('prepare-claim').disabled = busy || !client || !packageData || minted || Boolean(blocked) || (!vault && !equal(owner, packageData.recipient));
  $('payout-recovery').hidden = !manifest?.readOnlyTestnet || forward || minted || !packageData || !equal(owner, packageData.recipient);
  $('change-recipient').hidden = vault || minted || !packageData || equal(owner, packageData.recipient);
  $('discover').disabled = busy || !client;
  for (const element of document.querySelectorAll('#events button, #restore-burn, #package')) element.disabled = busy || !client || Boolean(saved);
  $('return-direction').hidden = !minted;
  if (minted) $('mint-summary').textContent = `${burn ? burn.amount + ' ' : ''}${destinationUnit} ${claimLabel}이 확인됐습니다.`;
  else if (packageData && !vault && !equal(owner, packageData.recipient)) {
    $('mint-summary').textContent = '위의 지갑 연결에서 지정된 수신자 계정으로 바꿔 주세요. ' + packageData.recipient;
  } else if (packageData) $('mint-summary').textContent = `${burn.amount} ${destinationUnit} ${claimLabel}을 청구할 수 있습니다.`;
  else $('mint-summary').textContent = vault ? `증명이 준비되면 지정된 주소로 ${claimLabel}을 청구할 수 있습니다.` : '증명이 준비되면 수신자 지갑에서 발행을 청구할 수 있습니다.';
}
async function task(step, fn) {
  if (busy) return;
  busy = true;
  controls();
  try { await fn(); }
  catch (error) { status(error.message, step, true); }
  finally { busy = false; controls(); }
}
function review(value) {
  preview = value;
  const step = transactionStep(value);
  $('transaction-' + step).append($('transaction-panel'));
  $('transaction-panel').hidden = false;
  const labels = {transfer: '전송', approve: '토큰 사용 승인', transferFrom: '대리 전송'};
  const label = value.nativeMethod ? 'WL 전송' : labels[value.tokenMethod] || (value.action ? sourceUnit + ' ' + actionLabel : destinationUnit + ' ' + claimLabel);
  $('review').textContent = [
    label + ' · ' + formatUnits(BigInt(value.amount), 18),
    '서명 계정 ' + value.owner,
    '수신자 / 승인 대상 ' + value.recipient,
    ...(value.tokenMethod === 'transferFrom' ? ['원본 보유자 ' + value.from] : [])
  ].join('\n');
  status('수량과 주소를 확인하고 승인하세요.', step);
}
async function balances() {
  const totals = {};
  for (const [chain, contract] of [['wl', 'original'], ['bnb', 'wrapped']]) {
    totals[chain] = {};
    const native = vault && chain === 'wl';
    if (native) {
      totals.wl.balanceOf = BigInt(await rpc('wl', 'eth_getBalance', [owner, 'latest']));
      totals.wl.vaultBalance = BigInt(await rpc('wl', 'eth_getBalance', [manifest.contracts.original, 'latest']));
    }
    const methods = native ? ['totalLocked', 'totalReleased'] : ['balanceOf', 'totalSupply', 'totalBridgeBurned', 'totalBridgeMinted'];
    for (const method of methods) {
      const args = method === 'balanceOf' ? [owner] : [];
      const raw = await rpc(chain, 'eth_call', [{to: manifest.contracts[contract], data: abi.encodeFunctionData(method, args)}, 'latest']);
      totals[chain][method] = abi.decodeFunctionResult(method, raw)[0];
    }
  }
  const wlUnit = manifest.assetProfile === 'xwl-entry-v1' ? 'xWL' : 'WL';
  $('balances-view').textContent = `${formatUnits(totals.wl.balanceOf, 18)} ${wlUnit} · ${formatUnits(totals.bnb.balanceOf, 18)} wWL`;
  $('ledger-view').textContent = JSON.stringify(totals, (_, value) => typeof value === 'bigint' ? formatUnits(value, 18) : value, 2);
}
function sameTransfer(a, b) {
  return a && b && a.action === b.action && equal(a.transferId, b.transferId);
}
function sameBurn(a, b) { return sameTransfer(a, b) && a.fromBlock === b.fromBlock; }
function inputSelection(value) {
  selected = value;
  $('transfer-id').value = value?.transferId ?? '';
  $('from-block').value = value?.fromBlock ?? 0;
}
function selectBurn(value) {
  if (!sameBurn(selected, value)) {
    clearPreview();
    burn = null;
    minted = false;
    packageData = null;
    job = null;
    proofPhase = '';
    $('proof-status').textContent = '증명을 요청할 수 있습니다.';
  }
  inputSelection(value);
  localStorage.setItem(flowKey('event'), JSON.stringify(value));
  renderHistory();
}
function selectionFromLog(event, action) {
  return {action, transferId: event.topics[1], fromBlock: Number(BigInt(event.blockNumber))};
}
function showBurn(event) {
  const decoded = abi.parseLog(event).args;
  burn = {amount: formatUnits(decoded.amount, 18), recipient: decoded.recipient};
  $('burn-summary').textContent = `${burn.amount} ${sourceUnit} ${actionLabel} 거래가 확인됐습니다. 수신자 ${burn.recipient}`;
}
async function checkClaim(transferId) {
  const raw = await rpc(destination, 'eth_call', [{to: manifest.contracts[receiver], data: abi.encodeFunctionData(claimedMethod, [transferId])}, 'latest']);
  return abi.decodeFunctionResult(claimedMethod, raw)[0];
}
async function loadBurn() {
  if (!selected) return;
  const block = '0x' + selected.fromBlock.toString(16);
  const events = await rpc(source, 'eth_getLogs', [{
    address: manifest.contracts[sourceToken], fromBlock: block, toBlock: 'latest', topics: [topic, selected.transferId]
  }]);
  if (events.length !== 1) throw Error(`입력한 블록부터 해당 ${actionLabel}을 하나로 확인할 수 없습니다.`);
  inputSelection(selectionFromLog(events[0], flow));
  localStorage.setItem(flowKey('event'), JSON.stringify(selected));
  showBurn(events[0]);
  minted = await checkClaim(selected.transferId);
  if (!job) restoreJob();
  if (!packageData) $('proof-status').textContent = minted ? `이 거래의 목적지 ${claimLabel}을 완료했습니다.` : `${actionLabel} 거래가 확인됐습니다. 증명을 요청하세요.`;
}
function restoreJob() {
  if (!selected) return;
  const saved = [load(flowKey('job-' + selected.transferId.toLowerCase())), load(flowKey('job')), load(key('job'))];
  job = preferredJob(selected) || saved.find(entry => sameTransfer(selected, entry?.request) && entry.request.fromBlock <= selected.fromBlock) || null;
}
async function connect(demo) {
  clearPreview();
  if (demo && manifest.readOnlyTestnet) throw Error('테스트넷에서는 확장 지갑을 연결하세요.');
  const next = new BurnMintClient(demo ? new DemoWallet(manifest, Number($('account').value)) : window.ethereum, manifest);
  const [address] = await next.connect();
  if (!address) throw Error('지갑에서 계정을 선택하세요.');
  if (!equal(address, owner)) {
    $('recovery-hash').value = '';
    if (bridge) history.clear();
  }
  if (!$('recipient').value || equal($('recipient').value, owner)) $('recipient').value = address;
  owner = address;
  client = next;
  $('owner').textContent = owner;
  if (bridge) renderHistory();
  if (!bridge) $('from').value = owner;
  status('지갑 연결 완료', 'wallet');
  await balances();
  const saved = pending();
  if (saved && (!saved.flow || saved.flow === flow)) await recoverPending(false);
  if (bridge) {
    await syncHistory();
    if (selected && !burn) await loadBurn();
  }
  if (!saved) {
    if (bridge && !minted) focusStep(packageData ? 'mint' : burn ? 'proof' : history.size ? 'history' : 'burn');
    else if (!bridge) focusStep('tools');
  }
}
function parseSelection() {
  const transferId = $('transfer-id').value.trim();
  const fromBlock = Number($('from-block').value);
  if (!/^0x[0-9a-f]{64}$/i.test(transferId) || !Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw Error(`${actionLabel} ID와 출발 블록을 확인하세요.`);
  }
  return {action: flow, transferId, fromBlock};
}
async function recover(advance = true) {
  const value = pending();
  if (!value || (value.flow && value.flow !== flow)) return;
  const step = pendingStep(value);
  const chain = value.chain === manifest.chains.wl.id ? 'wl' : 'bnb';
  const supplied = $('recovery-hash').value.trim();
  let hash = value.transactionHash;
  if (supplied) {
    if (!/^0x[0-9a-f]{64}$/i.test(supplied)) throw Error('거래 해시 형식이 잘못됐습니다.');
    const tx = await rpc(chain, 'eth_getTransactionByHash', [supplied]);
    if (!tx || !equal(tx.from, value.owner) || BigInt(tx.nonce) !== BigInt(value.nonce)) {
      throw Error('기록된 지갑과 nonce가 일치하는 거래를 찾지 못했습니다.');
    }
    if (!sameTransaction(value.transaction, {...tx, data:tx.input})) {
      const replacement = await rpc(chain, 'eth_getTransactionReceipt', [supplied]);
      if (!replacement) throw Error('대체 거래가 채굴되면 다시 조회하세요.');
      localStorage.removeItem(pendingKey());
      $('recovery-hash').value = '';
      clearPreview();
      status('대체 거래로 기존 nonce가 사용됐습니다. 원래 작업의 체인 기록을 확인하세요.', step);
      if (bridge) await syncHistory();
      return;
    }
    hash = supplied;
    localStorage.setItem(pendingKey(), JSON.stringify({...value, retry:false, transactionHash:hash}));
  }
  if (!hash) {
    status('지갑에서 거래 결과를 받지 못했습니다. 지갑의 거래 기록을 확인하세요.', step, true);
    return;
  }
  const receipt = await rpc(chain, 'eth_getTransactionReceipt', [hash]);
  if (!receipt) {
    status('거래를 전송했습니다. 체인 확인을 기다리는 중입니다.', step);
    return;
  }
  if (!supplied) {
    const tx = await rpc(chain, 'eth_getTransactionByHash', [hash]);
    if (!tx || !equal(tx.from, value.owner) || BigInt(tx.nonce) !== BigInt(value.nonce)
        || !sameTransaction(value.transaction, {...tx, data:tx.input})) {
      throw Error('영수증의 거래가 검토한 내용과 다릅니다. 지갑 내역에서 원본 또는 대체 거래를 확인하세요.');
    }
  }
  clearPreview();
  $('recovery-hash').value = '';
  if (BigInt(receipt.status) !== 1n) {
    localStorage.removeItem(pendingKey());
    status('거래가 되돌려졌습니다. 같은 단계에서 다시 시도할 수 있습니다.', step, true);
    return;
  }
  const forwardBurn = value.chain === manifest.chains.wl.id;
  const burnAction = vault ? forwardBurn ? 'lock-vault' : 'burn-vault' : forwardBurn ? 'burn-wl' : 'burn-bsc';
  const event = receipt.logs.find(log => equal(log.address, manifest.contracts[forwardBurn ? 'original' : 'wrapped']) && equal(log.topics[0], topic));
  const claim = receipt.logs.find(log => equal(log.address, manifest.contracts[forwardBurn ? 'unlock' : 'mint']) && equal(log.topics[0], claimTopic));
  if (event) {
    const item = selectionFromLog(event, burnAction);
    if (bridge && flow === burnAction) {
      selectBurn(item);
      showBurn(event);
      minted = await checkClaim(item.transferId);
      recordBurn(event, minted);
      status(`${actionLabel} 거래가 확인됐습니다.`, 'burn');
      if (advance && !minted) focusStep('proof');
    } else {
      localStorage.setItem(key(burnAction + '-event'), JSON.stringify(item));
      status(`${actionLabel} 거래가 확인됐습니다. 해당 방향 페이지에서 이어가세요.`, step);
    }
  } else if (bridge && claim && equal(claim.topics[1], selected?.transferId)) {
    minted = true;
    const row = history.get(selected.transferId.toLowerCase());
    if (row) row.claimed = true;
    renderHistory();
    status(`${claimLabel} 거래가 확인됐습니다.`, 'mint');
  } else {
    if (!bridge) tokenDone = true;
    status('거래가 수락됐습니다.', step);
  }
  localStorage.removeItem(pendingKey());
  await balances();
}
async function recoverPending(advance = true) {
  if (navigator.locks) return navigator.locks.request(pendingKey(), () => recover(advance));
  return recover(advance);
}
function sameTransaction(a, b) {
  return equal(a.to, b.to) && equal(a.data, b.data) && BigInt(a.value || 0) === BigInt(b.value || 0);
}
async function allowSameNonceRetry() {
  if (!navigator.locks) throw Error('거래 잠금을 지원하는 브라우저가 필요합니다.');
  await navigator.locks.request(pendingKey(), async () => {
    const saved = pending();
    if (!saved || saved.transactionHash || (saved.flow && saved.flow !== flow)) throw Error('재검토할 거래가 없습니다.');
    const chain = saved.chain === manifest.chains.wl.id ? 'wl' : 'bnb';
    for (const tag of ['latest','pending']) {
      const nonce = await rpc(chain, 'eth_getTransactionCount', [saved.owner, tag]);
      if (BigInt(nonce) !== BigInt(saved.nonce)) throw Error('지갑 내역에서 원본 또는 대체 거래 해시를 확인하세요.');
    }
    localStorage.setItem(pendingKey(), JSON.stringify({...saved, retry:true}));
    status('원래 거래를 다시 검토하세요. 동일 nonce와 거래 내용만 서명할 수 있습니다.', pendingStep(saved));
  });
}
async function submit() {
  const value = preview;
  if (!value) return;
  if (!navigator.locks) throw Error('거래 잠금을 지원하는 브라우저가 필요합니다.');
  const step = transactionStep(value);
  await navigator.locks.request(pendingKey(), async () => {
    const previous = pending();
    if ((previous && (!previous.retry || (previous.flow && previous.flow !== flow))) || preview !== value) {
      throw Error('미확인 거래 상태를 먼저 확인하세요.');
    }
    clearPreview();
    let saved = false;
    const save = async record => {
      if (previous && (record.chain !== previous.chain || BigInt(record.nonce) !== BigInt(previous.nonce)
          || !sameTransaction(previous.transaction,record.transaction))) {
        throw Error('이전과 같은 거래와 nonce를 사용해야 합니다.');
      }
      localStorage.setItem(pendingKey(), JSON.stringify({...record, flow, step}));
      saved = true;
    };
    try {
      if (value.nativeMethod) await client.submitNativeAction(value, save);
      else if (value.tokenMethod) await client.submitTokenAction(value, save);
      else if (value.action) {
        await checkTestnetSource(value.recipient);
        await client.submitAction(value, save);
      }
      else await client.submit(value, save);
    } catch (error) {
      if (error.code === 4001 && saved) {
        if (previous) localStorage.setItem(pendingKey(), JSON.stringify(previous));
        else localStorage.removeItem(pendingKey());
      }
      throw error;
    }
    await recover();
  });
}
async function acceptPackage(value, advance) {
  validatePackage(value, manifest);
  if (value.action !== flow) throw Error('이 페이지의 이동 방향과 다른 증명입니다.');
  await client.verifyComputation(value);
  const item = {action: flow, transferId: value.transferId, fromBlock: value.blockNumber};
  const alreadyClaimed = await checkClaim(item.transferId);
  selectBurn(item);
  burn = {amount: formatUnits(BigInt(value.amount), 18), recipient: value.recipient};
  $('burn-summary').textContent = `${burn.amount} ${sourceUnit} ${actionLabel} 거래가 확인됐습니다. 수신자 ${burn.recipient}`;
  packageData = value;
  minted = alreadyClaimed;
  proofPhase = 'ready';
  $('proof-status').textContent = '증명 생성과 SDK 검증을 완료했습니다.';
  if (advance) focusStep('mint');
}
async function poll(advance) {
  if (!job) return;
  const state = await api('/api/jobs/' + job.id);
  rememberJob(state);
  if (state.state === 'ready') {
    try {
      const value = await api('/api/jobs/' + job.id + '/package');
      if (!sameBurn(selected, {action: value.action, transferId: value.transferId, fromBlock: value.blockNumber})) {
        throw Error(`선택한 ${actionLabel}과 증명 결과가 다릅니다.`);
      }
      await acceptPackage(value, advance);
    } catch (error) {
      proofPhase = 'failed';
      $('proof-status').textContent = '증명 확인에 실패했습니다. 다시 요청하거나 상태를 조회하세요.';
      throw error;
    }
  } else if (state.state === 'waiting_root' || state.state === 'waiting_registry') {
    proofPhase = state.state;
    $('proof-status').textContent = state.detail;
  } else if (state.state === 'failed') {
    proofPhase = 'failed';
    $('proof-status').textContent = '증명 요청에 실패했습니다. ' + state.detail;
  } else {
    proofPhase = 'running';
    $('proof-status').textContent = '증명을 준비하고 있습니다. 보통 몇 분 걸립니다.';
  }
}
function preferredJob(item) {
  const priority = {ready: 3, running: 2, queued: 2, waiting_confirmations: 2, waiting_root: 2, waiting_registry: 2, failed: 1};
  return proofJobs.filter(entry => sameTransfer(item, entry.request) && entry.request.fromBlock <= item.fromBlock)
    .sort((a, b) => (priority[b.state] || 0) - (priority[a.state] || 0) || b.updatedAt - a.updatedAt)[0];
}
function rememberJob(value) {
  job = value;
  localStorage.setItem(flowKey('job-' + value.request.transferId.toLowerCase()), JSON.stringify(value));
  proofJobs = [...proofJobs.filter(entry => entry.id !== value.id), value];
  renderHistory();
}
async function refreshJobs() {
  lastHistoryPoll = Date.now();
  try {
    const {jobs} = await api('/api/jobs?action=' + flow);
    proofJobs = jobs;
    proofJobsAvailable = true;
  } catch {
    proofJobsAvailable = false;
  }
  if (!job) restoreJob();
}
function recordBurn(event, claimed, records = history) {
  const item = selectionFromLog(event, flow);
  const {amount, burner, recipient} = abi.parseLog(event).args;
  records.set(item.transferId.toLowerCase(), {...item, amount: formatUnits(amount, 18), burner, recipient, claimed});
  if (records === history) renderHistory();
}
function renderHistory() {
  const events = $('events');
  if (!events) return;
  const rows = [...history.values()].sort((a, b) => b.fromBlock - a.fromBlock);
  if (owner) {
    const outstanding = rows.filter(row => !row.claimed).length;
    let message = rows.length ? `전체 ${rows.length}건 · ${claimLabel} 대기 ${outstanding}건. 거래를 선택해 이어가세요.` : `이 방향에 ${actionLabel} 또는 수신 기록이 없습니다.`;
    if (!proofJobsAvailable && rows.length) message += ' 증명 상태를 확인하려면 새로고침하세요.';
    if ($('history-status').textContent !== message) $('history-status').textContent = message;
  }
  const states = rows.map(row => preferredJob(row)?.state);
  const view = JSON.stringify([rows, states, owner, selected?.transferId, proofJobsAvailable]);
  if (view === renderedHistory) return;
  renderedHistory = view;
  const focusedId = events.contains(document.activeElement) ? document.activeElement.dataset.transferId : null;
  events.replaceChildren();
  const labels = {ready: '증명 준비됨', failed: '증명 다시 요청', running: '증명 생성 중', queued: '증명 대기 중',
    waiting_confirmations: '블록 확인 대기', waiting_root: '루트 등록 대기', waiting_registry: '레지스트리 재개 대기'};
  for (const [index, row] of rows.entries()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const title = document.createElement('strong');
    const quantities = document.createElement('span');
    const detail = document.createElement('span');
    const badge = document.createElement('span');
    const state = states[index];
    const outgoing = equal(row.burner, owner);
    title.textContent = outgoing ? `내가 ${actionLabel}한 거래` : '내가 받을 거래';
    quantities.className = 'history-amounts';
    quantities.textContent = `${actionLabel} ${row.amount} ${sourceUnit} · ${claimLabel} ${row.claimed ? row.amount : '0'} ${destinationUnit}`;
    detail.className = 'history-meta';
    detail.textContent = '블록 ' + row.fromBlock + ' · ' + row.transferId.slice(0, 12) + '…' + row.transferId.slice(-6);
    button.title = actionLabel + ' ID ' + row.transferId;
    badge.textContent = row.claimed ? `✓ ${claimLabel} 완료` : labels[state] || (proofJobsAvailable ? '증명 미요청' : '증명 상태 확인 필요');
    badge.className = 'history-badge';
    button.dataset.state = row.claimed ? 'done' : state || 'unproved';
    button.dataset.transferId = row.transferId;
    button.setAttribute('aria-pressed', String(Boolean(sameTransfer(selected, row))));
    button.append(title, badge, quantities, detail);
    button.onclick = () => task('proof', async () => {
      selectBurn({action: row.action, transferId: row.transferId, fromBlock: row.fromBlock});
      await loadBurn();
      focusStep(minted ? 'mint' : 'proof');
      if (job && !minted && !packageData) await poll(true);
    });
    item.append(button);
    events.append(item);
    if (row.transferId === focusedId) button.focus({preventScroll: true});
  }
}
async function refreshHistory() {
  $('history-status').textContent = `체인에서 ${actionLabel} 기록을 불러오고 있습니다.`;
  const matches = new Map();
  const accountTopic = '0x' + '0'.repeat(24) + owner.slice(2);
  const height = Number(BigInt(await rpc(source, 'eth_blockNumber')));
  for (let start = manifest.chains[source].historyStartBlock || 0; start <= height; start += 2000) {
    const range = {
      address: manifest.contracts[sourceToken], fromBlock: '0x' + start.toString(16),
      toBlock: '0x' + Math.min(height, start + 1999).toString(16)
    };
    const logs = await Promise.all([
      rpc(source, 'eth_getLogs', [{...range, topics: [topic, null, accountTopic]}]),
      rpc(source, 'eth_getLogs', [{...range, topics: [topic, null, null, accountTopic]}])
    ]);
    for (const event of logs.flat()) if (!event.removed) matches.set(event.topics[1].toLowerCase(), event);
  }
  const records = new Map();
  const logs = [...matches.values()];
  for (let offset = 0; offset < logs.length; offset += 8) {
    await Promise.all(logs.slice(offset, offset + 8).map(async event => recordBurn(event, await checkClaim(event.topics[1]), records)));
  }
  history = records;
  await refreshJobs();
  const active = selected && history.get(selected.transferId.toLowerCase());
  if (burn && active?.claimed && !minted) {
    minted = true;
    clearPreview();
    $('proof-status').textContent = `이 거래의 목적지 ${claimLabel}을 완료했습니다.`;
  }
  renderHistory();
}
async function syncHistory() {
  try { await refreshHistory(); }
  catch (error) {
    $('history-status').textContent = `${actionLabel} 기록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.`;
    status(error.message, 'wallet', true);
  }
}

$('demo-wallet').onclick = () => task('wallet', () => connect(true));
$('extension-wallet').onclick = () => task('wallet', () => connect(false));
$('balances').onclick = () => task('wallet', balances);
$('account').onchange = () => {
  if (equal($('recipient').value, owner)) $('recipient').value = '';
  client = owner = null;
  history.clear();
  clearPreview();
  $('owner').textContent = '미연결';
  $('balances-view').textContent = '—';
  $('ledger-view').textContent = '';
  if (bridge) {
    renderHistory();
    $('history-status').textContent = `지갑을 연결하면 ${actionLabel}한 거래와 내가 받을 거래를 불러옵니다.`;
  }
  status('선택한 계정의 데모 지갑을 연결하세요.', 'wallet');
  controls();
};
$('prepare-action').onclick = () => task(bridge ? 'burn' : 'tools', async () => {
  clearPreview();
  const chain = bridge ? manifest.chains[source].id : Number($('chain').value);
  await client.switchChain(chain);
  const amount = parseUnits($('amount').value, 18).toString();
  const recipient = $('recipient').value.trim();
  if (bridge) {
    await checkTestnetSource(recipient,true);
    review(await client.action(flow, amount, owner, recipient));
  }
  else {
    tokenDone = false;
    const value = vault && chain === manifest.chains.wl.id ? await client.nativeAction('nativeTransfer', amount, owner, recipient)
      : await client.tokenAction($('action').value, amount, owner, recipient, chain, $('from').value.trim());
    review(value);
  }
});
for (const name of ['amount', 'recipient', 'chain', 'action', 'from']) {
  $(name)?.addEventListener('input', () => { clearPreview(); controls(); });
}
$('submit').onclick = () => task(preview ? transactionStep(preview) : 'wallet', submit);
$('recover').onclick = () => task(pending() ? pendingStep(pending()) : 'wallet', recoverPending);
$('retry-pending').onclick = () => task(pending() ? pendingStep(pending()) : 'wallet', allowSameNonceRetry);

if (bridge) {
  $('request-proof').onclick = () => task('proof', async () => {
    if (!burn || !selected || minted) return;
    rememberJob(await api('/api/jobs', job?.request || selected));
    await poll(true);
  });
  $('poll-proof').onclick = () => task('proof', () => poll(true));
  $('restore-burn').onclick = () => task('proof', async () => {
    selectBurn(parseSelection());
    await loadBurn();
    if (!job) restoreJob();
  });
  $('discover').onclick = () => task('wallet', syncHistory);
  $('package').onchange = () => task('proof', async () => {
    const file = $('package').files[0];
    if (!file || file.size > 16 * 1024 * 1024) throw Error('16 MiB 이하 JSON이 필요합니다.');
    clearPreview();
    await acceptPackage(JSON.parse(await file.text()), true);
    status('증명 파일을 SDK로 재검증했습니다.', 'proof');
  });
  $('download-package').onclick = () => {
    if (!packageData) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(packageData, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = flow + '-' + packageData.transferId + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('prepare-claim').onclick = () => task('mint', async () => {
    clearPreview();
    minted = await checkClaim(selected.transferId);
    if (minted) return;
    await client.switchChain(packageData.destinationChainId);
    const payout = $('payout-recovery').hidden ? undefined : $('payout').value.trim();
    review(await client.preview(packageData, 'claim', payout));
  });
  $('new-burn').onclick = () => {
    selectBurn(null);
    $('proof-status').textContent = `${actionLabel} 거래가 확인되면 증명을 요청할 수 있습니다.`;
    status('', 'burn');
    controls();
    focusStep('burn');
  };
  $('payout').oninput = () => { clearPreview(); controls(); };
} else {
  $('audit').onclick = () => task('tools', async () => {
    $('audit-view').textContent = JSON.stringify(await api('/api/audit'), null, 2);
  });
}

window.addEventListener('storage', () => { clearPreview(); controls(); });
await task('wallet', async () => {
  const configuration = validateManifest(await api('/api/manifest'));
  const supported = vault ? ['native-wl-vault-v1','native-wl-vault-testnet-v1'] : ['burn-mint-v2'];
  if (!supported.includes(configuration.protocol)) {
    throw Error(vault ? '격리된 Vault 서버가 필요합니다.' : '격리된 V2 서버가 필요합니다.');
  }
  manifest = configuration;
  if (manifest.readOnlyTestnet) {
    $('demo-account-field').hidden = $('demo-wallet').hidden = true;
    document.querySelector('header .tag').textContent = 'Gwangju · BSC 테스트넷';
    if (!bridge) {
      $('chain').options[0].value = String(manifest.chains.wl.id);
      $('chain').options[1].value = String(manifest.chains.bnb.id);
    }
  }
  if (manifest.assetProfile === 'xwl-entry-v1') {
    const home = document.querySelector('.page-links a');
    home.href = 'xwl.html';
    home.textContent = '← xWL 지갑';
    const help = document.querySelector('.page-links a[href="burn-mint-manual.html"]');
    if (help) help.href = 'xwl.html#help';
    if (bridge) {
      sourceUnit = forward ? 'xWL' : 'wWL';
      destinationUnit = forward ? 'wWL' : 'xWL';
      const heading = `${sourceUnit} → ${destinationUnit}`;
      document.querySelector('h1').textContent = heading;
      document.title = heading + ' · Burn & Mint';
      $('title-burn').textContent = sourceUnit + ' 소각';
      $('burn-intro').textContent = `${sourceUnit}를 소각하고 ${forward ? 'BSC' : 'WorldLand'}에서 받을 주소를 지정하세요.`;
      $('title-mint').textContent = destinationUnit + ' 발행';
      $('prepare-claim').textContent = destinationUnit + ' 발행 미리보기';
    } else {
      $('chain').options[0].textContent = 'WorldLand · xWL';
    }
  }
  if (bridge) {
    const saved = load(flowKey('event'));
    const legacy = load(key('event'));
    inputSelection(saved?.action === flow ? saved : !localStorage.getItem(flowKey('event')) && legacy?.action === flow ? legacy : null);
    if (!selected && localStorage.getItem(flowKey('event')) === null) {
      const previous = load(flowKey('job')) || load(key('job'));
      if (previous?.request?.action === flow) inputSelection(previous.request);
    }
    restoreJob();
  }
  status((vault ? 'Vault' : 'V2') + ' 준비 완료 · 지갑을 연결하세요.', 'wallet');
});

setInterval(() => {
  if (!client || busy) return;
  const saved = pending();
  if (saved?.transactionHash && (!saved.flow || saved.flow === flow)) {
    task(pendingStep(saved), recoverPending);
  } else if (bridge && history.size && Date.now() - lastHistoryPoll > 15000) {
    task('wallet', async () => { await refreshJobs(); renderHistory(); });
  } else if (bridge && job && !packageData && !minted && proofPhase !== 'failed') {
    const rect = $('step-proof').getBoundingClientRect();
    task('proof', () => poll(rect.bottom > 0 && rect.top < innerHeight));
  }
}, 5000);
