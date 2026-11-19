// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MPTReceiptProofCore} from "../src/bridge/MPTReceiptProofCore.sol";

interface VmReceiptFormats {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJson(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function expectRevert() external;
}

contract ReceiptCoreHarness {
    function verify(bytes32 root, uint256 txIndex, uint256 logIndex, bytes[] calldata nodes)
        external
        pure
        returns (MPTReceiptProofCore.VerifiedLog memory)
    {
        return MPTReceiptProofCore.verifyLog(root, txIndex, logIndex, nodes);
    }
}

contract ReceiptCoreFormatsTest {
    VmReceiptFormats private constant vm = VmReceiptFormats(address(uint160(uint256(keccak256("hevm cheat code")))));
    ReceiptCoreHarness private harness = new ReceiptCoreHarness();

    function _fixture(string memory name) private view returns (bytes32 root, uint256 index, bytes[] memory nodes) {
        string memory json = vm.readFile("test/fixtures/receipt-core.json");
        string memory prefix = string.concat(".", name);
        root = vm.parseJsonBytes32(json, string.concat(prefix, ".root"));
        index = vm.parseJsonUint(json, string.concat(prefix, ".logIndex"));
        nodes = abi.decode(vm.parseJson(json, string.concat(prefix, ".proofNodes")), (bytes[]));
    }

    function testSupportedLegacyAndTypedReceiptsUseLocalLogIndex() public view {
        string[5] memory names = ["legacy", "access-list", "dynamic-fee", "blob", "set-code"];
        for (uint256 i; i < names.length; ++i) {
            (bytes32 root, uint256 index, bytes[] memory nodes) = _fixture(names[i]);
            MPTReceiptProofCore.VerifiedLog memory result = harness.verify(root, 0, index, nodes);
            require(result.emitter == address(0x1234) && result.topics.length == 1, "wrong decoded log");
            require(result.topics[0] == bytes32(uint256(0xabcd)), "wrong topic");
            require(keccak256(result.data) == keccak256(hex"040506"), "selected global index instead of local index");
        }
    }

    function testCapturedNativeSetCodeReceiptMPTLog() public view {
        string[2] memory names = ["native-type4-index16.json", "native-type4-index107.json"];
        for (uint256 i; i < names.length; ++i) {
            string memory json = vm.readFile(string.concat("test/fixtures/", names[i]));
            bytes32 root = vm.parseJsonBytes32(json, ".root");
            uint256 txIndex = vm.parseJsonUint(json, ".txIndex");
            uint256 logIndex = vm.parseJsonUint(json, ".logIndex");
            bytes[] memory nodes = abi.decode(vm.parseJson(json, ".proofNodes"), (bytes[]));
            MPTReceiptProofCore.VerifiedLog memory result = harness.verify(root, txIndex, logIndex, nodes);
            require(result.emitter == vm.parseJsonAddress(json, ".emitter"), "native emitter differs");
            bytes32[] memory topics = abi.decode(vm.parseJson(json, ".topics"), (bytes32[]));
            require(keccak256(abi.encode(result.topics)) == keccak256(abi.encode(topics)), "native topics differ");
            require(keccak256(result.data) == keccak256(vm.parseJsonBytes(json, ".data")), "native data differs");
        }
    }

    function testUnsupportedTypesAndMalformedReceiptFieldsRejected() public {
        string[13] memory names = [
            "unsupported-type-0",
            "unsupported-type-5",
            "unsupported-type-127",
            "failed-status",
            "pre-byzantium-root",
            "gas-overflow",
            "noncanonical-gas-zero",
            "short-bloom",
            "extra-field",
            "log-out-of-range",
            "wrong-emitter-width",
            "wrong-topic-width",
            "data-is-list"
        ];
        for (uint256 i; i < names.length; ++i) {
            (bytes32 root, uint256 index, bytes[] memory nodes) = _fixture(names[i]);
            vm.expectRevert();
            harness.verify(root, 0, index, nodes);
        }
    }

    function testWrongRootTxIndexAndEmptyProofRejected() public {
        (bytes32 root, uint256 index, bytes[] memory nodes) = _fixture("dynamic-fee");
        vm.expectRevert();
        harness.verify(bytes32(uint256(root) ^ 1), 0, index, nodes);
        vm.expectRevert();
        harness.verify(root, 1, index, nodes);
        vm.expectRevert();
        harness.verify(root, 0, index, new bytes[](0));
    }
}
