// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public audit commitments; a confirmed incident permanently stops new claims.
contract BridgeAuditLog {
    address public immutable auditor;
    bool public halted;
    bytes32 public lastDigest;
    uint256 public sequence;
    event AuditCommitted(uint256 indexed sequence, bytes32 indexed digest, bytes32 previousDigest);
    event EmergencyStopped(bytes32 indexed evidenceDigest);
    error Unauthorized();
    error InvalidEvidence();
    error BridgeStopped();
    constructor() { auditor = msg.sender; }
    function commit(bytes32 digest) external {
        if (msg.sender != auditor) revert Unauthorized();
        if (digest == bytes32(0)) revert InvalidEvidence();
        emit AuditCommitted(++sequence, digest, lastDigest);
        lastDigest = digest;
    }
    function confirmIncident(bytes32 evidenceDigest) external {
        if (msg.sender != auditor) revert Unauthorized();
        if (evidenceDigest == bytes32(0)) revert InvalidEvidence();
        halted = true;
        emit EmergencyStopped(evidenceDigest);
    }
    function requireActive() external view { if (halted) revert BridgeStopped(); }
}
