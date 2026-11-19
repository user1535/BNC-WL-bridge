#!/usr/bin/env python3
"""Queue a saved Vault event or compare the completed proofs across a local restart."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SESSION = ROOT / 'results/wl-vault-v1'
EVIDENCE = ROOT / 'results/wl-vault-validation'
URL = 'http://127.0.0.1:8584'


def api(path, body=None):
    request = urllib.request.Request(URL + path, None if body is None else json.dumps(body).encode(),
        {'Content-Type': 'application/json', 'X-Bridge-Request': '1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def rpc(chain, method, params):
    result = api('/rpc/' + chain, dict(jsonrpc='2.0', id=1, method=method, params=params))
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result['result']


def manifest_and_resume():
    manifest = api('/api/manifest')
    resume = json.loads((EVIDENCE / 'browser-resume.json').read_text())
    if manifest['protocol'] != 'native-wl-vault-v1' or manifest['sessionId'] != resume['sessionId']:
        raise RuntimeError('the saved browser run requires its original Vault session')
    return manifest, resume


def require_idle_prover():
    with (ROOT / 'results/receipt-computation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for process in Path('/proc').iterdir():
            if not process.name.isdecimal():
                continue
            try:
                comm = (process / 'comm').read_text().strip()
                arguments = (process / 'cmdline').read_bytes().split(b'\0')
            except OSError:
                continue
            if arguments and arguments[0] and comm == 'r0vm':
                raise RuntimeError('an active local RISC Zero process already owns the prover')


def saved_job(event):
    jobs = api('/api/jobs?action=' + event['action'])['jobs']
    return next((job for job in jobs if job['request'] == event), None)


def queue(key):
    _, resume = manifest_and_resume()
    event = resume['events'][key]
    job = saved_job(event)
    if job is None or job['state'] == 'failed':
        require_idle_prover()
        job = api('/api/jobs', event)
    print(json.dumps(job, ensure_ascii=False))


def fingerprint(path):
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'size': path.stat().st_size, 'mtimeNs': path.stat().st_mtime_ns}


def snapshot():
    require_idle_prover()
    manifest, resume = manifest_and_resume()
    proof_jobs = SESSION / 'proof-jobs'
    jobs = [json.loads(path.read_text()) for path in proof_jobs.glob('*.json')]
    if any(job['state'] in ('running', 'queued', 'waiting_confirmations') for job in jobs):
        raise RuntimeError('a Vault proof job is still active')
    result = {'sessionId': manifest['sessionId'], 'contracts': manifest['contracts'], 'proofs': {}, 'balances': {}}
    for key, chain in [('lock', 'wl'), ('burn', 'bnb')]:
        job = saved_job(resume['events'][key])
        if job is None or job['state'] != 'ready':
            raise RuntimeError(f'{key} must have a ready receipt before restart')
        package = api(f"/api/jobs/{job['id']}/package")
        verified = api('/api/computation/verify', package)
        if not verified['verified']:
            raise RuntimeError('RISC Zero SDK verification required')
        block = rpc(chain, 'eth_getBlockByNumber', [hex(package['blockNumber']), False])
        directories = list(proof_jobs.glob(job['id'] + '-receipt-*'))
        if len(directories) != 1:
            raise RuntimeError('expected one computation cache for the saved event')
        result['proofs'][key] = {
            'transferId': package['transferId'], 'jobId': job['id'],
            'blockHash': block['hash'], 'receiptRoot': block['receiptsRoot'],
            'receipt': fingerprint(directories[0] / 'receipt.bin'),
            'run': fingerprint(directories[0] / 'run-result.json'),
        }
        if result['proofs'][key]['receipt']['sha256'] != verified['receiptSHA256']:
            raise RuntimeError('receipt cache differs from SDK verification')
        result['balances'][chain] = {
            address: rpc(chain, 'eth_getBalance', [address, 'latest']) for address in manifest['users']
        }
    vault = manifest['contracts']['original']
    result['balances']['vaultWL'] = rpc('wl', 'eth_getBalance', [vault, 'latest'])
    session = json.loads((SESSION / 'session.json').read_text())
    result['nodePids'] = {chain: data['pid'] for chain, data in session['chains'].items()}
    return result


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prove-lock', 'prove-burn', 'snapshot', 'compare'])
    phase = parser.parse_args().phase
    if phase.startswith('prove-'):
        queue(phase.removeprefix('prove-'))
        return
    current = snapshot()
    before_path = EVIDENCE / 'restart-before.json'
    if phase == 'snapshot':
        if before_path.exists():
            raise RuntimeError('restart baseline already exists')
        save(before_path, current)
        print('Vault restart baseline saved')
        return
    before = json.loads(before_path.read_text())
    old_pids, new_pids = before.pop('nodePids'), current.pop('nodePids')
    if before != current or any(old_pids[chain] == new_pids[chain] for chain in old_pids):
        raise RuntimeError('restart identity, preserved state or node restart mismatch')
    _, resume = manifest_and_resume()
    for key, event in resume['events'].items():
        restored = api('/api/jobs', dict(event, fromBlock=0))
        if restored['id'] != current['proofs'][key]['jobId'] or restored['state'] != 'ready':
            raise RuntimeError('recovery request must reuse the existing ready proof')
    save(EVIDENCE / 'restart-result.json', dict(status='passed', freshProofs=0, beforePids=old_pids,
                                               afterPids=new_pids, deduplicatedRecoveryRequests=2, **current))
    print('Vault restart preserved both verified receipts, source blocks and balances')


if __name__ == '__main__':
    main()
