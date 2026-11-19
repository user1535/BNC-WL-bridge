import importlib.util,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',Path(__file__).with_name('bridge-audit.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Session:
    def __init__(self,root):self.root=root;self.data={'operator':'operator','contracts':{'wl_headers':'old','bnb_headers':'old'}};self.values={};self.sent=[]
    def deploy(self,key,chain,*args):return chain
    def view(self,chain,address,signature,*args):
        if signature.startswith('auditLog'):raise ValueError('old registry')
        return self.values.get((chain,signature),'false' if signature.startswith('halted') else '0x'+'0'*64)
    def send(self,chain,sender,address,signature,*args):
        self.sent.append((chain,signature,args))
        if signature.startswith('commit'):self.values[chain,'lastDigest()(bytes32)']=args[0]
        if signature.startswith('confirmIncident'):self.values[chain,'halted()(bool)']='true'
with tempfile.TemporaryDirectory() as directory:
 s=Session(Path(directory));a=module.Audit(s);a.record('proof_job',dict(state='ready'));a.anchor();assert len(s.sent)==2
 a.validate();a.incident(dict(reason='verified test discrepancy'));assert a.halted()
 try:a.require_active();raise AssertionError('halt not enforced')
 except ValueError:pass
 b=module.Audit(s);assert b.halted();assert b.public()['halted'];b.enforce_stop()
 lines=a.path.read_text();a.path.write_text(lines.replace('proof_job','fake_job'))
 try:b.validate();raise AssertionError('tamper not detected')
 except ValueError:pass
print('audit chain commitment, tamper detection, incident stop and restart persistence PASS')

import subprocess
original_topic=subprocess.check_output
subprocess.check_output=lambda *args,**kwargs:'0xtopic'
try:
 with tempfile.TemporaryDirectory() as directory:
  s=Session(Path(directory));a=module.Audit(s)
  expected='0x'+'1'*64;root='0x'+'2'*64
  def rpc(chain,method,params):
   if method=='eth_blockNumber':return '0x9'
   if method=='eth_getLogs':return [dict(topics=['0xtopic','0x1','0x9'],data='0x'+expected[2:]+root[2:],transactionHash='0xregistration')]
   if method=='eth_getBlockByNumber':return dict(hash=expected,receiptsRoot=root)
  s.rpc=rpc;a.inspect();assert not a.halted()
  def mismatch(chain,method,params):
   if method=='eth_getBlockByNumber':return dict(hash='0x'+'3'*64,receiptsRoot=root)
   return rpc(chain,method,params)
  s.rpc=mismatch;a.inspect();assert a.halted()
 print('matching roots remain active; repeated registered-root mismatch triggers stop PASS')
finally:subprocess.check_output=original_topic
