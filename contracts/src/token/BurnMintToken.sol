// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MinimalERC20} from "./MinimalERC20.sol";
import {BurnMintReceiver} from "../bridge/BurnMintReceiver.sol";

/// @notice V2 local ERC20 model. This does not create or burn native WL.
contract BurnMintToken is MinimalERC20 {
    bytes32 public constant BURN_DOMAIN = keccak256("WORLDLAND_BNB_BURN_MINT_V2");
    uint256 public immutable peerChainId;
    address public immutable deploymentOwner;
    address public peerToken;
    address public mintReceiver;
    uint256 public totalBridgeBurned;
    uint256 public totalBridgeMinted;
    mapping(address => uint64) public burnNonce;
    mapping(bytes32 => bool) public mintedBurn;

    event BridgeBurned(bytes32 indexed burnId, address indexed burner, address indexed recipient,
        uint256 amount, uint64 nonce, uint256 destinationChainId);
    event BridgeMinted(bytes32 indexed burnId, address indexed recipient, uint256 amount);
    event PeerBound(address indexed token, address indexed receiver);
    error InvalidDomain();
    error Unauthorized();
    error AlreadyBound();
    error InvalidAmount();
    error BurnAlreadyMinted();
    error UnsafeMintReceiver();

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, uint256 peerChainId_)
        MinimalERC20(name_, symbol_)
    {
        if (!((block.chainid == 31337 && peerChainId_ == 31338)
            || (block.chainid == 31338 && peerChainId_ == 31337))) revert InvalidDomain();
        if (block.chainid == 31338 && initialSupply != 0) revert InvalidAmount();
        deploymentOwner = msg.sender;
        peerChainId = peerChainId_;
        if (initialSupply != 0) _mint(msg.sender, initialSupply);
    }

    function bindPeer(address token, address receiver) external {
        if (msg.sender != deploymentOwner) revert Unauthorized();
        if (peerToken != address(0)) revert AlreadyBound();
        if (token == address(0) || receiver.code.length == 0) revert InvalidDomain();
        // CRITICAL: an address allowlist alone would let the deployer install a
        // contract that calls bridgeMint without checking a burn. Compare the
        // full deployed runtime (including immutable configuration) with a fresh
        // instance of the only permitted verifier. The extra instance receives
        // no mint authority. The header source remains the explicit trusted-root
        // assumption; this check does not authenticate source-chain consensus.
        BurnMintReceiver candidate = BurnMintReceiver(receiver);
        BurnMintReceiver verifierTemplate = new BurnMintReceiver(this, candidate.headerSource(), token);
        if (receiver.codehash != address(verifierTemplate).codehash) revert UnsafeMintReceiver();
        peerToken = token;
        mintReceiver = receiver;
        emit PeerBound(token, receiver);
    }

    function bridgeBurn(uint256 amount, address recipient, uint256 destinationChainId) external returns (bytes32 burnId) {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (peerToken == address(0) || destinationChainId != peerChainId) revert InvalidDomain();
        uint64 nonce = ++burnNonce[msg.sender];
        burnId = keccak256(abi.encode(BURN_DOMAIN, block.chainid, address(this), peerChainId,
            peerToken, msg.sender, recipient, amount, nonce));
        _burn(msg.sender, amount);
        totalBridgeBurned += amount;
        emit BridgeBurned(burnId, msg.sender, recipient, amount, nonce, peerChainId);
    }

    function bridgeMint(bytes32 burnId, address recipient, uint256 amount) external {
        // CRITICAL: bindPeer accepts only the exact non-upgradeable verifier
        // runtime. There is no owner mint, recovery mint, receiver replacement,
        // arbitrary delegatecall or other post-construction issuance path.
        if (msg.sender != mintReceiver || mintReceiver == address(0)) revert Unauthorized();
        if (burnId == bytes32(0) || amount == 0) revert InvalidAmount();
        if (mintedBurn[burnId]) revert BurnAlreadyMinted();
        mintedBurn[burnId] = true;
        totalBridgeMinted += amount;
        _mint(recipient, amount);
        emit BridgeMinted(burnId, recipient, amount);
    }
}
