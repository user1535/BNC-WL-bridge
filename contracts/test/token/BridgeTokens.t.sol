// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../../src/token/BridgeLockableToken.sol";
import {BridgeWrappedToken} from "../../src/token/BridgeWrappedToken.sol";

contract TokenActor {
    function mint(BridgeWrappedToken token, address recipient, uint256 amount) external { token.bridgeMint(recipient, amount); }
    function lock(BridgeLockableToken token, uint256 amount, address recipient, uint256 destination) external returns (bytes32) {
        return token.bridgeLock(amount, recipient, destination);
    }
    function transferToken(BridgeLockableToken token, address recipient, uint256 amount) external returns (bool) {
        return token.transfer(recipient, amount);
    }
    function burn(BridgeWrappedToken token, uint256 amount, address recipient, uint256 destination) external returns (bytes32) {
        return token.bridgeBurn(amount, recipient, destination);
    }
}

contract BridgeTokensTest {
    uint256 private constant REMOTE_CHAIN = 31338;

    function testLockRestrictsTransferAndUnlockRestoresAvailability() external {
        BridgeLockableToken token = new BridgeLockableToken("WorldLand", "WLD", address(this), 1_000 ether);
        TokenActor alice = new TokenActor();
        TokenActor bob = new TokenActor();
        token.setSupportedDestination(REMOTE_CHAIN, true);
        token.transfer(address(alice), 100 ether);

        bytes32 transferId = alice.lock(token, 60 ether, address(alice), REMOTE_CHAIN);
        require(transferId != bytes32(0), "missing transfer id");
        require(token.balanceOf(address(alice)) == 100 ether, "lock moved balance");
        require(token.lockedBalanceOf(address(alice)) == 60 ether, "wrong locked balance");
        require(token.availableBalanceOf(address(alice)) == 40 ether, "wrong available balance");

        (bool success,) = address(alice).call(abi.encodeCall(TokenActor.transferToken, (token, address(bob), 41 ether)));
        require(!success, "locked funds were transferred");
        require(alice.transferToken(token, address(bob), 40 ether), "available transfer failed");

        bytes32 withdrawalId = keccak256("withdrawal-1");
        token.bridgeUnlock(withdrawalId, address(alice), 60 ether);
        require(token.lockedBalanceOf(address(alice)) == 0, "unlock failed");
        require(token.unlockedTransfer(withdrawalId), "withdrawal not consumed");
    }

    function testWithdrawalCannotReplay() external {
        BridgeLockableToken token = new BridgeLockableToken("WorldLand", "WLD", address(this), 100 ether);
        TokenActor alice = new TokenActor();
        token.setSupportedDestination(REMOTE_CHAIN, true);
        token.transfer(address(alice), 10 ether);
        alice.lock(token, 10 ether, address(alice), REMOTE_CHAIN);
        bytes32 withdrawalId = keccak256("withdrawal-2");
        token.bridgeUnlock(withdrawalId, address(alice), 10 ether);
        (bool replay,) = address(token).call(abi.encodeCall(BridgeLockableToken.bridgeUnlock, (withdrawalId, address(alice), 10 ether)));
        require(!replay, "withdrawal replay succeeded");
    }

    function testWrappedMintAndBurnRoundTrip() external {
        BridgeWrappedToken wrapped = new BridgeWrappedToken("Wrapped WorldLand", "wWLD", 31337, address(0x1234), address(this));
        TokenActor alice = new TokenActor();
        wrapped.bridgeMint(address(alice), 25 ether);
        require(wrapped.balanceOf(address(alice)) == 25 ether, "mint failed");
        bytes32 withdrawalId = alice.burn(wrapped, 25 ether, address(alice), 31337);
        require(withdrawalId != bytes32(0), "missing withdrawal id");
        require(wrapped.balanceOf(address(alice)) == 0, "burn balance remains");
        require(wrapped.totalSupply() == 0, "burn supply remains");
    }

    function testUnauthorizedMintFails() external {
        BridgeWrappedToken wrapped = new BridgeWrappedToken("Wrapped WorldLand", "wWLD", 31337, address(0x1234), address(this));
        TokenActor alice = new TokenActor();
        (bool success,) = address(alice).call(abi.encodeCall(TokenActor.mint, (wrapped, address(alice), 1 ether)));
        require(!success, "unauthorized mint succeeded");
    }
}
