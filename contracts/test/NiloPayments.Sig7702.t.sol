// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloPayments} from "../NiloPayments.sol";
import {NiloPaymentsTestBase} from "./NiloPayments.Base.t.sol";
import {Mock1271Wallet} from "./mocks/Mock1271Wallet.sol";
import {MockOpaque1271Wallet} from "./mocks/MockOpaque1271Wallet.sol";

/// @dev claimFor signature validation: ECDSA-first (EIP-7702 delegated EOAs), ERC-1271 fallback.
contract NiloPaymentsSig7702Test is NiloPaymentsTestBase {
    uint256 internal thirdPk;
    uint256 internal relayerPk;
    address internal relayerKeyed;

    function setUp() public override {
        super.setUp();
        (, thirdPk) = makeAddrAndKey("thirdKey");
        (relayerKeyed, relayerPk) = makeAddrAndKey("relayerKey");
    }

    /// @dev Simulate EIP-7702 delegation: bob's account code becomes 0xef0100 || delegate.
    function _delegate(address delegate) internal {
        vm.etch(bob, abi.encodePacked(hex"ef0100", delegate));
        assertGt(bob.code.length, 0);
    }

    function _relayClaim(uint256 id, uint256 sigDeadline, bytes memory sig) internal {
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    function _expectBad(uint256 id, uint256 sigDeadline, bytes memory sig) internal {
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
    }

    function _assertStillPending(uint256 id) internal view {
        assertEq(pay.payments(id).status, PENDING);
        assertEq(usdc.balanceOf(address(pay)), AMOUNT);
    }

    // ------------------------------------------------ (1) 7702 delegated EOA accepted
    function _acceptDelegated(address delegate) internal {
        uint256 id = _send();
        _delegate(delegate);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        uint256 relayerBefore = usdc.balanceOf(relayer);

        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Claimed(id, bob, AMOUNT);
        _relayClaim(id, sigDeadline, sig);

        assertEq(usdc.balanceOf(bob), AMOUNT, "funds go to bob");
        assertEq(usdc.balanceOf(relayer), relayerBefore, "relayer unchanged");
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(pay.payments(id).status, CLAIMED);
    }

    function test_Delegated_EcdsaSigAccepted_DelegateWithoutCode() public {
        address delegate = makeAddr("emptyDelegate");
        assertEq(delegate.code.length, 0);
        _acceptDelegated(delegate);
    }

    function test_Delegated_EcdsaSigAccepted_DelegateWithout1271() public {
        // usdc has code but no isValidSignature
        _acceptDelegated(address(usdc));
    }

    function test_Delegated_EcdsaSigAccepted_DelegateIsNon1271Wallet() public {
        // a contract delegate that would reject (different signer) must not block the owner's own ECDSA sig
        Mock1271Wallet delegate = new Mock1271Wallet(alice);
        _acceptDelegated(address(delegate));
    }

    // ------------------------------------------------ (2) delegated EOA refuses other signers / tampering
    function test_Delegated_RevertsOnSigFromSender() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, _claimSig(alicePk, id, sigDeadline));
        _assertStillPending(id);
    }

    function test_Delegated_RevertsOnSigFromThirdKey() public {
        uint256 id = _send();
        _delegate(address(usdc));
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, _claimSig(thirdPk, id, sigDeadline));
        _assertStillPending(id);
    }

    function test_Delegated_RevertsOnWrongId() public {
        uint256 id1 = _send();
        uint256 id2 = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sigFor2 = _claimSig(bobPk, id2, sigDeadline);
        _expectBad(id1, sigDeadline, sigFor2);
        _relayClaim(id2, sigDeadline, sigFor2);
        assertEq(pay.payments(id1).status, PENDING);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_Delegated_RevertsOnWrongDeadline() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        bytes memory sig = _claimSig(bobPk, id, block.timestamp + 1 hours);
        _expectBad(id, block.timestamp + 2 hours, sig);
        _assertStillPending(id);
    }

    function test_Delegated_RevertsOnExpiredSigDeadline() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.warp(sigDeadline + 1);
        _expectBad(id, sigDeadline, sig);
        _assertStillPending(id);
    }

    function test_Delegated_RevertsOnWrongChainDomain() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.chainId(block.chainid + 1); // domain separator changes -> digest differs
        _expectBad(id, sigDeadline, sig);
        // and a sig made for the foreign chain does not work on... the original chain
        bytes memory foreign = _claimSig(bobPk, id, sigDeadline);
        vm.chainId(block.chainid - 1);
        _expectBad(id, sigDeadline, foreign);
        _assertStillPending(id);
    }

    function test_Delegated_RevertsOnMalformedSignatures() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, "");
        _expectBad(id, sigDeadline, hex"1234");
        _expectBad(id, sigDeadline, new bytes(65));
        _assertStillPending(id);
    }

    // ------------------------------------------------ (6) replay / expiry for delegated case
    function test_Delegated_ReplayAfterClaimReverts() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        _relayClaim(id, sigDeadline, sig);
        vm.expectRevert(NiloPayments.NotPending.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    function test_Delegated_RevertsAfterClaimUntil() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint64 until = pay.payments(id).claimUntil;
        uint256 sigDeadline = until + 30 days;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.warp(until);
        vm.expectRevert(NiloPayments.Expired.selector);
        vm.prank(relayer);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Delegated_SucceedsOneSecondBeforeClaimUntil() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint64 until = pay.payments(id).claimUntil;
        bytes memory sig = _claimSig(bobPk, id, until);
        vm.warp(until - 1);
        _relayClaim(id, until, sig);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    // ------------------------------------------------ (3) ERC-1271 wallets
    function test_Wallet1271_EcdsaSigFromSignerAccepted() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);

        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Claimed(id, address(wallet), AMOUNT);
        _relayClaim(id, sigDeadline, sig);

        assertEq(usdc.balanceOf(address(wallet)), AMOUNT);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_OpaqueWallet_NonEcdsaBlobAccepted() public {
        bytes memory blob = hex"deadbeefcafebabe00112233445566778899aabbccddeeff01"; // 25 bytes
        MockOpaque1271Wallet wallet = new MockOpaque1271Wallet(keccak256(blob));
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);

        vm.expectEmit(true, true, false, true, address(pay));
        emit NiloPayments.Claimed(id, address(wallet), AMOUNT);
        _relayClaim(id, block.timestamp + 1 hours, blob);

        assertEq(usdc.balanceOf(address(wallet)), AMOUNT);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(pay.payments(id).status, CLAIMED);
    }

    function test_OpaqueWallet_LongBlobAccepted() public {
        bytes memory blob = new bytes(200);
        for (uint256 i; i < blob.length; ++i) blob[i] = bytes1(uint8(i + 1));
        MockOpaque1271Wallet wallet = new MockOpaque1271Wallet(keccak256(blob));
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        _relayClaim(id, block.timestamp + 1 hours, blob);
        assertEq(usdc.balanceOf(address(wallet)), AMOUNT);
    }

    function test_OpaqueWallet_WrongBlobRefused() public {
        bytes memory blob = hex"deadbeefcafebabe00112233445566778899aabbccddeeff01";
        MockOpaque1271Wallet wallet = new MockOpaque1271Wallet(keccak256(blob));
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, hex"deadbeefcafebabe00112233445566778899aabbccddeeff02");
        _expectBad(id, sigDeadline, "");
        _expectBad(id, sigDeadline, _claimSig(bobPk, id, sigDeadline)); // 65-byte ECDSA is not the blob
        _assertStillPending(id);
    }

    // ------------------------------------------------ (4) ERC-1271 wallet refuses other keys
    function test_Wallet1271_RefusesSigFromSender() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
            bytes memory sig = _claimSig(alicePk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(alice);
        pay.claimFor(id, sigDeadline, sig);
        _assertStillPending(id);
    }

    function test_Wallet1271_RefusesSigFromThirdKey() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, _claimSig(thirdPk, id, sigDeadline));
        _assertStillPending(id);
    }

    function test_Wallet1271_RefusesSigFromWalletItselfAsEcdsaSigner() public {
        // recovered address must equal payment.to OR 1271 must approve; a key for an unrelated address fails both
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        _expectBad(id, sigDeadline, _claimSig(relayerPk, id, sigDeadline));
        _assertStillPending(id);
    }

    function test_Wallet1271_RefusesBobSigForWrongIdOrDeadline() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 id2 = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id2, sigDeadline);
        _expectBad(id, sigDeadline, sig);
        _expectBad(id2, sigDeadline + 1, sig);
        assertEq(pay.payments(id).status, PENDING);
        assertEq(pay.payments(id2).status, PENDING);
    }

    // ------------------------------------------------ (5) plain EOA recipient, bad sigs
    function test_PlainEoa_GarbageEmptyAndCompactSigsRefused() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory good = _claimSig(bobPk, id, sigDeadline);

        _expectBad(id, sigDeadline, ""); // empty
        _expectBad(id, sigDeadline, hex"deadbeef"); // garbage short
        _expectBad(id, sigDeadline, new bytes(65)); // zero 65 bytes (invalid signature)
        _expectBad(id, sigDeadline, new bytes(64)); // zero 64 bytes
        _expectBad(id, sigDeadline, new bytes(66)); // wrong length

        // 64-byte truncation (r||s without v) of an otherwise valid signature
        bytes memory compact = new bytes(64);
        for (uint256 i; i < 64; ++i) compact[i] = good[i];
        _expectBad(id, sigDeadline, compact);

        // 65 bytes with corrupted v
        bytes memory badV = abi.encodePacked(bytes32(0), bytes32(0), uint8(0));
        for (uint256 i; i < 64; ++i) badV[i] = good[i];
        _expectBad(id, sigDeadline, badV);

        _assertStillPending(id);
    }

    function test_PlainEoa_Compact64ByteEip2098ForBobRefused() public {
        // Installed OZ ECDSA only recovers 65-byte signatures; an EIP-2098 compact sig is not accepted.
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, _claimDigest(id, sigDeadline));
        bytes32 vs = bytes32((uint256(v - 27) << 255) | uint256(s));
        _expectBad(id, sigDeadline, abi.encodePacked(r, vs));
        _assertStillPending(id);
    }

    function test_PlainEoa_ValidSigStillAccepted() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
        _relayClaim(id, sigDeadline, _claimSig(bobPk, id, sigDeadline));
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }

    // ------------------------------------------------ (7) relayer's own key never claims for itself
    function test_RelayerOwnKeyCannotClaimPlainEoaRecipient() public {
        uint256 id = _send();
        uint256 sigDeadline = block.timestamp + 1 hours;
            bytes memory sig = _claimSig(relayerPk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayerKeyed);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(relayerKeyed), 0);
        _assertStillPending(id);
    }

    function test_RelayerOwnKeyCannotClaimDelegatedRecipient() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
            bytes memory sig = _claimSig(relayerPk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayerKeyed);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(relayerKeyed), 0);
        _assertStillPending(id);
    }

    function test_RelayerOwnKeyCannotClaimWalletRecipient() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _sendTo(address(wallet), AMOUNT, 7 days);
        uint256 sigDeadline = block.timestamp + 1 hours;
            bytes memory sig = _claimSig(relayerPk, id, sigDeadline);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        vm.prank(relayerKeyed);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(relayerKeyed), 0);
        _assertStillPending(id);
    }

    function test_ValidSigAlwaysPaysRecipientNotRelayer_Delegated() public {
        uint256 id = _send();
        _delegate(makeAddr("emptyDelegate"));
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _claimSig(bobPk, id, sigDeadline);
        vm.prank(relayerKeyed);
        pay.claimFor(id, sigDeadline, sig);
        assertEq(usdc.balanceOf(relayerKeyed), 0);
        assertEq(usdc.balanceOf(bob), AMOUNT);
    }
}
