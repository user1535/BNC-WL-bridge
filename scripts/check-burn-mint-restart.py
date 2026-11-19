#!/usr/bin/env python3
"""Restart only the isolated V2 session; compare contracts, balances, blocks and receipts."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('restart_v2',ROOT/'scripts/burn-mint-session.py')
v2=importlib.util.module_from_spec(spec);spec.loader.exec_module(v2)
p=argparse.ArgumentParser();p.add_argument('--service-pid',type=int);p.add_argument('--xwl',action='store_true');args=p.parse_args()
directory=ROOT/'results'/('xwl-entry-v1' if args.xwl else 'burn-mint-v2-guarded')
session_type=v2.XwlSession if args.xwl else v2.Session
session=session_type(directory)
if session.data.get('protocol')!='burn-mint-v2':raise ValueError('isolated V2 required')
if session.data.get('asset_profile')!=session.asset_profile:raise ValueError('wrong asset profile')
jobs=[json.loads(p.read_text()) for p in (directory/'proof-jobs').glob('*.json')]
if not jobs or any(j['state']!='ready' for j in jobs):raise ValueError('finish active proof jobs before restart')
port=8583 if args.xwl else 8581

def api(path,body=None):
    request=urllib.request.Request(f'http://127.0.0.1:{port}'+path,
        data=json.dumps(body).encode() if body else None,
        headers={'Content-Type':'application/json','X-Bridge-Request':'1'})
    return json.load(urllib.request.urlopen(request,timeout=40))

def snapshot():
    session.guard();data={'sessionId':session.data['wallet_session_id'],'contracts':session.data['contracts'],
        'balances':{},'accounting':{},'sourceBlocks':{},'claims':{},'receipts':{}}
    for chain,key in [('wl','original'),('bnb','wrapped')]:
        token=session.data['contracts'][key]
        data['balances'][chain]={user:session.view(chain,token,'balanceOf(address)(uint256)',user) for user in session.data['users']}
        data['accounting'][chain]={name:session.view(chain,token,name+'()(uint256)') for name in ['totalSupply','totalBridgeBurned','totalBridgeMinted']}
    if args.xwl:
        token=session.data['contracts']['original']
        data['entry']={name:session.view('wl',token,name+'()(uint256)') for name in ['totalNativeSent','totalEntryMinted']}
        # Native user balances are independent of the audit operator's anchoring transactions.
        data['nativeBalances']={user:session.rpc('wl','eth_getBalance',[user,'latest']) for user in session.data['users']}
    for job in jobs:
        package=job['package'];source,destination,_,_,_,receiver=session.route(package['action'])
        block=session.rpc(source,'eth_getBlockByNumber',[hex(package['blockNumber']),False])
        data['sourceBlocks'][job['id']]={name:block[name] for name in ['number','hash','receiptsRoot','transactions']}
        data['claims'][job['id']]=session.view(destination,receiver,'claimedBurn(bytes32)(bool)',package['transferId'])
    for path in (directory/'proof-jobs').glob('*/receipt.bin'):
        data['receipts'][str(path.relative_to(directory))]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,'mtimeNs':path.stat().st_mtime_ns}
    return data

before=snapshot()
if args.xwl and 'false' not in before['claims'].values():raise ValueError('an unclaimed xWL proof is required')
pid=args.service_pid or int((directory/'proof-service.pid').read_text())
cmdline=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
if not any(Path(os.fsdecode(s)).name=='burn-mint-session.py' for s in cmdline) or b'serve' not in cmdline or Path(f'/proc/{pid}/cwd').resolve()!=ROOT:
    raise ValueError('refuse to stop an unrelated process')
os.kill(pid,signal.SIGTERM)
for _ in range(100):
    try:api('/api/manifest')
    except Exception:break
    time.sleep(.1)
else:raise ValueError('API did not stop')
session.stop();session.start();session.setup()
with (directory/'restart-server.log').open('a') as log:
    command=[os.sys.executable,str(ROOT/'scripts/burn-mint-session.py')]
    if args.xwl:command.append('--xwl')
    service=subprocess.Popen(command+['serve'],cwd=ROOT,stdout=log,stderr=log,start_new_session=True)
for _ in range(100):
    try:manifest=api('/api/manifest');break
    except Exception:
        if service.poll() is not None:raise ValueError('restarted API failed')
        time.sleep(.2)
else:raise ValueError('restarted API unavailable')
session=session_type(directory);after=snapshot()
if before!=after:raise ValueError('restart changed session evidence or balances')
verified=[]
for job in jobs:
    package=api('/api/jobs/'+job['id']+'/package')
    result=api('/api/computation/verify',package)
    if result.get('verified') is not True:raise ValueError('SDK reverification failed')
    verified.append(result['receiptSHA256'])
final=snapshot()
if final!=before:raise ValueError('SDK recheck changed receipts or source state')
result={'passed':True,'before':before,'after':after,'sdkReceiptsVerified':verified,'freshProofsGenerated':0,
    'userTransactionsSent':0,'newServicePid':service.pid,'ui':f"http://127.0.0.1:{port}/{'xwl.html' if args.xwl else 'burn-mint.html'}"}
evidence=ROOT/'results'/('xwl-entry-validation' if args.xwl else 'burn-mint-guarded-validation')
evidence.mkdir(exist_ok=True)
(evidence/'restart-summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'passed':True,'sdkReceiptsVerified':len(verified),'freshProofsGenerated':0,'newServicePid':service.pid}))
