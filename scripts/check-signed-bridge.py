#!/usr/bin/env python3
"""Read-only local checks, durable checkpoints, restart and evidence comparison."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('signed_bridge',ROOT/'scripts/signed-bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
OUT=ROOT/'results/signed-bridge-validation'

def read_api(path):
    with urllib.request.urlopen('http://127.0.0.1:8580'+path,timeout=30) as response:return json.load(response)

def historical():
    baseline=json.loads((OUT/'historical-before.json').read_text())
    failures=[]
    for name,files in baseline.items():
        current={str(p.relative_to(ROOT)) for p in (ROOT/name).rglob('*') if p.is_file()}
        if current!=set(files):failures.append(name+':file-set')
        for path,expected in files.items():
            p=ROOT/path
            actual=dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(),size=p.stat().st_size,mtime_ns=p.stat().st_mtime_ns)
            if actual!=expected:failures.append(path)
    if failures:raise ValueError('historical evidence changed: '+str(failures))
    return {name:len(files) for name,files in baseline.items()}

def snapshot():
    session=bridge.Session(ROOT/'results/signed-xwl-v1');session.verify_bindings()
    result=dict(contracts=session.data['contracts'],chains={},balances={},packages={},historical=historical())
    for chain in ['wl','bnb']:
        block=session.rpc(chain,'eth_getBlockByNumber',['latest',False])
        result['chains'][chain]=dict(number=block['number'],hash=block['hash'],pid=session.data['chains'][chain]['pid'])
        token=session.data['contracts']['xwl' if chain=='wl' else 'wwl']
        result['balances'][chain]=dict(supply=session.view(chain,token,'totalSupply()(uint256)'),native=session.rpc(chain,'eth_getBalance',[token,'latest']),
            users={u:session.view(chain,token,'balanceOf(address)(uint256)',u) for u in session.data['users']})
    for p in sorted((session.root/'packages').glob('*.json')):
        result['packages'][p.name]=dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(),size=p.stat().st_size,mtime_ns=p.stat().st_mtime_ns)
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('operation',choices=['status','snapshot','compare','verify'])
    args=parser.parse_args();OUT.mkdir(exist_ok=True)
    if not (OUT/'historical-before.json').exists():
        source=Path('/tmp/bnc-before-signed-bridge.json')
        if not source.exists():raise ValueError('historical preservation baseline missing')
        (OUT/'historical-before.json').write_bytes(source.read_bytes())
    if args.operation=='status':
        todo=[line.strip() for line in (ROOT/'docs/signed-bridge-checklist.md').read_text().splitlines() if line.startswith('- [ ]')]
        try:health=read_api('/api/health')
        except Exception as error:health=dict(status='not-serving',error=str(error))
        print(json.dumps(dict(health=health,nextSteps=todo,historical=historical()),ensure_ascii=False,indent=2));return
    if args.operation=='snapshot':
        bridge.local.write_json(OUT/'restart-before.json',snapshot());print('Restart snapshot saved; no asset transaction submitted.');return
    if args.operation=='compare':
        before=json.loads((OUT/'restart-before.json').read_text());after=snapshot()
        for key in ['contracts','balances','packages','historical']:
            if before[key]!=after[key]:raise ValueError('restart changed '+key)
        session=bridge.Session(ROOT/'results/signed-xwl-v1')
        for chain,block in before['chains'].items():
            if session.rpc(chain,'eth_getBlockByNumber',[block['number'],False])['hash']!=block['hash']:raise ValueError('source block changed')
            if after['chains'][chain]['pid']==block['pid']:raise ValueError('node was not restarted')
        result=dict(passed=True,contractsBalancesPackagesPreserved=True,sourceBlocksPreserved=True,nodePidsChanged=True,historical=after['historical'],newAssetTransactions=0)
        bridge.local.write_json(OUT/'restart-result.json',result);print(json.dumps(result));return
    packages=read_api('/api/packages')['packages'];session=bridge.Session(ROOT/'results/signed-xwl-v1')
    xwl=session.data['contracts']['xwl'];wwl=session.data['contracts']['wwl']
    collateral=int(session.rpc('wl','eth_getBalance',[xwl,'latest']),16)
    supplies={chain:int(session.view(chain,token,'totalSupply()(uint256)')) for chain,token in [('wl',xwl),('bnb',wwl)]}
    # Include all actual bridge burns, not just those already submitted for signing.
    pending=0;count=0
    service=bridge.Service(session)
    for chain,name in [('wl','xwl'),('bnb','wwl')]:
        remote,_,dest=service.route(chain)
        logs=session.rpc(chain,'eth_getLogs',[dict(address=session.data['contracts'][name],topics=[service.topic],fromBlock='0x0',toBlock='latest')])
        for log in logs:
            count+=1
            if session.view(remote,session.data['contracts'][dest],'claimedBurn(bytes32)(bool)',log['topics'][1])!='true':
                pending+=int(log['data'][2:66],16)
    if collateral!=sum(supplies.values())+pending:raise ValueError('collateral/supply/pending conservation failed')
    result=dict(passed=True,collateral=str(collateral),xwlSupply=str(supplies['wl']),wwlSupply=str(supplies['bnb']),pending=str(pending),bridgeBurns=count,packages=len(packages),historical=historical())
    bridge.local.write_json(OUT/'conservation.json',result);print(json.dumps(result))

if __name__=='__main__':main()
