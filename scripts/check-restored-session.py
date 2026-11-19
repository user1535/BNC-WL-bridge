#!/usr/bin/env python3
"""Read-only state/cache fingerprint for the restored service before/after restart."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
os.environ['PATH'] = str(Path.home() / '.foundry/bin') + os.pathsep + os.environ.get('PATH', '')
parser = argparse.ArgumentParser()
parser.add_argument('--session', type=Path, default=ROOT / 'results/prototype-risc0')
parser.add_argument('--url', default='http://127.0.0.1:8580')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--compare', type=Path)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('restored_session', ROOT / 'scripts/local-session.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
session = local.Session(args.session)
session.guard()


def get(path):
    with urllib.request.urlopen(args.url + path, timeout=40) as response:
        return json.load(response)


manifest = get('/api/manifest')
assert get('/api/health')['status'] == 'ok'
assert manifest['computationPolicy'] == 'risc0-receipt-computation'
balances = {}
for index, owner in enumerate(manifest['users']):
    original = int(session.view('wl', manifest['contracts']['original'], 'balanceOf(address)(uint256)', owner))
    available = int(session.view('wl', manifest['contracts']['original'], 'availableBalanceOf(address)(uint256)', owner))
    wrapped = int(session.view('bnb', manifest['contracts']['wrapped'], 'balanceOf(address)(uint256)', owner))
    balances[owner] = dict(original=str(original), available=str(available), locked=str(original - available), wrapped=str(wrapped))

proofs = {}
for file in sorted((session.root / 'proof-jobs').glob('*.json')):
    job = json.loads(file.read_text())
    assert job['state'] == 'ready', job
    package = get('/api/jobs/' + job['id'] + '/package')
    proof = package['computationProof']
    proofs[job['id']] = dict(action=package['action'], transferId=package['transferId'], blockHash=package['blockHash'],
        receiptRoot=package['receiptRoot'], receiptSHA256=proof['receiptSHA256'], imageId=proof['imageId'], sdkVerified=proof['sdkVerified'])
    source = 'wl' if package['action'] == 'lock' else 'bnb'
    block = session.rpc(source, 'eth_getBlockByNumber', [hex(package['blockNumber']), False])
    assert block['hash'].lower() == package['blockHash'].lower()
    assert block['receiptsRoot'].lower() == package['receiptRoot'].lower()

cache = {str(file.relative_to(session.root)): dict(sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
         modifiedNS=file.stat().st_mtime_ns, size=file.stat().st_size)
         for file in sorted((session.root / 'proof-jobs').glob('*receipt-*/receipt.bin'))}
result = dict(passed=True, session=str(session.root), sessionId=manifest.get('sessionId'), contracts=manifest['contracts'],
              balances=balances, proofs=proofs, cache=cache, newProofsGenerated=0)
assert len(proofs) == len(cache) == 2
if args.compare:
    before = json.loads(args.compare.read_text())
    for key in ('contracts', 'balances', 'proofs', 'cache'):
        assert before[key] == result[key], key + ' changed after restart'
    if before.get('sessionId'):
        assert before['sessionId'] == result['sessionId']
    result['restartStateAndCachePreserved'] = True
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(dict(passed=True, proofCount=len(proofs), newProofsGenerated=0,
                     restartStateAndCachePreserved=result.get('restartStateAndCachePreserved', False))))
