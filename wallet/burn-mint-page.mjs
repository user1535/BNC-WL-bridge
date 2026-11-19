const flow = document.body.dataset.flow;
const vault = document.body.dataset.profile === 'vault';
const tools = flow === 'tools';
const forward = flow === 'burn-wl' || flow === 'lock-vault';
const source = forward ? 'WL' : 'wWL';
const destination = forward ? 'wWL' : 'WL';
const destinationChain = forward ? 'BSC' : 'WorldLand';
const actionLabel = flow === 'lock-vault' ? '예치' : '소각';
const claimLabel = flow === 'burn-vault' ? '지급' : '발행';
const historyTitle = flow === 'lock-vault' ? '내 예치 기록' : '내 소각 기록';
const returnPage = vault ? forward ? 'vault-release.html' : 'vault-deposit.html' : forward ? 'burn-bsc.html' : 'burn-wl.html';

function step(name, number, title, content) {
  return `<section class="flow-step" id="step-${name}" aria-labelledby="title-${name}">
    <div class="step-heading">
      <span class="step-number" aria-hidden="true">${number}</span>
      <h2 id="title-${name}">${title}</h2>
      <span class="step-badge" role="status">대기</span>
    </div>
    ${content}
  </section>`;
}

const wallet = `
  <label id="demo-account-field">공개 테스트 계정
    <select id="account"><option value="1">A</option><option value="2">B</option><option value="3">C</option></select>
  </label>
  <button id="demo-wallet" disabled>데모 지갑 연결</button>
  <button id="extension-wallet" class="secondary" disabled>확장 지갑 연결</button>
  <p id="owner" class="address">미연결</p>
  <p id="balances-view">—</p>
  <button id="balances" class="secondary" disabled>잔액 새로고침</button>
  <details id="ledger"><summary>브리지 누계</summary><pre id="ledger-view"></pre></details>
  <div id="feedback-wallet"><p id="status" class="feedback" role="status">지갑을 준비하고 있습니다.</p></div>
  <div id="pending-wallet"></div>`;

const amount = '<label>수량 <input id="amount" value="1" inputmode="decimal"></label>';
const history = `
  <section id="burn-history" aria-labelledby="title-history">
    <div class="history-heading">
      <h2 id="title-history">${historyTitle}</h2>
      <button id="discover" class="secondary" disabled>새로고침</button>
    </div>
    <p id="history-status" role="status">지갑을 연결하면 ${actionLabel}한 거래와 내가 받을 거래를 불러옵니다.</p>
    <ol id="events" class="history-list"></ol>
  </section>`;
const burn = `
  <p id="burn-intro">${source}를 ${actionLabel}하고 ${destinationChain}에서 받을 주소를 지정하세요.</p>
  <p id="burn-summary" class="step-summary" hidden></p>
  <div id="burn-form">
    ${amount}
    <label>${destinationChain} 수신자 주소 <input id="recipient" autocomplete="off" spellcheck="false"></label>
    <button id="prepare-action" disabled>${actionLabel} 미리보기</button>
  </div>
  <button id="new-burn" class="secondary" hidden>새 ${actionLabel} 시작</button>
  <div id="transaction-burn"></div>
  <div id="pending-burn"></div>
  <div id="feedback-burn"></div>`;

const proof = `
  <p id="proof-status" role="status">${actionLabel} 거래가 확인되면 증명을 요청할 수 있습니다.</p>
  <button id="request-proof" disabled>증명 요청</button>
  <button id="poll-proof" class="secondary" disabled>요청 상태 조회</button>
  <details id="root-registration" hidden><summary>운영자에게 전달할 미서명 루트 등록 데이터</summary><pre id="root-registration-data"></pre></details>
  <details id="proof-recovery">
    <summary>이전 ${actionLabel} 이어가기 · 증명 파일</summary>
    <a href="#burn-history">${historyTitle}으로 이동 ↑</a>
    <label>${actionLabel} ID <input id="transfer-id" autocomplete="off" spellcheck="false"></label>
    <label>출발 블록 <input id="from-block" type="number" min="0" value="0"></label>
    <button id="restore-burn" class="secondary">${actionLabel} 불러오기</button>
    <button id="download-package" class="secondary" disabled>증명 JSON 다운로드</button>
    <label>증명 재업로드 <input id="package" type="file" accept="application/json"></label>
  </details>
  <div id="feedback-proof"></div>`;

const mint = `
  <p id="mint-summary">증명이 준비되면 지정된 주소로 ${destination} ${claimLabel}을 청구하세요.</p>
  <p id="change-recipient" hidden><a href="#step-wallet">수신자 지갑 연결로 이동 ↑</a></p>
  <details id="payout-recovery" hidden><summary>원래 수신자가 다른 주소로 지급받기</summary>
    <label>새 WL 지급 주소 <input id="payout" autocomplete="off" spellcheck="false"></label>
  </details>
  <button id="prepare-claim" disabled>${destination} ${claimLabel} 미리보기</button>
  <div id="transaction-mint"></div>
  <div id="pending-mint"></div>
  <div id="feedback-mint"></div>
  <a id="return-direction" href="${returnPage}" hidden>반대 방향으로 이동 →</a>`;

const tokenTools = `
  <label>체인 <select id="chain"><option value="31337">WorldLand · WL</option><option value="31338" selected>BSC · wWL</option></select></label>
  <label id="action-field">작업 <select id="action"><option value="transfer">전송</option><option value="approve">토큰 사용 승인</option><option value="transferFrom">대리 전송</option></select></label>
  ${amount}
  <label>수신자 또는 승인할 주소 <input id="recipient" autocomplete="off" spellcheck="false"></label>
  <label id="from-field" hidden>원본 보유자 주소 <input id="from" autocomplete="off" spellcheck="false"></label>
  <button id="prepare-action" disabled>거래 미리보기</button>
  <div id="transaction-tools"></div>
  <div id="pending-tools"></div>
  <div id="feedback-tools"></div>`;

document.getElementById('flow-content').innerHTML = `
  ${step('wallet', 1, '지갑 연결', wallet)}
  ${tools ? step('tools', 2, '토큰 거래', tokenTools) : [
    history,
    step('burn', 2, `${source} ${actionLabel}`, burn),
    step('proof', 3, `${actionLabel} 증명 생성`, proof),
    step('mint', 4, `${destination} ${claimLabel}`, mint)
  ].join('')}
  <div id="transaction-panel" class="transaction-panel" hidden>
    <h3>서명 전 검토</h3>
    <pre id="review"></pre>
    <button id="submit" disabled>지갑에서 승인·서명</button>
  </div>
  <div id="pending-panel" hidden>
    <label id="recovery-hash-field" hidden>지갑에서 확인한 원본 또는 대체 거래 해시
      <input id="recovery-hash" autocomplete="off" spellcheck="false">
    </label>
    <button id="recover" class="secondary">미확인 거래 상태 조회</button>
    <button id="retry-pending" class="secondary" hidden>같은 nonce로 다시 검토</button>
    <p id="pending-note"></p>
    <a id="pending-link" hidden>이 거래가 속한 페이지로 이동 →</a>
  </div>
  ${tools ? '<section><h2>감사 기록</h2><button id="audit" disabled>감사·체인 기록 조회</button><pre id="audit-view"></pre></section>' : ''}
`;
await import('./burn-mint-ui.mjs');
