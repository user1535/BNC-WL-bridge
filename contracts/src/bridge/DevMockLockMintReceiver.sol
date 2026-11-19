// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeWrappedToken} from "../token/BridgeWrappedToken.sol";

/// @notice DEV ONLY: an operator copies observed lock data; no cross-chain proof is checked.
contract DevMockLockMintReceiver {
    struct LockClaim {
        address recipient;
        uint256 amount;
        bool used;
    }

    BridgeWrappedToken public immutable wrappedToken;
    address public immutable devOperator;
    uint256 public immutable sourceChainId;
    address public immutable sourceToken;
    mapping(bytes32 => LockClaim) public claims;

    event LockRecorded(bytes32 indexed transferId, address indexed recipient, uint256 amount);
    event LockClaimed(bytes32 indexed transferId, address indexed recipient, uint256 amount);

    error Unauthorized();
    error InvalidClaim();
    error AlreadyRecorded();
    error AlreadyClaimed();

    constructor(BridgeWrappedToken wrappedToken_) {
        if (address(wrappedToken_) == address(0) || block.chainid != 31338 || wrappedToken_.originChainId() != 31337) {
            revert InvalidClaim();
        }
        wrappedToken = wrappedToken_;
        devOperator = msg.sender;
        sourceChainId = wrappedToken_.originChainId();
        sourceToken = wrappedToken_.originToken();
    }

    function recordLock(bytes32 transferId, address recipient, uint256 amount) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (transferId == bytes32(0) || recipient == address(0) || amount == 0) revert InvalidClaim();
        if (claims[transferId].recipient != address(0)) revert AlreadyRecorded();
        claims[transferId] = LockClaim(recipient, amount, false);
        emit LockRecorded(transferId, recipient, amount);
    }

    function claimLock(bytes32 transferId) external {
        LockClaim storage claim = claims[transferId];
        if (claim.recipient == address(0)) revert InvalidClaim();
        if (claim.used) revert AlreadyClaimed();
        claim.used = true;
        wrappedToken.bridgeMint(claim.recipient, claim.amount);
        emit LockClaimed(transferId, claim.recipient, claim.amount);
    }
}

