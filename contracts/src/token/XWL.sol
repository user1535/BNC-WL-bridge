// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BurnMintToken} from "./BurnMintToken.sol";

/// @notice Local entry asset. Native value sent to the sink is excluded from circulation.
contract XWL is BurnMintToken {
    address public constant ENTRY_SINK = address(0);
    uint256 public immutable entryCap;
    uint256 public totalEntryMinted;

    event EntryIssued(address indexed payer, address indexed recipient, uint256 nativeSent, uint256 xwlMinted);
    error EntryCapExceeded();
    error SinkTransferFailed();

    constructor(uint256 cap) BurnMintToken("WorldLand bridge asset", "xWL", 0, 31338) {
        if (cap == 0) revert InvalidAmount();
        entryCap = cap;
    }

    function enter(address recipient) external payable {
        uint256 amount = msg.value;
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > entryCap - totalEntryMinted) revert EntryCapExceeded();

        totalEntryMinted += amount;
        _mint(recipient, amount);
        (bool sent,) = ENTRY_SINK.call{value: amount}("");
        if (!sent) revert SinkTransferFailed();
        emit EntryIssued(msg.sender, recipient, amount, amount);
    }

    function totalNativeSent() external view returns (uint256) {
        return totalEntryMinted;
    }
}
