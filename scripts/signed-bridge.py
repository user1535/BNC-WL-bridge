#!/usr/bin/env python3
"""Owned local Anvil session and EIP-712 burn attestations; users submit assets."""
import argparse
import fcntl
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import threading
import urllib.request
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
os.environ['PATH'] = os.pathsep.join([str(ROOT/'.bin'), str(Path.home()/'.foundry/bin'), os.environ.get('PATH', '')])
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
local = module('signed_local', 'local-session.py')
http_config = module('signed_http', 'http-config.py')
PROTOCOL = 'signed-xwl-bridge-v1'
TUPLE = '(bytes32,uint256,address,address,address,uint256,uint64,bytes32,bytes32,uint256,uint256,uint256)'
FIELDS = [('burnId','bytes32'),('sourceChainId','uint256'),('sourceToken','address'),('sender','address'),
          ('recipient','address'),('amount','uint256'),('nonce','uint64'),('sourceTxHash','bytes32'),
          ('sourceBlockHash','bytes32'),('sourceBlockNumber','uint256'),('logIndex','uint256'),('deadline','uint256')]
HASH = re.compile(r'0x[0-9a-fA-F]{64}')
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}')

def same(a,b): return isinstance(a,str) and isinstance(b,str) and a.lower() == b.lower()
def tuple_value(message): return '(' + ','.join(str(message[k]) for k,_ in FIELDS) + ')'

class Session(local.Session):
    PROTOCOL = PROTOCOL
    def __init__(self, directory):
        if Path(directory).resolve() in {(ROOT/'results'/n).resolve() for n in ('prototype-risc0','wl-vault-v1','xwl-entry-v1')}:
            raise ValueError('historical evidence sessions are read-only')
        super().__init__(directory)
        if self.data and self.data.get('protocol') != PROTOCOL:
            raise ValueError('a separate signed-bridge session is required')

    def sources(self):
        names = ['contracts/signature/SignedBridge.sol','contracts/src/token/MinimalERC20.sol','contracts/foundry.toml']
        return {n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names}

    def setup(self):
        self.guard()
        if self.data.get('phase') == 'ready':
            if self.data.get('contractSources') != self.sources(): raise ValueError('deployed contract source changed; use a new session')
            self.verify_bindings(); return
        accounts = self.rpc('wl','eth_accounts',[])
        self.data.update(operator=accounts[0], signer=accounts[9], users=accounts[1:4])
        self.save()
        self.deploy('xwl','wl','signature/SignedBridge.sol:VaultXWL',self.data['signer'])
        self.deploy('wwl','bnb','signature/SignedBridge.sol:SignedWWL',self.data['signer'])
        for chain,name,peer in [('wl','xwl','wwl'),('bnb','wwl','xwl')]:
            token=self.data['contracts'][name]
            if int(self.view(chain,token,'peerToken()(address)'),16)==0:
                self.send(chain,self.data['operator'],token,'bindPeer(address)',self.data['contracts'][peer])
        self.data['contractSources']=self.sources()
        self.data['runtimeCode']={name:self.rpc(chain,'eth_getCode',[self.data['contracts'][name],'latest'])
                                  for chain,name in [('wl','xwl'),('bnb','wwl')]}
        self.data['phase']='ready'; self.save(); self.verify_bindings()

    def verify_bindings(self):
        self.guard()
        if self.data.get('contractSources') != self.sources(): raise ValueError('deployed contract source differs')
        for chain,name,peer,remote in [('wl','xwl','wwl',31338),('bnb','wwl','xwl',31337)]:
            token=self.data['contracts'][name]
            if (not same(self.view(chain,token,'peerToken()(address)'),self.data['contracts'][peer])
                or not same(self.view(chain,token,'operatorSigner()(address)'),self.data['signer'])
                or int(self.view(chain,token,'peerChainId()(uint256)')) != remote
                or self.rpc(chain,'eth_getCode',[token,'latest']) != self.data['runtimeCode'][name]):
                raise ValueError('signed bridge binding/runtime changed')

    def manifest(self):
        return dict(protocol=PROTOCOL, version=1, sessionId=hashlib.sha256(str(self.root).encode()).hexdigest()[:24],
                    trustModel='trusted-operator-and-rpc', sourceAuthenticated=False, risc0=False,
                    users=self.data['users'], signer=self.data['signer'], contracts=self.data['contracts'],
                    runtimeCode=self.data['runtimeCode'], chains={k:dict(id=v['id'],rpc=v['rpc']) for k,v in self.data['chains'].items()})

class Service:
    def __init__(self, session, confirmations=2, demo_mine=False):
        self.session=session; self.confirmations=confirmations; self.demo_mine=demo_mine
        session.verify_bindings()
        self.lock=threading.Lock(); self.capacity=threading.BoundedSemaphore(4)
        self.directory=session.root/'packages'; self.directory.mkdir(exist_ok=True)
        self.topic=local.command(['cast','keccak','BridgeBurned(bytes32,address,address,uint256,uint64,uint256,address)'])

    def route(self, chain):
        if chain=='wl': return 'bnb','xwl','wwl'
        if chain=='bnb': return 'wl','wwl','xwl'
        raise ValueError('configured local source chain required')

    def source_event(self, chain, tx_hash, index=None):
        if not isinstance(tx_hash,str) or not HASH.fullmatch(tx_hash): raise ValueError('source transaction hash required')
        if index is not None and (type(index)!=int or not 0<=index<100000): raise ValueError('invalid log index')
        destination,name,remote=self.route(chain); s=self.session; s.guard()
        receipt=s.rpc(chain,'eth_getTransactionReceipt',[tx_hash])
        if not receipt or int(receipt['status'],16)!=1 or not same(receipt['transactionHash'],tx_hash):
            raise ValueError('successful source transaction required')
        logs=[entry for entry in receipt['logs'] if same(entry['address'],s.data['contracts'][name])
              and len(entry['topics'])==4 and same(entry['topics'][0],self.topic)
              and (index is None or int(entry['logIndex'],16)==index)]
        if len(logs)!=1: raise ValueError('one bridge burn event required; redemption and transfers are not bridge burns')
        log=logs[0]
        if log.get('removed') or not same(log['blockHash'],receipt['blockHash']) or not same(log['transactionHash'],tx_hash):
            raise ValueError('source event metadata differs')
        height=int(receipt['blockNumber'],16)
        block=s.rpc(chain,'eth_getBlockByNumber',[hex(height),False])
        if not block or not same(block['hash'],receipt['blockHash']): raise ValueError('source event is not canonical')
        if len(log['data'])!=258: raise ValueError('invalid bridge event data')
        words=[int(log['data'][2+i:2+i+64],16) for i in range(0,256,64)]
        amount,nonce,dest_id,remote_address=words
        sender=int(log['topics'][2],16); recipient=int(log['topics'][3],16)
        if not 0<amount<2**256 or not 0<nonce<2**64 or not 0<sender<2**160 or not 0<recipient<2**160:
            raise ValueError('invalid bridge event values')
        if dest_id!=s.data['chains'][destination]['id'] or remote_address!=int(s.data['contracts'][remote],16):
            raise ValueError('bridge event destination differs')
        event=dict(burnId=log['topics'][1],sourceChainId=s.data['chains'][chain]['id'],sourceToken=s.data['contracts'][name],
                   sender='0x'+format(sender,'040x'),recipient='0x'+format(recipient,'040x'),amount=str(amount),nonce=str(nonce),
                   sourceTxHash=tx_hash,sourceBlockHash=receipt['blockHash'],sourceBlockNumber=str(height),logIndex=str(int(log['logIndex'],16)))
        expected=s.view(destination,s.data['contracts'][remote],
                        'burnIdFor(uint256,address,uint256,address,address,address,uint256,uint64)(bytes32)',
                        str(event['sourceChainId']),event['sourceToken'],str(dest_id),s.data['contracts'][remote],
                        event['sender'],event['recipient'],event['amount'],event['nonce'])
        if not same(expected,event['burnId']): raise ValueError('bridge event ID differs')
        tip=int(s.rpc(chain,'eth_blockNumber',[]),16)
        if tip<height+self.confirmations and self.demo_mine:
            s.rpc(chain,'anvil_mine',[hex(height+self.confirmations-tip)])
            tip=int(s.rpc(chain,'eth_blockNumber',[]),16)
        if tip<height+self.confirmations: raise ValueError('waiting for source confirmations')
        again=s.rpc(chain,'eth_getBlockByNumber',[hex(height),False])
        if not again or not same(again['hash'],event['sourceBlockHash']): raise ValueError('source changed during verification')
        return destination,remote,event

    def status(self, package):
        destination=package['destination']; token=package['domain']['verifyingContract']; c=package['message']
        claimed=self.session.view(destination,token,'claimedBurn(bytes32)(bool)',c['burnId'])=='true'
        block=self.session.rpc(destination,'eth_getBlockByNumber',['latest',False])
        return dict(package,state='claimed' if claimed else 'expired' if int(block['timestamp'],16)>int(c['deadline']) else 'ready')

    def attest(self, request):
        if not isinstance(request,dict) or set(request)-{'source','transactionHash','logIndex'}: raise ValueError('source locator only; claim amounts cannot be supplied')
        if not self.capacity.acquire(blocking=False): raise ValueError('signing capacity reached; retry later')
        try:
            with self.lock:
                destination,remote,message=self.source_event(request.get('source'),request.get('transactionHash'),request.get('logIndex'))
                key=hashlib.sha256((str(message['sourceChainId'])+message['sourceTxHash'].lower()+message['logIndex']).encode()).hexdigest()
                path=self.directory/(key+'.json')
                if path.exists():
                    saved=json.loads(path.read_text())
                    if any(str(saved['message'].get(k)).lower()!=str(v).lower() for k,v in message.items()):
                        raise ValueError('source differs from the issued attestation')
                    current=self.status(saved)
                    if current['state']!='expired': return current
                elif len(list(self.directory.glob('*.json')))>=10000:
                    raise ValueError('local package storage limit reached')
                token=self.session.data['contracts'][remote]
                block=self.session.rpc(destination,'eth_getBlockByNumber',['latest',False])
                message['deadline']=str(int(block['timestamp'],16)+3600)
                domain=dict(name='BNC Signed Bridge',version='1',chainId=self.session.data['chains'][destination]['id'],verifyingContract=token)
                types={'EIP712Domain':[dict(name=k,type=t) for k,t in [('name','string'),('version','string'),('chainId','uint256'),('verifyingContract','address')]],
                       'BridgeClaim':[dict(name=k,type=t) for k,t in FIELDS]}
                typed=dict(types=types,primaryType='BridgeClaim',domain=domain,message=message)
                # The signer is a public Anvil fixture held by the local node.
                # The HTTP RPC proxy never exposes signing or unlocked sending.
                signature=self.session.rpc('wl','eth_signTypedData_v4',[self.session.data['signer'],json.dumps(typed)])
                if not re.fullmatch(r'0x[0-9a-fA-F]{130}',signature): raise ValueError('invalid signer response')
                data=local.command(['cast','calldata','claim('+TUPLE+',bytes)',tuple_value(message),signature])
                digest=self.session.view(destination,token,'claimDigest('+TUPLE+')(bytes32)',tuple_value(message))
                # Independent onchain simulation checks the signer encoding and all claim conditions.
                self.session.rpc(destination,'eth_call',[dict(to=token,data=data),'latest'])
                self.source_event(request['source'],request['transactionHash'],int(message['logIndex']))
                package=dict(version=1,protocol=PROTOCOL,id=key,source=request['source'],destination=destination,
                             domain=domain,types={'BridgeClaim':types['BridgeClaim']},message=message,signature=signature,
                             signer=self.session.data['signer'],digest=digest,claimData=data,confirmations=self.confirmations,
                             sourceAuthenticated=False,verification='trusted-operator-signature')
                local.write_json(path,package)
                return self.status(package)
        finally: self.capacity.release()

    def packages(self):
        paths=sorted(self.directory.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:200]
        return [self.status(json.loads(p.read_text())) for p in paths]

class Server(ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=True
    def __init__(self,*args,**kwargs):
        self.slots=threading.BoundedSemaphore(16)
        super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.slots.acquire(False): self.shutdown_request(request); return
        try: super().process_request(request,address)
        except BaseException: self.slots.release(); raise
    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()

class Handler(SimpleHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT/'wallet'),**kwargs)
    def log_message(self,*args): pass
    def trusted(self,post=False):
        hosts={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
        origin=self.headers.get('Origin')
        return (self.headers.get('Host') in hosts and (not origin or origin in {'http://'+h for h in hosts})
                and (not post or self.headers.get('X-Bridge-Request')=='1'))
    def end_headers(self):
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        super().end_headers()
    def respond(self,status,value):
        body=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if not self.trusted(): return self.respond(403,dict(error='same-origin loopback request required'))
        path=urlsplit(self.path).path;service=self.server.service
        try:
            if path=='/api/manifest': return self.respond(200,dict(service.session.manifest(),confirmations=service.confirmations))
            if path=='/api/health': service.session.guard();return self.respond(200,dict(status='ok',protocol=PROTOCOL,risc0=False))
            if path=='/api/packages': return self.respond(200,dict(packages=service.packages()))
            if path.startswith('/api/packages/'):
                key=path.rsplit('/',1)[1]
                if not re.fullmatch(r'[0-9a-f]{64}',key): raise ValueError('invalid package ID')
                package=json.loads((service.directory/(key+'.json')).read_text())
                return self.respond(200,service.status(package))
            if path=='/api/events':
                query=parse_qs(urlsplit(self.path).query);chain=query.get('chain',['wl'])[0]
                _,name,_=service.route(chain)
                tip=int(service.session.rpc(chain,'eth_blockNumber',[]),16)
                start=max(0,int(query.get('from',['0'])[0]));end=min(tip,start+1999)
                logs=service.session.rpc(chain,'eth_getLogs',[dict(address=service.session.data['contracts'][name],fromBlock=hex(start),toBlock=hex(end))]) if start<=tip else []
                return self.respond(200,dict(chain=chain,logs=logs,nextBlock=end+1,latestBlock=tip))
            if path.startswith('/api/'): return self.respond(404,dict(error='unknown route'))
            if path in ('/','/index.html'): self.path='/signature.html'
            return super().do_GET()
        except FileNotFoundError: return self.respond(404,dict(error='package not found'))
        except Exception as error: return self.respond(409,dict(error=str(error)[:500]))
    def do_POST(self):
        if not self.trusted(True): return self.respond(403,dict(error='same-origin request header required'))
        try:
            path=urlsplit(self.path).path
            length=int(self.headers.get('Content-Length','0'))
            if self.headers.get('Transfer-Encoding') or not 0<length<=8192 or self.headers.get('Content-Type')!='application/json':
                raise ValueError('bounded JSON body required')
            body=json.loads(self.rfile.read(length))
            if path=='/api/attest': return self.respond(200,self.server.service.attest(body))
            if path in ('/rpc/wl','/rpc/bnb'):
                if (not isinstance(body,dict) or set(body)-{'jsonrpc','id','method','params'} or body.get('jsonrpc')!='2.0'
                    or body.get('method') not in http_config.RPC_METHODS or not isinstance(body.get('params',[]),list)):
                    raise ValueError('RPC method not allowed')
                if body['method']=='eth_sendRawTransaction' and (len(body.get('params',[]))!=1
                    or not isinstance(body['params'][0],str) or not re.fullmatch(r'0x[0-9a-fA-F]{2,16000}',body['params'][0])):
                    raise ValueError('browser-signed raw transaction required')
                value=self.server.service.session.rpc(path.rsplit('/',1)[1],body['method'],body.get('params',[]))
                return self.respond(200,dict(jsonrpc='2.0',id=body.get('id'),result=value))
            return self.respond(404,dict(error='unknown route'))
        except Exception as error: return self.respond(400,dict(error=str(error)[:500]))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['start','deploy','serve','stop','status'])
    parser.add_argument('--dir',type=Path,default=ROOT/'results/signed-xwl-v1')
    parser.add_argument('--port',type=int,default=8580)
    parser.add_argument('--confirmations',type=int,default=2)
    parser.add_argument('--demo-mine',action='store_true')
    args=parser.parse_args()
    if not 1024<=args.port<=65535 or not 1<=args.confirmations<=100: parser.error('local port/confirmation bounds')
    os.environ.setdefault('BNC_WL_PORT','8593');os.environ.setdefault('BNC_BNB_PORT','8594')
    session=Session(args.dir)
    with (session.root/('signature-service.lock' if args.operation=='serve' else 'client.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.operation=='start': session.start()
        elif args.operation=='deploy': session.setup()
        elif args.operation=='stop': session.stop()
        elif args.operation=='status': print(json.dumps(session.manifest(),indent=2))
        else:
            service=Service(session,args.confirmations,args.demo_mine)
            with Server(('127.0.0.1',args.port),Handler) as server:
                server.service=service
                def stop(signum,frame): raise KeyboardInterrupt
                signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
                print(f'http://127.0.0.1:{args.port}/signature.html',flush=True)
                try: server.serve_forever()
                except KeyboardInterrupt: pass

if __name__=='__main__':
    try: main()
    except (ValueError,RuntimeError,OSError) as error:
        print(str(error),file=__import__('sys').stderr);raise SystemExit(1)
