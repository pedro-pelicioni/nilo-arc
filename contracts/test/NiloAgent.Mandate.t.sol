// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloAgent} from "../NiloAgent.sol";
import {NiloAgentTestBase} from "./NiloAgent.Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockVault} from "./mocks/MockVault.sol";
import {MaliciousVault, RevertingAssetVault, NoAssetVault, DirtyAssetVault} from "./mocks/BadVaults.sol";

/// @dev Mandate validation, lifecycle (set / replace / revoke) and permit-based setting.
contract NiloAgentMandateTest is NiloAgentTestBase {
    // ---------------------------------------------------------------- constructor
    function test_Constructor_SetsState() public view {
        assertEq(address(agent.usdc()), address(usdc));
        assertEq(agent.operator(), operator);
        assertEq(agent.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(NiloAgent.BadAddress.selector);
        new NiloAgent(MockUSDC(address(0)), operator, owner);
    }

    function test_Constructor_RevertsOnZeroOperator() public {
        vm.expectRevert(NiloAgent.BadAddress.selector);
        new NiloAgent(usdc, address(0), owner);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new NiloAgent(usdc, operator, address(0));
    }

    // ---------------------------------------------------------------- validation (one bad field each)
    function test_SetMandate_RevertsOnZeroLimit() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 0;
        _expectBadMandate(m);
    }

    function test_SetMandate_RevertsOnPeriodBelow60() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.period = 59;
        _expectBadMandate(m);
    }

    function test_SetMandate_AcceptsPeriodExactly60() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.period = 60;
        _set(m);
        assertEq(agent.mandateOf(user).period, 60);
    }

    function test_SetMandate_RevertsWhenExpiryInPast() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.expiresAt = uint64(block.timestamp - 1);
        _expectBadMandate(m);
    }

    function test_SetMandate_RevertsWhenExpiryIsNow() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.expiresAt = uint64(block.timestamp);
        _expectBadMandate(m);
    }

    function test_SetMandate_AcceptsExpiryOneSecondAhead() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.expiresAt = uint64(block.timestamp + 1);
        _set(m);
        assertEq(agent.mandateOf(user).expiresAt, block.timestamp + 1);
    }

    function test_SetMandate_RevertsOnProfileAbove2() public {
        NiloAgent.Mandate memory m = _defaultMandate();
        m.profile = 3;
        _expectBadMandate(m);
        m.profile = 255;
        _expectBadMandate(m);
    }

    function test_SetMandate_AcceptsProfiles0To2() public {
        for (uint8 p; p <= 2; ++p) {
            NiloAgent.Mandate memory m = _defaultMandate();
            m.profile = p;
            _set(m);
            assertEq(agent.mandateOf(user).profile, p);
        }
    }

    function test_SetMandate_RevertsOnZeroVaults() public {
        NiloAgent.Mandate memory m = _mandate(new address[](0));
        _expectBadMandate(m);
    }

    function test_SetMandate_RevertsOnFiveVaults() public {
        address[] memory vs = new address[](5);
        for (uint256 i; i < 5; ++i) {
            vs[i] = address(new MockVault(usdc));
        }
        _expectBadMandate(_mandate(vs));
    }

    function test_SetMandate_AcceptsFourVaults() public {
        address[] memory vs = new address[](4);
        for (uint256 i; i < 4; ++i) {
            vs[i] = address(new MockVault(usdc));
        }
        _set(_mandate(vs));
        assertEq(agent.mandateOf(user).vaults.length, 4);
    }

    function test_SetMandate_RevertsOnAdjacentDuplicateVault() public {
        _expectBadMandate(_mandate(_vaults(address(vault), address(vault))));
    }

    function test_SetMandate_RevertsOnNonAdjacentDuplicateVault() public {
        address[] memory vs = new address[](3);
        vs[0] = address(vault);
        vs[1] = address(vault2);
        vs[2] = address(vault);
        _expectBadMandate(_mandate(vs));
    }

    function test_SetMandate_RevertsOnZeroAddressVault() public {
        _expectBadMandate(_mandate(_vaults(address(0))));
    }

    function test_SetMandate_RevertsOnEoaVault() public {
        _expectBadMandate(_mandate(_vaults(makeAddr("eoa"))));
    }

    function test_SetMandate_RevertsOnVaultWithOtherAsset() public {
        MockUSDC other = new MockUSDC();
        MockVault wrong = new MockVault(other);
        _expectBadMandate(_mandate(_vaults(address(wrong))));
    }

    function test_SetMandate_RevertsOnMaliciousVaultReportingOtherAsset() public {
        MaliciousVault bad = new MaliciousVault(makeAddr("fakeToken"));
        _expectBadMandate(_mandate(_vaults(address(bad))));
    }

    function test_SetMandate_RevertsWhenSecondVaultIsBad() public {
        MaliciousVault bad = new MaliciousVault(makeAddr("fakeToken"));
        _expectBadMandate(_mandate(_vaults(address(vault), address(bad))));
    }

    function test_SetMandate_RevertsOnRevertingAssetVault() public {
        _expectBadMandate(_mandate(_vaults(address(new RevertingAssetVault()))));
    }

    function test_SetMandate_RevertsOnVaultWithoutAssetFunction() public {
        _expectBadMandate(_mandate(_vaults(address(new NoAssetVault()))));
    }

    function test_SetMandate_RevertsOnMalformedAssetEncoding() public {
        _expectBadMandate(_mandate(_vaults(address(new DirtyAssetVault()))));
    }

    function test_SetMandate_FailedValidationLeavesExistingMandateIntact() public {
        _setDefault();
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 0;
        _expectBadMandate(m);
        assertEq(agent.mandateOf(user).limit, LIMIT);
    }

    // ---------------------------------------------------------------- set / events / views
    function test_SetMandate_StoresMandateAndStartsUsage() public {
        NiloAgent.Mandate memory m = _mandate(_vaults(address(vault), address(vault2)));
        m.reserve = 123e6;
        m.profile = 2;
        _set(m);
        NiloAgent.Mandate memory got = agent.mandateOf(user);
        assertEq(got.limit, m.limit);
        assertEq(got.period, m.period);
        assertEq(got.expiresAt, m.expiresAt);
        assertEq(got.reserve, 123e6);
        assertEq(got.profile, 2);
        assertEq(got.vaults.length, 2);
        assertEq(got.vaults[0], address(vault));
        assertEq(got.vaults[1], address(vault2));
        (uint64 start, uint128 spent) = agent.usageOf(user);
        assertEq(start, block.timestamp);
        assertEq(spent, 0);
        assertEq(agent.remaining(user), LIMIT);
    }

    function test_SetMandate_EmitsMandateSet() public {
        NiloAgent.Mandate memory m = _mandate(_vaults(address(vault), address(vault2)));
        m.reserve = 5e6;
        m.profile = 2;
        vm.expectEmit(true, false, false, true, address(agent));
        emit NiloAgent.MandateSet(user, m.limit, m.period, m.expiresAt, m.reserve, m.profile, m.vaults);
        _set(m);
    }

    function test_Revoke_EmitsRevokedAndClearsState() public {
        _setDefault();
        vm.expectEmit(true, false, false, true, address(agent));
        emit NiloAgent.Revoked(user);
        vm.prank(user);
        agent.revoke();
        NiloAgent.Mandate memory got = agent.mandateOf(user);
        assertEq(got.limit, 0);
        assertEq(got.vaults.length, 0);
        (uint64 start, uint128 spent) = agent.usageOf(user);
        assertEq(start, 0);
        assertEq(spent, 0);
        assertEq(agent.remaining(user), 0);
    }

    function test_Revoke_WithoutMandateIsNoopThatStillEmits() public {
        vm.expectEmit(true, false, false, true, address(agent));
        emit NiloAgent.Revoked(user);
        vm.prank(user);
        agent.revoke();
    }

    function test_SetMandate_ReplacesOldMandateAndResetsUsage() public {
        _setDefault();
        _invest(address(vault), 400e6);
        assertEq(agent.remaining(user), LIMIT - 400e6);

        NiloAgent.Mandate memory m = _mandate(_vaults(address(vault2)));
        m.limit = 2_000e6;
        m.profile = 0;
        _set(m);

        assertEq(agent.mandateOf(user).limit, 2_000e6);
        assertEq(agent.mandateOf(user).vaults.length, 1);
        assertEq(agent.mandateOf(user).vaults[0], address(vault2));
        (, uint128 spent) = agent.usageOf(user);
        assertEq(spent, 0);
        assertEq(agent.remaining(user), 2_000e6);

        // Old vault no longer allowed, new one is.
        vm.expectRevert(NiloAgent.VaultNotAllowed.selector);
        _invest(address(vault), 1e6);
        _invest(address(vault2), 2_000e6);
    }

    function test_MandatesAreIsolatedPerUser() public {
        _setDefault();
        address bob = makeAddr("bob");
        assertEq(agent.mandateOf(bob).limit, 0);
        assertEq(agent.remaining(bob), 0);
        vm.prank(operator);
        vm.expectRevert(NiloAgent.NoMandate.selector);
        agent.invest(bob, address(vault), 1e6);
    }

    // ---------------------------------------------------------------- setMandateWithPermit
    function test_SetMandateWithPermit_Success() public {
        uint256 allowance = 5_000e6;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user);
        usdc.approve(address(agent), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, userPk, user, address(agent), allowance, deadline);

        NiloAgent.Mandate memory m = _defaultMandate();
        vm.expectEmit(true, false, false, true, address(agent));
        emit NiloAgent.MandateSet(user, m.limit, m.period, m.expiresAt, m.reserve, m.profile, m.vaults);
        vm.prank(user);
        agent.setMandateWithPermit(m, allowance, deadline, v, r, s);

        assertEq(usdc.allowance(user, address(agent)), allowance);
        assertEq(agent.mandateOf(user).limit, LIMIT);
        _invest(address(vault), 100e6);
        assertEq(vault.balanceOf(user), 100e6);
    }

    function test_SetMandateWithPermit_SurvivesFrontRunPermit() public {
        uint256 allowance = 5_000e6;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user);
        usdc.approve(address(agent), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, userPk, user, address(agent), allowance, deadline);

        // Attacker consumes the permit first (nonce burned).
        vm.prank(attacker);
        usdc.permit(user, address(agent), allowance, deadline, v, r, s);
        assertEq(usdc.allowance(user, address(agent)), allowance);

        // The user's tx must still succeed because the allowance is sufficient.
        vm.prank(user);
        agent.setMandateWithPermit(_defaultMandate(), allowance, deadline, v, r, s);
        assertEq(agent.mandateOf(user).limit, LIMIT);
    }

    function test_SetMandateWithPermit_FailedPermitInsufficientAllowanceReverts() public {
        uint256 allowance = 5_000e6;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user);
        usdc.approve(address(agent), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, userPk, user, address(agent), allowance, deadline);

        // Attacker front-runs, then allowance is reduced below what the user wants.
        usdc.permit(user, address(agent), allowance, deadline, v, r, s);
        vm.prank(user);
        usdc.approve(address(agent), allowance - 1);

        NiloAgent.Mandate memory m = _defaultMandate();
        vm.expectRevert(NiloAgent.PermitFailed.selector);
        vm.prank(user);
        agent.setMandateWithPermit(m, allowance, deadline, v, r, s);
        assertEq(agent.mandateOf(user).limit, 0);
    }

    function test_SetMandateWithPermit_BadSignatureWithoutAllowanceReverts() public {
        vm.prank(user);
        usdc.approve(address(agent), 0);
        uint256 deadline = block.timestamp + 1 hours;
        (, uint256 wrongPk) = makeAddrAndKey("wrongSigner");
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, wrongPk, user, address(agent), 1_000e6, deadline);
        NiloAgent.Mandate memory m = _defaultMandate();
        vm.expectRevert(NiloAgent.PermitFailed.selector);
        vm.prank(user);
        agent.setMandateWithPermit(m, 1_000e6, deadline, v, r, s);
    }

    function test_SetMandateWithPermit_ExpiredPermitWithoutAllowanceReverts() public {
        vm.prank(user);
        usdc.approve(address(agent), 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, userPk, user, address(agent), 1_000e6, deadline);
        vm.warp(deadline + 1);
        NiloAgent.Mandate memory m = _defaultMandate();
        m.expiresAt = uint64(block.timestamp + LIFETIME);
        vm.expectRevert(NiloAgent.PermitFailed.selector);
        vm.prank(user);
        agent.setMandateWithPermit(m, 1_000e6, deadline, v, r, s);
    }

    function test_SetMandateWithPermit_BadPermitButSufficientExistingAllowanceSucceeds() public {
        // setUp already granted max allowance; garbage signature must be tolerated.
        NiloAgent.Mandate memory m = _defaultMandate();
        vm.prank(user);
        agent.setMandateWithPermit(m, 1_000e6, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(agent.mandateOf(user).limit, LIMIT);
    }

    function test_SetMandateWithPermit_InvalidMandateRevertsAndRollsBackPermit() public {
        vm.prank(user);
        usdc.approve(address(agent), 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, userPk, user, address(agent), 1_000e6, deadline);
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = 0;
        vm.expectRevert(NiloAgent.BadMandate.selector);
        vm.prank(user);
        agent.setMandateWithPermit(m, 1_000e6, deadline, v, r, s);
        assertEq(usdc.allowance(user, address(agent)), 0);
    }
}
