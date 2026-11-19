// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeLockableToken} from "../token/BridgeLockableToken.sol";
import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {MPTReceiptProofCore} from "./MPTReceiptProofCore.sol";

contract BurnUnlockReceiver {
    bytes32 private constant BURN_DOMAIN = keccak256("WORLDLAND_BNB_BRIDGE_BURN_V1");
    bytes32 private constant BURN_TOPIC = keccak256("Burned(bytes32,address,address,uint256,uint64,uint256)");

    struct BurnProof {
        uint256 blockNumber;
        bytes32 blockHash;
        uint256 txIndex;
        uint256 logIndex;
        bytes[] proofNodes;
    }

    BridgeLockableToken public immutable originalToken;
    IHeaderSource public immutable headerSource;
    uint256 public immutable sourceChainId;
    address public immutable sourceWrappedToken;
    mapping(bytes32 => bool) public claimedWithdrawal;

    event BurnClaimed(bytes32 indexed withdrawalId, address indexed account, uint256 amount);
    error InvalidEvent();
    error WithdrawalAlreadyClaimed();

    constructor(BridgeLockableToken originalToken_, IHeaderSource headerSource_, address sourceWrappedToken_) {
        if (
            address(originalToken_) == address(0) || address(headerSource_) == address(0)
                || sourceWrappedToken_ == address(0)
        ) revert InvalidEvent();
        originalToken = originalToken_;
        headerSource = headerSource_;
        sourceChainId = originalToken_.destinationChainId();
        sourceWrappedToken = sourceWrappedToken_;
    }

    function submitBurnProof(BurnProof calldata proof) external {
        bytes32 root = headerSource.getReceiptRoot(sourceChainId, proof.blockNumber, proof.blockHash);
        MPTReceiptProofCore.VerifiedLog memory logEntry =
            MPTReceiptProofCore.verifyLog(root, proof.txIndex, proof.logIndex, proof.proofNodes);
        if (logEntry.emitter != sourceWrappedToken || logEntry.topics.length != 4 || logEntry.topics[0] != BURN_TOPIC) {
            revert InvalidEvent();
        }
        address sender = _topicAddress(logEntry.topics[2]);
        address recipient = _topicAddress(logEntry.topics[3]);
        if (sender == address(0) || recipient != sender || logEntry.data.length != 96) revert InvalidEvent();
        (uint256 amount, uint64 nonce, uint256 destinationChainId) =
            abi.decode(logEntry.data, (uint256, uint64, uint256));
        if (amount == 0 || destinationChainId != block.chainid) revert InvalidEvent();
        bytes32 withdrawalId = logEntry.topics[1];
        if (
            withdrawalId
                != keccak256(
                    abi.encode(
                        BURN_DOMAIN,
                        sourceChainId,
                        sourceWrappedToken,
                        block.chainid,
                        address(originalToken),
                        sender,
                        recipient,
                        amount,
                        nonce,
                        destinationChainId
                    )
                )
        ) revert InvalidEvent();
        if (claimedWithdrawal[withdrawalId]) revert WithdrawalAlreadyClaimed();
        claimedWithdrawal[withdrawalId] = true;
        originalToken.bridgeUnlock(withdrawalId, recipient, amount);
        emit BurnClaimed(withdrawalId, recipient, amount);
    }

    function _topicAddress(bytes32 topic) private pure returns (address) {
        if (uint256(topic) >> 160 != 0) revert InvalidEvent();
        return address(uint160(uint256(topic)));
    }
}
