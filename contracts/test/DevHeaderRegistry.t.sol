// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DevHeaderRegistry} from "../src/bridge/DevHeaderRegistry.sol";

interface VmHeader {
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes4 selector) external;
}

contract DevHeaderRegistryTest {
    VmHeader private constant vm = VmHeader(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testRejectsLiveDestinationChain() public {
        vm.chainId(56);
        vm.expectRevert(DevHeaderRegistry.InvalidHeader.selector);
        new DevHeaderRegistry(103);
    }

    function testBatchCoverageAndConflictingHash() public {
        vm.chainId(31338);
        DevHeaderRegistry registry = new DevHeaderRegistry(31337);
        bytes32[] memory hashes = new bytes32[](3);
        bytes32[] memory roots = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            hashes[i] = bytes32(i + 1);
            roots[i] = bytes32(i + 11);
        }
        registry.registerHeaderBatch(100, hashes, roots);
        for (uint256 i = 0; i < 3; i++) {
            require(registry.isBlockCovered(31337, 100 + i, hashes[i]));
            require(registry.getReceiptRoot(31337, 100 + i, hashes[i]) == roots[i]);
        }
        require(!registry.isBlockCovered(31337, 101, bytes32(uint256(99))));
        require(!registry.isBlockCovered(31338, 101, hashes[1]));
        vm.expectRevert(DevHeaderRegistry.HeaderConflict.selector);
        registry.registerHeader(101, bytes32(uint256(99)), roots[1]);
    }
}
