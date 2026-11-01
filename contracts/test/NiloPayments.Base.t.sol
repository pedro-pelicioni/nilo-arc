// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NiloPayments} from "../NiloPayments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {PermitHelper} from "./mocks/PermitHelper.sol";

/// @dev Shared setup / helpers. Contains no test functions.
abstract contract NiloPaymentsTestBase is PermitHelper {
    NiloPayments internal pay;
    MockUSDC internal usdc;

    address internal alice; // sender
    uint256 internal alicePk;
    address internal bob; // recipient
    uint256 internal bobPk;
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant AMOUNT = 100e6;
    bytes32 internal constant MEMO = bytes32("lunch");

    uint8 internal constant PENDING = 0;
    uint8 internal constant CLAIMED = 1;
    uint8 internal constant RECOVERED = 2;

    function setUp() public virtual {
        vm.warp(T0);
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        usdc = new MockUSDC();
        pay = new NiloPayments(usdc);
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(pay), type(uint256).max);
    }

    function _deadline(uint256 ttl) internal view returns (uint64) {
        return uint64(block.timestamp + ttl);
    }

    /// @dev alice -> bob, AMOUNT, expires in 7 days. Returns the payment id.
    function _send() internal returns (uint256 id) {
        return _sendTo(bob, AMOUNT, 7 days);
    }

    function _sendTo(address to, uint256 amount, uint256 ttl) internal returns (uint256 id) {
        vm.prank(alice);
        id = pay.send(to, amount, _deadline(ttl), MEMO);
    }

    function _claimDigest(uint256 id, uint256 sigDeadline) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(pay.CLAIM_TYPEHASH(), id, sigDeadline));
        return keccak256(abi.encodePacked("\x19\x01", pay.DOMAIN_SEPARATOR(), structHash));
    }

    function _claimSig(uint256 pk, uint256 id, uint256 sigDeadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _claimDigest(id, sigDeadline));
        return abi.encodePacked(r, s, v);
    }
}
