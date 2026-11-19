#!/usr/bin/env python3
"""Prepare unsigned testnet deployments or serve proofs through a read-only RPC transport."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vault_testnet_api', ROOT / 'scripts/proof-service.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
PROTOCOL = 'native-wl-vault-testnet-v1'
CHAINS = {'wl': 10359, 'bnb': 97}
CONTRACT_CHAINS = {'original': 'wl', 'wrapped': 'bnb', 'wl_headers': 'wl', 'bnb_headers': 'bnb'}
RPC_ENV = {'wl': 'BNC_GWANGJU_RPC', 'bnb': 'BNC_BSC_TESTNET_RPC'}
DEFAULT_BSC = 'https://bsc-testnet-dataseed.bnbchain.org/'


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value) or int(value, 16) == 0:
        raise ValueError('nonzero public address required')
    return value.lower()


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('integer outside the permitted range')
    return value


def checked_endpoint(value):
    uri = urlsplit(value)
    if uri.scheme != 'https' or not uri.hostname or uri.username is not None or uri.fragment:
        raise ValueError('a testnet HTTPS RPC without URL userinfo or a fragment is required')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LogRangeLimit(ValueError):
    pass


class ReadSession:
    testnet_reader = True

    def __init__(self, directory, config, port):
        self.root = directory.resolve()
        self.path = self.root / 'session.json'
        if not os.getenv('BNC_GWANGJU_RPC'):
            raise ValueError('BNC_GWANGJU_RPC must be set to the operator-provided Gwangju testnet RPC')
        self.endpoints = {chain: checked_endpoint(os.getenv(variable, DEFAULT_BSC if chain == 'bnb' else ''))
                          for chain, variable in RPC_ENV.items()}
        self.operators = {chain: address(config['operators'][chain]) for chain in CHAINS}
        self.confirmations = {chain: integer(config['confirmations'][chain], 1, 100000) for chain in CHAINS}
        hashes = {name: config['runtimeKeccak256'][name] for name in CONTRACT_CHAINS}
        if any(not isinstance(item, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', item)
               or not int(item, 16) for item in hashes.values()):
            raise ValueError('each deployed contract needs a reviewed runtime Keccak-256 hash')
        self.runtime_hashes = {name: value.lower() for name, value in hashes.items()}
        contracts = {name: address(config['contracts'][name]) for name in CONTRACT_CHAINS}
        if contracts['original'] == contracts['wl_headers'] or contracts['wrapped'] == contracts['bnb_headers']:
            raise ValueError('asset and registry must be distinct on each chain')
        contracts.update(mint=contracts['wrapped'], unlock=contracts['original'])
        chains = {chain: dict(id=chain_id, rpc=f'http://127.0.0.1:{port}/rpc/{chain}',
                             historyStartBlock=integer(config['historyStartBlock'][chain], 1, 2**53 - 1))
                  for chain, chain_id in CHAINS.items()}
        identity = dict(contracts=contracts, operators=self.operators, confirmations=self.confirmations,
                        runtimeKeccak256=self.runtime_hashes,
                        historyStartBlock={key: value['historyStartBlock'] for key, value in chains.items()})
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        if self.path.exists():
            previous = json.loads(self.path.read_text())
            if previous.get('protocol') != PROTOCOL or previous.get('configFingerprint') != fingerprint:
                raise ValueError('use a dedicated testnet directory for this deployment and policy')
        self.data = dict(protocol=PROTOCOL, mode='dev', header_binding='minimal-link', phase='ready',
                         users=[], chains=chains, contracts=contracts, wallet_session_id=fingerprint[:32],
                         configFingerprint=fingerprint)
        self.opener = urllib.request.build_opener(NoRedirect)
        self.guard_lock = threading.Lock()
        self.guard_time = float('-inf')
        self.verify_deployment(address(config['bindingAuthority']))
        self.root.mkdir(parents=True, exist_ok=True)
        self.save()

    def save(self):
        api.local.write_json(self.path, self.data)

    def redact(self, _detail):
        # Provider errors can echo private URL path/query fragments.
        return 'testnet proof generator rejected the RPC block, receipt, root or contract binding'

    def rpc(self, chain, method, params):
        if method not in api.http_config.RPC_METHODS or method == 'eth_sendRawTransaction':
            raise ValueError('testnet RPC is read-only')
        if method != 'eth_getLogs' or len(params) != 1 or not isinstance(params[0], dict):
            return self._rpc(chain, method, params)
        request = params[0]
        try:
            return self._rpc(chain, method, params)
        except LogRangeLimit:
            start, end = request.get('fromBlock'), request.get('toBlock')
            if not isinstance(start, str) or not re.fullmatch(r'0x[0-9a-fA-F]+',start):
                raise
            if end == 'latest':
                end = self._rpc(chain, 'eth_blockNumber', [])
            if not isinstance(end, str) or not re.fullmatch(r'0x[0-9a-fA-F]+',end):
                raise
        ranges = [(int(start,16),int(end,16))]
        logs = []
        deadline = time.monotonic()+30
        attempts = 0
        combined_size = 0
        while ranges:
            first, last = ranges.pop()
            attempts += 1
            remaining = deadline-time.monotonic()
            if attempts > 32 or remaining <= 0 or first > last:
                raise LogRangeLimit('RPC log range limit; select a more recent starting block')
            try:
                chunk = self._rpc(chain, method,
                    [dict(request,fromBlock=hex(first),toBlock=hex(last))], timeout=min(15,remaining))
            except LogRangeLimit:
                if first == last:
                    raise
                middle = (first+last)//2
                ranges.extend([(middle+1,last),(first,middle)])
                continue
            if not isinstance(chunk, list):
                raise ValueError('invalid RPC log response')
            combined_size += len(json.dumps(chunk))
            if combined_size > api.LIMIT:
                raise LogRangeLimit('combined log response limit; select a more recent starting block')
            logs.extend(chunk)
        return logs

    def _rpc(self, chain, method, params, timeout=15):
        request = urllib.request.Request(self.endpoints[chain],
            json.dumps(dict(jsonrpc='2.0', id=1, method=method, params=params)).encode(),
            {'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(api.LIMIT + 1)
            if len(raw) > api.LIMIT:
                raise ValueError('RPC response limit')
            data = json.loads(raw)
            error = data.get('error')
            if method == 'eth_getLogs' and isinstance(error,dict) and any(
                hint in str(error.get('message','')).lower() for hint in
                ('block range','range too','too many results','query returned more','response size exceeded')
            ):
                raise LogRangeLimit('RPC log range limit')
            if data.get('id') != 1 or data.get('jsonrpc') != '2.0' or 'error' in data or 'result' not in data:
                raise ValueError('RPC result missing')
            return data['result']
        except LogRangeLimit:
            raise
        except (OSError, ValueError, AttributeError):
            raise ValueError(f'{chain} testnet RPC failed: {method}') from None

    def guard(self):
        with self.guard_lock:
            if time.monotonic() - self.guard_time < 15:
                return
            for chain, expected in CHAINS.items():
                if int(self.rpc(chain, 'eth_chainId', []), 16) != expected:
                    raise ValueError(f'{chain} testnet RPC chain ID mismatch')
            self.guard_time = time.monotonic()

    def view(self, chain, target, signature, *args):
        function, output = signature.rsplit(')(', 1)
        data = api.local.command(['cast', 'calldata', function + ')', *args])
        word = self.rpc(chain, 'eth_call', [dict(to=target, data=data), 'latest'])
        if not isinstance(word, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', word):
            raise ValueError('invalid contract view result')
        if output == 'address)':
            if int(word[2:26], 16):
                raise ValueError('invalid address ABI encoding')
            return '0x' + word[-40:].lower()
        if output == 'uint256)':
            return str(int(word, 16))
        if output == 'bool)':
            if int(word, 16) not in (0, 1):
                raise ValueError('invalid boolean ABI encoding')
            return 'true' if int(word, 16) else 'false'
        if output == 'bytes32)':
            return word.lower()
        raise ValueError('unsupported contract view type')

    def registered_header(self, chain, number):
        target = self.data['contracts'][chain + '_headers']
        data = api.local.command(['cast', 'calldata', 'headers(uint256)', str(number)])
        words = self.rpc(chain, 'eth_call', [dict(to=target, data=data), 'latest'])
        if not isinstance(words, str) or not re.fullmatch(r'0x[0-9a-fA-F]{128}', words):
            raise ValueError('invalid registry header response')
        return ('0x' + words[2:66].lower(), '0x' + words[66:].lower())

    def verify_deployment(self, binding_authority):
        self.guard()
        c = self.data['contracts']
        for name, chain in CONTRACT_CHAINS.items():
            code = self.rpc(chain, 'eth_getCode', [c[name], 'latest'])
            if code == '0x' or api.local.command(['cast', 'keccak', code]).lower() != self.runtime_hashes[name]:
                raise ValueError(f'{name} runtime hash differs from the reviewed deployment')
        for chain, name, peer, other in (('wl','original','wrapped','bnb'), ('bnb','wrapped','original','wl')):
            registry = c[chain + '_headers']
            if (self.view(chain, c[name], 'sourceToken()(address)') != c[peer]
                    or self.view(chain, c[name], 'headerSource()(address)') != registry
                    or int(self.view(chain, c[name], 'sourceChainId()(uint256)')) != CHAINS[other]
                    or int(self.view(chain, registry, 'sourceChainId()(uint256)')) != CHAINS[other]
                    or self.view(chain, registry, 'bridge()(address)') != c[name]
                    or self.view(chain, registry, 'devOperator()(address)') != self.operators[chain]):
                raise ValueError(f'{chain} deployment binding mismatch')
        if self.view('wl', c['original'], 'deploymentOwner()(address)') != binding_authority:
            raise ValueError('Vault binding authority mismatch')

    route = api.local.VaultSession.route


def operator_transaction(chain, operator, registry, signature, *values):
    return dict(chainId=CHAINS[chain], sender=operator, to=registry, value='0x0',
                data=api.local.command(['cast', 'calldata', signature, *map(str, values)]))


def plan(args):
    def compute(deployer, nonce):
        output = api.local.command(['cast', 'compute-address', deployer, '--nonce', str(nonce)])
        return address(output.split()[-1])

    def deploy(chain, sender, nonce, name, signature, values):
        artifact = json.loads((args.artifacts / 'VaultTestnet.sol' / (name + '.json')).read_text())
        settings = artifact['metadata']['settings']
        if settings['evmVersion'] != 'london' or not artifact['metadata']['compiler']['version'].startswith('0.8.24+'):
            raise ValueError('expected Solidity 0.8.24 London artifact')
        bytecode = artifact['bytecode']['object']
        if not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', bytecode):
            raise ValueError('invalid creation bytecode')
        encoded = api.local.command(['cast', 'abi-encode', signature, *map(str, values)])
        return dict(step=name, chainId=CHAINS[chain], sender=sender, nonce=nonce,
                    expectedAddress=compute(sender, nonce), value='0x0', data=bytecode+encoded[2:])

    wl, bnb = address(args.wl_deployer), address(args.bnb_deployer)
    wl_nonce = integer(args.wl_nonce, 0, 2**53-2)
    bnb_nonce = integer(args.bnb_nonce, 0, 2**53-2)
    authority = address(args.binding_authority)
    signature = 'constructor(uint256,address)'
    wl_registry = deploy('wl', wl, wl_nonce, 'VaultTestnetRegistry', signature, [97, address(args.wl_operator)])
    bnb_registry = deploy('bnb', bnb, bnb_nonce, 'VaultTestnetRegistry', signature, [10359, address(args.bnb_operator)])
    signature = 'constructor(address,address)'
    vault = deploy('wl', wl, wl_nonce+1, 'VaultTestnetWL', signature, [wl_registry['expectedAddress'], authority])
    wrapped = deploy('bnb', bnb, bnb_nonce+1, 'VaultTestnetWrappedWL', signature,
                     [bnb_registry['expectedAddress'], vault['expectedAddress']])
    binding = dict(step='bindWrappedToken', chainId=10359, sender=authority, to=vault['expectedAddress'], value='0x0',
                   data=api.local.command(['cast','calldata','bindWrappedToken(address)',wrapped['expectedAddress']]))
    configuration = [
        dict(step='configureBridge', **operator_transaction(chain, address(operator), registry['expectedAddress'],
            'configureBridge(address)', endpoint['expectedAddress']))
        for chain, operator, registry, endpoint in (
            ('wl', args.wl_operator, wl_registry, vault), ('bnb', args.bnb_operator, bnb_registry, wrapped))
    ]
    print(json.dumps(dict(protocol=PROTOCOL, broadcast=False,
                          contracts=dict(wl_headers=wl_registry['expectedAddress'], bnb_headers=bnb_registry['expectedAddress'],
                                         original=vault['expectedAddress'], wrapped=wrapped['expectedAddress']),
                          transactions=[wl_registry, bnb_registry, vault, wrapped, binding, *configuration]), indent=2))


def check_sdk_runtime():
    for binary in ('bridge-vault-testnet-proof', 'bridge-vault-testnet-receipt-host'):
        if not os.access(ROOT / '.bin' / binary, os.X_OK):
            raise ValueError(f'missing testnet runtime: {binary}')
    policy = json.loads((ROOT/'configs/vault-testnet-computation.json').read_text())
    sentinel = ROOT/'results/wl-vault-testnet-preflight/lock'
    with tempfile.TemporaryDirectory(prefix='vault-testnet-sdk-check-') as directory:
        folder = Path(directory)
        for filename in ('input.json', 'receipt.bin'):
            shutil.copyfile(sentinel/filename, folder/filename)
        computation = api.computation_module.Computation(
            folder, threading.Event(), policy=policy, host=ROOT/'.bin/bridge-vault-testnet-receipt-host')
        summary = computation.run('verify', folder)
        if summary['journal']['version'] != 4:
            raise ValueError('testnet Vault journal version mismatch')


def pause_plan(args):
    config = json.loads(args.config.read_text())
    digest = args.evidence_digest
    if not re.fullmatch(r'0x[0-9a-fA-F]{64}', digest) or not int(digest, 16):
        raise ValueError('expected a nonzero bytes32 incident digest')
    tx = [operator_transaction(chain, address(config['operators'][chain]),
        address(config['contracts'][chain+'_headers']), 'confirmIncident(bytes32)', digest) for chain in CHAINS]
    print(json.dumps(dict(protocol=PROTOCOL, broadcast=False, transactions=tx), indent=2))


def operator_plan(args):
    config = json.loads(args.config.read_text())
    with tempfile.TemporaryDirectory(prefix='vault-testnet-config-check-') as directory:
        session = ReadSession(Path(directory), config, 8586)
        c = session.data['contracts']
        if args.command == 'activate-plan':
            check_sdk_runtime()
            tx = [operator_transaction(chain, session.operators[chain], c[chain+'_headers'],
                'activate(address,address)', c[endpoint], c[peer])
                for chain, endpoint, peer in (('wl','original','wrapped'), ('bnb','wrapped','original'))]
        else:
            source = args.source
            destination = 'bnb' if source == 'wl' else 'wl'
            registry = c[destination+'_headers']
            number = integer(args.block, 1, 2**53-1)
            old_hash, old_root = session.registered_header(destination, number)
            if session.view(destination, registry, 'active()(bool)') == 'true':
                raise ValueError('pause the destination registry first')
            if not int(old_hash, 16) or session.view(destination, registry, 'consumedHeaders(uint256)(bool)', str(number)) == 'true':
                raise ValueError('only an existing unconsumed root can be invalidated')
            current = session.rpc(source, 'eth_getBlockByNumber', [hex(number), False])
            if not current or (current['hash'].lower(), current['receiptsRoot'].lower()) == (old_hash, old_root):
                raise ValueError('a different current source block or root must be visible')
            zero = '0x' + '00'*32
            tx = [operator_transaction(destination, session.operators[destination], registry,
                    'replaceHeader(uint256,bytes32,bytes32,bytes32,bytes32)', number, old_hash, old_root, zero, zero)]
    print(json.dumps(dict(protocol=PROTOCOL, broadcast=False, transactions=tx), indent=2))


def serve(args):
    check_sdk_runtime()
    config = json.loads(args.config.read_text())
    directory = args.state.resolve()
    port = integer(args.port, 1024, 65535)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory/'proof-service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with api.BoundedHTTPServer(('127.0.0.1', port), api.Handler) as server:
            session = ReadSession(directory, config, port)
            service = api.Service(directory, session_class=lambda _: session)
            server.service, server.public_origin, server.rpc_origins = service, None, set()
            def stop(signum, frame):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, stop)
            print(f'http://127.0.0.1:{port}/ (testnet RPC read-only)', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                service.stop.set()
                service.computation.cancel()
                service.worker.join(timeout=130)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    deploy = commands.add_parser('plan', help='emit unsigned testnet deployment data, without RPC')
    for field in ('wl-deployer','bnb-deployer','wl-operator','bnb-operator','binding-authority'):
        deploy.add_argument('--'+field, required=True)
    for field in ('wl-nonce','bnb-nonce'):
        deploy.add_argument('--'+field, type=int, required=True)
    deploy.add_argument('--artifacts', type=Path, required=True)
    reader = commands.add_parser('serve', help='open a loopback wallet and read-only testnet proof API')
    reader.add_argument('--config', type=Path, required=True)
    reader.add_argument('--state', type=Path, default=ROOT/'results/wl-vault-testnet')
    reader.add_argument('--port', type=int, default=8586)
    for name in ('activate-plan', 'pause-plan', 'invalidate-plan'):
        operation = commands.add_parser(name, help='emit unsigned operator data')
        operation.add_argument('--config', type=Path, required=True)
        if name == 'invalidate-plan':
            operation.add_argument('--source', choices=CHAINS, required=True)
            operation.add_argument('--block', type=int, required=True)
        if name == 'pause-plan':
            operation.add_argument('--evidence-digest', required=True)
    args = parser.parse_args()
    try:
        handler = {'plan': plan, 'serve': serve, 'pause-plan': pause_plan}.get(args.command, operator_plan)
        handler(args)
    except (KeyError, TypeError, ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f'{error}\n')
