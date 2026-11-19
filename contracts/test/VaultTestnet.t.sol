// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultTestnetRegistry, VaultTestnetWL, VaultTestnetWrappedWL} from "../testnet/VaultTestnet.sol";
import {NativeWLVaultCore} from "../src/bridge/NativeWLVault.sol";
import {VaultWrappedWLCore} from "../src/token/VaultWrappedWL.sol";
import {BridgeAuditLog} from "../src/bridge/BridgeAuditLog.sol";
import {VaultReceipt} from "../src/bridge/VaultReceipt.sol";

interface VmVaultTestnet {
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract NonPayableTestRecipient {
    function recover(VaultTestnetWL vault, VaultReceipt.Proof calldata proof, address payable to) external {
        vault.submitBurnProofTo(proof, to);
    }
}

contract VaultTestnetTest {
    VmVaultTestnet private constant vm = VmVaultTestnet(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0xA11CE);
    address private constant BINDER = address(0xB1D);
    address private constant USER = address(0xC0DE);

    function testBothDeploymentDomainsAndIndependentBindingAuthority() public {
        vm.chainId(10359);
        VaultTestnetRegistry wlRegistry = new VaultTestnetRegistry(97, OPERATOR);
        VaultTestnetWL vault = new VaultTestnetWL(wlRegistry, BINDER);
        vm.chainId(97);
        VaultTestnetRegistry bnbRegistry = new VaultTestnetRegistry(10359, OPERATOR);
        VaultTestnetWrappedWL wrapped = new VaultTestnetWrappedWL(bnbRegistry, address(vault));
        require(wrapped.totalSupply() == 0 && wrapped.sourceChainId() == 10359);
        require(wrapped.sourceToken() == address(vault) && address(wrapped.headerSource()) == address(bnbRegistry));
        vm.chainId(10359);
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        vault.bindWrappedToken(address(wrapped));
        vm.prank(BINDER);
        vault.bindWrappedToken(address(wrapped));
        require(vault.sourceToken() == address(wrapped) && vault.sourceChainId() == 97);
        vm.deal(USER, 10 ether);
        vm.prank(USER);
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        vault.lock{value: 10 ether}(OPERATOR);
        activate(wlRegistry, address(vault), address(wrapped));
        vm.prank(BINDER);
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        vault.bindWrappedToken(USER);
        vm.prank(USER);
        vm.expectRevert(NativeWLVaultCore.InvalidDeposit.selector);
        vault.lock{value: 10 ether}(address(wrapped));
        vm.prank(USER);
        bytes32 transferId = vault.lock{value: 10 ether}(OPERATOR);
        require(transferId != bytes32(0) && address(vault).balance == 10 ether && vault.totalLocked() == 10 ether);
        vm.prank(OPERATOR);
        wlRegistry.confirmIncident(keccak256("pause"));
        vm.deal(USER, 1 ether);
        vm.prank(USER);
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        vault.lock{value: 1 ether}(OPERATOR);
    }

    function testRootOperatorConflictAndStop() public {
        vm.chainId(97);
        VaultTestnetRegistry registry = new VaultTestnetRegistry(10359, OPERATOR);
        VaultTestnetWrappedWL wrapped = new VaultTestnetWrappedWL(registry, BINDER);
        activate(registry, address(wrapped), BINDER);
        bytes32 blockHash = keccak256("block");
        bytes32 root = keccak256("root");
        vm.expectRevert(VaultTestnetRegistry.Unauthorized.selector);
        registry.registerHeader(1, blockHash, root);
        vm.prank(OPERATOR);
        registry.registerHeader(1, blockHash, root);
        require(registry.getReceiptRoot(10359, 1, blockHash) == root);
        vm.prank(OPERATOR);
        vm.expectRevert(VaultTestnetRegistry.HeaderConflict.selector);
        registry.registerHeader(1, blockHash, keccak256("different"));
        vm.prank(OPERATOR);
        registry.confirmIncident(keccak256("evidence"));
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        registry.getReceiptRoot(10359, 1, blockHash);
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        wrapped.bridgeBurn(1, USER, 10359);
        bytes32 newRoot = keccak256("canonical");
        vm.prank(OPERATOR);
        registry.replaceHeader(1, blockHash, root, blockHash, newRoot);
        vm.prank(OPERATOR);
        registry.activate(address(wrapped), BINDER);
        require(registry.getReceiptRoot(10359, 1, blockHash) == newRoot);
    }

    function testMainnetAndMismatchedPeerAreRejected() public {
        vm.chainId(10359);
        vm.expectRevert(VaultTestnetRegistry.InvalidHeader.selector);
        new VaultTestnetRegistry(56, OPERATOR);
        VaultTestnetRegistry registry = new VaultTestnetRegistry(97, OPERATOR);
        vm.chainId(103);
        vm.expectRevert(VaultTestnetRegistry.InvalidHeader.selector);
        new VaultTestnetRegistry(97, OPERATOR);
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        new VaultTestnetWL(registry, BINDER);
    }

    function testRecipientRecoveryAndConsumedRootProtection() public {
        vm.chainId(10359);
        VaultTestnetRegistry registry = new VaultTestnetRegistry(97, OPERATOR);
        VaultTestnetWL vault = new VaultTestnetWL(registry, BINDER);
        address wrapped = address(0x1234);
        vm.prank(BINDER);
        vault.bindWrappedToken(wrapped);
        activate(registry, address(vault), wrapped);
        vm.deal(USER, 10 ether);
        vm.prank(USER);
        vault.lock{value: 10 ether}(USER);
        NonPayableTestRecipient recipient = new NonPayableTestRecipient();
        bytes32 id = VaultReceipt.transferId(97, wrapped, 10359, address(vault), USER, address(recipient), 10 ether, 1);
        VaultReceipt.Proof memory proof = makeProof(VaultReceipt.BURN_TOPIC, id, wrapped, address(recipient), 10359);
        bytes32 root = keccak256(proof.proofNodes[0]);
        vm.prank(OPERATOR);
        registry.registerHeader(1, proof.blockHash, root);
        vm.expectRevert(NativeWLVaultCore.PayoutFailed.selector);
        vault.submitBurnProof(proof);
        require(!registry.consumedHeaders(1));
        vm.expectRevert(NativeWLVaultCore.InvalidConfiguration.selector);
        vault.submitBurnProofTo(proof, payable(USER));
        recipient.recover(vault, proof, payable(USER));
        require(vault.claimedWithdrawal(id) && registry.consumedHeaders(1) && USER.balance == 10 ether);
        vm.expectRevert(NativeWLVaultCore.WithdrawalAlreadyClaimed.selector);
        recipient.recover(vault, proof, payable(USER));
        vm.prank(OPERATOR);
        registry.confirmIncident(keccak256("reorg"));
        vm.prank(OPERATOR);
        vm.expectRevert(VaultTestnetRegistry.HeaderConsumed.selector);
        registry.replaceHeader(1, proof.blockHash, root, bytes32(0), bytes32(0));
    }

    function testMintAndHolderTransfersWhileBridgeCanPause() public {
        vm.chainId(97);
        VaultTestnetRegistry registry = new VaultTestnetRegistry(10359, OPERATOR);
        VaultTestnetWrappedWL wrapped = new VaultTestnetWrappedWL(registry, BINDER);
        activate(registry, address(wrapped), BINDER);
        bytes32 id = VaultReceipt.transferId(10359, BINDER, 97, address(wrapped), USER, USER, 10 ether, 1);
        VaultReceipt.Proof memory proof = makeProof(VaultReceipt.LOCK_TOPIC, id, BINDER, USER, 97);
        vm.prank(OPERATOR);
        registry.registerHeader(1, proof.blockHash, keccak256(proof.proofNodes[0]));
        wrapped.submitLockProof(proof);
        require(registry.consumedHeaders(1) && wrapped.balanceOf(USER) == 10 ether);
        vm.prank(USER);
        vm.expectRevert(VaultWrappedWLCore.InvalidBurn.selector);
        wrapped.transfer(address(wrapped), 1 ether);
        vm.prank(OPERATOR);
        registry.confirmIncident(keccak256("pause"));
        vm.prank(USER);
        wrapped.transfer(BINDER, 4 ether);
        require(wrapped.balanceOf(BINDER) == 4 ether && wrapped.totalSupply() == 10 ether);
        vm.prank(BINDER);
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        wrapped.bridgeBurn(4 ether, USER, 10359);
        vm.prank(OPERATOR);
        registry.activate(address(wrapped), BINDER);
        vm.prank(BINDER);
        wrapped.bridgeBurn(4 ether, USER, 10359);
        require(wrapped.balanceOf(BINDER) == 0 && wrapped.totalSupply() == 6 ether);
    }

    function makeProof(bytes32 topic, bytes32 id, address source, address recipient, uint256 destination)
        private
        pure
        returns (VaultReceipt.Proof memory)
    {
        bytes memory topics = abi.encodePacked(
            hex"a0", topic, hex"a0", id, hex"a0", abi.encode(USER), hex"a0", abi.encode(recipient)
        );
        bytes memory data = abi.encode(10 ether, uint64(1), destination);
        bytes memory log = rlp(abi.encodePacked(hex"94", source, rlp(topics, 192), rlp(data, 128)), 192);
        bytes memory receipt = rlp(abi.encodePacked(hex"01825208", rlp(new bytes(256), 128), rlp(log, 192)), 192);
        bytes[] memory nodes = new bytes[](1);
        nodes[0] = rlp(abi.encodePacked(hex"822080", rlp(receipt, 128)), 192);
        return VaultReceipt.Proof(1, keccak256("block"), 0, 0, nodes);
    }

    function activate(VaultTestnetRegistry registry, address endpoint, address peer) private {
        vm.prank(OPERATOR);
        registry.configureBridge(endpoint);
        vm.prank(OPERATOR);
        registry.activate(endpoint, peer);
    }

    function rlp(bytes memory value, uint8 base) private pure returns (bytes memory) {
        if (value.length < 56) return abi.encodePacked(bytes1(base + uint8(value.length)), value);
        if (value.length < 256) return abi.encodePacked(bytes1(base + 56), bytes1(uint8(value.length)), value);
        return abi.encodePacked(bytes1(base + 57), bytes2(uint16(value.length)), value);
    }
}
