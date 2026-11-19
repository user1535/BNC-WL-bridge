#!/usr/bin/env python3
"""Bounded trusted-input computation; never authenticates HTTPS/RPC origin."""
import argparse,fcntl,hashlib,importlib.util,json,os,signal,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runtime',ROOT/'scripts/runtime-config.py');runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
p=argparse.ArgumentParser();p.add_argument('mode',choices=['execute','prove','verify']);p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
host=runtime.receipt_host()
if not host.is_file():raise SystemExit('build bridge-receipt-host first')
if args.input.stat().st_size>16*1024*1024:raise SystemExit('input exceeds cap')
args.output.mkdir(parents=True,exist_ok=True)
with (ROOT/'results/receipt-computation.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 env=os.environ.copy();env.pop('RISC0_DEV_MODE',None);env.pop('BONSAI_API_KEY',None);env.pop('BONSAI_API_URL',None)
 env.update(RAYON_NUM_THREADS=str(runtime.cpus()),RISC0_WORKERS=str(runtime.cpus()),RISC0_SERVER_PATH=str(runtime.r0vm()),OMP_NUM_THREADS=str(runtime.cpus()))
 def prepare():
  os.sched_setaffinity(0,set(sorted(os.sched_getaffinity(0))[:runtime.cpus()]))
  import resource
  resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024*1024,64*1024*1024))
 limit=int(runtime.available_memory_bytes()*.7)
 with (args.output/'run.log').open('w') as log:
  proc=subprocess.Popen([str(host),args.mode,str(args.input.resolve()),str(args.output.resolve())],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=prepare)
  def interrupted(signum,frame):
   try:os.killpg(proc.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:proc.wait(timeout=10)
   except subprocess.TimeoutExpired:
    os.killpg(proc.pid,signal.SIGKILL);proc.wait()
   raise SystemExit(128+signum)
  signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
  started=time.monotonic();failure=None;peak=0
  while proc.poll() is None:
   memory=0
   for directory in Path('/proc').iterdir():
    if not directory.name.isdigit():continue
    try:
     if os.getpgid(int(directory.name))==proc.pid:
      for line in (directory/'status').read_text().splitlines():
       if line.startswith('VmRSS:'):memory+=int(line.split()[1])*1024
    except (OSError,ProcessLookupError):pass
   peak=max(peak,memory)
   if memory>limit:failure='RAM70% cap exceeded'
   if time.monotonic()-started>1800:failure='1800s cap exceeded'
   if failure:os.killpg(proc.pid,signal.SIGTERM);break
   time.sleep(1)
  try:code=proc.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
 result=dict(mode=args.mode,exitCode=code,failure=failure,elapsedSeconds=time.monotonic()-started,peakRSS=peak,cpuCap=runtime.cpus(),memoryCap=limit,timeCap=1800,fileCap=64*1024*1024,inputSHA256=hashlib.sha256(args.input.read_bytes()).hexdigest(),hostSHA256=hashlib.sha256(host.read_bytes()).hexdigest())
 (args.output/'run-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(code if code else (1 if failure else 0))
