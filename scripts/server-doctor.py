#!/usr/bin/env python3
"""Read-only local preflight. No deployment, signing or proof generation."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('doctor_runtime',ROOT/'scripts/runtime-config.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--mode',choices=['risc0-computation'],default='risc0-computation')
 parser.parse_args()
 checks={tool:shutil.which(tool) is not None for tool in ('anvil','forge','cast')}
 checks['receiptGenerator']=r.binary('BNC_PROOF_BIN',ROOT/'.bin/bridge-proof').is_file() or shutil.which('go') is not None
 host=r.receipt_host();checks['receiptComputationHost']=host.is_file();checks['r0vm']=r.r0vm().is_file()
 checks['pinnedGuestReceiptVerified']=False
 if host.is_file():
  try:
   with tempfile.TemporaryDirectory(prefix='bnc-receipt-preflight-') as directory:
    env=os.environ.copy();env.pop('RISC0_DEV_MODE',None)
    shutil.copy2(ROOT/'results/receipt-computation-lock-proof/receipt.bin',Path(directory)/'receipt.bin')
    result=subprocess.run([str(host),'verify',str(ROOT/'risc0/receipt-computation/core/fixture.json'),directory],capture_output=True,timeout=30,env=env)
    summary=json.loads((Path(directory)/'summary.json').read_text()) if result.returncode==0 else {}
    checks['pinnedGuestReceiptVerified']=summary.get('sdkVerified') is True and summary.get('imageId')==json.loads((ROOT/'configs/receipt-computation.json').read_text())['imageId']
  except (OSError,ValueError,subprocess.SubprocessError):pass
 result=dict(passed=all(checks.values()),checks=checks,projectRoot=str(ROOT),receiptHost=str(host),effectiveProofCpuLimit=r.cpus(),effectiveMemoryLimitBytes=int(r.available_memory_bytes()*.7),timeoutSeconds=1800,fileCapBytes=64*1024*1024)
 print(json.dumps(result,indent=2));raise SystemExit(0 if result['passed'] else 1)
if __name__=='__main__':main()
