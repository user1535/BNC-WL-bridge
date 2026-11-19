// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../src/token/BridgeLockableToken.sol";
import {BridgeWrappedToken} from "../src/token/BridgeWrappedToken.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract BridgeTokensTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BOB = address(0xB0B);

    BridgeLockableToken private original;
    BridgeWrappedToken private wrapped;

    function setUp() public {
        vm.chainId(31337);
        original = new BridgeLockableToken("WorldLand local", "WL", 100 ether, 31338);
        wrapped = new BridgeWrappedToken("Wrapped WorldLand local", "wWL", 31338, address(original));
        original.bindUnlockReceiver(address(this));
        original.bindDestinationWrappedToken(address(wrapped));
        wrapped.bindMintReceiver(address(this));
    }

    function testLockPreventsTransferAndTransferFromUntilUnlock() public {
        bytes32 lockId = original.bridgeLock(60 ether, address(this), 31338);
        require(lockId != bytes32(0));
        require(original.balanceOf(address(this)) == 100 ether);
        require(original.lockedBalanceOf(address(this)) == 60 ether);
        require(original.availableBalanceOf(address(this)) == 40 ether);

        original.transfer(BOB, 40 ether);
        vm.expectRevert(BridgeLockableToken.LockedBalanceExceeded.selector);
        original.transfer(BOB, 1);

        original.approve(BOB, 1 ether);
        vm.expectRevert(BridgeLockableToken.LockedBalanceExceeded.selector);
        vm.prank(BOB);
        original.transferFrom(address(this), BOB, 1 ether);

        original.bridgeUnlock(bytes32(uint256(1)), address(this), 20 ether);
        require(original.lockedBalanceOf(address(this)) == 40 ether);
        original.transfer(BOB, 20 ether);
        require(original.balanceOf(address(this)) == 40 ether);
        require(original.availableBalanceOf(address(this)) == 0);
    }

    function testLockValidationAndUniqueIds() public {
        vm.expectRevert(BridgeLockableToken.InvalidAmount.selector);
        original.bridgeLock(0, address(this), 31338);
        vm.expectRevert(BridgeLockableToken.RecipientMustBeLocker.selector);
        original.bridgeLock(1, BOB, 31338);
        vm.expectRevert(BridgeLockableToken.InvalidChain.selector);
        original.bridgeLock(1, address(this), 56);
        bytes32 first = original.bridgeLock(1 ether, address(this), 31338);
        bytes32 second = original.bridgeLock(1 ether, address(this), 31338);
        require(first != second);
        require(original.bridgeNonce(address(this)) == 2);
    }

    function testUnlockAuthorizationAndReplay() public {
        original.bridgeLock(10 ether, address(this), 31338);
        bytes32 withdrawalId = bytes32(uint256(5));
        vm.prank(BOB);
        vm.expectRevert(BridgeLockableToken.Unauthorized.selector);
        original.bridgeUnlock(withdrawalId, address(this), 1 ether);
        original.bridgeUnlock(withdrawalId, address(this), 1 ether);
        vm.expectRevert(BridgeLockableToken.WithdrawalAlreadyUsed.selector);
        original.bridgeUnlock(withdrawalId, address(this), 1 ether);
        require(original.lockedBalanceOf(address(this)) == 9 ether);
    }

    function testMintBurnAndNoTransfer() public {
        vm.prank(BOB);
        vm.expectRevert(BridgeWrappedToken.Unauthorized.selector);
        wrapped.bridgeMint(address(this), 1 ether);
        wrapped.bridgeMint(address(this), 10 ether);
        require(wrapped.balanceOf(address(this)) == 10 ether);
        vm.expectRevert(BridgeWrappedToken.TransfersDisabled.selector);
        wrapped.approve(BOB, 1 ether);
        vm.expectRevert(BridgeWrappedToken.TransfersDisabled.selector);
        wrapped.transfer(BOB, 1 ether);
        vm.expectRevert(BridgeWrappedToken.RecipientMustBeBurner.selector);
        wrapped.bridgeBurn(1 ether, BOB, 31338);
        vm.expectRevert(BridgeWrappedToken.InvalidChain.selector);
        wrapped.bridgeBurn(1 ether, address(this), 56);
        bytes32 withdrawalId = wrapped.bridgeBurn(10 ether, address(this), 31338);
        require(withdrawalId != bytes32(0));
        require(wrapped.balanceOf(address(this)) == 0);
        require(wrapped.totalSupply() == 0);
    }

    function testLockRequiresDestinationTokenBinding() public {
        BridgeLockableToken unbound = new BridgeLockableToken("Unbound", "UB", 1 ether, 31338);
        vm.expectRevert(BridgeLockableToken.DestinationTokenNotBound.selector);
        unbound.bridgeLock(1 ether, address(this), 31338);
    }

    function testReceiverBindingIsOneTime() public {
        vm.expectRevert(BridgeLockableToken.ReceiverAlreadyBound.selector);
        original.bindUnlockReceiver(BOB);
        vm.expectRevert(BridgeLockableToken.DestinationTokenAlreadyBound.selector);
        original.bindDestinationWrappedToken(BOB);
        vm.expectRevert(BridgeWrappedToken.ReceiverAlreadyBound.selector);
        wrapped.bindMintReceiver(BOB);
    }
}
