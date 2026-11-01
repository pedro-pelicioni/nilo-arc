// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloAgent} from "../NiloAgent.sol";
import {NiloAgentTestBase} from "./NiloAgent.Base.t.sol";

contract NiloAgentFuzzTest is NiloAgentTestBase {
    uint256 internal constant N = 6;

    /// @dev Models the rolling window off-chain and checks: spend in a window never exceeds `limit`,
    /// OverLimit is the revert iff amount > limit - spent, and remaining() matches the model.
    function testFuzz_PeriodCapNeverExceeded(
        uint128 limitSeed,
        uint64 periodSeed,
        uint256[N] memory amountSeeds,
        uint32[N] memory dtSeeds
    ) public {
        uint128 limit = uint128(bound(limitSeed, 1e6, 5_000e6));
        uint64 period = uint64(bound(periodSeed, 60, 7 days));
        usdc.mint(user, 1_000_000e6); // plenty of balance so BelowReserve never interferes

        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = limit;
        m.period = period;
        m.expiresAt = uint64(block.timestamp + 365 days);
        _set(m);

        uint256 windowStart = block.timestamp;
        uint256 spent;
        uint256 totalInvested;

        for (uint256 i; i < N; ++i) {
            vm.warp(block.timestamp + bound(dtSeeds[i], 0, uint256(period) * 2));
            uint256 amount = bound(amountSeeds[i], 1, uint256(limit) + uint256(limit) / 2);

            // model: a window roll only persists if the invest succeeds (a revert undoes it)
            uint256 effStart = windowStart;
            uint256 effSpent = spent;
            if (block.timestamp >= windowStart + period) {
                effStart = block.timestamp;
                effSpent = 0;
            }
            assertEq(agent.remaining(user), uint256(limit) - effSpent, "remaining matches model");

            if (amount > uint256(limit) - effSpent) {
                vm.expectRevert(NiloAgent.OverLimit.selector);
                _invest(address(vault), amount);
            } else {
                _invest(address(vault), amount);
                spent = effSpent + amount;
                windowStart = effStart;
                totalInvested += amount;
            }

            assertLe(spent, limit, "window spend within limit");
            (uint64 start, uint128 onchainSpent) = agent.usageOf(user);
            assertEq(onchainSpent, spent);
            assertEq(start, windowStart);
        }
        assertEq(vault.balanceOf(user), totalInvested);
        assertEq(usdc.balanceOf(address(agent)), 0);
    }

    /// @dev Reserve property: after any successful invest the user's balance is >= reserve.
    function testFuzz_ReserveAlwaysRespected(uint128 reserveSeed, uint256 amountSeed) public {
        uint128 reserve = uint128(bound(reserveSeed, 0, USER_BAL + 1e6));
        uint256 amount = bound(amountSeed, 1, USER_BAL + 1e6);
        NiloAgent.Mandate memory m = _defaultMandate();
        m.limit = type(uint128).max;
        m.reserve = reserve;
        _set(m);

        if (amount > USER_BAL || USER_BAL - amount < reserve) {
            vm.expectRevert(NiloAgent.BelowReserve.selector);
            _invest(address(vault), amount);
        } else {
            _invest(address(vault), amount);
            assertGe(usdc.balanceOf(user), reserve);
        }
        assertEq(usdc.balanceOf(address(agent)), 0);
    }
}
