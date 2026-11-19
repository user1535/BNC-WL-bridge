// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface VmAudit { function chainId(uint256) external; function prank(address) external; function expectRevert(bytes4) external; }
import {DevHeaderRegistry} from "../src/bridge/DevHeaderRegistry.sol";
import {BridgeAuditLog} from "../src/bridge/BridgeAuditLog.sol";
contract BridgeAuditLogTest {
    VmAudit constant vm = VmAudit(address(uint160(uint256(keccak256("hevm cheat code")))));
    DevHeaderRegistry registry;
    function setUp() public { vm.chainId(31338); registry = new DevHeaderRegistry(31337); }
    function testInvalidCallerCannotStop() public {
        vm.prank(address(123)); vm.expectRevert(DevHeaderRegistry.Unauthorized.selector);
        registry.confirmIncident(keccak256("evidence"));
        require(!registry.auditLog().halted());
    }
    function testIncidentBlocksPreviouslyRegisteredRoot() public {
        registry.registerHeader(9, bytes32(uint256(1)), bytes32(uint256(2)));
        registry.commitAudit(keccak256("public record"));
        require(registry.auditLog().sequence()==1);
        registry.confirmIncident(keccak256("confirmed discrepancy"));
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        registry.getReceiptRoot(31337,9,bytes32(uint256(1)));
        vm.expectRevert(BridgeAuditLog.BridgeStopped.selector);
        registry.registerHeader(10,bytes32(uint256(3)),bytes32(uint256(4)));
    }
    function testMalformedHeaderDoesNotStop() public {
        vm.expectRevert(DevHeaderRegistry.InvalidHeader.selector);
        registry.registerHeader(9,bytes32(0),bytes32(0));
        require(!registry.auditLog().halted());
    }
}
