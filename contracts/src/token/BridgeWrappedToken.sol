// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MinimalERC20} from "./MinimalERC20.sol";

/// @notice Nontransferable wrapped claim for the initial same-owner roundtrip.
contract BridgeWrappedToken is MinimalERC20 {
    bytes32 private constant BURN_DOMAIN = keccak256("WORLDLAND_BNB_BRIDGE_BURN_V1");

    uint256 public immutable originChainId;
    address public immutable originToken;
    address public immutable deploymentOwner;
    address public mintReceiver;
    mapping(address => uint64) public burnNonce;

    event Burned(
        bytes32 indexed withdrawalId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint64 nonce,
        uint256 destinationChainId
    );
    event MintReceiverBound(address indexed receiver);

    error InvalidAmount();
    error InvalidChain();
    error RecipientMustBeBurner();
    error ReceiverAlreadyBound();
    error Unauthorized();
    error TransfersDisabled();

    constructor(string memory name_, string memory symbol_, uint256 originChainId_, address originToken_)
        MinimalERC20(name_, symbol_)
    {
        if (originChainId_ == 0 || originChainId_ == block.chainid) revert InvalidChain();
        if (originToken_ == address(0)) revert ZeroAddress();
        originChainId = originChainId_;
        originToken = originToken_;
        deploymentOwner = msg.sender;
    }

    function bindMintReceiver(address receiver) external {
        if (msg.sender != deploymentOwner) revert Unauthorized();
        if (mintReceiver != address(0)) revert ReceiverAlreadyBound();
        if (receiver == address(0)) revert ZeroAddress();
        mintReceiver = receiver;
        emit MintReceiverBound(receiver);
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert TransfersDisabled();
    }

    function bridgeMint(address recipient, uint256 amount) external {
        if (msg.sender != mintReceiver || mintReceiver == address(0)) revert Unauthorized();
        if (amount == 0) revert InvalidAmount();
        _mint(recipient, amount);
    }

    function bridgeBurn(uint256 amount, address sourceRecipient, uint256 destinationChainId_)
        external
        returns (bytes32 withdrawalId)
    {
        if (amount == 0) revert InvalidAmount();
        if (sourceRecipient == address(0)) revert ZeroAddress();
        if (sourceRecipient != msg.sender) revert RecipientMustBeBurner();
        if (destinationChainId_ != originChainId) revert InvalidChain();

        uint64 nonce = ++burnNonce[msg.sender];
        withdrawalId = keccak256(
            abi.encode(
                BURN_DOMAIN,
                block.chainid,
                address(this),
                originChainId,
                originToken,
                msg.sender,
                sourceRecipient,
                amount,
                nonce,
                destinationChainId_
            )
        );
        _burn(msg.sender, amount);
        emit Burned(withdrawalId, msg.sender, sourceRecipient, amount, nonce, destinationChainId_);
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal pure override {
        if (from != address(0) && to != address(0)) revert TransfersDisabled();
    }
}
