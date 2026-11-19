// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeAuditLog} from "../src/bridge/BridgeAuditLog.sol";
import {NativeWLVaultCore} from "../src/bridge/NativeWLVault.sol";
import {VaultWrappedWLCore} from "../src/token/VaultWrappedWL.sol";
import {IHeaderSource} from "../src/interfaces/IHeaderSource.sol";
import {VaultReceipt} from "../src/bridge/VaultReceipt.sol";

interface IVaultTestnetEndpoint {
    function headerSource() external view returns (IHeaderSource);
    function sourceToken() external view returns (address);
}

/// @notice Testnet-only registry. The operator authorizes the receipt roots.
contract VaultTestnetRegistry is IHeaderSource {
    struct Entry {
        bytes32 blockHash;
        bytes32 root;
    }
    uint256 public immutable sourceChainId;
    address public immutable devOperator;
    address public bridge;
    bool public active;
    bool public everActivated;
    mapping(uint256 => Entry) public headers;
    mapping(uint256 => bool) public consumedHeaders;

    event HeaderRegistered(
        uint256 indexed sourceChainId, uint256 indexed blockNumber, bytes32 blockHash, bytes32 receiptRoot
    );
    event HeaderReplaced(
        uint256 indexed blockNumber, bytes32 oldBlockHash, bytes32 oldRoot, bytes32 newBlockHash, bytes32 newRoot
    );
    event BridgeConfigured(address indexed bridge);
    event BridgeActivated(address indexed bridge, address indexed peer);
    event BridgePaused(bytes32 indexed evidenceDigest);
    error Unauthorized();
    error InvalidHeader();
    error HeaderConflict();
    error UnknownHeader();
    error InvalidBridge();
    error HeaderConsumed();

    constructor(uint256 peerChain, address operator) {
        if (
            operator == address(0)
                || !((block.chainid == 10359 && peerChain == 97) || (block.chainid == 97 && peerChain == 10359))
        ) revert InvalidHeader();
        sourceChainId = peerChain;
        devOperator = operator;
    }

    function configureBridge(address endpoint) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (
            everActivated || endpoint.code.length == 0
                || address(IVaultTestnetEndpoint(endpoint).headerSource()) != address(this)
        ) revert InvalidBridge();
        bridge = endpoint;
        emit BridgeConfigured(endpoint);
    }

    function activate(address expectedBridge, address expectedPeer) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (
            bridge == address(0) || bridge != expectedBridge || expectedPeer == address(0)
                || IVaultTestnetEndpoint(bridge).sourceToken() != expectedPeer
        ) revert InvalidBridge();
        active = true;
        everActivated = true;
        emit BridgeActivated(bridge, expectedPeer);
    }

    function requireActiveFor(address endpoint) public view {
        if (!active || bridge != endpoint) revert BridgeAuditLog.BridgeStopped();
    }

    function registerHeader(uint256 number, bytes32 blockHash, bytes32 root) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (!active) revert BridgeAuditLog.BridgeStopped();
        if (blockHash == bytes32(0) || root == bytes32(0)) revert InvalidHeader();
        Entry memory existing = headers[number];
        if (existing.blockHash != bytes32(0)) {
            if (existing.blockHash != blockHash || existing.root != root) revert HeaderConflict();
            return;
        }
        headers[number] = Entry(blockHash, root);
        emit HeaderRegistered(sourceChainId, number, blockHash, root);
    }

    function confirmIncident(bytes32 digest) external {
        if (msg.sender != devOperator) revert Unauthorized();
        if (digest == bytes32(0)) revert BridgeAuditLog.InvalidEvidence();
        active = false;
        emit BridgePaused(digest);
    }

    function replaceHeader(uint256 number, bytes32 oldHash, bytes32 oldRoot, bytes32 newHash, bytes32 newRoot)
        external
    {
        if (msg.sender != devOperator) revert Unauthorized();
        if (active || oldHash == bytes32(0) || (newHash == bytes32(0)) != (newRoot == bytes32(0))) {
            revert InvalidHeader();
        }
        Entry memory existing = headers[number];
        if (existing.blockHash != oldHash || existing.root != oldRoot) revert HeaderConflict();
        if (consumedHeaders[number]) revert HeaderConsumed();
        headers[number] = Entry(newHash, newRoot);
        emit HeaderReplaced(number, oldHash, oldRoot, newHash, newRoot);
    }

    function recordClaim(uint256 number) external {
        requireActiveFor(msg.sender);
        consumedHeaders[number] = true;
    }

    function isBlockCovered(uint256 sourceChain, uint256 number, bytes32 blockHash) external view returns (bool) {
        return sourceChain == sourceChainId && blockHash != bytes32(0) && headers[number].blockHash == blockHash;
    }

    function getReceiptRoot(uint256 sourceChain, uint256 number, bytes32 blockHash) external view returns (bytes32) {
        if (!active) revert BridgeAuditLog.BridgeStopped();
        if (sourceChain != sourceChainId) revert InvalidHeader();
        Entry memory entry = headers[number];
        if (entry.blockHash == bytes32(0) || entry.blockHash != blockHash) revert UnknownHeader();
        return entry.root;
    }
}

contract VaultTestnetWL is NativeWLVaultCore {
    constructor(IHeaderSource headers, address bindingAuthority)
        NativeWLVaultCore(headers, 10359, 97, bindingAuthority)
    {
        if (VaultTestnetRegistry(address(headers)).sourceChainId() != 97) revert InvalidConfiguration();
    }

    function bindWrappedToken(address token) public override {
        if (
            msg.sender != deploymentOwner || token == address(0)
                || VaultTestnetRegistry(address(headerSource)).everActivated()
        ) revert InvalidConfiguration();
        sourceToken = token;
        emit WrappedTokenBound(token);
    }

    function lock(address recipient) public payable override returns (bytes32) {
        VaultTestnetRegistry(address(headerSource)).requireActiveFor(address(this));
        if (recipient == sourceToken) revert InvalidDeposit();
        return super.lock(recipient);
    }

    function submitBurnProof(VaultReceipt.Proof calldata proof) public override {
        VaultTestnetRegistry(address(headerSource)).recordClaim(proof.blockNumber);
        super.submitBurnProof(proof);
    }

    /// @notice Only the recipient committed in the burn may choose a different payout address.
    function submitBurnProofTo(VaultReceipt.Proof calldata proof, address payable payout) external {
        if (payout == address(0) || payout == address(this)) revert InvalidConfiguration();
        VaultTestnetRegistry(address(headerSource)).recordClaim(proof.blockNumber);
        _release(proof, payout);
    }
}

contract VaultTestnetWrappedWL is VaultWrappedWLCore {
    constructor(IHeaderSource headers, address vault) VaultWrappedWLCore(headers, vault, 97, 10359) {
        if (VaultTestnetRegistry(address(headers)).sourceChainId() != 10359) revert InvalidConfiguration();
    }

    function submitLockProof(VaultReceipt.Proof calldata proof) public override {
        VaultTestnetRegistry(address(headerSource)).recordClaim(proof.blockNumber);
        super.submitLockProof(proof);
    }

    function bridgeBurn(uint256 amount, address recipient, uint256 destinationChainId)
        public
        override
        returns (bytes32)
    {
        VaultTestnetRegistry(address(headerSource)).requireActiveFor(address(this));
        return super.bridgeBurn(amount, recipient, destinationChainId);
    }

    function _beforeTokenTransfer(address, address to, uint256) internal view override {
        if (to == address(this)) revert InvalidBurn();
    }
}
