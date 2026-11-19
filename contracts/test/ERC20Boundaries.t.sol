// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MinimalERC20} from "../src/token/MinimalERC20.sol";
import {BridgeLockableToken} from "../src/token/BridgeLockableToken.sol";

interface BoundaryVm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract ERC20Harness is MinimalERC20 {
    constructor() MinimalERC20("Test", "T") {
        _mint(msg.sender, 100);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract ERC20BoundariesTest {
    BoundaryVm constant vm = BoundaryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant BOB = address(0xb0b);
    address constant SPENDER = address(0xcafe);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function testFiniteAndInfiniteAllowanceAndEvents() public {
        ERC20Harness token = new ERC20Harness();
        vm.expectEmit(true, true, false, true);
        emit Approval(address(this), SPENDER, 40);
        token.approve(SPENDER, 40);
        vm.prank(SPENDER);
        token.transferFrom(address(this), BOB, 30);
        require(token.allowance(address(this), SPENDER) == 10);
        token.approve(SPENDER, type(uint256).max);
        vm.prank(SPENDER);
        token.transferFrom(address(this), BOB, 10);
        require(token.allowance(address(this), SPENDER) == type(uint256).max);
        require(token.balanceOf(address(this)) == 60 && token.balanceOf(BOB) == 40 && token.totalSupply() == 100);
    }

    function testRevertedTransferFromRollsBackAllowance() public {
        ERC20Harness token = new ERC20Harness();
        token.approve(SPENDER, 101);
        vm.expectRevert(MinimalERC20.InsufficientBalance.selector);
        vm.prank(SPENDER);
        token.transferFrom(address(this), BOB, 101);
        require(token.allowance(address(this), SPENDER) == 101);
        require(token.balanceOf(address(this)) == 100 && token.balanceOf(BOB) == 0);
    }

    function testZeroAndSelfTransfersPreserveSupplyAndEmit() public {
        ERC20Harness token = new ERC20Harness();
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(this), BOB, 0);
        token.transfer(BOB, 0);
        token.transfer(address(this), 100);
        vm.prank(SPENDER);
        token.transferFrom(address(this), BOB, 0);
        require(token.balanceOf(address(this)) == 100 && token.totalSupply() == 100);
        vm.expectRevert(MinimalERC20.ZeroAddress.selector);
        token.transfer(address(0), 0);
        vm.expectRevert(MinimalERC20.ZeroAddress.selector);
        token.approve(address(0), 0);
    }

    function testMintBurnBoundaries() public {
        ERC20Harness token = new ERC20Harness();
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), BOB, 7);
        token.mint(BOB, 7);
        vm.expectEmit(true, true, false, true);
        emit Transfer(BOB, address(0), 7);
        token.burn(BOB, 7);
        require(token.totalSupply() == 100 && token.balanceOf(BOB) == 0);
        vm.expectRevert(MinimalERC20.InsufficientBalance.selector);
        token.burn(BOB, 1);
        vm.expectRevert(MinimalERC20.ZeroAddress.selector);
        token.mint(address(0), 1);
    }

    function testLockedTransferFromRollbackAndSelfRestriction() public {
        BridgeLockableToken token = new BridgeLockableToken("Local", "L", 100, 31338);
        token.bindDestinationWrappedToken(BOB);
        token.bridgeLock(60, address(this), 31338);
        token.approve(SPENDER, 100);
        vm.expectRevert(BridgeLockableToken.LockedBalanceExceeded.selector);
        vm.prank(SPENDER);
        token.transferFrom(address(this), BOB, 41);
        require(token.allowance(address(this), SPENDER) == 100 && token.lockedBalanceOf(address(this)) == 60);
        vm.expectRevert(BridgeLockableToken.LockedBalanceExceeded.selector);
        token.transfer(address(this), 100);
        token.transfer(address(this), 40);
        require(token.balanceOf(address(this)) == 100 && token.availableBalanceOf(address(this)) == 40);
    }

    function testFuzzLockTransferConservation(uint8 lockSeed, uint8 transferSeed) public {
        uint256 locked = 1 + uint256(lockSeed) % 100;
        uint256 moved = uint256(transferSeed) % (101 - locked);
        BridgeLockableToken token = new BridgeLockableToken("Local", "L", 100, 31338);
        token.bindDestinationWrappedToken(BOB);
        token.bridgeLock(locked, address(this), 31338);
        token.transfer(BOB, moved);
        require(token.lockedBalanceOf(address(this)) == locked);
        require(token.balanceOf(address(this)) + token.balanceOf(BOB) == token.totalSupply());
        require(
            token.balanceOf(address(this)) >= locked && token.availableBalanceOf(address(this)) == 100 - locked - moved
        );
    }
}
