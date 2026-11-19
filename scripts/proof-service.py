#!/usr/bin/env python3
"""Loopback unsigned proof delivery API for an owned local session."""
import argparse
import fcntl
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import re
import secrets
import os
import signal
import subprocess
import threading
import time
import urllib.request
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
# Match portable launchers even when invoked directly by an app terminal.
os.environ['PATH']=os.pathsep.join([str(Path.home()/'.foundry/bin'),str(Path.home()/'.cargo/bin'),os.environ.get('PATH','')])
LIMIT = 16 * 1024 * 1024
ACTIVE_JOBS = frozenset(('queued', 'running', 'waiting_confirmations', 'waiting_root', 'waiting_registry'))

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

local = module('api_session', 'local-session.py')
http_config=module('api_http_config','http-config.py')
audit_module=module('api_bridge_audit','bridge-audit.py')
computation_module=module('api_receipt_computation','receipt-computation.py')

def event_signature(action):
    if action == 'lock-vault':
        return 'VaultLocked(bytes32,address,address,uint256,uint64,uint256)'
    if action == 'burn-vault':
        return 'VaultBurned(bytes32,address,address,uint256,uint64,uint256)'
    if action in ('burn-wl','burn-bsc'):
        return 'BridgeBurned(bytes32,address,address,uint256,uint64,uint256)'
    return 'Locked(bytes32,address,address,uint256,uint64,uint256)' if action == 'lock' else 'Burned(bytes32,address,address,uint256,uint64,uint256)'

def manifest(session):
    session.guard()
    d = session.data
    if d['phase'] != 'ready' or d['mode'] != 'dev':
        raise ValueError('ready trusted-root local session required')
    result = dict(version=1, mode=d['mode'], headerBinding=d.get('header_binding', 'minimal-link'),
                  chainAuthenticated=False, realAssetDeploymentAllowed=False, imageId=d.get('image_id'),
                  users=d['users'], chains={k: dict(id=v['id'], rpc=v['rpc']) for k, v in d['chains'].items()},
                  contracts={}, runtimeCode={})
    result['protocol'] = d.get('protocol','lock-mint-v1')
    if getattr(session, 'testnet_reader', False):
        result['readOnlyTestnet'] = True
        for key, chain in result['chains'].items():
            chain['historyStartBlock'] = d['chains'][key]['historyStartBlock']
    if d.get('asset_profile'):
        result['assetProfile'] = d['asset_profile']
        result['entryPolicy'] = d['entry_policy']
    if d.get('wallet_session_id'):
        result['sessionId'] = d['wallet_session_id']
    for name, chain in [('original','wl'),('wrapped','bnb'),('mint','bnb'),('unlock','wl'),('wl_headers','wl'),('bnb_headers','bnb')]:
        address = d['contracts'][name]
        code = session.rpc(chain, 'eth_getCode', [address, 'latest'])
        if code == '0x':
            raise ValueError('missing contract runtime: ' + name)
        result['contracts'][name] = address
        result['runtimeCode'][name] = code
    return result

class Service:
    def __init__(self, directory, confirmations=2, demo_mine=False, session_class=None):
        self.session = (session_class or local.Session)(Path(directory))
        protocol = self.session.data.get('protocol')
        self.v2 = protocol == 'burn-mint-v2'
        self.testnet = bool(getattr(self.session, 'testnet_reader', False))
        self.vault = protocol == local.VaultSession.PROTOCOL or self.testnet
        if protocol == 'native-wl-vault-testnet-v1' and not self.testnet:
            raise ValueError('testnet requires its dedicated read-only launcher')
        if self.vault and not self.testnet and not isinstance(self.session, local.VaultSession):
            raise ValueError('Vault sessions require the Vault launcher')
        self.actions = ('lock-vault', 'burn-vault') if self.vault else ('burn-wl', 'burn-bsc') if self.v2 else ('lock', 'burn')
        self.proof_binary = local.PROOF
        policy, host = None, None
        if self.vault or self.v2:
            profile = 'vault-testnet' if self.testnet else 'vault' if self.vault else 'burn-mint'
            self.proof_binary = ROOT / '.bin' / ('bridge-' + profile + '-proof')
            policy = json.loads((ROOT / 'configs' / (profile + '-computation.json')).read_text())
            host = ROOT / '.bin' / ('bridge-' + profile + '-receipt-host')
        if not self.session.data.get('wallet_session_id'):
            self.session.guard()
            self.session.data['wallet_session_id'] = secrets.token_hex(16)
            self.session.save()
        self.manifest = manifest(self.session)
        self.confirmations = confirmations
        self.demo_mine = demo_mine
        self.directory = self.session.root / 'proof-jobs'
        self.directory.mkdir(exist_ok=True)
        self.lock = threading.Lock()
        self.job_status = {}
        self.stop = threading.Event()
        self.computation = computation_module.Computation(self.directory, self.stop, policy=policy, host=host)
        for path in self.directory.glob('*.json'):
            job = self.read(path)
            if job['state'] == 'running':
                job.update(state='queued', detail='서버 재시작 후 요청 복구')
                self.save(job)
            else:
                self.job_status[job['id']] = self.public(job)
        self.audit=None if self.testnet else audit_module.Audit(self.session)
        if self.audit and self.audit.last=='0'*64:
            self.audit.record('session_started',dict(contracts=self.manifest['contracts'],policy='trusted-rpc-receipt-root'))
            for path in sorted(self.directory.glob('*.json')):
                existing=self.read(path)
                self.audit.record('existing_proof_job',dict(id=existing['id'],request=existing['request'],state=existing['state'],detail=existing['detail']))
        self.audit_last_check=0
        self.worker = threading.Thread(target=self.work, daemon=True)
        self.worker.start()

    def read(self, path):
        if not path.is_file() or path.is_symlink() or path.stat().st_size > LIMIT:
            raise ValueError('invalid or oversized job file')
        return json.loads(path.read_bytes())

    def save(self, job):
        job['updatedAt'] = time.time()
        local.write_json(self.directory / (job['id'] + '.json'), job)
        self.job_status[job['id']] = self.public(job)
        if getattr(self,'audit',None):
            data=dict(id=job['id'],request=job['request'],state=job['state'],detail=job['detail'])
            if job.get('package'):
                proof=job['package'];data.update(packageDigest=hashlib.sha256(json.dumps(proof,sort_keys=True,separators=(',',':')).encode()).hexdigest(),blockHash=proof.get('blockHash'),receiptRoot=proof.get('receiptRoot'))
            self.audit.record('proof_job',data)

    def public(self, job):
        return {k: v for k, v in job.items()
                if k != 'package' and (k != 'rootRegistration' or job['state'] == 'waiting_root')}

    def confirmation_depth(self, source):
        return self.session.confirmations[source] if self.testnet else self.confirmations

    def list_jobs(self, action):
        if action not in self.actions:
            raise ValueError('invalid bridge direction')
        with self.lock:
            return [job for job in self.job_status.values() if job['request']['action'] == action]

    def submit(self, request):
        if self.audit:self.audit.require_active()
        if not isinstance(request, dict) or set(request) != {'action','transferId','fromBlock'}:
            raise ValueError('required: action, transferId, fromBlock')
        action, transfer, start = request['action'], request['transferId'], request['fromBlock']
        if action not in self.actions or not isinstance(transfer, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', transfer):
            raise ValueError('invalid action or transfer ID')
        if type(start) is not int or not 0 <= start <= 2**53-1:
            raise ValueError('invalid starting block')
        if self.vault:
            # Restored requests can supply an earlier starting block.
            # The actual event block gives each deposit or burn one job ID.
            self.session.guard()
            source, _, token, _, _, _ = self.session.route(action)
            if self.testnet:
                start = max(start, self.session.data['chains'][source]['historyStartBlock'])
            topic = local.command(['cast', 'keccak', event_signature(action)])
            logs = self.session.rpc(source, 'eth_getLogs', [dict(
                address=token, fromBlock=hex(start), toBlock='latest', topics=[topic, transfer.lower()])])
            if len(logs) != 1 or logs[0].get('removed'):
                raise ValueError('unique source event required')
            start = int(logs[0]['blockNumber'], 16)
        request = dict(action=action, transferId=transfer.lower(), fromBlock=start)
        identifier = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        with self.lock:
            path = self.directory / (identifier + '.json')
            job = self.read(path) if path.exists() else None
            if (job is None or job['state'] == 'failed') and sum(
                entry['state'] in ACTIVE_JOBS for entry in self.job_status.values()
            ) >= 256:
                raise ValueError('active proof job capacity reached')
            if job is not None:
                if job['state'] == 'failed' or (not self.vault and job['state'] == 'ready'):
                    job.update(state='queued', detail='원본 블록 및 목적지 등록 정보 재확인 중')
                    self.save(job)
            else:
                job = dict(id=identifier, request=request, state='queued', detail='확인 블록 대기', createdAt=time.time())
                self.save(job)
            return self.public(job)

    def get(self, identifier, package=False):
        if not re.fullmatch(r'[0-9a-f]{64}', identifier):
            raise ValueError('invalid job ID')
        with self.lock:
            job = self.read(self.directory / (identifier + '.json'))
        if not package:
            return self.public(job)
        if job['state'] not in ('ready',):
            raise ValueError('proof package is not ready')
        if self.audit:self.audit.require_active()
        proof = job['package']
        self.session.guard()
        source, _, _, _, _, _ = self.session.route(job['request']['action'])
        block = self.session.rpc(source, 'eth_getBlockByNumber', [hex(proof['blockNumber']), False])
        height = int(self.session.rpc(source, 'eth_blockNumber', []), 16)
        if (not block or block['hash'].lower() != proof['blockHash'].lower()
            or block['receiptsRoot'].lower() != proof['receiptRoot'].lower()
            or height < proof['blockNumber'] + self.confirmation_depth(source)):
            with self.lock:
                job.update(state='failed', detail='source changed or confirmations lost')
                job.pop('package', None)
                self.save(job)
            raise ValueError('source changed or confirmations lost')
        proof=self.receipt_computation(job,proof)
        self.check_computation_source(proof)
        return proof



    def generate(self, job):
        if self.audit:self.audit.require_active()
        self.session.guard()
        checkpoint=self.prepare_trusted_root(job)
        preview_root = checkpoint is not None and checkpoint['state'] == 'waiting_root'
        if checkpoint is not None and not preview_root:return checkpoint
        if preview_root and job.get('rootRegistration') == checkpoint['rootRegistration']:
            return checkpoint
        action = job['request']['action']
        source, destination, token, target, registry, receiver = self.session.route(action)
        chains = self.manifest['chains']
        cmd = [str(self.proof_binary), '--rpc', chains[source]['rpc'], '--chain-id', str(chains[source]['id']),
               '--token', token, '--destination-token', target, '--destination-rpc', chains[destination]['rpc'],
               '--header-source', registry, '--receiver', receiver, '--action', action,
               '--id', job['request']['transferId'], '--from-block', str(job['request']['fromBlock']),
               '--confirmations', str(self.confirmation_depth(source)), '--header-mode', self.manifest['mode']]
        env = None
        if self.testnet:
            cmd += ['--network-profile', 'vault-testnet']
            if preview_root:
                cmd.append('--preview-root')
            env = dict(os.environ, BNC_TESTNET_SOURCE_RPC=self.session.endpoints[source],
                       BNC_TESTNET_DESTINATION_RPC=self.session.endpoints[destination])
        result = subprocess.run(cmd, capture_output=True, timeout=65, env=env)
        if len(result.stdout) > LIMIT or len(result.stderr) > LIMIT:
            raise ValueError('generator output limit')
        if result.returncode:
            detail = result.stderr.decode(errors='replace').strip()[:2000]
            if self.testnet:
                detail = self.session.redact(detail)
            if 'expected exactly one safe event, found 0' in detail or 'exceeds safe source height' in detail:
                return dict(state='waiting_confirmations', detail='확인 블록을 기다립니다')
            raise ValueError(detail or 'generator failed')
        package=json.loads(result.stdout)
        if preview_root:
            proposal = checkpoint['rootRegistration']
            if (package['blockNumber'] != proposal['blockNumber']
                    or any(package[key].lower() != proposal[key].lower() for key in ('blockHash','receiptRoot'))):
                raise ValueError('reconstructed source root differs from the operator proposal')
            return checkpoint
        package=self.receipt_computation(job,package)
        self.check_computation_source(package)
        return dict(state='ready', detail='RISC0 내부 연산 증명 및 청구 패키지 준비 완료', package=package)

    def receipt_computation(self,job,package):
        if package.get('computationProof'):
            self.computation.verify(package)
            return package
        with self.lock:
            job['detail'] = 'RISC0 연산 증명 생성·SDK 검증 중 · 완료되면 패키지를 반환합니다'
            self.save(job)
        return self.computation.attach(job['id'], package)

    def check_computation_source(self, package):
        self.session.guard()
        action = package.get('action')
        if action not in self.actions:
            raise ValueError('invalid computation action')
        source, destination, token, remote, registry, receiver = self.session.route(action)
        if (package.get('sourceChainId') != self.manifest['chains'][source]['id']
                or package.get('destinationChainId') != self.manifest['chains'][destination]['id']
                or package.get('sourceToken', '').lower() != token.lower()
                or package.get('destinationToken', '').lower() != remote.lower()):
            raise ValueError('computation belongs to another session')
        number = package.get('blockNumber')
        if type(number) is not int or not 0 <= number <= 2**53 - 1:
            raise ValueError('invalid computation source block')
        block = self.session.rpc(source, 'eth_getBlockByNumber', [hex(number), False])
        height = int(self.session.rpc(source, 'eth_blockNumber', []), 16)
        if (not block or block['hash'].lower() != package.get('blockHash', '').lower()
                or block['receiptsRoot'].lower() != package.get('receiptRoot', '').lower()
                or height < number + self.confirmation_depth(source)):
            raise ValueError('source changed or confirmations lost')
        root = self.session.view(destination, registry, 'getReceiptRoot(uint256,uint256,bytes32)(bytes32)',
                                 str(package['sourceChainId']), str(number), package['blockHash'])
        if root.lower() != package['receiptRoot'].lower():
            raise ValueError('registered receipt root mismatch')

    def verify_computation(self, package):
        if self.audit:
            self.audit.require_active()
        verified = self.computation.verify(package)
        self.check_computation_source(package)
        return verified

    def prepare_trusted_root(self,job):
        source,destination,token,_,registry,_=self.session.route(job['request']['action'])
        confirmations = self.confirmation_depth(source)
        height=int(self.session.rpc(source,'eth_blockNumber',[]),16)
        if height<job['request']['fromBlock']+confirmations:
            if not self.demo_mine:return dict(state='waiting_confirmations',detail='확인 블록 대기')
            # Local fixture only: advance after finding this request's actual source event.
            topic=local.command(['cast','keccak',event_signature(job['request']['action'])])
            logs=self.session.rpc(source,'eth_getLogs',[dict(address=token,fromBlock=hex(job['request']['fromBlock']),toBlock='latest',topics=[topic,job['request']['transferId']])])
            if len(logs)!=1 or logs[0].get('removed'):raise ValueError('unique source event required before demo mining')
            needed=int(logs[0]['blockNumber'],16)+confirmations-height
            if needed>0:self.session.rpc(source,'anvil_mine',[hex(min(needed,confirmations))])
        info=self.event_info(job)
        block=self.session.rpc(source,'eth_getBlockByNumber',[hex(info['block']),False])
        if block['hash'].lower()!=info['hash'].lower():raise ValueError('source event changed before root registration')
        operator = self.session.operators[destination] if self.testnet else self.session.data['operator']
        if self.session.view(destination,registry,'devOperator()(address)').lower()!=operator.lower():raise ValueError('trusted root operator mismatch')
        if self.testnet:
            old_hash, old_root = self.session.registered_header(destination, info['block'])
            if int(old_hash, 16) and (old_hash, old_root) != (block['hash'].lower(), block['receiptsRoot'].lower()):
                used = self.session.view(destination, registry, 'consumedHeaders(uint256)(bool)', str(info['block'])) == 'true'
                detail = '기존 루트로 지급·발행한 청구를 운영자가 대조해야 합니다.' if used else '운영자가 일시 정지 후 미사용 루트를 무효화해야 합니다.'
                raise ValueError(f'등록 루트 불일치 · 출발 블록 {info["block"]} · {detail}')
            if self.session.view(destination, registry, 'active()(bool)') != 'true':
                return dict(state='waiting_registry', detail='목적지 레지스트리가 일시 정지됐습니다.')
        covered=self.session.view(destination,registry,'isBlockCovered(uint256,uint256,bytes32)(bool)',str(self.manifest['chains'][source]['id']),str(info['block']),info['hash'])=='true'
        if not covered:
            if self.testnet:
                data = local.command(['cast','calldata','registerHeader(uint256,bytes32,bytes32)',
                                      str(info['block']), block['hash'], block['receiptsRoot']])
                return dict(state='waiting_root', detail='목적지 운영자 지갑의 영수증 루트 등록 대기',
                            rootRegistration=dict(chainId=self.manifest['chains'][destination]['id'],
                                operator=operator, to=registry, data=data, value='0x0',
                                sourceChainId=self.manifest['chains'][source]['id'], blockNumber=info['block'],
                                blockHash=block['hash'], receiptRoot=block['receiptsRoot']))
            # Operator registers only a receipt root. Never submits a user asset transaction.
            with (self.session.root/'trusted-root.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                self.session.send(destination,self.session.data['operator'],registry,'registerHeader(uint256,bytes32,bytes32)',str(info['block']),block['hash'],block['receiptsRoot'])
        after=self.session.rpc(source,'eth_getBlockByNumber',[hex(info['block']),False])
        if after['hash']!=block['hash'] or after['receiptsRoot']!=block['receiptsRoot']:raise ValueError('source changed during root registration')
        self.event_info(job)
        root=self.session.view(destination,registry,'getReceiptRoot(uint256,uint256,bytes32)(bytes32)',str(self.manifest['chains'][source]['id']),str(info['block']),info['hash'])
        if root.lower()!=block['receiptsRoot'].lower():raise ValueError('registered receipt root mismatch')
        return None

    def event_info(self, job):
        action=job['request']['action']
        source,_,token,_,_,_=self.session.route(action)
        signature=event_signature(action)
        topic=local.command(['cast','keccak',signature])
        height=int(self.session.rpc(source,'eth_blockNumber',[]),16)-self.confirmation_depth(source)
        if height<job['request']['fromBlock']:
            raise ValueError('event confirmations lost')
        logs=self.session.rpc(source,'eth_getLogs',[dict(address=token,fromBlock=hex(job['request']['fromBlock']),toBlock=hex(height),topics=[topic,job['request']['transferId']])])
        if len(logs)!=1 or logs[0].get('removed'):
            raise ValueError('unique confirmed event required')
        log=logs[0]
        if len(log['topics']) != 4 or (not (self.v2 or self.vault) and log['topics'][2].lower() != log['topics'][3].lower()):
            raise ValueError('invalid event topics')
        owner='0x'+log['topics'][3][-40:]
        if int(owner,16)==0:
            raise ValueError('zero event recipient')
        return dict(block=int(log['blockNumber'],16),hash=log['blockHash'],owner=owner)




    def work(self):
        while not self.stop.is_set():
            if self.audit:
                try:
                    self.audit.enforce_stop()
                    if time.time()-self.audit_last_check>10:
                        self.audit.inspect();self.audit_last_check=time.time()
                    self.audit.anchor()
                except Exception as error:
                    self.audit_error=str(error)[:500]
                else:self.audit_error=None

            for path in sorted(self.directory.glob('*.json')):
                try:
                    with self.lock:
                        job = self.read(path)
                        if job['state'] not in ACTIVE_JOBS or job['state'] == 'running':
                            continue
                        if self.testnet and job['state'] != 'queued' and time.time() - job['updatedAt'] < 30:
                            continue
                        job.update(state='running', detail='신뢰 RPC root 등록 및 거래 포함 증명 생성 중')
                        self.save(job)
                    try:
                        update = self.generate(job)
                    except Exception as error:
                        update = dict(state='failed', detail=str(error)[:2000])
                    with self.lock:
                        job.update(update)
                        if job['state'] != 'waiting_root':
                            job.pop('rootRegistration', None)
                        if job['state'] not in ('ready',):
                            job.pop('package', None)
                        self.save(job)
                except Exception:
                    continue
            self.stop.wait(2)

class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self,*args,**kwargs):
        self.request_slots=threading.BoundedSemaphore(32)
        super().__init__(*args,**kwargs)
    def process_request(self,request,client_address):
        if not self.request_slots.acquire(blocking=False):
            try:request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            finally:self.shutdown_request(request)
            return
        try:super().process_request(request,client_address)
        except BaseException:self.request_slots.release();raise
    def process_request_thread(self,request,client_address):
        try:super().process_request_thread(request,client_address)
        finally:self.request_slots.release()

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT/'wallet'), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','no-store')
        origin=self.headers.get('Origin')
        if urlsplit(self.path).path in ('/rpc/wl','/rpc/bnb') and origin in getattr(self.server,'rpc_origins',set()):
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
            self.send_header('Access-Control-Allow-Methods','POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Content-Type')
        super().end_headers()

    def guess_type(self, path):
        return 'text/javascript' if path.endswith('.mjs') else super().guess_type(path)

    def trusted(self,mutation=False,rpc=False):
        authority=self.headers.get('Host','')
        public=getattr(self.server,'public_origin',None)
        allowed={f'127.0.0.1:{self.server.server_port}':'http',f'localhost:{self.server.server_port}':'http'}
        if public:
            parsed=urlsplit(public);allowed[parsed.netloc]=parsed.scheme
        if authority not in allowed:return False
        origin=self.headers.get('Origin')
        if origin and origin!=allowed[authority]+'://'+authority and not (rpc and origin in getattr(self.server,'rpc_origins',set())):return False
        return not mutation or self.headers.get('X-Bridge-Request')=='1'

    def public_manifest(self):
        return http_config.wallet_manifest(self.server.service.session,getattr(self.server,'public_origin',None),manifest)

    def rpc_transport(self,path):
        # Wallet submits its already signed raw transaction directly to its RPC.
        # No signing/unlocked send, personal methods, admin or prover submission.
        if not self.trusted(rpc=True):return self.respond(403,dict(error='untrusted RPC origin'))
        try:
            if self.headers.get('Transfer-Encoding'):raise ValueError('chunked RPC body not supported')
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=65536 or self.headers.get('Content-Type','').split(';')[0]!='application/json':
                raise ValueError('bounded JSON RPC body required')
            body=json.loads(self.rfile.read(length))
            if isinstance(body,dict):body.setdefault('params',[])
            if (not isinstance(body,dict) or set(body)-{'jsonrpc','id','method','params'} or body.get('jsonrpc')!='2.0'
                or body.get('method') not in http_config.RPC_METHODS or not isinstance(body.get('params'),list)):
                raise ValueError('RPC method not allowed')
            if body['method']=='eth_sendRawTransaction' and (len(body['params'])!=1 or not isinstance(body['params'][0],str)
                or not re.fullmatch(r'0x[0-9a-fA-F]+',body['params'][0])):
                raise ValueError('wallet-signed raw transaction required')
            session=self.server.service.session;session.guard()
            if self.server.service.testnet:
                if body['method']=='eth_sendRawTransaction':
                    raise ValueError('testnet API is read-only; submit from the wallet network')
                chain = path.rsplit('/',1)[1]
                return self.respond(200, dict(jsonrpc='2.0', id=body.get('id'),
                                               result=session.rpc(chain, body['method'], body['params'])))
            url=session.data['chains'][path.rsplit('/',1)[1]]['rpc']
            req=urllib.request.Request(url,json.dumps(body).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=15) as response:
                raw=response.read(LIMIT+1)
            if len(raw)>LIMIT:raise ValueError('RPC response limit')
            result=json.loads(raw)
            if body['method']=='eth_sendRawTransaction' and self.server.service.audit:
                try:self.server.service.audit.record('wallet_broadcast',dict(chain=path.rsplit('/',1)[1],transactionHash=result.get('result'),error=result.get('error')))
                except Exception as error:self.server.service.audit_error='broadcast audit write failed: '+str(error)[:200]
            return self.respond(200,result)
        except Exception as error:return self.respond(400,dict(error=str(error)[:2000]))

    def respond(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.trusted():
            return self.respond(403, dict(error='same-origin loopback access required'))
        path = urlsplit(self.path).path
        try:
            if path in ('/', '/index.html') and (self.server.service.v2 or self.server.service.vault):
                self.send_response(302)
                profile = self.server.service.manifest.get('assetProfile')
                landing = '/vault.html' if self.server.service.vault else '/xwl.html' if profile == 'xwl-entry-v1' else '/burn-mint.html'
                self.send_header('Location', landing)
                self.send_header('Content-Length','0')
                self.end_headers()
                return
            if path=='/api/audit':
                query=__import__('urllib.parse',fromlist=['parse_qs']).parse_qs(urlsplit(self.path).query)
                after=max(0,int(query.get('after',['0'])[0]));limit=min(200,max(1,int(query.get('limit',['100'])[0])))
                audit=self.server.service.audit
                if not audit:return self.respond(200,dict(records=[],total=0,enabled=False))
                result=audit.public(after,limit);result['monitorError']=getattr(self.server.service,'audit_error',None)
                return self.respond(200,result)
            if path=='/api/transactions':
                query=__import__('urllib.parse',fromlist=['parse_qs']).parse_qs(urlsplit(self.path).query)
                chain=query.get('chain',['wl'])[0];start=max(0,int(query.get('from',['0'])[0]))
                if chain not in ('wl','bnb'):raise ValueError('invalid chain')
                session=self.server.service.session;tip=int(session.rpc(chain,'eth_blockNumber',[]),16)
                end=min(tip,start+1999);names=['original','unlock','wl_headers','wl_audit'] if chain=='wl' else ['wrapped','mint','bnb_headers','bnb_audit'];names=[name for name in names if name in session.data['contracts']]
                logs=session.rpc(chain,'eth_getLogs',[dict(address=[session.data['contracts'][n] for n in names],fromBlock=hex(start),toBlock=hex(end))]) if start<=tip else []
                return self.respond(200,dict(chain=chain,logs=logs,nextBlock=end+1,latestBlock=tip))
            if path=='/api/health':
                healthy=self.server.service.worker.is_alive()
                return self.respond(200 if healthy else 503,dict(status='ok' if healthy else 'worker_stopped',singleWriter=True))
            if path == '/api/chains':
                chains={}
                for key in ('wl','bnb'):
                    config=self.server.service.session.data['chains'][key]
                    try:
                        def read(method,params):
                            if self.server.service.testnet:
                                return self.server.service.session.rpc(key,method,params)
                            request=urllib.request.Request(config['rpc'],json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params)).encode(),{'Content-Type':'application/json'})
                            with urllib.request.urlopen(request,timeout=2) as response:
                                value=json.load(response)
                            if 'error' in value:raise ValueError('RPC read failed')
                            return value['result']
                        chain_id=int(read('eth_chainId',[]),16)
                        if chain_id!=config['id']:raise ValueError('chain ID mismatch')
                        block=read('eth_getBlockByNumber',['latest',False])
                        chains[key]=dict(connected=True,chainId=chain_id,blockNumber=int(block['number'],16),blockHash=block['hash'],blockTimestamp=int(block['timestamp'],16),transactions=len(block['transactions']))
                    except Exception:
                        chains[key]=dict(connected=False,chainId=config['id'],error='체인 RPC 응답 실패 또는 체인 ID 불일치')
                return self.respond(200,dict(chains=chains,checkedAt=int(time.time()),pollSeconds=5))
            if path == '/api/manifest':
                data=self.public_manifest()
                data['proofPolicy']='trusted-rpc-receipt-root'
                data['computationPolicy']='risc0-receipt-computation'
                data['computationProof']=dict(self.server.service.computation.policy, verificationLocation='server-risc0-sdk')
                data['trustModel']='trusted-server-and-rpc'
                return self.respond(200,data)
            if path == '/api/jobs' and (self.server.service.v2 or self.server.service.vault):
                actions = parse_qs(urlsplit(self.path).query).get('action', [])
                if len(actions) != 1:
                    return self.respond(400, dict(error='specify one bridge direction'))
                return self.respond(200, dict(jobs=self.server.service.list_jobs(actions[0])))
            if path.startswith('/api/jobs/'):
                parts = path.split('/')
                if len(parts) not in (4,5) or (len(parts)==5 and parts[4]!='package'):
                    return self.respond(404, dict(error='unknown route'))
                return self.respond(200, self.server.service.get(parts[3], len(parts)==5))
            if path.startswith('/api/'):
                return self.respond(404, dict(error='unknown route'))
            return super().do_GET()
        except FileNotFoundError:
            return self.respond(404, dict(error='job not found'))
        except Exception as error:
            return self.respond(409, dict(error=str(error)[:2000]))

    def do_OPTIONS(self):
        if urlsplit(self.path).path not in ('/rpc/wl','/rpc/bnb') or not getattr(self.server,'public_origin',None) or not self.trusted(rpc=True):
            return self.respond(403,dict(error='RPC origin not allowed'))
        self.send_response(204);self.end_headers()

    def do_POST(self):
        if urlsplit(self.path).path in ('/rpc/wl','/rpc/bnb'):
            return self.rpc_transport(urlsplit(self.path).path)
        if not self.trusted(True):
            return self.respond(403, dict(error='same-origin request header required'))
        if self.path not in ('/api/jobs', '/api/computation/verify'):
            return self.respond(404, dict(error='unknown route'))
        try:
            length = int(self.headers.get('Content-Length','0'))
            cap = LIMIT if self.path == '/api/computation/verify' else 4096
            if self.headers.get('Transfer-Encoding') or not 0 < length <= cap or self.headers.get('Content-Type') != 'application/json':
                raise ValueError('bounded JSON body required')
            body=json.loads(self.rfile.read(length))
            if self.path == '/api/computation/verify':
                return self.respond(200, self.server.service.verify_computation(body))
            return self.respond(202, self.server.service.submit(body))
        except Exception as error:
            return self.respond(400, dict(error=str(error)[:2000]))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', type=Path, required=True)
    parser.add_argument('--vault', action='store_true')
    parser.add_argument('--port',type=int,default=int(os.environ.get('BNC_API_PORT','8580')))
    parser.add_argument('--bind',default=os.environ.get('BNC_BIND','127.0.0.1'))
    parser.add_argument('--public-origin',default=os.environ.get('BNC_PUBLIC_ORIGIN'))
    parser.add_argument('--rpc-origins',default=os.environ.get('BNC_RPC_ORIGINS',''),help='comma-separated explicitly trusted extension RPC origins')
    parser.add_argument('--confirmations', type=int, default=2)
    parser.add_argument('--demo-mine',action='store_true',help='owned local Anvil only: advance confirmation blocks after a real event')
    args = parser.parse_args()
    if args.bind!='127.0.0.1' or args.public_origin:parser.error('local trusted RPC demo only')
    if args.public_origin:args.public_origin=http_config.origin(args.public_origin)
    rpc_origins=set(filter(None,args.rpc_origins.split(',')))
    for origin in rpc_origins:
        if not re.fullmatch(r'(chrome-extension|moz-extension)://[a-zA-Z0-9-]+',origin):http_config.origin(origin)
    if args.bind!='127.0.0.1' and not args.public_origin:parser.error('non-loopback bind requires explicit public origin')
    if not 1024<=args.port<=65535:parser.error('port must be1024..65535')
    if not 0 <= args.confirmations <= 100000:
        parser.error('confirmations outside local policy bounds')
    with (args.session/'proof-service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with BoundedHTTPServer((args.bind,args.port),Handler) as server:
            service=Service(args.session,args.confirmations,args.demo_mine,
                            session_class=local.VaultSession if args.vault else None)
            server.service = service
            server.public_origin=args.public_origin
            server.rpc_origins=rpc_origins|({args.public_origin} if args.public_origin else set())
            def interrupted(signum, frame):
                service.stop.set()
                service.computation.cancel()
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM,interrupted)
            signal.signal(signal.SIGINT,interrupted)
            print(args.public_origin or f'http://{args.bind}:{args.port}',flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                service.stop.set()
                service.computation.cancel()
                service.worker.join(timeout=130)

if __name__ == '__main__':
    main()
