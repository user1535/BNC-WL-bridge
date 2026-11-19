"""Public JSON audit journal with commitments in independent local chains.
An anchor detects later edits; it does not prove that the original record was true.
"""
import hashlib,json,time,threading
class Audit:
    def __init__(self,session):
        self.session=session;self.root=session.root;self.lock=threading.RLock()
        self.path=self.root/'audit-journal.jsonl';self.stop_path=self.root/'audit-stop.json'
        self.pending=self.root/'audit-anchor-pending.json'
        self.path.touch(exist_ok=True)
        self.addresses={}
        for chain in ('wl','bnb'):
            key=chain+'_audit'
            self.addresses[chain]=session.deploy(key,chain,'src/bridge/BridgeAuditLog.sol:BridgeAuditLog')
        self.validate()
        digests={'0x'+'0'*64}|{'0x'+json.loads(line)['digest'] for line in self.path.read_text().splitlines()}
        for chain,address in self.addresses.items():
            anchor=session.view(chain,address,'lastDigest()(bytes32)').lower()
            if anchor not in digests:raise ValueError('public audit anchor missing from local journal; refuse overwritten/truncated history')
    def validate(self):
        previous='0'*64
        for line in self.path.read_text().splitlines():
            item=json.loads(line);digest=item.pop('digest')
            if item['previous']!=previous or hashlib.sha256(json.dumps(item,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=digest:
                raise ValueError('audit journal integrity mismatch')
            previous=digest
        self.last=previous
    def record(self,kind,data):
        with self.lock:
            item=dict(sequence=sum(1 for _ in self.path.open())+1,time=time.time(),kind=kind,data=data,previous=self.last)
            digest=hashlib.sha256(json.dumps(item,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            item['digest']=digest
            encoded=json.dumps(item,ensure_ascii=False)+'\n'
            if self.path.stat().st_size+len(encoded.encode())>64*1024*1024:raise ValueError('audit journal 64MiB capacity reached; archive before continuing')
            with self.path.open('a') as f:f.write(encoded);f.flush();__import__('os').fsync(f.fileno())
            self.last=digest
            self.pending.write_text(json.dumps(dict(digest=digest)))
            return item
    def anchor(self):
        with self.lock:
            if not self.pending.exists():return
            digest=json.loads(self.pending.read_text())['digest']
            for chain,address in self.addresses.items():
                if self.session.view(chain,address,'lastDigest()(bytes32)').lower()!='0x'+digest:
                    self.session.send(chain,self.session.data['operator'],address,'commit(bytes32)','0x'+digest)
            self.pending.unlink()
    def halted(self):return self.stop_path.exists()
    def incident(self,evidence):
        with self.lock:
            if self.halted():return
            item=self.record('confirmed_incident',evidence)
            # Persist stop before RPC calls; network failures never undo the stop.
            self.stop_path.write_text(json.dumps(item,ensure_ascii=False))
            self.enforce_stop()
    def enforce_stop(self):
        if not self.halted():return
        digest=json.loads(self.stop_path.read_text())['digest']
        for chain,address in self.addresses.items():
            if self.session.view(chain,address,'halted()(bool)')!='true':
                self.session.send(chain,self.session.data['operator'],address,'confirmIncident(bytes32)','0x'+digest)
            registry=self.session.data['contracts'][chain+'_headers']
            try:self.session.view(chain,registry,'auditLog()(address)')
            except Exception:continue # Existing immutable registries lack the new guard.
            self.session.send(chain,self.session.data['operator'],registry,'confirmIncident(bytes32)','0x'+digest)
    def require_active(self):
        if self.halted():raise ValueError('감사 이상 확인으로 신규 증명·패키지 제공이 긴급 정지됐습니다')
    def inspect(self):
        # Only authenticated registry records are compared, never arbitrary requests.
        for source,destination in [('wl','bnb'),('bnb','wl')]:
            registry=self.session.data['contracts'][destination+'_headers']
            tip=int(self.session.rpc(destination,'eth_blockNumber',[]),16)
            from subprocess import check_output
            topic=check_output(['cast','keccak','HeaderRegistered(uint256,uint256,bytes32,bytes32)'],text=True).strip()
            for start in range(0,tip+1,2000):
                logs=self.session.rpc(destination,'eth_getLogs',[dict(address=registry,fromBlock=hex(start),toBlock=hex(min(tip,start+1999)),topics=[topic])])
                for log in logs:
                    if log.get('removed'):continue
                    number=int(log['topics'][2],16);raw=log['data'][2:];expected_hash='0x'+raw[:64];expected_root='0x'+raw[64:128]
                    block=self.session.rpc(source,'eth_getBlockByNumber',[hex(number),False])
                    if block and (block['hash'].lower()!=expected_hash.lower() or block['receiptsRoot'].lower()!=expected_root.lower()):
                        # Read again; a transient RPC error is not proof of an incident.
                        again=self.session.rpc(source,'eth_getBlockByNumber',[hex(number),False])
                        if again and again['hash']==block['hash'] and again['receiptsRoot']==block['receiptsRoot']:
                            self.incident(dict(source=source,destination=destination,block=number,registrationTransaction=log['transactionHash'],registeredHash=expected_hash,registeredRoot=expected_root,observedHash=block['hash'],observedRoot=block['receiptsRoot'],reason='registered source block/root differs from repeated trusted RPC reads'));return
    def public(self,after=0,limit=100):
        with self.lock:
            records=[json.loads(x) for x in self.path.read_text().splitlines()]
            entries=[x for x in records if x['sequence']>after][:limit]
            anchors={}
            for chain,address in self.addresses.items():
                try:anchors[chain]=dict(address=address,digest=self.session.view(chain,address,'lastDigest()(bytes32)'),halted=self.session.view(chain,address,'halted()(bool)')=='true')
                except Exception:anchors[chain]=dict(address=address,error='audit RPC unavailable')
            enforced=True
            for chain in ('wl','bnb'):
                try:self.session.view(chain,self.session.data['contracts'][chain+'_headers'],'auditLog()(address)')
                except Exception:enforced=False
            return dict(records=entries,nextAfter=entries[-1]['sequence'] if entries else after,total=len(records),digest='0x'+self.last,halted=self.halted(),onchainClaimStopSupported=enforced,anchors=anchors,anchorPending=self.pending.exists())
