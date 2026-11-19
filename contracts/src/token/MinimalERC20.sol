// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Small ERC-20 core for the local bridge prototype. This is not an audited library.
abstract contract MinimalERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) public virtual returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 current = allowance[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = current - amount;
            emit Approval(from, msg.sender, current - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        _beforeTokenTransfer(from, to, amount);
        uint256 current = balanceOf[from];
        if (current < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = current - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (from == address(0)) revert ZeroAddress();
        _beforeTokenTransfer(from, address(0), amount);
        uint256 current = balanceOf[from];
        if (current < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = current - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal view virtual {
        from;
        to;
        amount;
    }
}

