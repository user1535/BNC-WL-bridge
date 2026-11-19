// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RLPReader.sol";

library MerklePatriciaProof {
    using RLPReader for bytes;

    error InvalidProof();

    function verify(bytes32 root, bytes memory path, bytes[] memory proof)
        internal
        pure
        returns (bytes memory value, bool ok)
    {
        bytes memory nibbles = _bytesToNibbles(path);
        bytes32 expectedHash = root;
        // MPT child references shorter than 32 bytes are embedded RLP nodes, not hashes.
        bytes memory expectedInline;
        uint256 pathOffset;
        uint256 proofOffset;

        while (true) {
            bytes memory node;
            if (expectedInline.length != 0) {
                node = expectedInline;
                delete expectedInline;
            } else {
                if (proofOffset == proof.length) return ("", false);
                node = proof[proofOffset++];
                if (keccak256(node) != expectedHash) return ("", false);
            }

            RLPReader.Item[] memory nodeItems = node.listItems();
            if (nodeItems.length == 17) {
                // Branch node: 16 child slots plus optional value in slot 16.
                if (pathOffset == nibbles.length) {
                    if (proofOffset != proof.length) return ("", false);
                    // An empty branch value proves absence, not receipt inclusion.
                    value = RLPReader.itemBytes(node, nodeItems[16]);
                    return (value, value.length != 0);
                }

                uint8 nibble = uint8(nibbles[pathOffset]);
                if (nibble > 15) revert InvalidProof();
                if (nodeItems[nibble].length == 0) return ("", false);
                (expectedHash, expectedInline) = _decodeNodeRef(node, nodeItems[nibble]);
                pathOffset++;
            } else if (nodeItems.length == 2) {
                // Short node: extension or leaf, distinguished by hex-prefix compact encoding.
                (bytes memory partialPath, bool isLeaf) = _decodeCompact(RLPReader.itemBytes(node, nodeItems[0]));
                if (!_matches(nibbles, pathOffset, partialPath)) return ("", false);
                pathOffset += partialPath.length;

                if (isLeaf) {
                    if (pathOffset != nibbles.length || proofOffset != proof.length) return ("", false);
                    value = RLPReader.itemBytes(node, nodeItems[1]);
                    return (value, value.length != 0);
                }

                if (partialPath.length == 0 || nodeItems[1].length == 0) revert InvalidProof();
                (expectedHash, expectedInline) = _decodeNodeRef(node, nodeItems[1]);
            } else {
                revert InvalidProof();
            }
        }

    }

    function _decodeNodeRef(bytes memory node, RLPReader.Item memory item) private pure returns (bytes32 nodeHash, bytes memory inlineNode) {
        if (item.isList) {
            inlineNode = RLPReader.itemEncoded(node, item);
            if (inlineNode.length >= 32) revert InvalidProof();
        } else {
            bytes memory nodeRef = RLPReader.itemBytes(node, item);
            if (nodeRef.length != 32) revert InvalidProof();
            assembly {
                nodeHash := mload(add(nodeRef, 32))
            }
        }
    }

    function _bytesToNibbles(bytes memory input) private pure returns (bytes memory out) {
        out = new bytes(input.length * 2);
        for (uint256 i = 0; i < input.length; i++) {
            out[i * 2] = bytes1(uint8(input[i]) >> 4);
            out[i * 2 + 1] = bytes1(uint8(input[i]) & 0x0f);
        }
    }

    function _decodeCompact(bytes memory compact) private pure returns (bytes memory partialPath, bool isLeaf) {
        // Hex-prefix compact encoding stores leaf/extension and odd/even path flags in the first nibble.
        if (compact.length == 0) revert InvalidProof();
        bytes memory expanded = _bytesToNibbles(compact);
        uint8 flags = uint8(expanded[0]);
        if (flags > 3) revert InvalidProof();

        isLeaf = flags >= 2;
        bool oddLength = flags % 2 == 1;
        if (!oddLength && expanded[1] != 0x00) revert InvalidProof();
        uint256 start = oddLength ? 1 : 2;
        partialPath = new bytes(expanded.length - start);
        for (uint256 i = 0; i < partialPath.length; i++) {
            partialPath[i] = expanded[start + i];
        }
    }

    function _matches(bytes memory full, uint256 offset, bytes memory partialPath) private pure returns (bool) {
        if (offset + partialPath.length > full.length) return false;
        for (uint256 i = 0; i < partialPath.length; i++) {
            if (full[offset + i] != partialPath[i]) return false;
        }
        return true;
    }
}
