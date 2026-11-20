#!/usr/bin/env python3
"""Live negative checks; never submits a user asset transaction."""
import json
from pathlib import Path
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
import importlib.util

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8580'
checks=[]
def request(path,body=None,headers=None):
    h={'Content-Type':'application/json','X-Bridge-Request':'1'};h.update(headers or {})
    req=urllib.request.Request(URL+path,None if body is None else json.dumps(body).encode(),h)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as error:return error.code,json.load(error)

def reject(name,path,body,headers=None):
    status,data=request(path,body,headers)
    assert status>=400,(name,status,data)
    checks.append(name)

reject('foreign-origin','/api/attest',{}, {'Origin':'https://attacker.invalid'})
reject('foreign-host','/api/attest',{}, {'Host':'attacker.invalid'})
reject('missing-request-header','/api/attest',{}, {'X-Bridge-Request':'0'})
reject('client-supplied-amount','/api/attest',{'source':'wl','transactionHash':'0x'+'ab'*32,'amount':'999'})
reject('missing-source-transaction','/api/attest',{'source':'wl','transactionHash':'0x'+'ab'*32})
reject('external-chain','/api/attest',{'source':'mainnet','transactionHash':'0x'+'ab'*32})
reject('oversized-body','/api/attest',{'data':'x'*8200})
for method in ['eth_sendTransaction','eth_sign','eth_signTypedData_v4','anvil_mine','anvil_setBalance','personal_unlockAccount']:
    reject('rpc-denied:'+method,'/rpc/wl',dict(jsonrpc='2.0',id=1,method=method,params=[]))
reject('malformed-raw-transaction','/rpc/wl',dict(jsonrpc='2.0',id=1,method='eth_sendRawTransaction',params=['bad']))
status,manifest=request('/api/manifest')
assert status==200 and manifest['risc0'] is False and manifest['protocol']=='signed-xwl-bridge-v1'
assert not any(key in json.dumps(manifest).lower() for key in ['privatekey','private_key','mnemonic'])
checks.append('public-manifest-no-private-keys')
packages=request('/api/packages')[1]['packages']
if packages:
    p=packages[0]
    status,again=request('/api/attest',dict(source=p['source'],transactionHash=p['message']['sourceTxHash'],logIndex=int(p['message']['logIndex'])))
    assert status==200 and again['signature']==p['signature'] and again['digest']==p['digest']
    checks.append('duplicate-attestation-reuses-signature')
    locator=dict(source=p['source'],transactionHash=p['message']['sourceTxHash'],logIndex=int(p['message']['logIndex']))
    with ThreadPoolExecutor(max_workers=6) as pool:
        concurrent=list(pool.map(lambda _:request('/api/attest',locator),range(6)))
    assert any(status==200 for status,_ in concurrent)
    for status,value in concurrent:
        if status==200:assert value['signature']==p['signature']
        else:assert status==400 and 'capacity' in value['error']
    checks.append('bounded-concurrent-idempotent-attestation')
    reject('wrong-log-index','/api/attest',dict(locator,logIndex=99999))
    spec=importlib.util.spec_from_file_location('check_signed_service',ROOT/'scripts/signed-bridge.py')
    service_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(service_module)
    session=service_module.Session(ROOT/'results/signed-xwl-v1')
    service=service_module.Service(session,confirmations=100,demo_mine=False)
    try:service.attest(locator)
    except ValueError as error:assert 'confirmations' in str(error)
    else:raise AssertionError('confirmation policy was skipped for cached package')
    checks.append('confirmation-policy-applies-before-cache-reuse')
    # Deployment and initial peer binding use account 0; serving attestations
    # must not consume its transaction nonce or the signing account's nonce.
    nonces={chain:{'operator':int(session.rpc(chain,'eth_getTransactionCount',[session.data['operator'],'latest']),16),
                   'signer':int(session.rpc(chain,'eth_getTransactionCount',[session.data['signer'],'latest']),16)} for chain in ['wl','bnb']}
    assert all(v['operator']==2 and v['signer']==0 for v in nonces.values()),nonces
    checks.append('operator-deployment-only-signer-zero-asset-transactions')
out=ROOT/'results/signed-bridge-validation/api-checks.json';out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(dict(passed=True,checks=checks),indent=2)+'\n')
print(json.dumps(dict(passed=True,count=len(checks),checks=checks)))
