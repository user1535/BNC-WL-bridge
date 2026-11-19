"""Portable runtime paths and host/cgroup resource ceilings."""
import math,os,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def binary(name,default):
 value=os.environ.get(name,str(default));found=shutil.which(value)
 if found:return Path(found).resolve()
 p=Path(value).expanduser();return (ROOT/p).resolve() if not p.is_absolute() else p

def cpus():
 available=len(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else os.cpu_count() or 1
 try:
  quota,period=Path('/sys/fs/cgroup/cpu.max').read_text().split()
  if quota!='max':available=min(available,max(1,math.floor(int(quota)/int(period))))
 except (OSError,ValueError):
  try:
   quota=int(Path('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').read_text())
   period=int(Path('/sys/fs/cgroup/cpu/cpu.cfs_period_us').read_text())
   if quota>0 and period>0:available=min(available,max(1,quota//period))
  except (OSError,ValueError):pass
 return max(1,min(12,available))

def memory_bytes():
 limit=os.sysconf('SC_PHYS_PAGES')*os.sysconf('SC_PAGE_SIZE')
 for file in ('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes'):
  try:
   value=Path(file).read_text().strip()
   if value!='max' and int(value)>0:limit=min(limit,int(value))
  except (OSError,ValueError):pass
 return limit

def available_memory_bytes():
 # Reserve against currently usable memory, including cgroup usage, before proving.
 limit=memory_bytes()
 try:
  available=next(int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
  limit=min(limit,available)
 except (OSError,StopIteration,ValueError):pass
 for maximum,current in (('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current'),('/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/memory/memory.usage_in_bytes')):
  try:
   value=Path(maximum).read_text().strip()
   if value!='max':limit=min(limit,max(0,int(value)-int(Path(current).read_text())))
  except (OSError,ValueError):pass
 return limit

def r0vm():
 candidates=[ROOT/'.bin/r0vm',Path.home()/'.risc0/bin/r0vm',Path.home()/'.cargo/bin/r0vm']
 return binary('RISC0_SERVER_PATH',shutil.which('r0vm') or next((p for p in candidates if p.is_file()),candidates[0]))

def port(name,default):
 value=int(os.environ.get(name,default))
 if not 1024<=value<=65535:raise ValueError(name+' must be1024..65535')
 return value

def receipt_host():
 candidates=[ROOT/'.bin/bridge-receipt-host',ROOT/'risc0/receipt-computation/target/release/bridge-receipt-host']
 return binary('BNC_RECEIPT_HOST',next((p for p in candidates if p.is_file()),candidates[0]))
