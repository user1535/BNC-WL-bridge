import {BurnMintClient} from './burn-mint-client.mjs';
import {validateManifest} from './client.mjs';
import {DemoWallet} from './demo-wallet.mjs';
import {Interface, formatUnits, getAddress, parseUnits} from './vendor/ethers-6.15.0.min.mjs';

const $ = id => document.getElementById(id);
const entryPage = document.body.dataset.xwl === 'entry';
const flow = entryPage ? 'xwl-entry' : 'xwl-trade';
const abi = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function totalEntryMinted() view returns(uint256)',
  'function totalNativeSent() view returns(uint256)',
  'function enter(address) payable',
  'function transfer(address,uint256)',
  'event EntryIssued(address indexed payer,address indexed recipient,uint256 nativeSent,uint256 xwlMinted)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const zero = '0x' + '0'.repeat(40);
const units = amount => formatUnits(amount, 18);
let manifest, client, owner, preview, terms;
let busy = false;
const verified = {xwl: false, wl: false};

const key = suffix => 'bnc-burn-mint-v2-' + manifest.sessionId + '-' + suffix;
const pendingKey = () => key('pending-' + owner.toLowerCase());
const entryKey = () => key('entry-last-' + owner.toLowerCase());
const tradeKey = () => key('trade-' + [terms.seller, terms.buyer, terms.xwl, terms.wl].join('-').toLowerCase());
const legKey = kind => tradeKey() + '-' + kind;
function load(name) {
  try { return JSON.parse(localStorage.getItem(name)); } catch { return null; }
}
function pending() { return owner ? load(pendingKey()) : null; }
function status(message, error = false) {
  $('status').textContent = message;
  $('status').toggleAttribute('data-error', error);
}
function controls() {
  const saved = pending();
  const foreign = saved && saved.flow !== flow;
  for (const element of document.querySelectorAll('button,input,select')) element.disabled = busy;
  for (const name of ['demo-wallet','extension-wallet']) $(name).disabled = busy || !manifest;
  $('submit').disabled = busy || !preview || Boolean(saved);
  $('recover').disabled = busy || !saved || Boolean(foreign);
  $('pending-link').hidden = !foreign;
  if (foreign) {
    const pages = {'burn-wl':'burn-wl.html', 'burn-bsc':'burn-bsc.html', tools:'burn-mint-tools.html', 'xwl-entry':'xwl-entry.html', 'xwl-trade':'xwl-trade.html'};
    $('pending-link').href = pages[saved.flow] || 'xwl.html';
  }
  if (entryPage) $('entry-preview').disabled = busy || !client || Boolean(saved);
  else {
    $('save-terms').disabled = busy || Boolean(saved);
    $('verify-trade').disabled = busy || !terms;
    $('xwl-preview').disabled = busy || !client || !terms || !same(owner, terms.seller) || verified.xwl || Boolean(saved);
    $('wl-preview').disabled = busy || !client || !terms || !same(owner, terms.buyer) || verified.wl || Boolean(saved);
    for (const name of ['seller','buyer','xwl-amount','wl-amount','xwl-hash','wl-hash']) $(name).disabled = busy || Boolean(saved);
  }
}
async function task(action) {
  if (busy) return;
  busy = true;
  controls();
  try { await action(); } catch (error) { status(error.message, true); }
  finally { busy = false; controls(); }
}
async function rpc(method, params = []) {
  const response = await fetch('/rpc/wl', {
    method: 'POST', headers: {'Content-Type':'application/json', 'X-Bridge-Request':'1'},
    body: JSON.stringify({jsonrpc:'2.0', id:1, method, params}), signal: AbortSignal.timeout(20000)
  });
  const value = await response.json();
  if (!response.ok || value.error) throw Error(value.error?.message || value.error || 'WorldLand RPC 오류');
  return value.result;
}
async function tokenRead(method, args = []) {
  const raw = await rpc('eth_call', [{to: manifest.contracts.original, data: abi.encodeFunctionData(method, args)}, 'latest']);
  return abi.decodeFunctionResult(method, raw)[0];
}
async function balances() {
  const [wl, xwl] = await Promise.all([rpc('eth_getBalance', [owner,'latest']), tokenRead('balanceOf',[owner])]);
  $('balances-view').textContent = units(BigInt(wl)) + ' WL · ' + units(xwl) + ' xWL';
}
function parseAddress(value) {
  const address = getAddress(value.trim());
  if (address === zero) throw Error('0 주소를 사용할 수 없습니다.');
  return address;
}
function parseAmount(value) {
  const amount = parseUnits(value.trim(), 18);
  if (amount <= 0n || amount >= 2n**256n) throw Error('18자리 단위의 양수 수량을 입력하세요.');
  return amount.toString();
}
function clearPreview() {
  preview = null;
  $('review-panel').hidden = true;
}
function review(value, kind) {
  preview = {value, kind};
  const unit = kind === 'xwl' ? 'xWL' : 'WL';
  $('review').textContent = [
    kind === 'entry' ? units(value.amount) + ' WL 소각 → ' + units(value.amount) + ' xWL 발행' : units(value.amount) + ' ' + unit + ' 전송',
    '보내는 주소 ' + value.owner, '받는 주소 ' + value.recipient
  ].join('\n');
  $('review-panel').hidden = false;
  $('review-panel').scrollIntoView({block:'nearest'});
}
function expectedTrade(kind) {
  const native = kind === 'wl';
  return {
    kind, amount: terms[kind], owner: native ? terms.buyer : terms.seller, recipient: native ? terms.seller : terms.buyer
  };
}
async function verifyReceipt(hash, expected) {
  if (!hashPattern.test(hash)) throw Error('거래 해시 형식이 올바르지 않습니다.');
  const [tx, receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])
  ]);
  if (!tx || !receipt) return false;
  const amount = BigInt(expected.amount);
  const native = expected.kind === 'wl';
  const entry = expected.kind === 'entry';
  const to = native ? expected.recipient : manifest.contracts.original;
  const data = native ? '0x' : entry ? abi.encodeFunctionData('enter',[expected.recipient]) :
    abi.encodeFunctionData('transfer',[expected.recipient,amount]);
  if (BigInt(receipt.status) !== 1n || !same(tx.hash, hash) || !same(receipt.transactionHash, hash) ||
      !same(tx.blockHash, receipt.blockHash) || !same(tx.from, expected.owner) || !same(tx.to, to) ||
      !same(tx.input, data) || BigInt(tx.value) !== (native || entry ? amount : 0n)) {
    throw Error('서명한 거래와 입력한 주소·수량이 일치하지 않습니다.');
  }
  if (!native) {
    const matched = receipt.logs.some(log => {
      if (!same(log.address, manifest.contracts.original)) return false;
      const event = abi.parseLog(log);
      if (entry) return event?.name === 'EntryIssued' && same(event.args.payer, expected.owner) &&
        same(event.args.recipient, expected.recipient) && event.args.nativeSent === amount && event.args.xwlMinted === amount;
      return event?.name === 'Transfer' && same(event.args.from, expected.owner) &&
        same(event.args.to, expected.recipient) && event.args.value === amount;
    });
    if (!matched) throw Error('영수증에 해당 xWL 기록이 없습니다.');
  }
  return true;
}
async function displayEntry(hash, expected) {
  const confirmed = await verifyReceipt(hash, expected);
  if (!confirmed) return false;
  const [nativeSent, minted] = await Promise.all([tokenRead('totalNativeSent'), tokenRead('totalEntryMinted')]);
  $('entry-badge').textContent = '✓ 소각·발행 완료';
  $('entry-step').dataset.state = 'done';
  $('entry-result').textContent = units(expected.amount) + ' WL 소각 · ' + units(expected.amount) +
    ' xWL 발행. 누계 ' + units(nativeSent) + ' WL / ' + units(minted) + ' xWL.';
  return true;
}
async function verifyTrade() {
  const hashes = {xwl: $('xwl-hash').value.trim(), wl: $('wl-hash').value.trim()};
  await Promise.all(Object.keys(hashes).map(async kind => {
    const expected = expectedTrade(kind);
    let detail = '전송 대기';
    verified[kind] = false;
    if (hashes[kind]) {
      try {
        verified[kind] = await verifyReceipt(hashes[kind], expected);
        detail = verified[kind] ? '✓ 영수증 확인' : '거래 확인 대기';
      } catch (error) {
        detail = '확인 실패 · ' + error.message;
      }
    }
    $(kind + '-leg').textContent = units(expected.amount) + ' ' + (kind === 'wl' ? 'WL' : 'xWL') + ' · ' + detail;
  }));
  const count = Number(verified.xwl) + Number(verified.wl);
  $('trade-status').textContent = count === 2 ? '✓ 거래 완료 · 두 전송 확인' : count === 1 ? '한 건만 확인됨 · 상대 전송 대기' : '전송 확인 0 / 2';
  $('trade-legs').dataset.state = count === 2 ? 'done' : 'current';
}
async function openTerms(value) {
  terms = value;
  localStorage.setItem(key('trade-terms'), JSON.stringify(terms));
  const hashes = load(tradeKey()) || {};
  for (const kind of ['xwl', 'wl']) $(kind + '-hash').value = localStorage.getItem(legKey(kind)) ?? hashes[kind] ?? '';
  $('trade-legs').hidden = false;
  await verifyTrade();
}
async function connect(demo) {
  clearPreview();
  const next = new BurnMintClient(demo ? new DemoWallet(manifest, Number($('account').value)) : window.ethereum, manifest);
  const [address] = await next.connect();
  if (!address) throw Error('지갑에서 계정을 선택하세요.');
  if (entryPage && (!$('entry-recipient').value || same($('entry-recipient').value, owner))) $('entry-recipient').value = address;
  client = next;
  owner = address;
  $('owner').textContent = address;
  status('지갑 연결 완료');
  await balances();
  if (pending()?.flow === flow) await recover();
  else if (pending()) status('다른 작업에 미확인 거래가 있습니다.');
  else if (entryPage) {
    const saved = load(entryKey());
    if (saved) await displayEntry(saved.hash, saved.expected);
  }
}
async function recover() {
  const saved = pending();
  if (!saved || saved.flow !== flow) return;
  if (!saved.transactionHash) {
    status('지갑에서 거래 해시를 받지 못했습니다. 지갑의 거래 기록을 확인하세요.', true);
    return;
  }
  const receipt = await rpc('eth_getTransactionReceipt', [saved.transactionHash]);
  if (!receipt) {
    status('전송했습니다. 체인 확인을 기다리고 있습니다.');
    return;
  }
  if (BigInt(receipt.status) !== 1n) {
    localStorage.removeItem(pendingKey());
    throw Error('거래가 되돌려졌습니다. 상태를 확인하고 다시 시도하세요.');
  }
  if (entryPage) {
    if (!await displayEntry(saved.transactionHash, saved.expected)) return;
    localStorage.setItem(entryKey(), JSON.stringify({hash:saved.transactionHash, expected:saved.expected}));
  } else {
    if (!await verifyReceipt(saved.transactionHash, saved.expected)) return;
    await openTerms(saved.terms);
    $(saved.expected.kind + '-hash').value = saved.transactionHash;
    localStorage.setItem(legKey(saved.expected.kind), saved.transactionHash);
    await verifyTrade();
  }
  localStorage.removeItem(pendingKey());
  status('거래가 확인됐습니다. ' + saved.transactionHash);
  await balances();
}
async function submit() {
  const draft = preview;
  if (!draft || !navigator.locks) throw Error('검토와 거래 잠금을 확인하세요.');
  await navigator.locks.request(pendingKey(), async () => {
    if (pending() || preview !== draft) throw Error('미확인 거래부터 확인하세요.');
    const expected = {kind:draft.kind, amount:draft.value.amount, owner:draft.value.owner, recipient:draft.value.recipient};
    clearPreview();
    let saved = false;
    const save = async record => {
      localStorage.setItem(pendingKey(), JSON.stringify({...record, flow, expected, terms}));
      saved = true;
    };
    try {
      if (draft.kind === 'xwl') await client.submitTokenAction(draft.value, save);
      else await client.submitNativeAction(draft.value, save);
    } catch (error) {
      if (error.code === 4001 && saved) localStorage.removeItem(pendingKey());
      throw error;
    }
    await recover();
  });
}

$('demo-wallet').onclick = () => task(() => connect(true));
$('extension-wallet').onclick = () => task(() => connect(false));
$('account').onchange = () => {
  if (entryPage && same($('entry-recipient').value, owner)) $('entry-recipient').value = '';
  owner = client = null;
  clearPreview();
  $('owner').textContent = '미연결';
  $('balances-view').textContent = '—';
  if (entryPage) {
    $('entry-step').dataset.state = '';
    $('entry-badge').textContent = '대기';
    $('entry-result').textContent = '';
  }
  status('선택한 계정의 지갑을 연결하세요.');
  controls();
};
$('submit').onclick = () => task(submit);
$('recover').onclick = () => task(recover);
if (entryPage) {
  for (const name of ['entry-amount','entry-recipient']) $(name).oninput = () => { clearPreview(); controls(); };
  $('entry-preview').onclick = () => task(async () => {
    clearPreview();
    await client.switchChain(31337);
    const value = await client.nativeAction('entry', parseAmount($('entry-amount').value), owner, parseAddress($('entry-recipient').value));
    review(value, 'entry');
  });
} else {
  for (const name of ['seller','buyer','xwl-amount','wl-amount']) $(name).oninput = () => {
    terms = null;
    clearPreview();
    $('trade-legs').hidden = true;
    controls();
  };
  $('save-terms').onclick = () => task(async () => {
    const seller = parseAddress($('seller').value);
    const buyer = parseAddress($('buyer').value);
    if (same(seller, buyer)) throw Error('서로 다른 두 주소를 지정하세요.');
    await openTerms({seller, buyer, xwl:parseAmount($('xwl-amount').value), wl:parseAmount($('wl-amount').value)});
  });
  for (const kind of ['xwl','wl']) {
    $(kind + '-hash').onchange = () => task(async () => {
      clearPreview();
      localStorage.setItem(legKey(kind), $(kind + '-hash').value.trim());
      await verifyTrade();
    });
    $(kind + '-preview').onclick = () => task(async () => {
      clearPreview();
      await verifyTrade();
      if (verified[kind]) throw Error('이미 확인된 전송입니다.');
      if ($(kind + '-hash').value.trim()) throw Error('이 전송의 기존 해시를 먼저 확인하세요.');
      await client.switchChain(31337);
      const expected = expectedTrade(kind);
      const value = kind === 'xwl' ? await client.tokenAction('transfer',expected.amount,expected.owner,expected.recipient,31337) :
        await client.nativeAction('nativeTransfer',expected.amount,expected.owner,expected.recipient);
      review(value, kind);
    });
  }
  $('verify-trade').onclick = () => task(verifyTrade);
}
window.addEventListener('storage', event => {
  clearPreview();
  controls();
  if (terms && ['xwl', 'wl'].some(kind => event.key === legKey(kind))) {
    task(async () => {
      for (const kind of ['xwl', 'wl']) {
        if (event.key === legKey(kind)) $(kind + '-hash').value = event.newValue || '';
      }
      await verifyTrade();
    });
  }
});
setInterval(() => {
  if (pending()?.flow === flow && pending().transactionHash && !busy) task(recover);
}, 5000);

await task(async () => {
  const response = await fetch('/api/manifest', {signal:AbortSignal.timeout(10000)});
  const value = validateManifest(await response.json());
  if (value.assetProfile !== 'xwl-entry-v1') throw Error('xWL 전용 로컬 서버에서 이 화면을 여세요.');
  manifest = value;
  if (entryPage) {
    $('entry-policy').textContent = '1 WL당 1 xWL · 진입 발행 한도 ' + units(manifest.entryPolicy.entryCap) + ' xWL';
  } else {
    const saved = load(key('trade-terms'));
    $('seller').value = saved?.seller || manifest.users[0];
    $('buyer').value = saved?.buyer || manifest.users[1];
    if (saved) {
      $('xwl-amount').value = units(saved.xwl);
      $('wl-amount').value = units(saved.wl);
      await openTerms(saved);
    }
  }
  status('xWL 지갑 준비 완료');
});
