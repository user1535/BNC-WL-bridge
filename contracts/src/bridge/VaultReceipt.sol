// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {MPTReceiptProofCore} from "./MPTReceiptProofCore.sol";

library VaultReceipt {
    bytes32 internal constant LOCK_TOPIC = keccak256("VaultLocked(bytes32,address,address,uint256,uint64,uint256)");
    bytes32 internal constant BURN_TOPIC = keccak256("VaultBurned(bytes32,address,address,uint256,uint64,uint256)");
    bytes32 private constant DOMAIN = keccak256("WORLDLAND_BNB_NATIVE_VAULT_V1");

    struct Proof {
        uint256 blockNumber;
        bytes32 blockHash;
        uint256 txIndex;
        uint256 logIndex;
        bytes[] proofNodes;
    }

    error InvalidEvent();

    function transferId(
        uint256 sourceChain, address source, uint256 destinationChain, address destination,
        address sender, address recipient, uint256 amount, uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, sourceChain, source, destinationChain, destination,
            sender, recipient, amount, nonce));
    }

    function verify(IHeaderSource headers, uint256 sourceChain, address source, bytes32 topic, Proof calldata proof)
        internal view returns (bytes32 id, address recipient, uint256 amount)
    {
        if (source == address(0)) revert InvalidEvent();
        bytes32 root = headers.getReceiptRoot(sourceChain, proof.blockNumber, proof.blockHash);
        MPTReceiptProofCore.VerifiedLog memory entry =
            MPTReceiptProofCore.verifyLog(root, proof.txIndex, proof.logIndex, proof.proofNodes);
        if (entry.emitter != source || entry.topics.length != 4 || entry.topics[0] != topic || entry.data.length != 96) {
            revert InvalidEvent();
        }
        address sender = _address(entry.topics[2]);
        recipient = _address(entry.topics[3]);
        uint64 nonce;
        uint256 destinationChain;
        (amount, nonce, destinationChain) = abi.decode(entry.data, (uint256, uint64, uint256));
        id = entry.topics[1];
        if (amount == 0 || nonce == 0 || destinationChain != block.chainid
            || id != transferId(sourceChain, source, block.chainid, address(this), sender, recipient, amount, nonce)) {
            revert InvalidEvent();
        }
    }

    function _address(bytes32 topic) private pure returns (address account) {
        account = address(uint160(uint256(topic)));
        if (uint256(topic) >> 160 != 0 || account == address(0)) revert InvalidEvent();
    }
}
