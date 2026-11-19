// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeAuditLog} from "./BridgeAuditLog.sol";
import {IHeaderSource} from "../interfaces/IHeaderSource.sol";

/// @notice DEV ONLY: operator supplied headers are trusted and have no consensus verification.
contract DevHeaderRegistry is IHeaderSource {
    struct HeaderRecord {
        bytes32 blockHash;
        bytes32 receiptRoot;
    }

    uint256 public immutable sourceChainId;
    address public immutable devOperator;
    BridgeAuditLog public immutable auditLog;
    mapping(uint256 => HeaderRecord) public headers;

    event HeaderRegistered(
        uint256 indexed sourceChainId, uint256 indexed blockNumber, bytes32 blockHash, bytes32 receiptRoot
    );
    error Unauthorized();
    error InvalidHeader();
    error HeaderConflict();
    error UnknownHeader();
    error InvalidBatch();

    constructor(uint256 sourceChainId_) {
        if (!((block.chainid == 31338 && sourceChainId_ == 31337)
                    || (block.chainid == 31337 && sourceChainId_ == 31338))) revert InvalidHeader();
        sourceChainId = sourceChainId_;
        devOperator = msg.sender;
        auditLog = new BridgeAuditLog();
    }

    function commitAudit(bytes32 digest) external {
        if (msg.sender != devOperator) revert Unauthorized();
        auditLog.commit(digest);
    }

    function confirmIncident(bytes32 evidenceDigest) external {
        if (msg.sender != devOperator) revert Unauthorized();
        auditLog.confirmIncident(evidenceDigest);
    }

    function registerHeader(uint256 blockNumber, bytes32 blockHash, bytes32 receiptRoot) external {
        if (msg.sender != devOperator) revert Unauthorized();
        auditLog.requireActive();
        _register(blockNumber, blockHash, receiptRoot);
    }

    function registerHeaderBatch(uint256 startBlock, bytes32[] calldata blockHashes, bytes32[] calldata receiptRoots)
        external
    {
        if (msg.sender != devOperator) revert Unauthorized();
        auditLog.requireActive();
        if (blockHashes.length == 0 || blockHashes.length > 128 || blockHashes.length != receiptRoots.length) {
            revert InvalidBatch();
        }
        for (uint256 i = 0; i < blockHashes.length; i++) {
            _register(startBlock + i, blockHashes[i], receiptRoots[i]);
        }
    }

    function _register(uint256 blockNumber, bytes32 blockHash, bytes32 receiptRoot) internal {
        if (blockHash == bytes32(0) || receiptRoot == bytes32(0)) revert InvalidHeader();
        HeaderRecord storage old = headers[blockNumber];
        if (old.blockHash != bytes32(0)) {
            if (old.blockHash != blockHash || old.receiptRoot != receiptRoot) revert HeaderConflict();
            return;
        }
        headers[blockNumber] = HeaderRecord(blockHash, receiptRoot);
        emit HeaderRegistered(sourceChainId, blockNumber, blockHash, receiptRoot);
    }

    function isBlockCovered(uint256 sourceChainId_, uint256 blockNumber, bytes32 blockHash)
        external
        view
        returns (bool)
    {
        return sourceChainId_ == sourceChainId && blockHash != bytes32(0) && headers[blockNumber].blockHash == blockHash;
    }

    function getReceiptRoot(uint256 sourceChainId_, uint256 blockNumber, bytes32 blockHash)
        external
        view
        returns (bytes32 receiptRoot)
    {
        auditLog.requireActive();
        if (sourceChainId_ != sourceChainId) revert InvalidHeader();
        HeaderRecord memory header = headers[blockNumber];
        if (header.blockHash == bytes32(0) || header.blockHash != blockHash) revert UnknownHeader();
        return header.receiptRoot;
    }
}

