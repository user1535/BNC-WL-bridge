// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeWrappedToken} from "../token/BridgeWrappedToken.sol";
import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {MPTReceiptProofCore} from "./MPTReceiptProofCore.sol";

contract LockMintReceiver {
    bytes32 private constant LOCK_DOMAIN = keccak256("WORLDLAND_BNB_BRIDGE_LOCK_V2");
    bytes32 private constant LOCK_TOPIC = keccak256("Locked(bytes32,address,address,uint256,uint64,uint256)");

    struct LockProof {
        uint256 blockNumber;
        bytes32 blockHash;
        uint256 txIndex;
        uint256 logIndex;
        bytes[] proofNodes;
    }

    BridgeWrappedToken public immutable wrappedToken;
    IHeaderSource public immutable headerSource;
    uint256 public immutable sourceChainId;
    address public immutable sourceToken;
    mapping(bytes32 => bool) public claimedTransfer;

    event LockClaimed(bytes32 indexed transferId, address indexed recipient, uint256 amount);
    error InvalidEvent();
    error TransferAlreadyClaimed();

    constructor(BridgeWrappedToken wrappedToken_, IHeaderSource headerSource_) {
        if (address(wrappedToken_) == address(0) || address(headerSource_) == address(0)) revert InvalidEvent();
        wrappedToken = wrappedToken_;
        headerSource = headerSource_;
        sourceChainId = wrappedToken_.originChainId();
        sourceToken = wrappedToken_.originToken();
    }

    function submitLockProof(LockProof calldata proof) external {
        bytes32 root = headerSource.getReceiptRoot(sourceChainId, proof.blockNumber, proof.blockHash);
        MPTReceiptProofCore.VerifiedLog memory logEntry =
            MPTReceiptProofCore.verifyLog(root, proof.txIndex, proof.logIndex, proof.proofNodes);
        if (logEntry.emitter != sourceToken || logEntry.topics.length != 4 || logEntry.topics[0] != LOCK_TOPIC) {
            revert InvalidEvent();
        }
        address sender = _topicAddress(logEntry.topics[2]);
        address recipient = _topicAddress(logEntry.topics[3]);
        if (sender == address(0) || recipient != sender || logEntry.data.length != 96) revert InvalidEvent();
        (uint256 amount, uint64 nonce, uint256 destinationChainId) =
            abi.decode(logEntry.data, (uint256, uint64, uint256));
        if (amount == 0 || destinationChainId != block.chainid) revert InvalidEvent();
        bytes32 transferId = logEntry.topics[1];
        if (
            transferId
                != keccak256(
                    abi.encode(
                        LOCK_DOMAIN,
                        sourceChainId,
                        sourceToken,
                        address(wrappedToken),
                        sender,
                        recipient,
                        amount,
                        nonce,
                        destinationChainId
                    )
                )
        ) revert InvalidEvent();
        if (claimedTransfer[transferId]) revert TransferAlreadyClaimed();
        claimedTransfer[transferId] = true;
        wrappedToken.bridgeMint(recipient, amount);
        emit LockClaimed(transferId, recipient, amount);
    }

    function _topicAddress(bytes32 topic) private pure returns (address) {
        if (uint256(topic) >> 160 != 0) revert InvalidEvent();
        return address(uint160(uint256(topic)));
    }
}

