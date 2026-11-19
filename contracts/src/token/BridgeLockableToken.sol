// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MinimalERC20} from "./MinimalERC20.sol";

/// @notice Local prototype: the original assets remain in the locking account.
contract BridgeLockableToken is MinimalERC20 {
    bytes32 private constant LOCK_DOMAIN = keccak256("WORLDLAND_BNB_BRIDGE_LOCK_V2");

    uint256 public immutable destinationChainId;
    address public immutable deploymentOwner;
    address public unlockReceiver;
    address public destinationWrappedToken;

    mapping(address => uint256) private _lockedBalance;
    mapping(address => uint64) public bridgeNonce;
    mapping(bytes32 => bool) public unlockedWithdrawal;

    event Locked(
        bytes32 indexed transferId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint64 nonce,
        uint256 destinationChainId
    );
    event Unlocked(bytes32 indexed withdrawalId, address indexed account, uint256 amount);
    event UnlockReceiverBound(address indexed receiver);
    event DestinationWrappedTokenBound(address indexed token);

    error InvalidAmount();
    error InvalidChain();
    error RecipientMustBeLocker();
    error LockedBalanceExceeded();
    error ReceiverAlreadyBound();
    error DestinationTokenAlreadyBound();
    error DestinationTokenNotBound();
    error Unauthorized();
    error WithdrawalAlreadyUsed();

    constructor(string memory name_, string memory symbol_, uint256 initialSupply_, uint256 destinationChainId_)
        MinimalERC20(name_, symbol_)
    {
        if (destinationChainId_ == 0 || destinationChainId_ == block.chainid) revert InvalidChain();
        destinationChainId = destinationChainId_;
        deploymentOwner = msg.sender;
        _mint(msg.sender, initialSupply_);
    }

    /// @dev One-time local deployment binding. A live design needs reviewed governance and receiver code.
    function bindUnlockReceiver(address receiver) external {
        if (msg.sender != deploymentOwner) revert Unauthorized();
        if (unlockReceiver != address(0)) revert ReceiverAlreadyBound();
        if (receiver == address(0)) revert ZeroAddress();
        unlockReceiver = receiver;
        emit UnlockReceiverBound(receiver);
    }

    /// @dev One-time destination asset identity binding for the lock ID domain.
    function bindDestinationWrappedToken(address token) external {
        if (msg.sender != deploymentOwner) revert Unauthorized();
        if (destinationWrappedToken != address(0)) revert DestinationTokenAlreadyBound();
        if (token == address(0)) revert ZeroAddress();
        destinationWrappedToken = token;
        emit DestinationWrappedTokenBound(token);
    }

    function lockedBalanceOf(address account) external view returns (uint256) {
        return _lockedBalance[account];
    }

    function availableBalanceOf(address account) public view returns (uint256) {
        return balanceOf[account] - _lockedBalance[account];
    }

    function bridgeLock(uint256 amount, address recipient, uint256 destinationChainId_)
        external
        returns (bytes32 transferId)
    {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        // Until transferable lock positions are designed, redemption must return to the locker.
        if (recipient != msg.sender) revert RecipientMustBeLocker();
        if (destinationChainId_ != destinationChainId) revert InvalidChain();
        if (destinationWrappedToken == address(0)) revert DestinationTokenNotBound();
        if (availableBalanceOf(msg.sender) < amount) revert LockedBalanceExceeded();

        uint64 nonce = ++bridgeNonce[msg.sender];
        transferId = keccak256(
            abi.encode(
                LOCK_DOMAIN,
                block.chainid,
                address(this),
                destinationWrappedToken,
                msg.sender,
                recipient,
                amount,
                nonce,
                destinationChainId_
            )
        );
        _lockedBalance[msg.sender] += amount;
        emit Locked(transferId, msg.sender, recipient, amount, nonce, destinationChainId_);
    }

    function bridgeUnlock(bytes32 withdrawalId, address account, uint256 amount) external {
        if (msg.sender != unlockReceiver || unlockReceiver == address(0)) revert Unauthorized();
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (unlockedWithdrawal[withdrawalId]) revert WithdrawalAlreadyUsed();
        if (_lockedBalance[account] < amount) revert LockedBalanceExceeded();
        unlockedWithdrawal[withdrawalId] = true;
        _lockedBalance[account] -= amount;
        emit Unlocked(withdrawalId, account, amount);
    }

    function _beforeTokenTransfer(address from, address, uint256 amount) internal view override {
        if (from != address(0) && availableBalanceOf(from) < amount) revert LockedBalanceExceeded();
    }
}

