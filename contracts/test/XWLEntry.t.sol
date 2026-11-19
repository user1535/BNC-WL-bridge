// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XWL} from "../src/token/XWL.sol";
import {BurnMintToken} from "../src/token/BurnMintToken.sol";
import {MinimalERC20} from "../src/token/MinimalERC20.sol";

interface VmEntry {
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert(bytes4) external;
}

contract XWLEntryTest {
    VmEntry private constant vm = VmEntry(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant recipient = address(0xA11CE);
    XWL private token;

    function setUp() public {
        vm.chainId(31337);
        vm.deal(address(this), 20 ether);
        token = new XWL(10 ether);
    }

    function testPaidEntryIssuesExactlyTenAndSeparatesBridgeCounters() public {
        uint256 beforeSink = address(0).balance;
        require(token.totalSupply() == 0);
        token.enter{value: 10 ether}(recipient);
        require(address(0).balance == beforeSink + 10 ether);
        require(address(token).balance == 0);
        require(token.balanceOf(recipient) == 10 ether && token.totalSupply() == 10 ether);
        require(token.totalNativeSent() == 10 ether && token.totalEntryMinted() == 10 ether);
        require(token.totalBridgeMinted() == 0 && token.totalBridgeBurned() == 0);
        vm.expectRevert(XWL.EntryCapExceeded.selector);
        token.enter{value: 1}(recipient);
    }

    function testZeroPaymentInvalidRecipientAndUnauthorizedMintRevert() public {
        uint256 beforeSink = address(0).balance;
        vm.expectRevert(BurnMintToken.InvalidAmount.selector);
        token.enter(recipient);
        vm.expectRevert(MinimalERC20.ZeroAddress.selector);
        token.enter{value: 1 ether}(address(0));
        vm.expectRevert(BurnMintToken.Unauthorized.selector);
        token.bridgeMint(bytes32(uint256(1)), recipient, 10 ether);
        require(address(0).balance == beforeSink && token.totalSupply() == 0);
    }

    function testSinkFailureRollsBackMintAndNativePayment() public {
        uint256 beforeSink = address(0).balance;
        uint256 beforePayer = address(this).balance;
        vm.etch(address(0), hex"60006000fd");
        vm.expectRevert(XWL.SinkTransferFailed.selector);
        token.enter{value: 10 ether}(recipient);
        require(address(0).balance == beforeSink && address(this).balance == beforePayer);
        require(token.balanceOf(recipient) == 0 && token.totalSupply() == 0 && token.totalNativeSent() == 0);
    }
}
