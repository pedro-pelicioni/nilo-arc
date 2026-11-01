// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloAgent} from "../NiloAgent.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockVault} from "./mocks/MockVault.sol";
import {PermitHelper} from "./mocks/PermitHelper.sol";

/// @dev Shared setup / helpers. Contains no test functions.
abstract contract NiloAgentTestBase is PermitHelper {
    NiloAgent internal agent;
    MockUSDC internal usdc;
    MockVault internal vault;
    MockVault internal vault2;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal attacker = makeAddr("attacker");
    address internal user;
    uint256 internal userPk;

    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant USER_BAL = 10_000e6;
    uint128 internal constant LIMIT = 1_000e6;
    uint64 internal constant PERIOD = 1 days;
    uint64 internal constant LIFETIME = 30 days;

    function setUp() public virtual {
        vm.warp(T0);
        (user, userPk) = makeAddrAndKey("user");
        usdc = new MockUSDC();
        vault = new MockVault(usdc);
        vault2 = new MockVault(usdc);
        agent = new NiloAgent(usdc, operator, owner);
        usdc.mint(user, USER_BAL);
        vm.prank(user);
        usdc.approve(address(agent), type(uint256).max);
    }

    function _vaults(address a) internal pure returns (address[] memory v) {
        v = new address[](1);
        v[0] = a;
    }

    function _vaults(address a, address b) internal pure returns (address[] memory v) {
        v = new address[](2);
        v[0] = a;
        v[1] = b;
    }

    function _mandate(address[] memory vs) internal view returns (NiloAgent.Mandate memory) {
        return NiloAgent.Mandate({
            limit: LIMIT,
            period: PERIOD,
            expiresAt: uint64(block.timestamp + LIFETIME),
            reserve: 0,
            profile: 1,
            vaults: vs
        });
    }

    function _defaultMandate() internal view returns (NiloAgent.Mandate memory) {
        return _mandate(_vaults(address(vault)));
    }

    function _set(NiloAgent.Mandate memory m) internal {
        vm.prank(user);
        agent.setMandate(m);
    }

    function _setDefault() internal {
        _set(_defaultMandate());
    }

    function _invest(address v, uint256 amount) internal {
        vm.prank(operator);
        agent.invest(user, v, amount);
    }

    function _expectBadMandate(NiloAgent.Mandate memory m) internal {
        vm.expectRevert(NiloAgent.BadMandate.selector);
        vm.prank(user);
        agent.setMandate(m);
    }
}
