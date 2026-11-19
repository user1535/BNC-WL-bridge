import {WalletClient} from './client.mjs';
import {Interface,toQuantity} from './vendor/ethers-6.15.0.min.mjs';
const abi=new Interface(['function transfer(address,uint256)','function approve(address,uint256)','function transferFrom(address,address,uint256)','function allowance(address,address) view returns(uint256)']);
const entryAbi=new Interface(['function enter(address) payable']);
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
export class BurnMintClient extends WalletClient {
  async tokenAction(method,amount,owner,recipient,chain=31338,from=owner) {
    requireValue(['transfer','approve','transferFrom'].includes(method),'unsupported token action');
    requireValue((method==='approve'&&amount==='0'||/^[1-9][0-9]*$/.test(amount))
      &&BigInt(amount)<2n**256n,'invalid uint256 amount');
    requireValue(/^0x[0-9a-fA-F]{40}$/.test(recipient)&&BigInt(recipient)!==0n,'recipient required');
    const wl=this.manifest.chains.wl.id, bnb=this.manifest.chains.bnb.id;
    requireValue([wl,bnb].includes(chain),'configured chain required');
    requireValue(!this.manifest.protocol.startsWith('native-wl-vault-')||chain===bnb,'WorldLand uses native WL transfers');
    const name=chain===wl?'original':'wrapped',epoch=this.epoch;
    await this.context(chain,owner,epoch);await this.identity(chain,[name]);
    if (this.manifest.readOnlyTestnet && method==='approve' && amount!=='0') {
      const allowance = await this.call(this.manifest.contracts[name],abi,'allowance',[owner,recipient]);
      requireValue(allowance===0n,'기존 사용 승인을 0으로 취소한 뒤 새 수량을 승인하세요.');
    }
    const args=method==='transferFrom'?[from,recipient,BigInt(amount)]:[recipient,BigInt(amount)];
    const transaction={from:owner,to:this.manifest.contracts[name],data:abi.encodeFunctionData(method,args),value:'0x0',chainId:toQuantity(chain)};
    await this.rpc('eth_call',[transaction,'latest']);
    transaction.gas=await this.rpc('eth_estimateGas',[transaction]);
    const [balance,price]=await Promise.all([this.rpc('eth_getBalance',[owner,'latest']),this.rpc('eth_gasPrice')]);
    requireValue(BigInt(balance)>=BigInt(price)*BigInt(transaction.gas),'insufficient gas');
    await this.context(chain,owner,epoch);
    return {tokenMethod:method,amount,owner,recipient,chain,from,epoch,transaction};
  }
  async submitTokenAction(preview,save) {
    requireValue(preview.epoch===this.epoch,'preview expired');
    const fresh=await this.tokenAction(preview.tokenMethod,preview.amount,preview.owner,preview.recipient,preview.chain,preview.from);
    return this.sendReviewed(preview,fresh,save);
  }
  async nativeAction(method,amount,owner,recipient) {
    const xwl=this.manifest.assetProfile==='xwl-entry-v1';
    requireValue(xwl&&['entry','nativeTransfer'].includes(method)
      || this.manifest.protocol.startsWith('native-wl-vault-')&&method==='nativeTransfer','unsupported native action');
    requireValue(/^[1-9][0-9]{0,77}$/.test(amount) && BigInt(amount)<2n**256n,'positive uint256 amount required');
    requireValue(/^0x[0-9a-fA-F]{40}$/.test(recipient) && BigInt(recipient)!==0n,'recipient required');
    const chain=this.manifest.chains.wl.id, epoch=this.epoch, entry=method==='entry';
    await this.context(chain,owner,epoch);
    if(entry)await this.identity(chain,['original']);
    const value=BigInt(amount);
    const transaction={from:owner,to:entry?this.manifest.contracts.original:recipient,
      data:entry?entryAbi.encodeFunctionData('enter',[recipient]):'0x',value:toQuantity(value),chainId:toQuantity(chain)};
    await this.rpc('eth_call',[transaction,'latest']);
    transaction.gas=await this.rpc('eth_estimateGas',[transaction]);
    const [balance,price]=await Promise.all([this.rpc('eth_getBalance',[owner,'latest']),this.rpc('eth_gasPrice')]);
    requireValue(BigInt(balance)>=value+BigInt(price)*BigInt(transaction.gas),'insufficient WL for amount and gas');
    await this.context(chain,owner,epoch);
    return {nativeMethod:method,amount,owner,recipient,chain,epoch,transaction};
  }
  async submitNativeAction(preview,save) {
    requireValue(preview.epoch===this.epoch,'preview expired');
    const fresh=await this.nativeAction(preview.nativeMethod,preview.amount,preview.owner,preview.recipient);
    return this.sendReviewed(preview,fresh,save);
  }
  async sendReviewed(preview,fresh,save) {
    requireValue(fresh.transaction.data===preview.transaction.data && fresh.transaction.to===preview.transaction.to
      && fresh.transaction.value===preview.transaction.value,'preview changed');
    const nonce=await this.rpc('eth_getTransactionCount',[fresh.owner,'pending']);
    await this.context(fresh.chain,fresh.owner,fresh.epoch);
    await save({...fresh,nonce,status:'awaiting_wallet'});
    const transactionHash=await this.rpc('eth_sendTransaction',[{...fresh.transaction,nonce}]);
    requireValue(/^0x[0-9a-fA-F]{64}$/.test(transactionHash),'invalid wallet hash');
    await save({...fresh,nonce,status:'submitted',transactionHash});return transactionHash;
  }
}
