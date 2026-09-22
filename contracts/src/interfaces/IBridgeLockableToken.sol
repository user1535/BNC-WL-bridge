// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBridgeLockableToken {
    function bridgeUnlock(bytes32 withdrawalId, address account, uint256 amount) external;
}
