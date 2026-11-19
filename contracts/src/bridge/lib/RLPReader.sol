// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library RLPReader {
    error InvalidRLP();

    struct Item {
        // offset/length point to the payload, excluding the RLP prefix byte(s).
        uint256 offset;
        uint256 length;
        bool isList;
        uint256 encodedOffset;
        uint256 encodedLength;
    }

    function readItem(bytes memory data, uint256 offset) internal pure returns (Item memory item, uint256 nextOffset) {
        if (offset >= data.length) revert InvalidRLP();

        uint8 prefix = uint8(data[offset]);
        uint256 payloadOffset;
        uint256 payloadLength;
        bool isList;

        if (prefix < 0x80) {
            payloadOffset = offset;
            payloadLength = 1;
        } else if (prefix <= 0xb7) {
            payloadOffset = offset + 1;
            payloadLength = prefix - 0x80;
        } else if (prefix <= 0xbf) {
            uint256 lengthOfLength = prefix - 0xb7;
            payloadOffset = offset + 1 + lengthOfLength;
            payloadLength = _readLength(data, offset + 1, lengthOfLength);
        } else if (prefix <= 0xf7) {
            payloadOffset = offset + 1;
            payloadLength = prefix - 0xc0;
            isList = true;
        } else {
            uint256 lengthOfLength = prefix - 0xf7;
            payloadOffset = offset + 1 + lengthOfLength;
            payloadLength = _readLength(data, offset + 1, lengthOfLength);
            isList = true;
        }

        if (payloadOffset + payloadLength > data.length) revert InvalidRLP();
        if (prefix >= 0x81 && prefix <= 0xb7 && payloadLength == 1 && uint8(data[payloadOffset]) < 0x80) revert InvalidRLP();
        if ((prefix > 0xb7 && prefix <= 0xbf || prefix > 0xf7) && payloadLength < 56) revert InvalidRLP();
        item = Item({offset: payloadOffset, length: payloadLength, isList: isList, encodedOffset: offset, encodedLength: payloadOffset + payloadLength - offset});
        nextOffset = payloadOffset + payloadLength;
    }

    function listItems(bytes memory data) internal pure returns (Item[] memory out) {
        (Item memory root, uint256 nextOffset) = readItem(data, 0);
        if (!root.isList || nextOffset != data.length) revert InvalidRLP();
        return listItems(data, root);
    }

    function listItems(bytes memory data, Item memory root) internal pure returns (Item[] memory out) {
        if (!root.isList) revert InvalidRLP();

        uint256 count;
        uint256 cursor = root.offset;
        uint256 end = root.offset + root.length;
        while (cursor < end) {
            (, cursor) = readItem(data, cursor);
            count++;
        }
        if (cursor != end) revert InvalidRLP();

        out = new Item[](count);
        cursor = root.offset;
        for (uint256 i = 0; i < count; i++) {
            (out[i], cursor) = readItem(data, cursor);
        }
    }

    function itemBytes(bytes memory data, Item memory item) internal pure returns (bytes memory out) {
        if (item.isList) revert InvalidRLP();
        out = new bytes(item.length);
        for (uint256 i = 0; i < item.length; i++) {
            out[i] = data[item.offset + i];
        }
    }

    function itemEncoded(bytes memory data, Item memory item) internal pure returns (bytes memory out) {
        out = new bytes(item.encodedLength);
        for (uint256 i = 0; i < out.length; i++) out[i] = data[item.encodedOffset + i];
    }

    function itemBytes32(bytes memory data, Item memory item) internal pure returns (bytes32 out) {
        bytes memory raw = itemBytes(data, item);
        if (raw.length != 32) revert InvalidRLP();
        assembly {
            out := mload(add(raw, 32))
        }
    }

    function itemAddress(bytes memory data, Item memory item) internal pure returns (address out) {
        bytes memory raw = itemBytes(data, item);
        if (raw.length != 20) revert InvalidRLP();
        uint160 value;
        for (uint256 i = 0; i < 20; i++) {
            value = (value << 8) | uint8(raw[i]);
        }
        out = address(value);
    }

    function itemUint(bytes memory data, Item memory item) internal pure returns (uint256 out) {
        bytes memory raw = itemBytes(data, item);
        if (raw.length > 32 || raw.length > 0 && raw[0] == 0x00) revert InvalidRLP();
        for (uint256 i = 0; i < raw.length; i++) {
            out = (out << 8) | uint8(raw[i]);
        }
    }

    function _readLength(bytes memory data, uint256 offset, uint256 lengthOfLength) private pure returns (uint256 out) {
        if (lengthOfLength == 0 || lengthOfLength > 8 || offset + lengthOfLength > data.length) revert InvalidRLP();
        if (data[offset] == 0x00) revert InvalidRLP();
        for (uint256 i = 0; i < lengthOfLength; i++) {
            out = (out << 8) | uint8(data[offset + i]);
        }
    }
}
