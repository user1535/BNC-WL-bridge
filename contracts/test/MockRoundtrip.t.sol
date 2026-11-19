// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../src/token/BridgeLockableToken.sol";
import {BridgeWrappedToken} from "../src/token/BridgeWrappedToken.sol";
import {DevMockLockMintReceiver} from "../src/bridge/DevMockLockMintReceiver.sol";
import {DevMockBurnUnlockReceiver} from "../src/bridge/DevMockBurnUnlockReceiver.sol";

interface VmRoundtrip {
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract MockRoundtripTest {
    VmRoundtrip private constant vm = VmRoundtrip(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OTHER = address(0xB0B);

    function testDevMocksRejectLiveDestinationChains() public {
        vm.chainId(31337);
        BridgeLockableToken original = new BridgeLockableToken("WorldLand local", "WL", 100 ether, 31338);
        vm.chainId(31338);
        BridgeWrappedToken wrapped = new BridgeWrappedToken("Wrapped WorldLand local", "wWL", 31337, address(original));
        vm.chainId(56);
        vm.expectRevert(DevMockLockMintReceiver.InvalidClaim.selector);
        new DevMockLockMintReceiver(wrapped);
        vm.chainId(103);
        vm.expectRevert(DevMockBurnUnlockReceiver.InvalidClaim.selector);
        new DevMockBurnUnlockReceiver(original, 31338, address(wrapped));
    }

    function testSameOwnerRoundtripAndFrontRun() public {
        vm.chainId(31337);
        BridgeLockableToken original = new BridgeLockableToken("WorldLand local", "WL", 100 ether, 31338);

        vm.chainId(31338);
        BridgeWrappedToken wrapped = new BridgeWrappedToken("Wrapped WorldLand local", "wWL", 31337, address(original));
        DevMockLockMintReceiver mintReceiver = new DevMockLockMintReceiver(wrapped);
        wrapped.bindMintReceiver(address(mintReceiver));

        vm.chainId(31337);
        DevMockBurnUnlockReceiver unlockReceiver = new DevMockBurnUnlockReceiver(original, 31338, address(wrapped));
        original.bindUnlockReceiver(address(unlockReceiver));
        original.bindDestinationWrappedToken(address(wrapped));

        bytes32 lockId = original.bridgeLock(25 ether, address(this), 31338);
        require(original.lockedBalanceOf(address(this)) == 25 ether);
        require(original.balanceOf(address(this)) == 100 ether);

        vm.chainId(31338);
        mintReceiver.recordLock(lockId, address(this), 25 ether);
        vm.prank(OTHER);
        mintReceiver.claimLock(lockId);
        require(wrapped.balanceOf(address(this)) == 25 ether);
        require(wrapped.balanceOf(OTHER) == 0);
        vm.expectRevert(DevMockLockMintReceiver.AlreadyClaimed.selector);
        mintReceiver.claimLock(lockId);

        bytes32 withdrawalId = wrapped.bridgeBurn(25 ether, address(this), 31337);
        require(wrapped.totalSupply() == 0);

        vm.chainId(31337);
        unlockReceiver.recordBurn(withdrawalId, address(this), 25 ether);
        vm.prank(OTHER);
        unlockReceiver.claimBurn(withdrawalId);
        require(original.lockedBalanceOf(address(this)) == 0);
        require(original.balanceOf(address(this)) == 100 ether);
        require(original.availableBalanceOf(address(this)) == 100 ether);
        vm.expectRevert(DevMockBurnUnlockReceiver.AlreadyClaimed.selector);
        unlockReceiver.claimBurn(withdrawalId);
    }
}
