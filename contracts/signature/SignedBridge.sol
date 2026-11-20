// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MinimalERC20} from "../src/token/MinimalERC20.sol";

/// @notice Local prototype: the authorized operator attests to source burns.
/// No source consensus, MPT or RISC Zero verification is performed here.
abstract contract SignedBridgeToken is MinimalERC20 {
    bytes32 public constant BURN_DOMAIN = keccak256("BNC_SIGNED_BRIDGE_BURN_V1");
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "BridgeClaim(bytes32 burnId,uint256 sourceChainId,address sourceToken,address sender,address recipient,uint256 amount,uint64 nonce,bytes32 sourceTxHash,bytes32 sourceBlockHash,uint256 sourceBlockNumber,uint256 logIndex,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct BridgeClaim {
        bytes32 burnId;
        uint256 sourceChainId;
        address sourceToken;
        address sender;
        address recipient;
        uint256 amount;
        uint64 nonce;
        bytes32 sourceTxHash;
        bytes32 sourceBlockHash;
        uint256 sourceBlockNumber;
        uint256 logIndex;
        uint256 deadline;
    }

    address public immutable operatorSigner;
    address public immutable deploymentOwner;
    uint256 public immutable peerChainId;
    address public peerToken;
    uint256 public totalBridgeBurned;
    uint256 public totalBridgeMinted;
    mapping(address => uint64) public burnNonce;
    mapping(bytes32 => bool) public claimedBurn;

    event PeerBound(address indexed token);
    event BridgeBurned(bytes32 indexed burnId, address indexed sender, address indexed recipient,
        uint256 amount, uint64 nonce, uint256 destinationChainId, address destinationToken);
    event BridgeClaimed(bytes32 indexed burnId, address indexed recipient, uint256 amount, bytes32 sourceTxHash);
    error InvalidConfiguration();
    error InvalidClaim();
    error InvalidSignature();
    error AlreadyClaimed();
    error ExpiredClaim();

    constructor(string memory name_, string memory symbol_, address signer, uint256 localChain, uint256 remoteChain)
        MinimalERC20(name_, symbol_)
    {
        if (block.chainid != localChain || signer == address(0)
            || !((localChain == 31337 && remoteChain == 31338) || (localChain == 31338 && remoteChain == 31337))) {
            revert InvalidConfiguration();
        }
        operatorSigner = signer;
        deploymentOwner = msg.sender;
        peerChainId = remoteChain;
    }

    function bindPeer(address token) external {
        if (msg.sender != deploymentOwner || peerToken != address(0) || token == address(0)) revert InvalidConfiguration();
        peerToken = token;
        emit PeerBound(token);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("BNC Signed Bridge"), keccak256("1"), block.chainid, address(this)));
    }

    function burnIdFor(uint256 sourceChain, address source, uint256 destinationChain, address destination,
        address sender, address recipient, uint256 amount, uint64 nonce) public pure returns (bytes32)
    {
        return keccak256(abi.encode(BURN_DOMAIN, sourceChain, source, destinationChain, destination, sender, recipient, amount, nonce));
    }

    function bridgeBurn(uint256 amount, address recipient) external returns (bytes32 id) {
        if (amount == 0 || recipient == address(0) || peerToken == address(0)) revert InvalidClaim();
        uint64 nonce = ++burnNonce[msg.sender];
        id = burnIdFor(block.chainid, address(this), peerChainId, peerToken, msg.sender, recipient, amount, nonce);
        _burn(msg.sender, amount);
        totalBridgeBurned += amount;
        emit BridgeBurned(id, msg.sender, recipient, amount, nonce, peerChainId, peerToken);
    }

    function claimDigest(BridgeClaim calldata c) public view returns (bytes32) {
        // BridgeClaim contains only static ABI fields; encoding the struct is the
        // same field sequence specified by the EIP-712 type above.
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), keccak256(abi.encode(CLAIM_TYPEHASH, c))));
    }

    function claim(BridgeClaim calldata c, bytes calldata signature) external {
        if (block.timestamp > c.deadline) revert ExpiredClaim();
        if (peerToken == address(0) || c.sourceChainId != peerChainId || c.sourceToken != peerToken
            || c.sender == address(0) || c.recipient == address(0) || c.amount == 0 || c.nonce == 0
            || c.sourceTxHash == bytes32(0) || c.sourceBlockHash == bytes32(0)
            || c.burnId != burnIdFor(c.sourceChainId, c.sourceToken, block.chainid, address(this), c.sender, c.recipient, c.amount, c.nonce)) {
            revert InvalidClaim();
        }
        if (claimedBurn[c.burnId]) revert AlreadyClaimed();
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)
            || ecrecover(claimDigest(c), v, r, s) != operatorSigner) revert InvalidSignature();
        claimedBurn[c.burnId] = true;
        totalBridgeMinted += c.amount;
        _mint(c.recipient, c.amount);
        emit BridgeClaimed(c.burnId, c.recipient, c.amount, c.sourceTxHash);
    }
}

/// @notice WL collateral and its transferable xWL claim live in this one contract.
contract VaultXWL is SignedBridgeToken {
    uint256 public totalDeposited;
    uint256 public totalRedeemed;
    bool private paying;
    event Deposited(address indexed sender, address indexed recipient, uint256 amount);
    event Redeemed(address indexed sender, address indexed recipient, uint256 amount);
    error InvalidDeposit();
    error PayoutFailed();
    error ReentrantPayout();

    constructor(address signer) SignedBridgeToken("Vault WorldLand", "xWL", signer, 31337, 31338) {}

    function deposit(address recipient) external payable {
        if (msg.value == 0 || recipient == address(0) || recipient == address(this)) revert InvalidDeposit();
        totalDeposited += msg.value;
        _mint(recipient, msg.value);
        emit Deposited(msg.sender, recipient, msg.value);
    }

    function redeem(uint256 amount, address payable recipient) external {
        if (paying) revert ReentrantPayout();
        if (amount == 0 || recipient == address(0) || recipient == address(this) || amount > address(this).balance) revert InvalidClaim();
        paying = true;
        _burn(msg.sender, amount);
        totalRedeemed += amount;
        (bool paid,) = recipient.call{value: amount}("");
        if (!paid) revert PayoutFailed();
        paying = false;
        // Local redemption deliberately emits no BridgeBurned event.
        emit Redeemed(msg.sender, recipient, amount);
    }
}

contract SignedWWL is SignedBridgeToken {
    constructor(address signer) SignedBridgeToken("Signed Wrapped WorldLand", "wWL", signer, 31338, 31337) {}
}
