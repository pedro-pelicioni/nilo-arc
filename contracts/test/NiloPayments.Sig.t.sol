// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloPayments} from "../NiloPayments.sol";
import {NiloPaymentsTestBase} from "./NiloPayments.Base.t.sol";
import {Mock1271Wallet} from "./mocks/Mock1271Wallet.sol";

/// @dev claimFor (EIP-712 / ERC-1271) and sendWithPermit (EIP-2612).
contract NiloPaymentsSigTest is NiloPaymentsTestBase {
    // ---------------------------------------------------------------- claimFor
    function test_ClaimFor_RelayerClaimsOnBehalfOfRecipient() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        uint256 relayerBefore = usdc.balanceOf(relayer);

        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Claimed(id, bob, AMOUNT);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);

        assertEq(usdc.balanceOf(relayer), relayerBefore, "relayer balance unchanged");
        assertEq(usdc.balanceOf(bob), AMOUNT, "funds go to recipient");
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(pay.payments(id).status, CLAIMED);
    }

    function test_ClaimFor_SigDeadlineEqualToNowIsAccepted() public {
        uint256 id = _send();
        bytes memory sig = _claimSig(bobPk, id, block.timestamp);
        vm.prank(relayer);
        pay.claimFor(id, block.timestamp, sig);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_ClaimFor_RevertsOnWrongSigner() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        (, uint256 attackerPk) = makeAddrAndKey("attackerKey");
        bytes memory sig = _claimSig(attackerPk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    function test_ClaimFor_SenderCannotClaimWithOwnSignature() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(alicePk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(alice);
        pay.claimFor(id, sigDeadline, sig);
    }

    function test_ClaimFor_RevertsOnExpiredSigDeadline() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.warp(sigDeadline + 1);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    function test_ClaimFor_RevertsOnSignatureForDifferentId() public {
        uint256 id1 = _send();
        uint256 id2 = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sigFor2 = _claimSig(bobPk, id2, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id1, sigDeadline, sigFor2);
        // and the right id still works
        vm.prank(relayer);
        pay.claimFor(id2, sigDeadline, sigFor2);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_ClaimFor_RevertsWhenSigDeadlineTamperedWith() public {
        uint256 id = _send();
        bytes memory sig = _claimSig(bobPk, id, block.timestamp + 1 hours);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, block.timestamp + 2 hours, sig);
    }

    function test_ClaimFor_RevertsOnMalformedSignature() public {
        uint256 id = _send();
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, block.timestamp + 1 hours, hex"1234");
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, block.timestamp + 1 hours, "");
    }

    function test_ClaimFor_ReplayAfterClaimReverts() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_ClaimFor_RevertsAfterClaimUntil() public {
        uint256 id = _send();
        uint64 until = pay.payments(id).claimUntil;
        uint256 sigDeadline = until + 30 days;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.warp(until);
        vm.expectRevert(NiloPayments.Expired.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
        vm.warp(until + 1);
        vm.expectRevert(NiloPayments.Expired.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    function test_ClaimFor_SucceedsOneSecondBeforeClaimUntil() public {
        uint256 id = _send();
        uint64 until = pay.payments(id).claimUntil;
        bytes memory sig = _claimSig(bobPk, id, until);
        vm.warp(until - 1);
        vm.prank(relayer);
        pay.claimFor(id, until, sig);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_ClaimFor_AfterRecoverReverts() public {
        uint256 id = _send();
        uint64 until = pay.payments(id).claimUntil;
        bytes memory sig = _claimSig(bobPk, id, until + 1 days);
        vm.warp(until);
        vm.prank(alice);
        pay.recover(id);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(relayer);
        pay.claimFor(id, until + 1 days, sig);
    }

    function test_ClaimFor_UnknownIdReverts() public {
        bytes memory sig = _claimSig(bobPk, 1, block.timestamp + 1);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(relayer);
        pay.claimFor(1, block.timestamp + 1, sig);
    }

    function test_ClaimFor_Erc1271ContractRecipient() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);

        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);

        assertEq(usdc.balanceOf(address(wallet)), AMOUNT);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(pay.payments(id).status, CLAIMED);
    }

    function test_ClaimFor_Erc1271RejectsWrongSigner() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(alicePk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    // ---------------------------------------------------------------- sendWithPermit
    function _noAllowance() internal {
        vm.prank(alice);
        usdc.approve(address(pay), 0);
    }

    function test_SendWithPermit_Success() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, alicePk, alice, address(pay), AMOUNT, deadline);
        uint64 until = _deadline(7 days);

        vm.expectEmit(true, true, true, true, address(pay));
        emit NiloPayments.Sent(1, alice, bob, AMOUNT, until, MEMO);
        vm.prank(alice);
        uint256 id = pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);

        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(pay)), AMOUNT);
        assertEq(usdc.balanceOf(alice), 10_000e6 - AMOUNT);
        assertEq(usdc.allowance(alice, address(pay)), 0, "permit allowance fully consumed");
        assertEq(pay.payments(id).to, bob);
        assertEq(pay.sentBy(alice).length, 1);
    }

    function test_SendWithPermit_SurvivesFrontRunPermit() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, alicePk, alice, address(pay), AMOUNT, deadline);

        vm.prank(attacker);
        usdc.permit(alice, address(pay), AMOUNT, deadline, v, r, s);

        uint64 until = _deadline(7 days);
        vm.prank(alice);
        uint256 id = pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);
        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(pay)), AMOUNT);
    }

    function test_SendWithPermit_FailedPermitInsufficientAllowanceReverts() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, alicePk, alice, address(pay), AMOUNT, deadline);
        usdc.permit(alice, address(pay), AMOUNT, deadline, v, r, s); // burn nonce
        vm.prank(alice);
        usdc.approve(address(pay), AMOUNT - 1);

        uint64 until = _deadline(7 days);
        vm.expectRevert(NiloPayments.PermitFailed.selector);
        vm.prank(alice);
        pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);
    }

    function test_SendWithPermit_BadSignatureNoAllowanceReverts() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, bobPk, alice, address(pay), AMOUNT, deadline);
        uint64 until = _deadline(7 days);
        vm.expectRevert(NiloPayments.PermitFailed.selector);
        vm.prank(alice);
        pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);
    }

    function test_SendWithPermit_ExpiredPermitNoAllowanceReverts() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, alicePk, alice, address(pay), AMOUNT, deadline);
        vm.warp(deadline + 1);
        uint64 until = _deadline(7 days);
        vm.expectRevert(NiloPayments.PermitFailed.selector);
        vm.prank(alice);
        pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);
    }

    function test_SendWithPermit_GarbagePermitWithSufficientAllowanceStillSends() public {
        // base setUp left alice with max allowance
        uint64 until = _deadline(7 days);
        vm.prank(alice);
        uint256 id =
            pay.sendWithPermit(bob, AMOUNT, until, MEMO, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(id, 1);
    }

    function test_SendWithPermit_ValidationStillApplies() public {
        _noAllowance();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(usdc, alicePk, alice, address(pay), AMOUNT, deadline);
        uint64 until = _deadline(366 days);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        vm.prank(alice);
        pay.sendWithPermit(bob, AMOUNT, until, MEMO, deadline, v, r, s);
        assertEq(usdc.allowance(alice, address(pay)), 0, "permit rolled back");
        assertEq(pay.nextId(), 1);
    }
}
