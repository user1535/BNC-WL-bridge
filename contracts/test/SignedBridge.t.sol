// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SignedBridgeToken, VaultXWL, SignedWWL} from "../signature/SignedBridge.sol";

interface VmSignedBridge {
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function warp(uint256) external;
}
contract RejectWLPayout {
    bool public accepts;
    function accept() external { accepts = true; }
    receive() external payable { require(accepts); }
}
contract SignedBridgeTest {
    VmSignedBridge private constant vm = VmSignedBridge(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant KEY = 712;
    address private constant A = address(0xA11);
    address private constant B = address(0xB0B);
    address private constant C = address(0xCAFE);
    VaultXWL private xwl;
    SignedWWL private wwl;

    function setUp() public {
        address signer = vm.addr(KEY);
        vm.chainId(31337);
        xwl = new VaultXWL(signer);
        vm.deal(A, 20 ether);
        vm.chainId(31338);
        wwl = new SignedWWL(signer);
        wwl.bindPeer(address(xwl));
        vm.chainId(31337);
        xwl.bindPeer(address(wwl));
    }

    function _deposit() private {
        vm.chainId(31337);
        vm.prank(A);
        xwl.deposit{value: 10 ether}(A);
    }

    function _claimData(bool forward, address sender, address recipient, uint256 amount, uint64 nonce)
        private view returns (SignedBridgeToken.BridgeClaim memory c)
    {
        c.sourceChainId = forward ? 31337 : 31338;
        c.sourceToken = forward ? address(xwl) : address(wwl);
        c.sender = sender; c.recipient = recipient; c.amount = amount; c.nonce = nonce;
        c.burnId = xwl.burnIdFor(c.sourceChainId, c.sourceToken, forward ? 31338 : 31337,
            forward ? address(wwl) : address(xwl), sender, recipient, amount, nonce);
        c.sourceTxHash = bytes32(uint256(123)); c.sourceBlockHash = bytes32(uint256(456));
        c.sourceBlockNumber = 1; c.logIndex = 0; c.deadline = block.timestamp + 1 hours;
    }

    function _signature(SignedBridgeToken token, SignedBridgeToken.BridgeClaim memory c, uint256 key) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, token.claimDigest(c));
        return abi.encodePacked(r, s, v);
    }

    function _forward() private returns (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) {
        _deposit();
        vm.prank(A);
        xwl.bridgeBurn(10 ether, B);
        vm.chainId(31338);
        c = _claimData(true, A, B, 10 ether, 1);
        sig = _signature(wwl, c, KEY);
    }

    function testRoundtripTransferThirdPartyClaimAndLocalRedemption() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        vm.prank(C); wwl.claim(c, sig);
        require(wwl.balanceOf(B) == 10 ether && wwl.balanceOf(C) == 0);
        vm.prank(B); wwl.approve(C, 10 ether);
        vm.prank(C); wwl.transferFrom(B, C, 10 ether);
        vm.prank(C); wwl.bridgeBurn(10 ether, B);
        vm.chainId(31337);
        c = _claimData(false, C, B, 10 ether, 1);
        sig = _signature(xwl, c, KEY);
        vm.prank(A); xwl.claim(c, sig);
        vm.prank(B); xwl.redeem(10 ether, payable(C));
        require(C.balance == 10 ether && address(xwl).balance == 0);
        require(xwl.totalSupply() == 0 && wwl.totalSupply() == 0);
        require(xwl.totalDeposited() == 10 ether && xwl.totalRedeemed() == 10 ether);
    }

    function testLocalTransferAndRedemptionNeedNoOperatorSignature() public {
        _deposit();
        vm.prank(A); xwl.transfer(B, 4 ether);
        vm.prank(B); xwl.redeem(4 ether, payable(C));
        require(C.balance == 4 ether && xwl.balanceOf(A) == 6 ether);
        require(xwl.totalBridgeBurned() == 0 && xwl.burnNonce(B) == 0);
    }

    function testReplayRejectedEvenWithFreshDeadlineSignature() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        wwl.claim(c, sig);
        c.deadline += 100;
        sig = _signature(wwl, c, KEY);
        vm.expectRevert(SignedBridgeToken.AlreadyClaimed.selector); wwl.claim(c, sig);
    }

    function testWrongSignerAndTamperedSourceMetadataRejected() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        bytes memory other = _signature(wwl, c, 713);
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); wwl.claim(c, other);
        c.sourceTxHash = bytes32(uint256(124));
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); wwl.claim(c, sig);
        require(wwl.totalSupply() == 0 && !wwl.claimedBurn(c.burnId));
    }

    function testTamperedRecipientAmountAndPeerRejected() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        c.recipient = C;
        vm.expectRevert(SignedBridgeToken.InvalidClaim.selector); wwl.claim(c, sig);
        c.recipient = B; c.amount++;
        vm.expectRevert(SignedBridgeToken.InvalidClaim.selector); wwl.claim(c, sig);
        c.amount--; c.sourceToken = C;
        vm.expectRevert(SignedBridgeToken.InvalidClaim.selector); wwl.claim(c, sig);
    }

    function testExpiredClaimRejected() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        vm.warp(c.deadline + 1);
        vm.expectRevert(SignedBridgeToken.ExpiredClaim.selector); wwl.claim(c, sig);
    }

    function testSignatureDomainCannotMoveBetweenChainsOrContracts() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        SignedWWL other = new SignedWWL(vm.addr(KEY)); other.bindPeer(address(xwl));
        c.burnId = other.burnIdFor(31337, address(xwl), 31338, address(other), A, B, c.amount, 1);
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); other.claim(c, sig);
    }

    function testPayoutFailureIsAtomicAndRetryable() public {
        _deposit(); RejectWLPayout target = new RejectWLPayout();
        vm.prank(A); vm.expectRevert(VaultXWL.PayoutFailed.selector); xwl.redeem(10 ether, payable(address(target)));
        require(xwl.balanceOf(A) == 10 ether && xwl.totalRedeemed() == 0 && address(xwl).balance == 10 ether);
        target.accept(); vm.prank(A); xwl.redeem(10 ether, payable(address(target)));
        require(address(target).balance == 10 ether && xwl.totalSupply() == 0);
    }

    function testNoZeroDepositAndNoPeerReplacement() public {
        vm.expectRevert(VaultXWL.InvalidDeposit.selector); xwl.deposit(A);
        vm.expectRevert(SignedBridgeToken.InvalidConfiguration.selector); xwl.bindPeer(C);
    }

    function testSignatureLengthHighSAndBadVRejected() public {
        (SignedBridgeToken.BridgeClaim memory c, bytes memory sig) = _forward();
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); wwl.claim(c, new bytes(64));
        sig[64] = bytes1(uint8(1));
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); wwl.claim(c, sig);
        sig = _signature(wwl, c, KEY);
        for (uint256 i = 32; i < 64; i++) sig[i] = bytes1(uint8(255));
        vm.expectRevert(SignedBridgeToken.InvalidSignature.selector); wwl.claim(c, sig);
    }

    function testRevertedBurnDoesNotConsumeNonceOrSupply() public {
        _deposit();
        vm.prank(A); vm.expectRevert(bytes4(keccak256("InsufficientBalance()"))); xwl.bridgeBurn(11 ether, B);
        require(xwl.burnNonce(A) == 0 && xwl.totalBridgeBurned() == 0 && xwl.balanceOf(A) == 10 ether);
    }

    function testNoOwnerMintOrNativeEntryOnWrappedSide() public {
        vm.chainId(31338);
        (bool minted,) = address(wwl).call(abi.encodeWithSignature("mint(address,uint256)", A, 10 ether));
        (bool deposited,) = address(wwl).call(abi.encodeWithSignature("deposit(address)", A));
        require(!minted && !deposited && wwl.totalSupply() == 0);
    }

    function testFuzzLocalTransferRedemptionConservation(uint96 input, uint96 portion) public {
        uint256 amount = uint256(input) % (100000 ether) + 1;
        uint256 part = uint256(portion) % (amount + 1);
        vm.chainId(31337); vm.deal(A, amount);
        vm.prank(A); xwl.deposit{value: amount}(A);
        vm.prank(A); xwl.transfer(B, part);
        if (part != 0) { vm.prank(B); xwl.redeem(part, payable(B)); }
        if (amount != part) { vm.prank(A); xwl.redeem(amount - part, payable(A)); }
        require(address(xwl).balance == 0 && xwl.totalSupply() == 0 && xwl.totalDeposited() == xwl.totalRedeemed());
        require(xwl.totalBridgeBurned() == 0 && xwl.totalBridgeMinted() == 0);
    }
}
