// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {VaultReceipt} from "../bridge/VaultReceipt.sol";
import {MinimalERC20} from "./MinimalERC20.sol";

/// @notice Transferable wWL backed by the native WL Vault. Starts with zero supply.
abstract contract VaultWrappedWLCore is MinimalERC20 {
    uint256 public immutable sourceChainId;
    IHeaderSource public immutable headerSource;
    address public immutable sourceToken;
    uint256 public totalBridgeMinted;
    uint256 public totalBridgeBurned;
    mapping(address => uint64) public burnNonce;
    mapping(bytes32 => bool) public claimedTransfer;

    event VaultBurned(bytes32 indexed withdrawalId, address indexed sender, address indexed recipient,
        uint256 amount, uint64 nonce, uint256 destinationChainId);
    event LockClaimed(bytes32 indexed transferId, address indexed recipient, uint256 amount);

    error InvalidConfiguration();
    error InvalidBurn();
    error TransferAlreadyClaimed();

    constructor(IHeaderSource headers, address vault, uint256 localChain, uint256 peerChain)
        MinimalERC20("Vault Wrapped WorldLand", "wWL")
    {
        if (block.chainid != localChain || address(headers).code.length == 0 || vault == address(0)) {
            revert InvalidConfiguration();
        }
        headerSource = headers;
        sourceChainId = peerChain;
        sourceToken = vault;
    }

    function submitLockProof(VaultReceipt.Proof calldata proof) public virtual {
        (bytes32 id, address recipient, uint256 amount) =
            VaultReceipt.verify(headerSource, sourceChainId, sourceToken, VaultReceipt.LOCK_TOPIC, proof);
        if (claimedTransfer[id]) revert TransferAlreadyClaimed();
        _beforeTokenTransfer(address(0), recipient, amount);
        claimedTransfer[id] = true;
        totalBridgeMinted += amount;
        _mint(recipient, amount);
        emit LockClaimed(id, recipient, amount);
    }

    function bridgeBurn(uint256 amount, address recipient, uint256 destinationChainId)
        public virtual returns (bytes32 id)
    {
        if (amount == 0 || recipient == address(0) || recipient == sourceToken || destinationChainId != sourceChainId) {
            revert InvalidBurn();
        }
        uint64 nonce = ++burnNonce[msg.sender];
        id = VaultReceipt.transferId(block.chainid, address(this), sourceChainId, sourceToken,
            msg.sender, recipient, amount, nonce);
        _burn(msg.sender, amount);
        totalBridgeBurned += amount;
        emit VaultBurned(id, msg.sender, recipient, amount, nonce, sourceChainId);
    }
}

contract VaultWrappedWL is VaultWrappedWLCore {
    constructor(IHeaderSource headers, address vault) VaultWrappedWLCore(headers, vault, 31338, 31337) {}
}
