#!/usr/bin/env python3
"""Package the current local app, source and receipt host; exclude wallet/chain state."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('package_runtime',ROOT/'scripts/runtime-config.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--receipt-host',type=Path,default=runtime.receipt_host())
a=p.parse_args();a.output=a.output.resolve();a.output.parent.mkdir(parents=True,exist_ok=True)
if a.output.exists():p.error('output already exists')
if platform.system()!='Linux' or platform.machine()!='x86_64':p.error('release targets Linux x86_64')
skip={'target','out','cache','broadcast','__pycache__','.git','node_modules'}
with tempfile.TemporaryDirectory(prefix='bnc-release-') as tmp:
 dest=Path(tmp)/'bnc-wl';dest.mkdir()
 for directory in ['scripts','wallet','configs','proof-generator','contracts','risc0/receipt-computation','native-wl']:
  for src in (ROOT/directory).rglob('*'):
   rel=src.relative_to(ROOT)
   if not src.is_file() or src.is_symlink() or any(x in skip for x in rel.parts):continue
   target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,target)
 for name in ['README.md','AGENTS.md','.gitignore','docs/README.md','docs/local-demo-manual.md','docs/current-status-report.md','docs/implementation-details.md','docs/plan-gap-analysis.md','docs/bidirectional-burn-mint-direction-20261103.md','docs/burn-mint-checklist.md','docs/burn-mint-runtime.md','docs/native-wl-burn-mint-spec.md','results/burn-mint-development/v1-source-baseline.tar.gz','results/burn-mint-guarded-validation/summary.json','results/burn-mint-guarded-validation/browser-summary.json','results/burn-mint-guarded-validation/restart-browser-summary.json','results/receipt-computation-lock-proof/receipt.bin','results/receipt-computation-lock-proof/summary.json']:
  target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
 for src,name in [(ROOT/'.bin/bridge-proof','bridge-proof'),(a.receipt_host,'bridge-receipt-host'),(ROOT/'.bin/bridge-burn-mint-proof','bridge-burn-mint-proof'),(ROOT/'.bin/bridge-burn-mint-receipt-host','bridge-burn-mint-receipt-host')]:
  if not src.is_file():p.error('build required runtime binary: '+str(src))
  target=dest/'.bin'/name;target.parent.mkdir(exist_ok=True);shutil.copy2(src,target)
 hashes={str(f.relative_to(dest)):hashlib.sha256(f.read_bytes()).hexdigest() for f in dest.rglob('*') if f.is_file()}
 manifest={'mode':'risc0-computation','platform':'linux-x86_64','sdk':'3.0.5','sha256':hashes,'excluded':['user sessions','chain state','personal keys','retired experiments','build caches'],'externalRequirements':['Python 3.12','Foundry and solc 0.8.24','compatible r0vm']}
 (dest/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 with tarfile.open(a.output,'w:gz') as archive:archive.add(dest,arcname='bnc-wl')
 if a.output.stat().st_size>64*1024*1024:a.output.unlink();p.error('release exceeds 64 MiB')
print(json.dumps({'output':str(a.output),'bytes':a.output.stat().st_size,'sha256':hashlib.sha256(a.output.read_bytes()).hexdigest()}))
