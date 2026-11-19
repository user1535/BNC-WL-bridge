#!/usr/bin/env python3
"""Persistent, local-only wallet client. The Go generators never sign transactions."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('session_runtime',ROOT/'scripts/runtime-config.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
PROOF=runtime.binary('BNC_PROOF_BIN',ROOT/'.bin/bridge-proof')
os.environ.setdefault('RISC0_SERVER_PATH',str(runtime.r0vm()))


def command(args, *, output=True):
    result = subprocess.run([str(v) for v in args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'command failed')
    return result.stdout.strip() if output else None


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


class Session:
    def __init__(self, directory):
        self.root = directory.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'session.json'
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {}

    def save(self):
        write_json(self.path, self.data)


    def rpc(self, chain, method, params):
        url = self.data['chains'][chain]['rpc']
        request = urllib.request.Request(url, json.dumps({'jsonrpc': '2.0', 'id': 1,
            'method': method, 'params': params}).encode(), {'Content-Type': 'application/json'})
        response = json.load(urllib.request.urlopen(request, timeout=15))
        if 'error' in response:
            raise RuntimeError(str(response['error']))
        return response['result']

    def guard(self):
        for chain, expected in [('wl', 31337), ('bnb', 31338)]:
            config=self.data['chains'][chain];url=urlsplit(config['rpc'])
            if (url.scheme!='http' or url.hostname!='127.0.0.1' or url.port!=config['port']
                or url.username or url.password or url.path or url.query or url.fragment):
                raise RuntimeError('owned session requires its configured loopback RPC')
            if int(self.rpc(chain, 'eth_chainId', []), 16) != expected:
                raise RuntimeError('local session chain ID changed')
            pid = self.data['chains'][chain]['pid']
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if Path(os.fsdecode(cmdline[0])).name != 'anvil' or os.fsencode(str(self.root / f'{chain}-state.json')) not in cmdline:
                raise RuntimeError('RPC process is not this session Anvil')

    def start(self):
        mode, binding = 'dev', 'minimal-link'
        if not self.data:
            self.data = {'version': 1, 'protocol': getattr(self,'PROTOCOL','lock-mint-v1'), 'mode': mode, 'header_binding': binding, 'phase': 'created', 'chains': {}, 'contracts': {},
                'events': [], 'chain_authenticated': False, 'real_asset_deployment_allowed': False}
            if getattr(self, 'asset_profile', None):
                self.data.update(asset_profile=self.asset_profile, entry_policy=self.policy)
            if runtime.port('BNC_WL_PORT',8565)==runtime.port('BNC_BNB_PORT',8566):
                raise ValueError('chain ports must differ')
            for chain, port, chain_id in [('wl', runtime.port('BNC_WL_PORT',8565), 31337), ('bnb', runtime.port('BNC_BNB_PORT',8566), 31338)]:
                self.data['chains'][chain] = {'rpc': f'http://127.0.0.1:{port}', 'port': port, 'id': chain_id}
            self.save()
        if self.data['mode'] != mode:
            raise RuntimeError('existing session mode is immutable')
        if self.data.get('header_binding', 'minimal-link') != binding:
            raise RuntimeError('existing session header binding is immutable')
        for chain, config in self.data['chains'].items():
            try:
                self.rpc(chain, 'eth_chainId', [])
            except Exception:
                with (self.root / f'{chain}-anvil.log').open('a') as log:
                    process = subprocess.Popen(['anvil', '--silent', '--host', '127.0.0.1', '--port', str(config['port']),
                        '--chain-id', str(config['id']), '--state', str(self.root / f'{chain}-state.json'),
                        '--state-interval', '1', '--preserve-historical-states'], stdout=log, stderr=log, start_new_session=True)
                    config['pid'] = process.pid
                    self.save()
                for _ in range(50):
                    try:
                        self.rpc(chain, 'eth_chainId', [])
                        break
                    except Exception:
                        time.sleep(.2)
            # A responding unknown service must never be adopted or reset.
        self.guard()
        print('local session nodes running; state files preserve restart data')

    def view(self, chain, address, signature, *args):
        return command(['cast', 'call', address, signature, *args, '--rpc-url', self.data['chains'][chain]['rpc']]).split()[0]

    def send(self, chain, sender, address, *args):
        self.guard()
        result = json.loads(command(['cast', 'send', address, *args, '--rpc-url', self.data['chains'][chain]['rpc'],
            '--unlocked', '--from', sender, '--json']))
        if int(result['status'], 16) != 1:
            raise RuntimeError('wallet transaction reverted')
        return result

    def deploy(self, key, chain, contract, *args):
        if key in self.data['contracts']:
            return self.data['contracts'][key]
        cmd = ['forge', 'create', '--root', ROOT / 'contracts', contract, '--rpc-url', self.data['chains'][chain]['rpc'],
            '--unlocked', '--from', self.data['operator'], '--broadcast', '--json']
        if args:
            cmd += ['--constructor-args', *args]
        address = json.loads(command(cmd))['deployedTo']
        self.data['contracts'][key] = address
        self.save()
        return address

    def setup(self):
        self.guard()
        ROOT.joinpath('.bin').mkdir(exist_ok=True)
        if not PROOF.is_file() or os.environ.get('BNC_REBUILD_BINARIES')=='1':
            PROOF.parent.mkdir(parents=True,exist_ok=True)
            command(['go','-C',ROOT/'proof-generator','build','-o',PROOF,'./cmd/bridge-proof'])
        accounts = self.rpc('wl', 'eth_accounts', [])
        self.data['operator'], self.data['users'] = accounts[0], accounts[1:4]
        self.save()
        if self.data['phase'] == 'ready':
            print('deployment already ready')
            return
        operator = self.data['operator']
        original = self.deploy('original', 'wl', 'src/token/BridgeLockableToken.sol:BridgeLockableToken', 'Local WorldLand', 'WL', str(1000 * 10**18), '31338')
        wrapped = self.deploy('wrapped', 'bnb', 'src/token/BridgeWrappedToken.sol:BridgeWrappedToken', 'Local Wrapped WorldLand', 'wWL', '31337', original)
        if int(self.view('wl', original, 'destinationWrappedToken()(address)'), 16) == 0:
            self.send('wl', operator, original, 'bindDestinationWrappedToken(address)', wrapped)
        for user in self.data['users']:
            funding_key = 'funded_' + user.lower()
            if not self.data.get(funding_key):
                # Funding is idempotent across a process interruption after broadcast.
                if int(self.view('wl', original, 'balanceOf(address)(uint256)', user)) == 0:
                    self.send('wl', operator, original, 'transfer(address,uint256)', user, str(100 * 10**18))
                self.data[funding_key] = True
                self.save()
        self.deploy('bnb_headers', 'bnb', 'src/bridge/DevHeaderRegistry.sol:DevHeaderRegistry', '31337')
        mint = self.deploy('mint', 'bnb', 'src/bridge/LockMintReceiver.sol:LockMintReceiver', wrapped, self.data['contracts']['bnb_headers'])
        if int(self.view('bnb', wrapped, 'mintReceiver()(address)'), 16) == 0:
            self.send('bnb', operator, wrapped, 'bindMintReceiver(address)', mint)
        self.deploy('wl_headers', 'wl', 'src/bridge/DevHeaderRegistry.sol:DevHeaderRegistry', '31338')
        unlock = self.deploy('unlock', 'wl', 'src/bridge/BurnUnlockReceiver.sol:BurnUnlockReceiver', original, self.data['contracts']['wl_headers'], wrapped)
        if int(self.view('wl', original, 'unlockReceiver()(address)'), 16) == 0:
            self.send('wl', operator, original, 'bindUnlockReceiver(address)', unlock)
        self.data['phase'] = 'ready'
        self.save()
        print('deployment ready; wallets are local Anvil accounts; no private key stored in session')

    def route(self, action):
        c = self.data['contracts']
        return ('wl', 'bnb', c['original'], c['wrapped'], c['bnb_headers'], c['mint']) if action in ('lock','burn-wl') else ('bnb', 'wl', c['wrapped'], c['original'], c['wl_headers'], c['unlock'])








    def stop(self):
        self.guard()
        for config in self.data['chains'].values():
            os.kill(config['pid'], signal.SIGTERM)
        for _ in range(50):
            stopped = True
            for chain in self.data['chains']:
                try:
                    self.rpc(chain, 'eth_chainId', [])
                    stopped = False
                except Exception:
                    pass
            if stopped:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('session nodes did not finish stopping')
        print('session stopped; public manifest, proof cache and Anvil state retained')


class VaultSession(Session):
    PROTOCOL = 'native-wl-vault-v1'

    def __init__(self, directory):
        super().__init__(directory)
        if self.data and self.data.get('protocol') != self.PROTOCOL:
            raise ValueError('the Vault requires its own state directory')

    def setup(self):
        self.guard()
        accounts = self.rpc('wl', 'eth_accounts', [])
        self.data['operator'], self.data['users'] = accounts[0], accounts[1:4]
        self.save()
        if self.data['phase'] != 'ready':
            wl_headers = self.deploy('wl_headers', 'wl', 'src/bridge/DevHeaderRegistry.sol:DevHeaderRegistry', '31338')
            bnb_headers = self.deploy('bnb_headers', 'bnb', 'src/bridge/DevHeaderRegistry.sol:DevHeaderRegistry', '31337')
            vault = self.deploy('original', 'wl', 'src/bridge/NativeWLVault.sol:NativeWLVault', wl_headers)
            wrapped = self.deploy('wrapped', 'bnb', 'src/token/VaultWrappedWL.sol:VaultWrappedWL', bnb_headers, vault)
            if int(self.view('wl', vault, 'sourceToken()(address)'), 16) == 0:
                self.send('wl', self.data['operator'], vault, 'bindWrappedToken(address)', wrapped)
            self.data['contracts'].update(mint=wrapped, unlock=vault)
        self.verify_bindings()
        self.data['phase'] = 'ready'
        self.save()
        print('native WL Vault and transferable wWL are ready')

    def verify_bindings(self):
        contracts = self.data['contracts']
        for chain, name, peer, source in (
            ('wl', 'original', 'wrapped', 31338), ('bnb', 'wrapped', 'original', 31337)
        ):
            target = contracts[name]
            if (self.view(chain, target, 'sourceToken()(address)').lower() != contracts[peer].lower()
                    or self.view(chain, target, 'headerSource()(address)').lower() != contracts[chain + '_headers'].lower()
                    or int(self.view(chain, target, 'sourceChainId()(uint256)')) != source):
                raise ValueError('Vault bridge deployment binding mismatch')
        if contracts['mint'] != contracts['wrapped'] or contracts['unlock'] != contracts['original']:
            raise ValueError('Vault receivers must be the bound asset contracts')

    def route(self, action):
        c = self.data['contracts']
        if action == 'lock-vault':
            return ('wl', 'bnb', c['original'], c['wrapped'], c['bnb_headers'], c['mint'])
        if action == 'burn-vault':
            return ('bnb', 'wl', c['wrapped'], c['original'], c['wl_headers'], c['unlock'])
        raise ValueError('invalid Vault action')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir', type=Path, default=ROOT / 'results/prototype-risc0')
    parser.add_argument('--vault', action='store_true')
    parser.add_argument('operation', choices=['start', 'deploy', 'stop', 'status'])
    args = parser.parse_args()
    session_class = VaultSession if args.vault else Session
    session = session_class(args.dir)
    with (session.root / 'client.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        session = session_class(args.dir)
        if args.operation == 'start':
            session.start()
        elif args.operation == 'stop':
            session.stop()
        elif args.operation == 'status':
            print(json.dumps(session.data, indent=2))
        else:
            session.guard()
            session.setup()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
