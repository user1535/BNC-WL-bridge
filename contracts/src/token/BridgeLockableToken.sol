// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Core} from "./ERC20Core.sol";

contract BridgeLockableToken is ERC20Core {
    bytes32 private constant LOCK_DOMAIN = keccak256("BNC_WL_BRIDGE_LOCK_V1");

    address public immutable burnUnlockReceiver;
    address public immutable owner;
    mapping(address account => uint256) private _lockedBalance;
    mapping(address account => uint64) public bridgeNonce;
    mapping(bytes32 withdrawalId => bool) public unlockedTransfer;
    mapping(uint256 chainId => bool) public supportedDestination;

    event Locked(
        bytes32 indexed transferId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint64 nonce,
        uint256 destinationChainId
    );
    event BridgeUnlocked(bytes32 indexed withdrawalId, address indexed account, uint256 amount);

    error Unauthorized();
    error InvalidAmount();
    error UnsupportedDestination();
    error AvailableBalanceTooLow();
    error AlreadyUnlocked();
    error LockedBalanceTooLow();
    error NonceOverflow();

    constructor(
        string memory name_,
        string memory symbol_,
        address burnUnlockReceiver_,
        uint256 initialSupply
    ) ERC20Core(name_, symbol_) {
        if (burnUnlockReceiver_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        burnUnlockReceiver = burnUnlockReceiver_;
        _mint(msg.sender, initialSupply);
    }

    function setSupportedDestination(uint256 chainId, bool supported) external {
        if (msg.sender != owner) revert Unauthorized();
        supportedDestination[chainId] = supported;
    }

    function lockedBalanceOf(address account) external view returns (uint256) {
        return _lockedBalance[account];
    }

    function availableBalanceOf(address account) public view returns (uint256) {
        return balanceOf[account] - _lockedBalance[account];
    }

    function bridgeLock(uint256 amount, address recipient, uint256 destinationChainId)
        external
        returns (bytes32 transferId)
    {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidAddress();
        if (!supportedDestination[destinationChainId]) revert UnsupportedDestination();
        _checkAvailableBalance(msg.sender, amount);

        uint64 nonce = bridgeNonce[msg.sender];
        if (nonce == type(uint64).max) revert NonceOverflow();
        unchecked {
            nonce++;
        }
        bridgeNonce[msg.sender] = nonce;
        transferId = _computeLockId(msg.sender, recipient, amount, nonce, destinationChainId);
        _lockedBalance[msg.sender] += amount;
        emit Locked(transferId, msg.sender, recipient, amount, nonce, destinationChainId);
    }

    function bridgeUnlock(bytes32 withdrawalId, address account, uint256 amount) external {
        if (msg.sender != burnUnlockReceiver) revert Unauthorized();
        if (amount == 0) revert InvalidAmount();
        if (unlockedTransfer[withdrawalId]) revert AlreadyUnlocked();
        uint256 locked = _lockedBalance[account];
        if (locked < amount) revert LockedBalanceTooLow();
        unlockedTransfer[withdrawalId] = true;
        unchecked {
            _lockedBalance[account] = locked - amount;
        }
        emit BridgeUnlocked(withdrawalId, account, amount);
    }

    function _computeLockId(address sender, address recipient, uint256 amount, uint64 nonce, uint256 destinationChainId)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(LOCK_DOMAIN, block.chainid, address(this), sender, recipient, amount, nonce, destinationChainId)
        );
    }

    function _checkAvailableBalance(address from, uint256 amount) internal view {
        if (availableBalanceOf(from) < amount) revert AvailableBalanceTooLow();
    }

    function _update(address from, address to, uint256 amount) internal override {
        _checkAvailableBalance(from, amount);
        super._update(from, to, amount);
    }
}
