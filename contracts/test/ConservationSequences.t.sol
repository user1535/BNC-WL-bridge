// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../src/token/BridgeLockableToken.sol";
import {BridgeWrappedToken} from "../src/token/BridgeWrappedToken.sol";
import {DevMockLockMintReceiver} from "../src/bridge/DevMockLockMintReceiver.sol";
import {DevMockBurnUnlockReceiver} from "../src/bridge/DevMockBurnUnlockReceiver.sol";

interface VmConservation {
    function chainId(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

/// @notice Accounting fuzz uses dev mocks. No MPT/header authentication claim.
contract ConservationSequencesTest {
    VmConservation private constant vm = VmConservation(address(uint160(uint256(keccak256("hevm cheat code")))));
    address[3] private actors = [address(0xA11CE), address(0xB0B), address(0xCA701)];
    BridgeLockableToken private original;
    BridgeWrappedToken private wrapped;
    DevMockLockMintReceiver private mintReceiver;
    DevMockBurnUnlockReceiver private unlockReceiver;

    struct Claim {
        bytes32 id;
        address owner;
        uint256 amount;
        bool used;
    }
    Claim[] private locks;
    Claim[] private burns;

    function setUp() public {
        vm.chainId(31337);
        original = new BridgeLockableToken("Original", "WL", 300 ether, 31338);
        for (uint256 i; i < actors.length; ++i) {
            original.transfer(actors[i], 100 ether);
        }
        vm.chainId(31338);
        wrapped = new BridgeWrappedToken("Wrapped", "wWL", 31337, address(original));
        mintReceiver = new DevMockLockMintReceiver(wrapped);
        wrapped.bindMintReceiver(address(mintReceiver));
        vm.chainId(31337);
        unlockReceiver = new DevMockBurnUnlockReceiver(original, 31338, address(wrapped));
        original.bindUnlockReceiver(address(unlockReceiver));
        original.bindDestinationWrappedToken(address(wrapped));
    }

    function testFuzzPendingClaimsPartialBurnTransfersAndReplay(uint256 seed) public {
        for (uint256 step; step < 96; ++step) {
            uint256 draw = uint256(keccak256(abi.encode(seed, step)));
            address owner = actors[(draw >> 8) % 3];
            uint256 operation = draw % 5;
            if (operation == 0) _lock(owner, draw >> 16);
            else if (operation == 1 && locks.length != 0) _mint(draw % locks.length, actors[(draw >> 32) % 3]);
            else if (operation == 2) _burn(owner, draw >> 16);
            else if (operation == 3 && burns.length != 0) _unlock(draw % burns.length, actors[(draw >> 32) % 3]);
            else if (operation == 4) _transfer(owner, actors[(draw >> 32) % 3], draw >> 16);
            _checkAccounting();
        }
        // Delayed claims can be settled in a different order from creation.
        for (uint256 i = locks.length; i > 0; --i) {
            if (!locks[i - 1].used) _mint(i - 1, actors[i % 3]);
        }
        for (uint256 i = burns.length; i > 0; --i) {
            if (!burns[i - 1].used) _unlock(i - 1, actors[i % 3]);
        }
        _checkAccounting();
        for (uint256 i; i < actors.length; ++i) {
            uint256 balance = wrapped.balanceOf(actors[i]);
            if (balance != 0) {
                _burnAmount(actors[i], balance);
                _unlock(burns.length - 1, actors[(i + 1) % 3]);
            }
            _checkAccounting();
            require(original.lockedBalanceOf(actors[i]) == 0, "unsettled lock");
        }
        require(wrapped.totalSupply() == 0, "unsettled wrapped supply");
        require(original.totalSupply() == 300 ether, "source supply changed");
    }

    function _lock(address owner, uint256 draw) private {
        vm.chainId(31337);
        uint256 available = original.availableBalanceOf(owner);
        if (available == 0) return;
        uint256 amount = 1 + draw % available;
        vm.prank(owner);
        bytes32 id = original.bridgeLock(amount, owner, 31338);
        locks.push(Claim(id, owner, amount, false));
        vm.chainId(31338);
        mintReceiver.recordLock(id, owner, amount);
    }

    function _mint(uint256 index, address submitter) private {
        vm.chainId(31338);
        Claim storage claim = locks[index];
        if (claim.used) {
            vm.expectRevert(DevMockLockMintReceiver.AlreadyClaimed.selector);
            vm.prank(submitter);
            mintReceiver.claimLock(claim.id);
            return;
        }
        claim.used = true;
        vm.prank(submitter);
        mintReceiver.claimLock(claim.id);
    }

    function _burn(address owner, uint256 draw) private {
        uint256 balance = wrapped.balanceOf(owner);
        if (balance != 0) _burnAmount(owner, 1 + draw % balance);
    }

    function _burnAmount(address owner, uint256 amount) private {
        vm.chainId(31338);
        vm.prank(owner);
        bytes32 id = wrapped.bridgeBurn(amount, owner, 31337);
        burns.push(Claim(id, owner, amount, false));
        vm.chainId(31337);
        unlockReceiver.recordBurn(id, owner, amount);
    }

    function _unlock(uint256 index, address submitter) private {
        vm.chainId(31337);
        Claim storage claim = burns[index];
        if (claim.used) {
            vm.expectRevert(DevMockBurnUnlockReceiver.AlreadyClaimed.selector);
            vm.prank(submitter);
            unlockReceiver.claimBurn(claim.id);
            return;
        }
        claim.used = true;
        vm.prank(submitter);
        unlockReceiver.claimBurn(claim.id);
    }

    function _transfer(address owner, address recipient, uint256 draw) private {
        vm.chainId(31337);
        uint256 available = original.availableBalanceOf(owner);
        uint256 amount = available == 0 ? 0 : draw % (available + 1);
        vm.prank(owner);
        original.transfer(recipient, amount);
    }

    function _checkAccounting() private view {
        uint256 sourceBalances;
        uint256 remoteBalances;
        uint256 lockedTotal;
        uint256 pendingTotal;
        for (uint256 a; a < actors.length; ++a) {
            address owner = actors[a];
            uint256 locked = original.lockedBalanceOf(owner);
            uint256 balance = original.balanceOf(owner);
            uint256 remote = wrapped.balanceOf(owner);
            uint256 pending;
            for (uint256 i; i < locks.length; ++i) {
                if (!locks[i].used && locks[i].owner == owner) pending += locks[i].amount;
            }
            for (uint256 i; i < burns.length; ++i) {
                if (!burns[i].used && burns[i].owner == owner) pending += burns[i].amount;
            }
            require(
                balance >= locked && original.availableBalanceOf(owner) == balance - locked,
                "available balance violated"
            );
            require(locked == remote + pending, "per-owner conservation violated");
            sourceBalances += balance;
            remoteBalances += remote;
            lockedTotal += locked;
            pendingTotal += pending;
        }
        require(sourceBalances == original.totalSupply(), "source supply conservation violated");
        require(remoteBalances == wrapped.totalSupply(), "remote supply conservation violated");
        require(lockedTotal == wrapped.totalSupply() + pendingTotal, "global conservation violated");
    }
}
