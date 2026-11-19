"""Explicit external origin; no trust in proxy-supplied forwarding headers."""
import re
from urllib.parse import urlsplit
RPC_METHODS=frozenset(('eth_chainId','net_version','eth_blockNumber','eth_getBalance','eth_getCode','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_call','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBlockByNumber','eth_getLogs','eth_sendRawTransaction'))
def origin(value):
 u=urlsplit(value)
 if (u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment
     or not re.fullmatch(r'[a-zA-Z0-9.-]+',u.hostname)):
  raise ValueError('public origin must be an exact http(s) origin without credentials/path')
 if u.scheme!='https' and u.hostname not in ('localhost','127.0.0.1'):
  raise ValueError('public origin requires HTTPS')
 if u.port is not None and not 1<=u.port<=65535:raise ValueError('invalid origin port')
 return value

def wallet_manifest(session,public_origin,make_manifest):
 result=make_manifest(session)
 if public_origin:
  result['publicOrigin']=origin(public_origin)
  for name in ('wl','bnb'):result['chains'][name]['rpc']=public_origin+'/rpc/'+name
 return result
