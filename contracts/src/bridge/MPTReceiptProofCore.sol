// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerklePatriciaProof} from "./lib/MerklePatriciaProof.sol";
import {RLPReader} from "./lib/RLPReader.sol";

library MPTReceiptProofCore {
    struct VerifiedLog {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    error InvalidReceiptProof();
    error InvalidReceipt();
    error InvalidLog();

    function verifyLog(bytes32 receiptRoot, uint256 txIndex, uint256 logIndex, bytes[] memory proofNodes)
        internal
        pure
        returns (VerifiedLog memory result)
    {
        (bytes memory receipt, bool valid) =
            MerklePatriciaProof.verify(receiptRoot, _rlpEncodeUint(txIndex), proofNodes);
        if (!valid || receipt.length == 0) revert InvalidReceiptProof();

        // EIP-2718 typed receipts have a one-byte type prefix before the RLP payload.
        if (uint8(receipt[0]) < 0x80) {
            // Explicit codecs support types1..3 plus EIP-7702 type4, which uses
            // the same status/cumulative gas/bloom/log consensus payload.
            if (uint8(receipt[0]) == 0 || uint8(receipt[0]) > 4) revert InvalidReceipt();
            bytes memory payload = new bytes(receipt.length - 1);
            for (uint256 i = 1; i < receipt.length; i++) {
                payload[i - 1] = receipt[i];
            }
            receipt = payload;
        }

        RLPReader.Item[] memory fields = RLPReader.listItems(receipt);
        if (fields.length != 4 || RLPReader.itemUint(receipt, fields[0]) != 1) revert InvalidReceipt();
        if (RLPReader.itemUint(receipt, fields[1]) > type(uint64).max) revert InvalidReceipt();
        if (RLPReader.itemBytes(receipt, fields[2]).length != 256) revert InvalidReceipt();

        RLPReader.Item[] memory logs = RLPReader.listItems(receipt, fields[3]);
        if (logIndex >= logs.length) revert InvalidLog();
        RLPReader.Item[] memory logFields = RLPReader.listItems(receipt, logs[logIndex]);
        if (logFields.length != 3) revert InvalidLog();

        result.emitter = RLPReader.itemAddress(receipt, logFields[0]);
        RLPReader.Item[] memory topics = RLPReader.listItems(receipt, logFields[1]);
        result.topics = new bytes32[](topics.length);
        for (uint256 i = 0; i < topics.length; i++) {
            result.topics[i] = RLPReader.itemBytes32(receipt, topics[i]);
        }
        result.data = RLPReader.itemBytes(receipt, logFields[2]);
    }

    function _rlpEncodeUint(uint256 value) private pure returns (bytes memory) {
        if (value == 0) return hex"80";
        uint256 temp = value;
        uint256 len;
        while (temp != 0) {
            len++;
            temp >>= 8;
        }
        bytes memory raw = new bytes(len);
        for (uint256 i = len; i > 0; i--) {
            raw[i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
        if (len == 1 && uint8(raw[0]) < 0x80) return raw;
        return bytes.concat(bytes1(uint8(0x80 + len)), raw);
    }
}

