#!/usr/bin/env python3
"""Regression gates for the current trusted-server receipt-computation bridge."""
import argparse
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--node',default='node')
p.add_argument('--skip-sdk',action='store_true',help='CI without a compiled host: run source tests only')
a=p.parse_args()
commands=[['go','-C','proof-generator','test','-race','./...'],['go','-C','proof-generator','vet','./...'],['forge','test','--root','contracts'],['cargo','test','--locked','--manifest-path','risc0/receipt-computation/Cargo.toml','-p','bridge-receipt-core'],[a.node,'--test','wallet/client.test.mjs','wallet/burn-mint.test.mjs'],['python3','-m','unittest','discover','-s','native-wl','-v']]
commands += [['python3','scripts/check-runtime-resources.py']]
if not a.skip_sdk:commands += [['python3','scripts/check-receipt-computation.py'],['python3','scripts/check-burn-mint-computation.py'],['python3','scripts/check-bridge-audit.py']]
for command in commands:
 print('Running: '+' '.join(command),flush=True)
 subprocess.run(command,cwd=ROOT,check=True)
print('Current source and selected SDK gates PASS')
