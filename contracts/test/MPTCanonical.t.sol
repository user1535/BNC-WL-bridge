// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerklePatriciaProof} from "../src/bridge/lib/MerklePatriciaProof.sol";
import {RLPReader} from "../src/bridge/lib/RLPReader.sol";

interface VmMPT {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytesArray(string calldata json, string calldata key) external pure returns (bytes[] memory);
    function expectRevert() external;
}

contract MPTHarness {
    function verify(bytes32 root, bytes calldata key, bytes[] calldata proof) external pure returns (bytes memory, bool) {
        return MerklePatriciaProof.verify(root, key, proof);
    }
    function parse(bytes calldata data) external pure returns (uint256) {
        return RLPReader.listItems(data).length;
    }
    function integer(bytes calldata data) external pure returns (uint256) {
        (RLPReader.Item memory item,) = RLPReader.readItem(data, 0);
        return RLPReader.itemUint(data, item);
    }
}

contract MPTCanonicalTest {
    VmMPT private constant vm = VmMPT(address(uint160(uint256(keccak256("hevm cheat code")))));
    MPTHarness private harness = new MPTHarness();

    function _fixture(string memory name) private view returns (bytes32 root, bytes memory key, bytes memory value, bytes[] memory nodes) {
        string memory json = vm.readFile("test/fixtures/geth-mpt.json");
        string memory prefix = string.concat(".", name);
        root = vm.parseJsonBytes32(json, string.concat(prefix, ".root"));
        key = vm.parseJsonBytes(json, string.concat(prefix, ".key"));
        value = vm.parseJsonBytes(json, string.concat(prefix, ".value"));
        nodes = vm.parseJsonBytesArray(json, string.concat(prefix, ".proofNodes"));
    }

    function _compare(string memory name) private view {
        (bytes32 root, bytes memory key, bytes memory expected, bytes[] memory nodes) = _fixture(name);
        (bytes memory actual, bool valid) = harness.verify(root, key, nodes);
        require(valid && keccak256(actual) == keccak256(expected), "geth/Solidity mismatch");
        key[0] ^= 0x80;
        (,valid) = harness.verify(root, key, nodes);
        require(!valid, "wrong key accepted");
    }

    function testGethInlineBranchAndExtension() public view {
        _compare("inline-branch");
        _compare("inline-extension");
        _compare("branch-value");
    }

    function testGethHashedBranchAndExtension() public view {
        _compare("hashed-branch");
        _compare("hashed-extension");
    }

    function testTrailingAndEmptyProofsRejected() public view {
        (bytes32 root, bytes memory key,,bytes[] memory nodes) = _fixture("hashed-extension");
        bytes[] memory extra = new bytes[](nodes.length + 1);
        for (uint256 i; i < nodes.length; i++) extra[i] = nodes[i];
        extra[nodes.length] = hex"c0";
        (,bool valid) = harness.verify(root, key, extra);
        require(!valid);
        (,valid) = harness.verify(root, key, new bytes[](0));
        require(!valid);
    }

    function testNonCanonicalRLPRejected() public {
        vm.expectRevert(); harness.parse(hex"c28101"); // short string for a direct byte
        vm.expectRevert(); harness.parse(hex"f80180"); // long list for one byte
        vm.expectRevert(); harness.parse(hex"c3b80101"); // long string for one byte
        vm.expectRevert(); harness.parse(hex"f9000180"); // leading zero in length
        vm.expectRevert(); harness.integer(hex"820001"); // leading zero integer
    }

    function testEvenCompactPaddingMustBeZero() public {
        bytes[] memory nodes = new bytes[](1);
        nodes[0] = hex"c482211276"; // leaf compact 0x2112 uses nonzero even padding nibble
        bytes32 root = keccak256(nodes[0]);
        vm.expectRevert(); harness.verify(root, hex"12", nodes);
    }

    function _reject(bytes32 root, bytes memory key, bytes[] memory nodes) private view {
        (bool success, bytes memory result) = address(harness).staticcall(abi.encodeCall(MPTHarness.verify, (root, key, nodes)));
        if (success) {
            (,bool valid) = abi.decode(result, (bytes, bool));
            require(!valid, "corrupt inclusion proof accepted");
        }
    }

    function _differentialName(uint256 index) private pure returns (string memory) {
        bytes memory digits = new bytes(3);
        digits[0] = bytes1(uint8(48 + index / 100));
        digits[1] = bytes1(uint8(48 + index / 10 % 10));
        digits[2] = bytes1(uint8(48 + index % 10));
        return string.concat("differential-", string(digits));
    }

    function testGethDifferential128CanonicalProofs() public view {
        // Give each JSON witness its own EVM memory frame. Repeated decoding
        // of the fixture file in one frame otherwise accumulates test memory.
        for (uint256 i; i < 128; i++) this.compareGethFixture(_differentialName(i));
    }

    function compareGethFixture(string calldata name) external view {
        _compare(name);
    }

    function testGethNonMembershipIsNotInclusion() public view {
        string[6] memory names = ["missing-branch-value", "missing-branch-slot", "missing-leaf", "missing-extension", "missing-short-key", "missing-long-key"];
        for (uint256 i; i < names.length; i++) {
            (bytes32 root, bytes memory key, bytes memory expected, bytes[] memory nodes) = _fixture(names[i]);
            require(expected.length == 0, "geth nonmembership fixture differs");
            _reject(root, key, nodes);
        }
    }

    function testFuzzGethDifferentialMutation(uint8 fixtureSeed, uint16 nodeSeed, uint16 byteSeed, uint8 maskSeed) public view {
        (bytes32 root, bytes memory key, bytes memory expected, bytes[] memory nodes) = _fixture(_differentialName(uint256(fixtureSeed) % 128));
        (bytes memory actual, bool valid) = harness.verify(root, key, nodes);
        require(valid && keccak256(actual) == keccak256(expected), "geth/Solidity original mismatch");
        uint256 node = uint256(nodeSeed) % nodes.length;
        uint256 offset = uint256(byteSeed) % nodes[node].length;
        nodes[node][offset] ^= bytes1(maskSeed == 0 ? uint8(1) : maskSeed);
        _reject(root, key, nodes);
    }
}
