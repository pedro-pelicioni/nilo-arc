// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloPayments} from "../NiloPayments.sol";
import {NiloPaymentsTestBase} from "./NiloPayments.Base.t.sol";
import {MockUSDC, FeeOnTransferUSDC} from "./mocks/MockUSDC.sol";

/// @dev send / claim / recover / views.
contract NiloPaymentsTest is NiloPaymentsTestBase {
    // ---------------------------------------------------------------- constructor
    function test_Constructor_SetsUsdcAndStartsIdsAtOne() public view {
        assertEq(address(pay.usdc()), address(usdc));
        assertEq(pay.nextId(), 1);
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(NiloPayments.BadPayment.selector);
        new NiloPayments(MockUSDC(address(0)));
    }

    // ---------------------------------------------------------------- send
    function test_Send_HappyPathStoresPaymentAndEscrowsFunds() public {
        uint64 until = _deadline(7 days);
        vm.prank(alice);
        uint256 id = pay.send(bob, AMOUNT, until, MEMO);

        assertEq(id, 1, "ids start at 1");
        assertEq(pay.nextId(), 2);
        assertEq(usdc.balanceOf(alice), 10_000e6 - AMOUNT);
        assertEq(usdc.balanceOf(address(pay)), AMOUNT);

        NiloPayments.Payment memory p = pay.payments(id);
        assertEq(p.from, alice);
        assertEq(p.to, bob);
        assertEq(p.amount, AMOUNT);
        assertEq(p.createdAt, block.timestamp);
        assertEq(p.claimUntil, until);
        assertEq(p.status, PENDING);
        assertEq(p.memo, MEMO);
    }

    function test_Send_EmitsSent() public {
        uint64 until = _deadline(7 days);
        vm.expectEmit(true, true, true, true, address(pay));
        emit NiloPayments.Sent(1, alice, bob, AMOUNT, until, MEMO);
        vm.prank(alice);
        pay.send(bob, AMOUNT, until, MEMO);
    }

    function test_Send_IdsIncrement() public {
        assertEq(_send(), 1);
        assertEq(_send(), 2);
        assertEq(_sendTo(relayer, 1e6, 1 days), 3);
        assertEq(pay.nextId(), 4);
    }

    function test_Send_RevertsOnZeroRecipient() public {
        uint64 until = _deadline(1 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(address(0), AMOUNT, until, MEMO);
    }

    function test_Send_RevertsOnSelfPayment() public {
        uint64 until = _deadline(1 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(alice, AMOUNT, until, MEMO);
    }

    function test_Send_RevertsOnZeroAmount() public {
        uint64 until = _deadline(1 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(bob, 0, until, MEMO);
    }

    function test_Send_RevertsOnAmountAboveUint128() public {
        uint64 until = _deadline(1 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(bob, uint256(type(uint128).max) + 1, until, MEMO);
    }

    function test_Send_RevertsWhenClaimUntilInPast() public {
        uint64 until = uint64(block.timestamp - 1);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(bob, AMOUNT, until, MEMO);
    }

    function test_Send_RevertsWhenClaimUntilIsNow() public {
        uint64 until = uint64(block.timestamp);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(bob, AMOUNT, until, MEMO);
    }

    function test_Send_AcceptsOneSecondAhead() public {
        assertEq(_sendTo(bob, AMOUNT, 1), 1);
    }

    function test_Send_RevertsAbove365Days() public {
        uint64 until = _deadline(365 days + 1);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.send(bob, AMOUNT, until, MEMO);
    }

    function test_Send_AcceptsExactly365Days() public {
        uint256 id = _sendTo(bob, AMOUNT, 365 days);
        assertEq(pay.payments(id).claimUntil, block.timestamp + 365 days);
    }

    function test_Send_RevertsOnInsufficientBalance() public {
        uint64 until = _deadline(1 days);
        vm.expectRevert();
        vm.prank(alice);
        pay.send(bob, 10_000e6 + 1, until, MEMO);
    }

    function test_Send_RevertsWithoutAllowance() public {
        vm.prank(alice);
        usdc.approve(address(pay), 0);
        uint64 until = _deadline(1 days);
        vm.expectRevert();
        vm.prank(alice);
        pay.send(bob, AMOUNT, until, MEMO);
    }

    function test_Send_RejectsFeeOnTransferToken() public {
        FeeOnTransferUSDC fee = new FeeOnTransferUSDC();
        NiloPayments feePay = new NiloPayments(fee);
        fee.mint(alice, 1_000e6);
        vm.prank(alice);
        fee.approve(address(feePay), type(uint256).max);
        uint64 until = _deadline(1 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        feePay.send(bob, AMOUNT, until, MEMO);
    }

    // ---------------------------------------------------------------- claim
    function test_Claim_HappyPath() public {
        uint256 id = _send();
        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Claimed(id, bob, AMOUNT);
        vm.prank(bob);
        pay.claim(id);

        assertEq(usdc.balanceOf(bob), AMOUNT);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(pay.payments(id).status, CLAIMED);
    }

    function test_Claim_RevertsForNonRecipient() public {
        uint256 id = _send();
        vm.expectRevert(NiloPayments.NotRecipient.selector);
        vm.prank(alice);
        pay.claim(id);
        vm.expectRevert(NiloPayments.NotRecipient.selector);
        vm.prank(attacker);
        pay.claim(id);
    }

    function test_Claim_DoubleClaimReverts() public {
        uint256 id = _send();
        vm.prank(bob);
        pay.claim(id);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(bob);
        pay.claim(id);
    }

    function test_Claim_SucceedsOneSecondBeforeDeadline() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil - 1);
        vm.prank(bob);
        pay.claim(id);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_Claim_RevertsAtExactlyClaimUntil() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil);
        vm.expectRevert(NiloPayments.Expired.selector);
        vm.prank(bob);
        pay.claim(id);
    }

    function test_Claim_RevertsAfterDeadline() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil + 1 days);
        vm.expectRevert(NiloPayments.Expired.selector);
        vm.prank(bob);
        pay.claim(id);
        assertEq(usdc.balanceOf(address(pay)), AMOUNT, "funds still escrowed");
    }

    function test_Claim_AfterRecoverReverts() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil);
        vm.prank(alice);
        pay.recover(id);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(bob);
        pay.claim(id);
    }

    function test_Claim_UnknownIdReverts() public {
        _send();
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(bob);
        pay.claim(0);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(bob);
        pay.claim(2);
    }

    // ---------------------------------------------------------------- recover
    function test_Recover_RevertsBeforeDeadline() public {
        uint256 id = _send();
        vm.expectRevert(NiloPayments.NotExpired.selector);
        vm.prank(alice);
        pay.recover(id);
        vm.warp(pay.payments(id).claimUntil - 1);
        vm.expectRevert(NiloPayments.NotExpired.selector);
        vm.prank(alice);
        pay.recover(id);
    }

    function test_Recover_SucceedsAtExactlyClaimUntil() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil);
        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Recovered(id, alice, AMOUNT);
        vm.prank(alice);
        pay.recover(id);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(pay.payments(id).status, RECOVERED);
    }

    function test_Recover_SucceedsLongAfterDeadline() public {
        uint256 id = _send();
        vm.warp(block.timestamp + 400 days);
        vm.prank(alice);
        pay.recover(id);
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }

    function test_Recover_RevertsForNonSender() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil);
        vm.expectRevert(NiloPayments.NotSender.selector);
        vm.prank(bob);
        pay.recover(id);
        vm.expectRevert(NiloPayments.NotSender.selector);
        vm.prank(attacker);
        pay.recover(id);
    }

    function test_Recover_DoubleRecoverReverts() public {
        uint256 id = _send();
        vm.warp(pay.payments(id).claimUntil);
        vm.prank(alice);
        pay.recover(id);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(alice);
        pay.recover(id);
    }

    function test_Recover_AfterClaimReverts() public {
        uint256 id = _send();
        vm.prank(bob);
        pay.claim(id);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(alice);
        pay.recover(id);
        vm.warp(pay.payments(id).claimUntil + 1);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(alice);
        pay.recover(id);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_Recover_UnknownIdReverts() public {
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.recover(1);
    }

    // ---------------------------------------------------------------- views
    function test_Payments_UnknownIdReverts() public {
        vm.expectRevert(NiloPayments.BadPayment.selector);
        pay.payments(0);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        pay.payments(1);
    }

    function test_SentByAndReceivedBy_ListIds() public {
        _sendTo(bob, 1e6, 1 days); // 1
        _sendTo(relayer, 2e6, 1 days); // 2
        _sendTo(bob, 3e6, 1 days); // 3

        uint256[] memory sent = pay.sentBy(alice);
        assertEq(sent.length, 3);
        assertEq(sent[0], 1);
        assertEq(sent[1], 2);
        assertEq(sent[2], 3);

        uint256[] memory recvBob = pay.receivedBy(bob);
        assertEq(recvBob.length, 2);
        assertEq(recvBob[0], 1);
        assertEq(recvBob[1], 3);

        assertEq(pay.receivedBy(relayer).length, 1);
        assertEq(pay.sentBy(bob).length, 0);
        assertEq(pay.receivedBy(alice).length, 0);
    }

    function test_GetPayments_Batch() public {
        _sendTo(bob, 1e6, 1 days);
        _sendTo(relayer, 2e6, 2 days);
        _sendTo(bob, 3e6, 3 days);

        uint256[] memory ids = new uint256[](3);
        ids[0] = 3;
        ids[1] = 1;
        ids[2] = 2;
        NiloPayments.Payment[] memory ps = pay.getPayments(ids);
        assertEq(ps.length, 3);
        assertEq(ps[0].amount, 3e6);
        assertEq(ps[1].amount, 1e6);
        assertEq(ps[2].amount, 2e6);
        assertEq(ps[2].to, relayer);
    }

    function test_GetPayments_EmptyBatch() public view {
        assertEq(pay.getPayments(new uint256[](0)).length, 0);
    }

    function test_GetPayments_UnknownIdRevertsWholeBatch() public {
        _send();
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 99;
        vm.expectRevert(NiloPayments.BadPayment.selector);
        pay.getPayments(ids);
    }

    function test_DomainSeparator_MatchesEip712Spec() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("NiloPayments"),
                keccak256("1"),
                block.chainid,
                address(pay)
            )
        );
        assertEq(pay.DOMAIN_SEPARATOR(), expected);
        assertEq(pay.CLAIM_TYPEHASH(), keccak256("Claim(uint256 id,uint256 deadline)"));
    }
}
