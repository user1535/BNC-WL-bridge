// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {VaultReceipt} from "./VaultReceipt.sol";

/// @notice Pool of native WL. A verified wWL burn authorizes release to its committed recipient.
abstract contract NativeWLVaultCore {
    uint256 public immutable sourceChainId;
    IHeaderSource public immutable headerSource;
    address public immutable deploymentOwner;
    address public sourceToken;
    uint256 public totalLocked;
    uint256 public totalReleased;
    mapping(address => uint64) public lockNonce;
    mapping(bytes32 => bool) public claimedWithdrawal;

    event WrappedTokenBound(address indexed token);
    event VaultLocked(bytes32 indexed transferId, address indexed sender, address indexed recipient,
        uint256 amount, uint64 nonce, uint256 destinationChainId);
    event BurnClaimed(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount);

    error InvalidConfiguration();
    error InvalidDeposit();
    error WithdrawalAlreadyClaimed();
    error InsufficientCollateral();
    error PayoutFailed();

    constructor(IHeaderSource headers, uint256 localChain, uint256 peerChain, address owner) {
        if (block.chainid != localChain || address(headers).code.length == 0 || owner == address(0)) {
            revert InvalidConfiguration();
        }
        headerSource = headers;
        sourceChainId = peerChain;
        deploymentOwner = owner;
    }

    function bindWrappedToken(address token) public virtual {
        if (msg.sender != deploymentOwner || sourceToken != address(0) || token == address(0)) {
            revert InvalidConfiguration();
        }
        sourceToken = token;
        emit WrappedTokenBound(token);
    }

    function lock(address recipient) public payable virtual returns (bytes32 id) {
        address wrapped = sourceToken;
        if (msg.value == 0 || recipient == address(0) || wrapped == address(0)) revert InvalidDeposit();
        uint64 nonce = ++lockNonce[msg.sender];
        id = VaultReceipt.transferId(block.chainid, address(this), sourceChainId, wrapped,
            msg.sender, recipient, msg.value, nonce);
        totalLocked += msg.value;
        emit VaultLocked(id, msg.sender, recipient, msg.value, nonce, sourceChainId);
    }

    function submitBurnProof(VaultReceipt.Proof calldata proof) public virtual {
        _release(proof, payable(address(0)));
    }

    function _release(VaultReceipt.Proof calldata proof, address payable payout) internal {
        (bytes32 id, address recipient, uint256 amount) =
            VaultReceipt.verify(headerSource, sourceChainId, sourceToken, VaultReceipt.BURN_TOPIC, proof);
        if (payout == address(0)) payout = payable(recipient);
        else if (msg.sender != recipient) revert InvalidConfiguration();
        if (claimedWithdrawal[id]) revert WithdrawalAlreadyClaimed();
        if (amount > totalLocked - totalReleased || amount > address(this).balance) revert InsufficientCollateral();
        claimedWithdrawal[id] = true;
        totalReleased += amount;
        (bool paid,) = payout.call{value: amount}("");
        if (!paid) revert PayoutFailed();
        emit BurnClaimed(id, payout, amount);
    }
}

contract NativeWLVault is NativeWLVaultCore {
    constructor(IHeaderSource headers) NativeWLVaultCore(headers, 31337, 31338, msg.sender) {}
}
