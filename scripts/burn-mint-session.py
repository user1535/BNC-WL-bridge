#!/usr/bin/env python3
"""Isolated V2 local chains and operator-only deployment/root transactions."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('burn_mint_api', ROOT/'scripts/proof-service.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class Session(api.local.Session):
    PROTOCOL = 'burn-mint-v2'
    asset_profile = None
    original_contract = 'BurnMintToken'
    rpc_ports = ('8575', '8576')
    operator_index = 0

    def contract_sources(self):
        vault_sources = {'NativeWLVault.sol', 'VaultReceipt.sol', 'VaultWrappedWL.sol'}
        paths = [path for path in sorted((ROOT/'contracts/src').rglob('*.sol'))
                 if path.name not in vault_sources and (path.name != 'XWL.sol' or self.asset_profile)]
        paths.append(ROOT/'contracts/foundry.toml')
        if self.asset_profile:
            paths.append(ROOT/'configs/xwl-entry-local.json')
        return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

    def validate_revision(self):
        if self.data.get('contract_sources') != self.contract_sources():
            raise ValueError('V2 deployed source revision differs or is unrecorded; verify-runtime or use a fresh isolated session')

    def verify_runtime(self):
        """One-time migration check against compiled code, masking only immutable slots."""
        self.guard()
        if self.data.get('protocol') != self.PROTOCOL: raise ValueError('V2 session required')
        c=self.data['contracts'];runtime={}
        for chain,name,contract in [('wl','original',self.original_contract),('bnb','wrapped','BurnMintToken'),('wl','unlock','BurnMintReceiver'),('bnb','mint','BurnMintReceiver')]:
            artifact=ROOT/'contracts/out'/f'{contract}.sol'/f'{contract}.json'
            data=json.loads(artifact.read_text())['deployedBytecode']
            code=bytes.fromhex(self.rpc(chain,'eth_getCode',[c[name],'latest'])[2:])
            actual=bytearray(code);expected=bytearray.fromhex(data['object'].removeprefix('0x'))
            if len(actual)!=len(expected):raise ValueError('deployed bytecode length differs: '+name)
            for entries in data.get('immutableReferences',{}).values():
                for ref in entries:
                    start,length=ref['start'],ref['length'];actual[start:start+length]=expected[start:start+length]=bytes(length)
            if actual!=expected:raise ValueError('deployed canonical runtime differs: '+name)
            peer='bnb' if chain=='wl' else 'wl';remote=c['wrapped' if chain=='wl' else 'original']
            views={'peerChainId()(uint256)':str(self.data['chains'][peer]['id']),'deploymentOwner()(address)':self.data['operator']} if name in ('original', 'wrapped') else {
                'sourceChainId()(uint256)':str(self.data['chains'][peer]['id']),'sourceToken()(address)':remote,
                'destinationToken()(address)':c['original' if chain=='wl' else 'wrapped'],'headerSource()(address)':c[chain+'_headers']}
            if contract == 'XWL':
                views.update({'entryCap()(uint256)': self.policy['entryCap'], 'ENTRY_SINK()(address)': self.policy['sink']})
            for signature,value in views.items():
                if self.view(chain,c[name],signature).lower()!=value.lower():raise ValueError('immutable binding differs: '+name+' '+signature)
            runtime[name]=hashlib.sha256(code).hexdigest()
        self.data['contract_sources']=self.contract_sources()
        self.data['runtime_sha256']=runtime
        self.save()
        return runtime
    def start(self):
        if self.data and self.data.get('protocol') != 'burn-mint-v2':
            raise ValueError('V2 refuses an existing V1 session')
        os.environ.setdefault('BNC_WL_PORT', self.rpc_ports[0])
        os.environ.setdefault('BNC_BNB_PORT', self.rpc_ports[1])
        super().start()
        self.data['protocol'] = 'burn-mint-v2'
        self.save()

    def deploy_original(self):
        return self.deploy('original', 'wl', 'src/token/BurnMintToken.sol:BurnMintToken',
                           'Local WL model V2', 'WL', str(1000*10**18), '31338')

    def setup(self):
        self.guard()
        if self.data.get('protocol') != 'burn-mint-v2':
            raise ValueError('isolated V2 session required')
        if self.data.get('phase') == 'ready': self.validate_revision()
        accounts = self.rpc('wl', 'eth_accounts', [])
        self.data['operator'], self.data['users'] = accounts[self.operator_index], accounts[1:4]
        self.save()
        operator = self.data['operator']
        original = self.deploy_original()
        wrapped = self.deploy('wrapped', 'bnb', 'src/token/BurnMintToken.sol:BurnMintToken',
                             'Wrapped WL V2', 'wWL', '0', '31337')
        for chain, peer, token, remote, key in [('wl', '31338', original, wrapped, 'unlock'),
                                               ('bnb', '31337', wrapped, original, 'mint')]:
            headers = self.deploy(chain+'_headers', chain, 'src/bridge/DevHeaderRegistry.sol:DevHeaderRegistry', peer)
            receiver = self.deploy(key, chain, 'src/bridge/BurnMintReceiver.sol:BurnMintReceiver', token, headers, remote)
            bound = self.view(chain, token, 'peerToken()(address)')
            if int(bound, 16) == 0:
                self.send(chain, operator, token, 'bindPeer(address,address)', remote, receiver)
            elif bound.lower() != remote.lower() or self.view(chain, token, 'mintReceiver()(address)').lower() != receiver.lower():
                raise ValueError('V2 peer binding changed')
        for user in ([] if self.asset_profile else self.data['users']):
            key = 'funded_'+user.lower()
            if not self.data.get(key):
                # Deployment-only local fixture funding. Users sign all bridge actions in the browser.
                if int(self.view('wl', original, 'balanceOf(address)(uint256)', user)) == 0:
                    self.send('wl', operator, original, 'transfer(address,uint256)', user, str(100*10**18))
                self.data[key] = True
                self.save()
        self.data['phase'] = 'ready'
        self.data['contract_sources'] = self.contract_sources()
        self.save()


class XwlSession(Session):
    asset_profile = 'xwl-entry-v1'
    original_contract = 'XWL'
    rpc_ports = ('8584', '8585')
    operator_index = 9  # Different deployment nonce domain from the prior V2 fixtures.
    policy = json.loads((ROOT/'configs/xwl-entry-local.json').read_text())

    def deploy_original(self):
        return self.deploy('original', 'wl', 'src/token/XWL.sol:XWL', self.policy['entryCap'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir', type=Path)
    parser.add_argument('--port', type=int)
    parser.add_argument('--xwl', action='store_true', help='use the isolated xWL entry profile')
    parser.add_argument('operation', choices=['start', 'deploy', 'stop', 'serve', 'status', 'verify-runtime'])
    args = parser.parse_args()
    session_type = XwlSession if args.xwl else Session
    args.dir = args.dir or ROOT/'results'/('xwl-entry-v1' if args.xwl else 'burn-mint-v2-guarded')
    args.port = args.port if args.port is not None else (8583 if args.xwl else 8581)
    if args.dir.resolve() == (ROOT/'results/prototype-risc0').resolve():
        parser.error('V1 evidence session is immutable')
    session = session_type(args.dir)
    if session.data and session.data.get('asset_profile') != session.asset_profile:
        parser.error('existing session has a different asset profile')
    with (session.root/('proof-service.lock' if args.operation == 'serve' else 'client.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.operation == 'start': session.start()
        elif args.operation == 'deploy': session.setup()
        elif args.operation == 'stop': session.stop()
        elif args.operation == 'status': print(session.path.read_text())
        elif args.operation == 'verify-runtime': print(json.dumps(session.verify_runtime()))
        else:
            if session.data.get('protocol') != 'burn-mint-v2': raise ValueError('V2 session required')
            session.validate_revision()
            if not 1024 <= args.port <= 65535: raise ValueError('invalid UI port')
            with api.BoundedHTTPServer(('127.0.0.1', args.port), api.Handler) as server:
                service = api.Service(session.root, confirmations=2, demo_mine=True, session_class=session_type)
                server.service, server.public_origin, server.rpc_origins = service, None, set()
                pid_path = session.root/'proof-service.pid'
                pid_path.write_text(str(os.getpid()))
                def stop(signum, frame):
                    service.stop.set()
                    service.computation.cancel()
                    raise KeyboardInterrupt
                api.signal.signal(api.signal.SIGTERM, stop)
                api.signal.signal(api.signal.SIGINT, stop)
                page = 'xwl.html' if args.xwl else 'burn-mint.html'
                print(f'http://127.0.0.1:{args.port}/{page}', flush=True)
                try: server.serve_forever()
                except KeyboardInterrupt: pass
                finally:
                    service.stop.set()
                    service.computation.cancel()
                    service.worker.join(timeout=30)
                    pid_path.unlink(missing_ok=True)


if __name__ == '__main__': main()
