// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {NiloPayments} from "../NiloPayments.sol";
import {NiloPaymentsTestBase} from "./NiloPayments.Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives bounded random send / claim / recover / time-travel sequences.
contract PaymentsHandler is Test {
    NiloPayments public pay;
    MockUSDC public usdc;
    address[3] public actors;

    uint256 public sends;
    uint256 public totalSent;
    uint256 public totalClaimed;
    uint256 public totalRecovered;

    constructor(NiloPayments pay_, MockUSDC usdc_) {
        pay = pay_;
        usdc = usdc_;
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
        for (uint256 i; i < 3; ++i) {
            vm.prank(actors[i]);
            usdc.approve(address(pay), type(uint256).max);
        }
    }

    function send(uint256 fromSeed, uint256 toOffsetSeed, uint256 amountSeed, uint256 ttlSeed) external {
        uint256 fromIdx = fromSeed % 3;
        address from = actors[fromIdx];
        address to = actors[(fromIdx + 1 + (toOffsetSeed % 2)) % 3];
        uint256 amount = bound(amountSeed, 1, 1_000e6);
        uint256 ttl = bound(ttlSeed, 1, 365 days);
        usdc.mint(from, amount);
        vm.prank(from);
        pay.send(to, amount, uint64(block.timestamp + ttl), bytes32(0));
        sends++;
        totalSent += amount;
    }

    function claim(uint256 idSeed) external {
        if (pay.nextId() == 1) return;
        uint256 id = bound(idSeed, 1, pay.nextId() - 1);
        NiloPayments.Payment memory p = pay.payments(id);
        vm.prank(p.to);
        try pay.claim(id) {
            totalClaimed += p.amount;
        } catch {}
    }

    function recover(uint256 idSeed) external {
        if (pay.nextId() == 1) return;
        uint256 id = bound(idSeed, 1, pay.nextId() - 1);
        NiloPayments.Payment memory p = pay.payments(id);
        vm.prank(p.from);
        try pay.recover(id) {
            totalRecovered += p.amount;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 60 days));
    }
}

contract NiloPaymentsInvariantTest is NiloPaymentsTestBase {
    PaymentsHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PaymentsHandler(pay, usdc);
        targetContract(address(handler));
    }

    function _pendingSum() internal view returns (uint256 sum) {
        uint256 n = pay.nextId();
        for (uint256 id = 1; id < n; ++id) {
            NiloPayments.Payment memory p = pay.payments(id);
            if (p.status == PENDING) sum += p.amount;
        }
    }

    /// @dev PROPERTY: the escrow's USDC balance always equals the sum of pending payment amounts.
    function invariant_EscrowBalanceEqualsPendingSum() public view {
        assertEq(usdc.balanceOf(address(pay)), _pendingSum());
    }

    /// @dev PROPERTY: every USDC ever escrowed is either still pending, claimed, or recovered.
    function invariant_FundsConserved() public view {
        assertEq(handler.totalSent(), _pendingSum() + handler.totalClaimed() + handler.totalRecovered());
    }

    function invariant_IdsAreDenseAndMatchSends() public view {
        assertEq(pay.nextId(), handler.sends() + 1);
    }
}

contract NiloPaymentsFuzzTest is NiloPaymentsTestBase {
    function testFuzz_EscrowAccounting(uint256 amountSeed, uint256 ttlSeed, uint8 action) public {
        uint256 amount = bound(amountSeed, 1, 10_000e6);
        uint256 ttl = bound(ttlSeed, 1, 365 days);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 id = _sendTo(bob, amount, ttl);
        assertEq(usdc.balanceOf(address(pay)), amount);

        action = action % 3;
        if (action == 0) {
            vm.prank(bob);
            pay.claim(id);
            assertEq(usdc.balanceOf(bob), amount);
            assertEq(usdc.balanceOf(alice), aliceBefore - amount);
        } else if (action == 1) {
            vm.warp(pay.payments(id).claimUntil);
            vm.prank(alice);
            pay.recover(id);
            assertEq(usdc.balanceOf(alice), aliceBefore);
            assertEq(usdc.balanceOf(bob), 0);
        } else {
            uint256 sigDeadline = block.timestamp + ttl;
            bytes memory sig = _claimSig(bobPk, id, sigDeadline);
            vm.prank(relayer);
            pay.claimFor(id, sigDeadline, sig);
            assertEq(usdc.balanceOf(bob), amount);
            assertEq(usdc.balanceOf(relayer), 0);
        }
        assertEq(usdc.balanceOf(address(pay)), 0);
    }
}
