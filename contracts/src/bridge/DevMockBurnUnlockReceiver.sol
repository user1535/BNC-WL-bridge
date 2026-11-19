// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../token/BridgeLockableToken.sol";

/// @notice DEV ONLY: an operator copies observed burn data; no cross-chain proof is checked.
contract DevMockBurnUnlockReceiver {
    struct BurnClaim {
        address account;
        uint256 amount;
        bool used;
    }

    BridgeLockableToken public immutable originalToken;
    address public immutable devOperator;
    uint256 public immutable sourceChainId;
    address public immutable sourceWrappedToken;
    mapping(bytes32 => BurnClaim) public claims;

    event BurnRecorded(bytes32 indexed withdrawalId, address indexed account, uint256 amount);
    event BurnClaimed(bytes32 indexed withdrawalId, address indexed account, uint256 amount);

    error Unauthorized();
    error InvalidClaim();
    error AlreadyRecorded();
    error AlreadyClaimed();

    constructor(BridgeLockableToken originalToken_, uint256 sourceChainId_, address sourceWrappedToken_) {
        if (
            address(originalToken_) == address(0) || block.chainid != 31337 || sourceChainId_ != 31338
                || sourceWrappedToken_ == address(0)
        ) {
            revert InvalidClaim();
        }
        if (originalToken_.destinationChainId() != sourceChainId_) revert InvalidClaim();
        originalToken = originalToken_;
        devOperator = msg.sender;
        sourceChainId = sourceChainId_;
        sourceWrappedToken = sourceWrappedToken_;
    }

    function recordBurn(bytes32 withdrawalId, address account, uint256 amount) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (withdrawalId == bytes32(0) || account == address(0) || amount == 0) revert InvalidClaim();
        if (claims[withdrawalId].account != address(0)) revert AlreadyRecorded();
        claims[withdrawalId] = BurnClaim(account, amount, false);
        emit BurnRecorded(withdrawalId, account, amount);
    }

    function claimBurn(bytes32 withdrawalId) external {
        BurnClaim storage claim = claims[withdrawalId];
        if (claim.account == address(0)) revert InvalidClaim();
        if (claim.used) revert AlreadyClaimed();
        claim.used = true;
        originalToken.bridgeUnlock(withdrawalId, claim.account, claim.amount);
        emit BurnClaimed(withdrawalId, claim.account, claim.amount);
    }
}

