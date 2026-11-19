// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DevHeaderRegistry} from "../src/bridge/DevHeaderRegistry.sol";
import {NativeWLVault, NativeWLVaultCore} from "../src/bridge/NativeWLVault.sol";
import {VaultReceipt} from "../src/bridge/VaultReceipt.sol";
import {VaultWrappedWL, VaultWrappedWLCore} from "../src/token/VaultWrappedWL.sol";

interface VmVault {
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract GatedRecipient {
    bool public accepting;
    function acceptPayments() external { accepting = true; }
    receive() external payable { require(accepting); }
}

contract NativeWLVaultTest {
    VmVault private constant vm = VmVault(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant A = address(0xA11);
    address private constant B = address(0xB0B);
    address private constant C = address(0xCAFE);
    NativeWLVault private vault;
    VaultWrappedWL private wrapped;
    DevHeaderRegistry private wlHeaders;
    DevHeaderRegistry private bscHeaders;
    uint256 private height;

    function setUp() public {
        vm.chainId(31337);
        wlHeaders = new DevHeaderRegistry(31338);
        vault = new NativeWLVault(wlHeaders);
        vm.deal(A, 20 ether);
        vm.chainId(31338);
        bscHeaders = new DevHeaderRegistry(31337);
        wrapped = new VaultWrappedWL(bscHeaders, address(vault));
        vm.chainId(31337);
        vault.bindWrappedToken(address(wrapped));
    }

    function testNativeDepositThirdPartyMintAndTransferableRedemption() public {
        bytes32 lockId = _mintToB();
        vm.prank(B);
        wrapped.approve(C, 10 ether);
        vm.prank(C);
        wrapped.transferFrom(B, C, 10 ether);
        vm.prank(C);
        bytes32 burnId = wrapped.bridgeBurn(4 ether, B, 31337);
        require(wrapped.balanceOf(C) == 6 ether && wrapped.totalSupply() == 6 ether);
        vm.chainId(31337);
        VaultReceipt.Proof memory release = _proof(false, burnId, C, B, 4 ether, 1);
        vault.submitBurnProof(release);
        require(B.balance == 4 ether && A.balance == 10 ether);
        require(address(vault).balance == 6 ether && vault.totalLocked() == 10 ether && vault.totalReleased() == 4 ether);
        require(wrapped.claimedTransfer(lockId) && vault.claimedWithdrawal(burnId));
        vm.expectRevert(NativeWLVaultCore.WithdrawalAlreadyClaimed.selector);
        vault.submitBurnProof(release);
    }

    function testPayoutFailurePreservesProofAndCollateralForRetry() public {
        _mintToB();
        GatedRecipient recipient = new GatedRecipient();
        vm.prank(B);
        bytes32 id = wrapped.bridgeBurn(10 ether, address(recipient), 31337);
        vm.chainId(31337);
        VaultReceipt.Proof memory proof = _proof(false, id, B, address(recipient), 10 ether, 1);
        vm.expectRevert(NativeWLVaultCore.PayoutFailed.selector);
        vault.submitBurnProof(proof);
        require(!vault.claimedWithdrawal(id) && address(vault).balance == 10 ether && vault.totalReleased() == 0);
        recipient.acceptPayments();
        vault.submitBurnProof(proof);
        require(address(recipient).balance == 10 ether && vault.claimedWithdrawal(id));
    }

    function testRejectsExcessReleaseEvenWithRegisteredRoot() public {
        uint256 amount = 1 ether;
        bytes32 id = VaultReceipt.transferId(31338, address(wrapped), 31337, address(vault), B, C, amount, 1);
        VaultReceipt.Proof memory proof = _proof(false, id, B, C, amount, 1);
        vm.expectRevert(NativeWLVaultCore.InsufficientCollateral.selector);
        vault.submitBurnProof(proof);
        require(!vault.claimedWithdrawal(id));
    }

    function testMutatedLockDataAndReplayRejected() public {
        vm.prank(A);
        bytes32 id = vault.lock{value: 10 ether}(B);
        vm.chainId(31338);
        VaultReceipt.Proof memory wrongRecipient = _proof(true, id, A, C, 10 ether, 1);
        VaultReceipt.Proof memory wrongAmount = _proof(true, id, A, B, 9 ether, 1);
        vm.expectRevert(VaultReceipt.InvalidEvent.selector);
        wrapped.submitLockProof(wrongRecipient);
        vm.expectRevert(VaultReceipt.InvalidEvent.selector);
        wrapped.submitLockProof(wrongAmount);
        require(wrapped.totalSupply() == 0);
        VaultReceipt.Proof memory valid = _proof(true, id, A, B, 10 ether, 1);
        wrapped.submitLockProof(valid);
        vm.expectRevert(VaultWrappedWLCore.TransferAlreadyClaimed.selector);
        wrapped.submitLockProof(valid);
    }

    function testZeroInputsBindingAndUnverifiedMintRejected() public {
        vm.expectRevert(NativeWLVaultCore.InvalidDeposit.selector);
        vault.lock(B);
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        vault.bindWrappedToken(C);
        NativeWLVault unbound = new NativeWLVault(wlHeaders);
        vm.prank(B);
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        unbound.bindWrappedToken(C);
        vm.chainId(31338);
        (bool directMint,) = address(wrapped).call(abi.encodeWithSignature("bridgeMint(address,uint256)", B, 1));
        require(!directMint && wrapped.totalSupply() == 0);
        vm.expectRevert(VaultWrappedWLCore.InvalidBurn.selector);
        wrapped.bridgeBurn(1, C, 31338);
    }

    function _mintToB() private returns (bytes32 id) {
        vm.prank(A);
        id = vault.lock{value: 10 ether}(B);
        require(A.balance == 10 ether && address(vault).balance == 10 ether);
        vm.chainId(31338);
        VaultReceipt.Proof memory proof = _proof(true, id, A, B, 10 ether, 1);
        // The proof commits to B even when a different wallet submits it.
        vm.prank(C);
        wrapped.submitLockProof(proof);
        require(wrapped.balanceOf(B) == 10 ether && wrapped.balanceOf(C) == 0);
    }

    function _proof(bool forward, bytes32 id, address sender, address recipient, uint256 amount, uint64 nonce)
        private returns (VaultReceipt.Proof memory)
    {
        address source = forward ? address(vault) : address(wrapped);
        bytes32 topic = forward ? VaultReceipt.LOCK_TOPIC : VaultReceipt.BURN_TOPIC;
        bytes memory topics = abi.encodePacked(_rlp(abi.encode(topic), false), _rlp(abi.encode(id), false),
            _rlp(abi.encode(sender), false), _rlp(abi.encode(recipient), false));
        bytes memory log = _rlp(abi.encodePacked(_rlp(abi.encodePacked(source), false), _rlp(topics, true),
            _rlp(abi.encode(amount, nonce, block.chainid), false)), true);
        bytes memory receipt = _rlp(abi.encodePacked(hex"01825208", _rlp(new bytes(256), false), _rlp(log, true)), true);
        bytes[] memory nodes = new bytes[](1);
        nodes[0] = _rlp(abi.encodePacked(hex"822080", _rlp(receipt, false)), true);
        ++height;
        bytes32 blockHash = keccak256(abi.encode(height));
        (forward ? bscHeaders : wlHeaders).registerHeader(height, blockHash, keccak256(nodes[0]));
        return VaultReceipt.Proof(height, blockHash, 0, 0, nodes);
    }

    function _rlp(bytes memory value, bool isList) private pure returns (bytes memory) {
        uint256 n = value.length;
        if (!isList && n == 1 && uint8(value[0]) < 128) return value;
        uint8 base = isList ? 192 : 128;
        if (n < 56) return abi.encodePacked(bytes1(base + uint8(n)), value);
        if (n < 256) return abi.encodePacked(bytes1(base + 56), bytes1(uint8(n)), value);
        return abi.encodePacked(bytes1(base + 57), bytes2(uint16(n)), value);
    }
}
