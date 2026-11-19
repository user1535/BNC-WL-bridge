// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHeaderSource {
    function getReceiptRoot(uint256 sourceChainId, uint256 blockNumber, bytes32 blockHash)
        external
        view
        returns (bytes32 receiptRoot);

    function isBlockCovered(uint256 sourceChainId, uint256 blockNumber, bytes32 blockHash) external view returns (bool);
}

