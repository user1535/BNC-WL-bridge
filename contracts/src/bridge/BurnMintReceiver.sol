// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BurnMintToken} from "../token/BurnMintToken.sol";
import {IHeaderSource} from "../interfaces/IHeaderSource.sol";
import {MPTReceiptProofCore} from "./MPTReceiptProofCore.sol";

/// @notice Operator-root MPT/event/replay verification. RISC0 is verified by the server SDK.
contract BurnMintReceiver {
    bytes32 private constant BURN_DOMAIN = keccak256("WORLDLAND_BNB_BURN_MINT_V2");
    bytes32 private constant BURN_TOPIC = keccak256("BridgeBurned(bytes32,address,address,uint256,uint64,uint256)");
    struct BurnProof { uint256 blockNumber; bytes32 blockHash; uint256 txIndex; uint256 logIndex; bytes[] proofNodes; }
    BurnMintToken public immutable destinationToken;
    IHeaderSource public immutable headerSource;
    uint256 public immutable sourceChainId;
    address public immutable sourceToken;
    mapping(bytes32 => bool) public claimedBurn;
    uint256 public totalClaimed;
    event BurnClaimed(bytes32 indexed burnId, address indexed recipient, uint256 amount);
    error InvalidEvent();
    error BurnAlreadyClaimed();

    constructor(BurnMintToken token, IHeaderSource headers, address peer) {
        if (address(token).code.length == 0 || address(headers).code.length == 0 || peer == address(0)) revert InvalidEvent();
        destinationToken = token;
        headerSource = headers;
        sourceChainId = token.peerChainId();
        sourceToken = peer;
    }

    function submitBurnProof(BurnProof calldata proof) external {
        bytes32 root = headerSource.getReceiptRoot(sourceChainId, proof.blockNumber, proof.blockHash);
        MPTReceiptProofCore.VerifiedLog memory entry = MPTReceiptProofCore.verifyLog(root, proof.txIndex, proof.logIndex, proof.proofNodes);
        if (entry.emitter != sourceToken || entry.topics.length != 4 || entry.topics[0] != BURN_TOPIC || entry.data.length != 96) revert InvalidEvent();
        address burner = _address(entry.topics[2]);
        address recipient = _address(entry.topics[3]);
        (uint256 amount, uint64 nonce, uint256 chain) = abi.decode(entry.data, (uint256, uint64, uint256));
        if (burner == address(0) || recipient == address(0) || amount == 0 || nonce == 0 || chain != block.chainid) revert InvalidEvent();
        bytes32 burnId = entry.topics[1];
        if (burnId != keccak256(abi.encode(BURN_DOMAIN, sourceChainId, sourceToken, block.chainid,
            address(destinationToken), burner, recipient, amount, nonce))) revert InvalidEvent();
        if (destinationToken.peerToken() != sourceToken || destinationToken.mintReceiver() != address(this)) revert InvalidEvent();
        if (claimedBurn[burnId]) revert BurnAlreadyClaimed();
        claimedBurn[burnId] = true;
        totalClaimed += amount;
        destinationToken.bridgeMint(burnId, recipient, amount);
        emit BurnClaimed(burnId, recipient, amount);
    }

    function _address(bytes32 topic) private pure returns (address) {
        if (uint256(topic) >> 160 != 0) revert InvalidEvent();
        return address(uint160(uint256(topic)));
    }
}
