// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Core} from "./ERC20Core.sol";

contract BridgeWrappedToken is ERC20Core {
    bytes32 private constant BURN_DOMAIN = keccak256("BNC_WL_BRIDGE_BURN_V1");

    uint256 public immutable originChainId;
    address public immutable originToken;
    address public immutable mintReceiver;
    mapping(address account => uint64) public burnNonce;

    event Burned(
        bytes32 indexed withdrawalId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint64 nonce,
        uint256 destinationChainId
    );

    error Unauthorized();
    error InvalidAmount();
    error InvalidDestination();
    error NonceOverflow();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 originChainId_,
        address originToken_,
        address mintReceiver_
    ) ERC20Core(name_, symbol_) {
        if (originChainId_ == 0 || originToken_ == address(0) || mintReceiver_ == address(0)) revert InvalidAddress();
        originChainId = originChainId_;
        originToken = originToken_;
        mintReceiver = mintReceiver_;
    }

    function bridgeMint(address recipient, uint256 amount) external {
        if (msg.sender != mintReceiver) revert Unauthorized();
        if (amount == 0) revert InvalidAmount();
        _mint(recipient, amount);
    }

    function bridgeBurn(uint256 amount, address sourceRecipient, uint256 destinationChainId)
        external
        returns (bytes32 withdrawalId)
    {
        if (amount == 0) revert InvalidAmount();
        if (sourceRecipient == address(0)) revert InvalidAddress();
        if (destinationChainId != originChainId) revert InvalidDestination();

        uint64 nonce = burnNonce[msg.sender];
        if (nonce == type(uint64).max) revert NonceOverflow();
        unchecked {
            nonce++;
        }
        burnNonce[msg.sender] = nonce;
        withdrawalId = keccak256(
            abi.encode(
                BURN_DOMAIN,
                block.chainid,
                address(this),
                originToken,
                msg.sender,
                sourceRecipient,
                amount,
                nonce,
                destinationChainId
            )
        );
        _burn(msg.sender, amount);
        emit Burned(withdrawalId, msg.sender, sourceRecipient, amount, nonce, destinationChainId);
    }
}
