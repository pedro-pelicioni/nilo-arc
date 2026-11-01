// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloAgent} from "../NiloAgent.sol";
import {NiloAgentTestBase} from "./NiloAgent.Base.t.sol";
import {InflatedVault, ZeroSharesVault, FreeSharesVault} from "./mocks/BadVaults.sol";

/// @dev invest(), caps, reserve, expiry, access control, operator rotation, vault misbehaviour.
contract NiloAgentTest is NiloAgentTestBase {
    // ---------------------------------------------------------------- invest happy path
    function test_Invest_SharesLandOnUserAndAgentHoldsNothing() public {
        _setDefault();
        _invest(address(vault), 250e6);

        assertEq(vault.balanceOf(user), 250e6, "shares on user");
        assertEq(vault.balanceOf(address(agent)), 0, "agent holds no shares");
        assertEq(vault.balanceOf(operator), 0, "operator holds no shares");
        assertEq(usdc.balanceOf(address(agent)), 0, "agent holds no usdc");
        assertEq(usdc.allowance(address(agent), address(vault)), 0, "no residual allowance");
        assertEq(usdc.balanceOf(user), USER_BAL - 250e6, "user paid");
        assertEq(usdc.balanceOf(address(vault)), 250e6, "vault received");
        (uint64 start, uint128 spent) = agent.usageOf(user);
        assertEq(start, block.timestamp);
        assertEq(spent, 250e6);
    }

    function test_Invest_EmitsInvested() public {
        _setDefault();
        vm.expectEmit(true, true, false, true, address(agent));
        emit NiloAgent.Invested(user, address(vault), 100e6, 100e6);
        _invest(address(vault), 100e6);
    }

    function test_Invest_WorksForSecondAllowedVault() public {
        _set(_mandate(_vaults(address(vault), address(vault2))));
        _invest(address(vault2), 10e6);
        assertEq(vault2.balanceOf(user), 10e6);
        assertEq(vault.balanceOf(user), 0);
    }

    function test_Invest_ExactLimitSucceeds() public {
        _setDefault();
        _invest(address(vault), LIMIT);
        assertEq(agent.remaining(user), 0);
    }

    function test_Invest_RevertsWithoutUserAllowance() public {
        _setDefault();
        vm.prank(user);
        usdc.approve(address(agent), 0);
        vm.expectRevert();
        _invest(address(vault), 1e6);
    }

    // ---------------------------------------------------------------- validation / auth
    function test_Invest_RevertsForNonOperator() public {
        _setDefault();
        address[3] memory callers = [user, owner, attacker];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NiloAgent.NotOperator.selector);
            agent.invest(user, address(vault), 1e6);
        }
    }

    function test_Invest_RevertsNoMandate() public {
        vm.expectRevert(NiloAgent.NoMandate.selector);
        _invest(address(vault), 1e6);
    }

    function test_Invest_RevertsBadAmount() public {
        _setDefault();
        vm.expectRevert(NiloAgent.BadAmount.selector);
        _invest(address(vault), 0);
    }

    function test_Invest_RevertsVaultNotInMandate() public {
        _setDefault();
        vm.expectRevert(NiloAgent.VaultNotAllowed.selector);
        _invest(address(vault2), 1e6);
        vm.expectRevert(NiloAgent.VaultNotAllowed.selector);
        _invest(makeAddr("randomVault"), 1e6);
        vm.expectRevert(NiloAgent.VaultNotAllowed.selector);
        _invest(address(0), 1e6);
    }

    // ---------------------------------------------------------------- expiry
    function test_Invest_RevertsAtExactExpiry() public {
        _setDefault();
        uint64 exp = agent.mandateOf(user).expiresAt;
        vm.warp(exp);
        vm.expectRevert(NiloAgent.Expired.selector);
        _invest(address(vault), 1e6);
    }

    function test_Invest_SucceedsOneSecondBeforeExpiry() public {
        _setDefault();
        uint64 exp = agent.mandateOf(user).expiresAt;
        vm.warp(exp - 1);
        _invest(address(vault), 1e6);
        assertEq(vault.balanceOf(user), 1e6);
    }

    function test_Invest_RevertsLongAfterExpiry() public {
        _setDefault();
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(NiloAgent.Expired.selector);
        _invest(address(vault), 1e6);
    }

    // ---------------------------------------------------------------- cap / window
    function test_Cap_OverLimitRevertsAndLeavesStateUntouched() public {
        _setDefault();
        _invest(address(vault), 600e6);
        _invest(address(vault), 400e6);
        vm.expectRevert(NiloAgent.OverLimit.selector);
        _invest(address(vault), 1);
        assertEq(vault.balanceOf(user), LIMIT);
        assertEq(usdc.balanceOf(user), USER_BAL - LIMIT);
    }

    function test_Cap_SingleInvestAboveLimitReverts() public {
        _setDefault();
        vm.expectRevert(NiloAgent.OverLimit.selector);
        _invest(address(vault), uint256(LIMIT) + 1);
    }

    function test_Cap_WindowRollsAfterPeriod() public {
        _setDefault();
        (uint64 start,) = agent.usageOf(user);
        _invest(address(vault), LIMIT);

        vm.warp(start + PERIOD - 1);
        vm.expectRevert(NiloAgent.OverLimit.selector);
        _invest(address(vault), 1);

        vm.warp(start + PERIOD);
        _invest(address(vault), LIMIT);
        (uint64 newStart, uint128 spent) = agent.usageOf(user);
        assertEq(newStart, start + PERIOD);
        assertEq(spent, LIMIT);
        assertEq(vault.balanceOf(user), 2 * uint256(LIMIT));
    }

    function test_Cap_NewWindowStartsAtInvestTimeNotBoundary() public {
        _setDefault();
        _invest(address(vault), 1e6);
        vm.warp(block.timestamp + 5 days);
        _invest(address(vault), 1e6);
        (uint64 start, uint128 spent) = agent.usageOf(user);
        assertEq(start, block.timestamp);
        assertEq(spent, 1e6);
    }

    // ---------------------------------------------------------------- remaining()
    function test_Remaining_AcrossStates() public {
        assertEq(agent.remaining(user), 0, "no mandate");

        _setDefault();
        assertEq(agent.remaining(user), LIMIT, "fresh");

        _invest(address(vault), 300e6);
        assertEq(agent.remaining(user), LIMIT - 300e6, "after spend");

        (uint64 start,) = agent.usageOf(user);
        vm.warp(start + PERIOD - 1);
        assertEq(agent.remaining(user), LIMIT - 300e6, "end of window");

        vm.warp(start + PERIOD);
        assertEq(agent.remaining(user), LIMIT, "window rolled (view only)");
        (, uint128 spent) = agent.usageOf(user);
        assertEq(spent, 300e6, "view does not mutate");

        vm.warp(agent.mandateOf(user).expiresAt);
        assertEq(agent.remaining(user), 0, "expired");
    }

    function test_Remaining_ZeroAfterRevoke() public {
        _setDefault();
        vm.prank(user);
        agent.revoke();
        assertEq(agent.remaining(user), 0);
    }

    function test_Remaining_IgnoresUserBalanceAndAllowance() public {
        _setDefault();
        vm.prank(user);
        usdc.approve(address(agent), 0);
        vm.prank(user);
        usdc.transfer(attacker, USER_BAL);
        assertEq(agent.remaining(user), LIMIT);
    }

    // ---------------------------------------------------------------- reserve
    function test_Reserve_InvestDownToReserveSucceeds() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 20_000e6;
        m.reserve = 9_500e6;
        _set(m);
        _invest(address(vault), 500e6);
        assertEq(usdc.balanceOf(user), 9_500e6);
    }

    function test_Reserve_BreachingReserveReverts() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 20_000e6;
        m.reserve = 9_500e6;
        _set(m);
        vm.expectRevert(NiloAgent.BelowReserve.selector);
        _invest(address(vault), 500e6 + 1);
    }

    function test_Reserve_BalanceLowerThanAmountRevertsBelowReserveNotPanic() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 20_000e6;
        m.reserve = 0;
        _set(m);
        vm.expectRevert(NiloAgent.BelowReserve.selector);
        _invest(address(vault), USER_BAL + 1);
    }

    function test_Reserve_ReserveAboveBalanceBlocksEverything() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.reserve = uint128(USER_BAL + 1);
        _set(m);
        vm.expectRevert(NiloAgent.BelowReserve.selector);
        _invest(address(vault), 1);
    }

    // ---------------------------------------------------------------- revoke
    function test_Revoke_ThenInvestFailsAndSharesStayWithUser() public {
        _setDefault();
        _invest(address(vault), 200e6);
        vm.prank(user);
        agent.revoke();

        vm.expectRevert(NiloAgent.NoMandate.selector);
        _invest(address(vault), 1e6);

        assertEq(vault.balanceOf(user), 200e6, "shares remain with user");
        // user can still redeem on their own
        vm.prank(user);
        vault.redeem(200e6, user, user);
        assertEq(usdc.balanceOf(user), USER_BAL);
    }

    // ---------------------------------------------------------------- operator / ownership
    function test_SetOperator_RotatesAndEmits() public {
        address newOp = makeAddr("newOp");
        _setDefault();
        vm.expectEmit(true, true, false, false, address(agent));
        emit NiloAgent.OperatorUpdated(operator, newOp);
        vm.prank(owner);
        agent.setOperator(newOp);
        assertEq(agent.operator(), newOp);

        vm.expectRevert(NiloAgent.NotOperator.selector);
        _invest(address(vault), 1e6); // old operator

        vm.prank(newOp);
        agent.invest(user, address(vault), 1e6);
        assertEq(vault.balanceOf(user), 1e6);
    }

    function test_SetOperator_RevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        agent.setOperator(attacker);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", operator));
        agent.setOperator(operator);
    }

    function test_SetOperator_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(NiloAgent.BadAddress.selector);
        agent.setOperator(address(0));
        assertEq(agent.operator(), operator);
    }

    function test_RenounceOwnership_AlwaysReverts() public {
        vm.prank(owner);
        vm.expectRevert(NiloAgent.OwnershipChangeDisabled.selector);
        agent.renounceOwnership();
        assertEq(agent.owner(), owner);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        agent.renounceOwnership();
    }

    function test_TransferOwnership_StillWorksForKeyRotation() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        agent.transferOwnership(newOwner);
        assertEq(agent.owner(), newOwner);
        vm.prank(newOwner);
        agent.setOperator(newOwner);
        assertEq(agent.operator(), newOwner);
    }

    // ---------------------------------------------------------------- misbehaving vaults
    function test_Invest_SlippageExceededOnInflatedSharePrice() public {
        InflatedVault bad = new InflatedVault(usdc);
        _set(_mandate(_vaults(address(bad))));
        vm.expectRevert(NiloAgent.SlippageExceeded.selector);
        _invest(address(bad), 100e6);
        // whole tx reverted: nothing moved
        assertEq(usdc.balanceOf(user), USER_BAL);
        assertEq(usdc.balanceOf(address(agent)), 0);
        assertEq(bad.balanceOf(user), 0);
        (, uint128 spent) = agent.usageOf(user);
        assertEq(spent, 0, "usage not consumed");
    }

    function test_Invest_RevertsZeroShares() public {
        ZeroSharesVault bad = new ZeroSharesVault(usdc);
        _set(_mandate(_vaults(address(bad))));
        vm.expectRevert(NiloAgent.ZeroShares.selector);
        _invest(address(bad), 100e6);
    }

    function test_Invest_RevertsFundsRetainedWhenVaultDoesNotPull() public {
        FreeSharesVault bad = new FreeSharesVault(usdc);
        _set(_mandate(_vaults(address(bad))));
        vm.expectRevert(NiloAgent.FundsRetained.selector);
        _invest(address(bad), 100e6);
        assertEq(usdc.balanceOf(address(agent)), 0);
        assertEq(usdc.balanceOf(user), USER_BAL);
    }
}
