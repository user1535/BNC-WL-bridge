// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BurnMintToken} from "../src/token/BurnMintToken.sol";
import {BurnMintReceiver} from "../src/bridge/BurnMintReceiver.sol";
import {DevHeaderRegistry} from "../src/bridge/DevHeaderRegistry.sol";
import {IHeaderSource} from "../src/interfaces/IHeaderSource.sol";

/// @dev Deliberately insecure candidate: same header getter, but no proof gate.
contract NoProofMintReceiver {
    IHeaderSource public immutable headerSource;
    constructor(IHeaderSource headers) { headerSource = headers; }
    function mintWithoutProof(BurnMintToken token, bytes32 id, address to, uint256 amount) external {
        token.bridgeMint(id, to, amount);
    }
}

/// @dev Even a proxy that currently delegates to the correct verifier is rejected.
contract MintReceiverProxy {
    address private immutable implementation;
    constructor(address target) { implementation = target; }
    fallback() external {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}

interface VmBurnMint {
    function chainId(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function clearMockedCalls() external;
}

contract BurnMintV2Test {
    VmBurnMint constant vm = VmBurnMint(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant B = address(0xB0B);
    address constant C = address(0xCAFE);
    address constant D = address(0xD00D);
    BurnMintToken wl;
    BurnMintToken wrapped;
    BurnMintReceiver wlMint;
    BurnMintReceiver bscMint;
    DevHeaderRegistry wlHeaders;
    DevHeaderRegistry bscHeaders;
    uint256 height;

    function setUp() public {
        vm.chainId(31337);
        wl = new BurnMintToken("Local WL", "WL", 100 ether, 31338);
        wlHeaders = new DevHeaderRegistry(31338);
        vm.chainId(31338);
        wrapped = new BurnMintToken("wWL", "wWL", 0, 31337);
        bscHeaders = new DevHeaderRegistry(31337);
        bscMint = new BurnMintReceiver(wrapped, bscHeaders, address(wl));
        wrapped.bindPeer(address(wl), address(bscMint));
        vm.chainId(31337);
        wlMint = new BurnMintReceiver(wl, wlHeaders, address(wrapped));
        wl.bindPeer(address(wrapped), address(wlMint));
    }

    function _rlp(bytes memory value, bool isList) private pure returns (bytes memory) {
        uint256 n = value.length;
        if (!isList && n == 1 && uint8(value[0]) < 128) return value;
        uint8 base = isList ? 192 : 128;
        if (n < 56) return abi.encodePacked(bytes1(base+uint8(n)), value);
        if (n < 256) return abi.encodePacked(bytes1(base+56), bytes1(uint8(n)), value);
        return abi.encodePacked(bytes1(base+57), bytes2(uint16(n)), value);
    }

    function _proof(bool forward, bytes32 burnId, address burner, address recipient, uint256 amount, uint64 nonce, uint256 chain)
        private returns (BurnMintReceiver.BurnProof memory p)
    {
        address source = forward ? address(wl) : address(wrapped);
        bytes memory topics = abi.encodePacked(
            _rlp(abi.encode(keccak256("BridgeBurned(bytes32,address,address,uint256,uint64,uint256)")), false),
            _rlp(abi.encode(burnId), false), _rlp(abi.encode(burner), false), _rlp(abi.encode(recipient), false));
        bytes memory log = _rlp(abi.encodePacked(_rlp(abi.encodePacked(source), false), _rlp(topics, true),
            _rlp(abi.encode(amount, nonce, chain), false)), true);
        bytes memory receipt = _rlp(abi.encodePacked(hex"01825208", _rlp(new bytes(256), false), _rlp(log, true)), true);
        bytes[] memory nodes = new bytes[](1);
        nodes[0] = _rlp(abi.encodePacked(hex"822080", _rlp(receipt, false)), true);
        ++height;
        bytes32 blockHash = keccak256(abi.encode(height));
        (forward ? bscHeaders : wlHeaders).registerHeader(height, blockHash, keccak256(nodes[0]));
        return BurnMintReceiver.BurnProof(height, blockHash, 0, 0, nodes);
    }

    function _forward() private returns (bytes32 burnId, BurnMintReceiver.BurnProof memory p) {
        vm.chainId(31337);
        burnId = wl.bridgeBurn(10 ether, B, 31338);
        require(wl.totalSupply() == 90 ether && wl.totalBridgeBurned() == 10 ether);
        vm.chainId(31338);
        p = _proof(true, burnId, address(this), B, 10 ether, 1, 31338);
    }

    function testMPTTransferDelegatedTransferPartialBurnOtherRecipient() public {
        (, BurnMintReceiver.BurnProof memory p) = _forward();
        bscMint.submitBurnProof(p);
        vm.prank(B); wrapped.transfer(C, 3 ether);
        vm.prank(B); wrapped.approve(C, 7 ether);
        vm.prank(C); wrapped.transferFrom(B, C, 7 ether);
        require(wrapped.balanceOf(C) == 10 ether && wrapped.allowance(B,C) == 0);
        vm.prank(C); bytes32 burnId = wrapped.bridgeBurn(4 ether, D, 31337);
        require(wrapped.totalBridgeBurned() == 4 ether && wrapped.totalSupply() == 6 ether);
        vm.chainId(31337);
        wlMint.submitBurnProof(_proof(false, burnId, C, D, 4 ether, 1, 31337));
        require(wl.balanceOf(D) == 4 ether && wl.totalSupply() == 94 ether);
        require(wl.totalBridgeMinted() == 4 ether && wrapped.totalBridgeMinted() == 10 ether);
        require(wl.totalBridgeBurned() == wrapped.totalBridgeMinted());
        require(wrapped.totalBridgeBurned() == wl.totalBridgeMinted());
    }

    function testReplayAndThirdPartyClaimCannotRedirect() public {
        (bytes32 burnId, BurnMintReceiver.BurnProof memory p) = _forward();
        vm.prank(C); bscMint.submitBurnProof(p);
        require(wrapped.balanceOf(B) == 10 ether && wrapped.balanceOf(C) == 0);
        vm.expectRevert(); bscMint.submitBurnProof(p);
        require(bscMint.claimedBurn(burnId) && bscMint.totalClaimed() == 10 ether);
    }

    function testAlteredRecipientAmountChainNonceAndBurnerRejected() public {
        (bytes32 burnId,) = _forward();
        for (uint256 i; i < 5; ++i) {
            BurnMintReceiver.BurnProof memory p = _proof(true, burnId, i==4?C:address(this), i==0?D:B,
                i==1?11 ether:10 ether, i==3?2:1, i==2?31337:31338);
            vm.expectRevert(); bscMint.submitBurnProof(p);
            require(!bscMint.claimedBurn(burnId) && wrapped.totalSupply() == 0);
        }
    }

    function testWrongRootAndMissingProofRejected() public {
        (, BurnMintReceiver.BurnProof memory p) = _forward();
        bytes32 originalHash = p.blockHash; p.blockHash = bytes32(uint256(123));
        vm.expectRevert(); bscMint.submitBurnProof(p);
        p.blockHash = originalHash; p.proofNodes = new bytes[](0);
        vm.expectRevert(); bscMint.submitBurnProof(p);
    }

    function testRevertedMintRollsBackReplayAndAccountingThenRetrySucceeds() public {
        (bytes32 burnId, BurnMintReceiver.BurnProof memory p) = _forward();
        vm.mockCallRevert(address(wrapped), abi.encodeWithSelector(wrapped.bridgeMint.selector), hex"deadbeef");
        vm.expectRevert(); bscMint.submitBurnProof(p);
        require(!bscMint.claimedBurn(burnId) && bscMint.totalClaimed() == 0 && !wrapped.mintedBurn(burnId));
        vm.clearMockedCalls(); bscMint.submitBurnProof(p);
        require(wrapped.balanceOf(B) == 10 ether);
    }

    function testUnauthorizedMintAndBindingRejected() public {
        vm.expectRevert(); wl.bridgeMint(bytes32(uint256(1)), D, 1);
        vm.prank(B); vm.expectRevert(); wl.bindPeer(address(wrapped), address(wlMint));
        vm.expectRevert(); wl.bindPeer(address(wrapped), address(wlMint));
    }

    function testRevertedBurnRollsBackNonceSupplyAndCounter() public {
        vm.expectRevert(); wl.bridgeBurn(101 ether, D, 31338);
        require(wl.burnNonce(address(this)) == 0 && wl.totalSupply() == 100 ether && wl.totalBridgeBurned() == 0);
        vm.expectRevert(); wl.bridgeBurn(1, address(0), 31338);
        vm.expectRevert(); wl.bridgeBurn(1, D, 56);
    }

    function testNoWrappedGenesisOrRealChainDeployment() public {
        vm.chainId(31338); vm.expectRevert(); new BurnMintToken("w", "w", 1, 31337);
        vm.chainId(56); vm.expectRevert(); new BurnMintToken("w", "w", 0, 31337);
    }

    function testDeployerCannotBindProofBypassingReceiver() public {
        BurnMintToken fresh = new BurnMintToken("WL", "WL", 100 ether, 31338);
        NoProofMintReceiver bypass = new NoProofMintReceiver(wlHeaders);
        vm.expectRevert(); fresh.bindPeer(address(wrapped), address(bypass));
        require(fresh.peerToken() == address(0) && fresh.mintReceiver() == address(0), "failed bind changed authority");
        vm.expectRevert(); bypass.mintWithoutProof(fresh, bytes32(uint256(1)), D, 10 ether);
        require(fresh.totalSupply() == 100 ether && fresh.totalBridgeMinted() == 0, "bypass issued tokens");
        // Rejected setup is atomic; the intended exact verifier can still bind.
        BurnMintReceiver correct = new BurnMintReceiver(fresh, wlHeaders, address(wrapped));
        fresh.bindPeer(address(wrapped), address(correct));
        require(fresh.mintReceiver() == address(correct));
    }

    function testProxyAndWrongImmutableConfigurationCannotReceiveMintAuthority() public {
        BurnMintToken fresh = new BurnMintToken("WL", "WL", 100 ether, 31338);
        BurnMintReceiver correct = new BurnMintReceiver(fresh, wlHeaders, address(wrapped));
        MintReceiverProxy proxy = new MintReceiverProxy(address(correct));
        vm.expectRevert(); fresh.bindPeer(address(wrapped), address(proxy));
        BurnMintReceiver wrongDestination = new BurnMintReceiver(wl, wlHeaders, address(wrapped));
        vm.expectRevert(); fresh.bindPeer(address(wrapped), address(wrongDestination));
        BurnMintReceiver wrongSource = new BurnMintReceiver(fresh, wlHeaders, C);
        vm.expectRevert(); fresh.bindPeer(address(wrapped), address(wrongSource));
        require(fresh.peerToken() == address(0) && fresh.mintReceiver() == address(0));
    }

    function testAdminRecoveryUpgradeAndUnverifiedClaimSelectorsCannotMint() public {
        bytes[8] memory attempts = [
            abi.encodeWithSignature("mint(address,uint256)", D, 10 ether),
            abi.encodeWithSignature("ownerMint(address,uint256)", D, 10 ether),
            abi.encodeWithSignature("recoverMint(address,uint256)", D, 10 ether),
            abi.encodeWithSignature("upgradeTo(address)", D),
            abi.encodeWithSignature("setMintReceiver(address)", D),
            abi.encodeWithSignature("claimBurn(bytes32,address,uint256,bool)", bytes32(uint256(1)), D, 10 ether, true),
            abi.encodeWithSignature("initialize(address)", D),
            abi.encodeWithSignature("bridgeMint(bytes32,address,uint256)", bytes32(uint256(1)), D, 10 ether)
        ];
        for (uint256 i; i < attempts.length; ++i) {
            (bool tokenOk,) = address(wl).call(attempts[i]);
            (bool receiverOk,) = address(wlMint).call(attempts[i]);
            require(!tokenOk && !receiverOk, "unexpected privileged entrypoint");
        }
        require(wl.totalSupply() == 100 ether && wl.balanceOf(D) == 0 && wl.totalBridgeMinted() == 0);
        require(wl.mintReceiver() == address(wlMint));
    }

    function testFuzzAnyNonReceiverCannotMint(address caller, bytes32 id, uint256 amount) public {
        if (caller == address(wlMint)) return;
        vm.prank(caller); vm.expectRevert(); wl.bridgeMint(id, D, amount);
        require(wl.totalSupply() == 100 ether && wl.balanceOf(D) == 0 && wl.totalBridgeMinted() == 0);
        require(!wl.mintedBurn(id));
    }
}
