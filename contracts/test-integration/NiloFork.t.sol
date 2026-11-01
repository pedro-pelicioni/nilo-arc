// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {NiloAgent} from "../NiloAgent.sol";
import {NiloPayments} from "../NiloPayments.sol";
import {Mock1271Wallet} from "../test/mocks/Mock1271Wallet.sol";

/// @dev Stand-in for Arc's native-coin authority precompile at 0x1800...0000. On the real chain Arc's USDC
/// ERC-20 moves the *native* balance by calling `transfer(from, to, amount18)` on that address. forge's
/// EVM does not implement it (the fork's code there is the 1-byte stub 0x01, which underflows), so we etch
/// this shim: it moves native balances with the same revert rules the USDC ERC-20 enforces itself.
contract NativeCoinAuthorityShim {
    Vm private constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function transfer(address from, address to, uint256 amount) external returns (bool) {
        require(to != address(0), "shim: to zero");
        require(from.balance >= amount, "shim: insufficient native balance");
        VM.deal(from, from.balance - amount);
        VM.deal(to, to.balance + amount);
        return true;
    }
}

/// @dev Stand-in for Arc's blocklist precompile at 0x1800...0001 (`isBlocklisted(address)`); nobody is blocklisted here.
contract BlocklistShim {
    function isBlocklisted(address) external pure returns (bool) {
        return false;
    }
}

/// @notice Fork test of the DEPLOYED Nilo contracts on Arc Testnet (chain 5042002), driven exactly the way the
/// web app and the server drive them (same calldata shapes, same EIP-712 domain/types, same split and math).
/// Run: forge test --match-path contracts/test-integration/NiloFork.t.sol -vv   (override the RPC with ARC_TESTNET_RPC)
contract NiloForkTest is Test {
    // ---- deployed addresses (AGENTS.md) ----
    IERC20 internal constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    NiloAgent internal constant AGENT = NiloAgent(0x16F0819135205B7D710D99eF92C69173e2D464C6);
    NiloPayments internal constant PAYMENTS = NiloPayments(0x20376Ca84C65242097b57Ad1E5A122f86E12f305);
    address internal constant OPERATOR = 0x59782DC984d9F4e6A37c08B9A63B0DCf77954E1f;
    address internal constant NATIVE_AUTHORITY = 0x1800000000000000000000000000000000000000;
    address internal constant BLOCKLIST = 0x1800000000000000000000000000000000000001;
    // Balanced personality: "prime" slot 60%, "yield" slot 40% (core/agent.ts).
    IERC4626 internal constant PRIME = IERC4626(0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88);
    IERC4626 internal constant YIELD = IERC4626(0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC);

    uint256 internal constant CHAIN_ID = 5042002;
    uint256 internal constant WEEK = 7 days;

    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC", string("https://rpc.testnet.arc.io")));
        assertEq(block.chainid, CHAIN_ID, "wrong chain");

        // Arc USDC is native-backed, so forge-std `deal(token, ...)` (storage slot) cannot fund it. Fund the NATIVE
        // balance (18 decimals); the ERC-20 view (6 decimals) reads it back as native / 1e12.
        vm.etch(NATIVE_AUTHORITY, address(new NativeCoinAuthorityShim()).code);
        vm.allowCheatcodes(NATIVE_AUTHORITY);
        vm.etch(BLOCKLIST, address(new BlocklistShim()).code);

        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        _fund(alice, 1_000e6);
        // bob stays at 0 USDC: the gasless-claim case.
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address who, uint256 usdc6) internal {
        vm.deal(who, usdc6 * 1e12);
        assertEq(USDC.balanceOf(who), usdc6, "native<->ERC-20 view");
    }

    /// @dev Mirrors core/abi.ts claimDomain + CLAIM_TYPES, i.e. what viem's signTypedData hashes.
    function _claimDigest(uint256 chainId, address verifying, uint256 id, uint256 deadline) internal pure returns (bytes32) {
        bytes32 domainTypehash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator =
            keccak256(abi.encode(domainTypehash, keccak256("NiloPayments"), keccak256("1"), chainId, verifying));
        bytes32 structHash = keccak256(abi.encode(keccak256("Claim(uint256 id,uint256 deadline)"), id, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev 65-byte r||s||v signature, v in {27,28}, as eth_signTypedData_v4 returns.
    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev build.ts buildSendCalls: approve exactly `amount` when the allowance is short, then send(..., zeroHash).
    function _send(address from, address to, uint256 amount, uint64 claimUntil) internal returns (uint256 id) {
        id = PAYMENTS.nextId();
        vm.startPrank(from);
        if (USDC.allowance(from, address(PAYMENTS)) < amount) USDC.approve(address(PAYMENTS), amount);
        uint256 g = gasleft();
        uint256 got = PAYMENTS.send(to, amount, claimUntil, bytes32(0));
        console.log("gas send            ", g - gasleft());
        vm.stopPrank();
        assertEq(got, id, "id");
    }

    /// @dev core/agent.ts mandateFrom(balanced) with the default 100 USDC/week, 30 days, keep 1 USDC.
    function _balancedMandate() internal view returns (NiloAgent.Mandate memory m) {
        address[] memory vaults = new address[](2);
        vaults[0] = address(PRIME);
        vaults[1] = address(YIELD);
        m = NiloAgent.Mandate({
            limit: 100e6,
            period: uint64(WEEK),
            expiresAt: uint64(block.timestamp + 30 days),
            reserve: 1e6,
            profile: 1,
            vaults: vaults
        });
    }

    /// @dev core/agent.ts allowanceFor: limit * ceil((expiresAt - now) / period).
    function _allowanceFor(NiloAgent.Mandate memory m) internal view returns (uint256) {
        uint256 periods = (m.expiresAt - block.timestamp + m.period - 1) / m.period;
        return uint256(m.limit) * (periods == 0 ? 1 : periods);
    }

    function _signMandate(address user) internal returns (NiloAgent.Mandate memory m, uint256 allowance) {
        m = _balancedMandate();
        allowance = _allowanceFor(m);
        vm.startPrank(user);
        if (USDC.allowance(user, address(AGENT)) != allowance) USDC.approve(address(AGENT), allowance);
        uint256 g = gasleft();
        AGENT.setMandate(m);
        console.log("gas setMandate      ", g - gasleft());
        vm.stopPrank();
    }

    /// @dev server/agent/run.ts: amount = min(wallet - reserve, remaining, allowance); split 60/40, remainder to vault[0],
    /// legs below 0.01 USDC dropped. Returns the legs.
    function _plan(address user, NiloAgent.Mandate memory m) internal view returns (uint256 pa, uint256 ya) {
        uint256 wallet = USDC.balanceOf(user);
        uint256 idle = wallet - m.reserve;
        uint256 left = AGENT.remaining(user);
        uint256 allowance = USDC.allowance(user, address(AGENT));
        uint256 amount = idle < left ? idle : left;
        if (allowance < amount) amount = allowance;
        pa = (amount * 6_000) / 10_000;
        ya = (amount * 4_000) / 10_000;
        pa += amount - pa - ya;
        if (pa < 10_000) pa = 0;
        if (ya < 10_000) ya = 0;
    }

    function _invest(address user, IERC4626 vault, uint256 amount) internal {
        vm.prank(OPERATOR);
        uint256 g = gasleft();
        AGENT.invest(user, address(vault), amount);
        console.log("gas invest          ", g - gasleft());
    }

    // ------------------------------------------------------------------ deployment sanity + ABI parity

    function test_Deployed_WiringMatchesFrontendConfig() public view {
        assertEq(address(AGENT.usdc()), address(USDC));
        assertEq(address(PAYMENTS.usdc()), address(USDC));
        assertEq(AGENT.operator(), OPERATOR);
        assertEq(AGENT.owner(), OPERATOR);
        assertEq(AGENT.MAX_SLIPPAGE_BPS(), 100);
        assertEq(PAYMENTS.CLAIM_TYPEHASH(), keccak256("Claim(uint256 id,uint256 deadline)"));
        // Arc USDC: 6 decimals ERC-20 view of the 18-decimal native balance.
        (bool ok, bytes memory ret) = address(USDC).staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint8)), 6);
        assertEq(PRIME.asset(), address(USDC));
        assertEq(YIELD.asset(), address(USDC));
    }

    function test_Deployed_Eip712DomainEqualsFrontendDomain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = PAYMENTS.eip712Domain();
        assertEq(name, "NiloPayments");
        assertEq(version, "1");
        assertEq(chainId, CHAIN_ID);
        assertEq(verifying, address(PAYMENTS));
        // Our hand-built digest must be keccak(0x1901 || DOMAIN_SEPARATOR || structHash) with the contract's separator.
        bytes32 structHash = keccak256(abi.encode(PAYMENTS.CLAIM_TYPEHASH(), uint256(7), uint256(1234)));
        bytes32 viaContractSeparator = keccak256(abi.encodePacked("\x19\x01", PAYMENTS.DOMAIN_SEPARATOR(), structHash));
        assertEq(_claimDigest(CHAIN_ID, address(PAYMENTS), 7, 1234), viaContractSeparator);
    }

    /// @dev Selectors the web/server ABI (core/abi.ts) calls must exist on the deployed contracts with the same shape.
    function test_AbiParity_SelectorsAndErrors() public pure {
        assertEq(bytes4(keccak256("send(address,uint256,uint64,bytes32)")), NiloPayments.send.selector);
        assertEq(bytes4(keccak256("claim(uint256)")), NiloPayments.claim.selector);
        assertEq(bytes4(keccak256("claimFor(uint256,uint256,bytes)")), NiloPayments.claimFor.selector);
        assertEq(bytes4(keccak256("recover(uint256)")), NiloPayments.recover.selector);
        assertEq(bytes4(keccak256("payments(uint256)")), NiloPayments.payments.selector);
        assertEq(bytes4(keccak256("getPayments(uint256[])")), NiloPayments.getPayments.selector);
        assertEq(bytes4(keccak256("sentBy(address)")), NiloPayments.sentBy.selector);
        assertEq(bytes4(keccak256("receivedBy(address)")), NiloPayments.receivedBy.selector);
        assertEq(bytes4(keccak256("setMandate((uint128,uint64,uint64,uint128,uint8,address[]))")), NiloAgent.setMandate.selector);
        assertEq(bytes4(keccak256("mandateOf(address)")), NiloAgent.mandateOf.selector);
        assertEq(bytes4(keccak256("usageOf(address)")), NiloAgent.usageOf.selector);
        assertEq(bytes4(keccak256("remaining(address)")), NiloAgent.remaining.selector);
        assertEq(bytes4(keccak256("invest(address,address,uint256)")), NiloAgent.invest.selector);
        assertEq(bytes4(keccak256("revoke()")), NiloAgent.revoke.selector);
        assertEq(bytes4(keccak256("Expired()")), NiloPayments.Expired.selector);
        assertEq(bytes4(keccak256("SlippageExceeded()")), NiloAgent.SlippageExceeded.selector);
        assertEq(bytes4(keccak256("FundsRetained()")), NiloAgent.FundsRetained.selector);
        assertEq(bytes4(keccak256("OverLimit()")), NiloAgent.OverLimit.selector);
    }

    // ------------------------------------------------------------------ payments

    function test_Payments_Send_GaslessClaimFor_ByRelayer() public {
        uint256 amount = 25e6;
        uint64 claimUntil = uint64(block.timestamp + 1 hours);
        uint256 id = _send(alice, bob, amount, claimUntil);

        // Stored as the frontend expects (getPayments row -> viewBalance).
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        NiloPayments.Payment memory p = PAYMENTS.getPayments(ids)[0];
        assertEq(p.from, alice);
        assertEq(p.to, bob);
        assertEq(p.amount, amount);
        assertEq(p.claimUntil, claimUntil);
        assertEq(p.status, 0);
        assertEq(p.memo, bytes32(0));
        uint256[] memory sent = PAYMENTS.sentBy(alice);
        uint256[] memory received = PAYMENTS.receivedBy(bob);
        assertEq(sent[sent.length - 1], id);
        assertEq(received[received.length - 1], id);
        assertEq(USDC.balanceOf(alice), 1_000e6 - amount);
        assertEq(USDC.allowance(alice, address(PAYMENTS)), 0, "approve-exact is fully consumed");

        // claim.ts: sigDeadline = min(now + 10 min, claimUntil). SignPanel signs Claim(id, BigInt(sigDeadline)).
        uint256 sigDeadline = block.timestamp + 10 minutes;
        bytes memory sig = _sign(bobPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        assertEq(sig.length, 65);

        // sponsor.ts: the relayer is the operator key; it must pay nothing to itself and the funds go to bob.
        uint256 relayerBefore = USDC.balanceOf(OPERATOR);
        uint256 escrowBefore = USDC.balanceOf(address(PAYMENTS));
        vm.prank(OPERATOR);
        uint256 g = gasleft();
        PAYMENTS.claimFor(id, sigDeadline, sig);
        console.log("gas claimFor        ", g - gasleft());

        assertEq(USDC.balanceOf(bob), amount, "bob got the funds");
        assertEq(USDC.balanceOf(OPERATOR), relayerBefore, "relayer received nothing");
        assertEq(USDC.balanceOf(address(PAYMENTS)), escrowBefore - amount);
        assertEq(PAYMENTS.payments(id).status, 1);

        // Replay and double-claim are refused.
        vm.prank(OPERATOR);
        vm.expectRevert(NiloPayments.NotPending.selector);
        PAYMENTS.claimFor(id, sigDeadline, sig);
        vm.prank(bob);
        vm.expectRevert(NiloPayments.NotPending.selector);
        PAYMENTS.claim(id);
    }

    /// @dev Vector produced by viem itself (`account.signTypedData` with core/abi.ts claimDomain + CLAIM_TYPES, chain 5042002,
    /// verifyingContract = payments, message {id: 7n, deadline: 4_000_000_000n}, signer 0x2c75...5c23 (throwaway key)).
    /// Proves the on-chain domain/typehash and the 65-byte r||s||v (v = 27|28) format accept the frontend's signature byte for byte.
    function test_Payments_ClaimFor_WithSignatureProducedByViem() public {
        address viemSigner = 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23;
        bytes32 viemDigest = 0x0ccdafda1ce2079ae8d3b2067ca00e3af352ebcf60b30aef5101f3f7f188d050;
        bytes memory viemSig =
            hex"06517fba5045392fba5c973ad583e08afb09f02870af2d0708f7c5dafb393411091e1b105fba14244dc1d39cea7cfdd96ddf893e77e44d086c5d9776809e7aba1c";
        assertEq(viemSigner.code.length, 0, "plain EOA");
        assertEq(_claimDigest(CHAIN_ID, address(PAYMENTS), 7, 4_000_000_000), viemDigest, "digest == viem hashTypedData");

        // Make the next payment id 7 (fork-only edit of `nextId`, storage slot 2) so the fixed signature matches.
        vm.store(address(PAYMENTS), bytes32(uint256(2)), bytes32(uint256(7)));
        uint256 id = _send(alice, viemSigner, 12e6, uint64(block.timestamp + 1 days));
        assertEq(id, 7);

        uint256 before = USDC.balanceOf(viemSigner); // this well-known key may hold testnet dust already
        vm.prank(OPERATOR);
        PAYMENTS.claimFor(7, 4_000_000_000, viemSig);
        assertEq(USDC.balanceOf(viemSigner), before + 12e6);
        assertEq(PAYMENTS.payments(7).status, 1);
    }

    /// @dev EIP-7702 fix: on Arc Testnet the well-known account 0x7099...79C8 carries delegation code (0xef0100...). A plain
    /// ECDSA signature by its key is now ACCEPTED by claimFor (ECDSA is tried first, ERC-1271 is only the fallback).
    function test_Payments_ClaimFor_Eip7702DelegatedEoa_EcdsaSigAccepted() public {
        address delegated = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        bytes memory sig =
            hex"013c419f8f4436ab48262c9ec04ccb9071b84805f775db5092a9af1040713a6734a52d7513cf5001d9a8d3682275d06090c7c0150f0eaf41aa0e7544b7950e4a1c";
        assertGt(delegated.code.length, 0, "has 7702 delegation code");
        assertEq(delegated.code[0], bytes1(0xef));
        vm.store(address(PAYMENTS), bytes32(uint256(2)), bytes32(uint256(7)));
        _send(alice, delegated, 12e6, uint64(block.timestamp + 1 days));
        uint256 before = USDC.balanceOf(delegated);
        uint256 relayerBefore = USDC.balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        PAYMENTS.claimFor(7, 4_000_000_000, sig);
        assertEq(USDC.balanceOf(delegated), before + 12e6, "funds to the delegated EOA");
        assertEq(USDC.balanceOf(OPERATOR), relayerBefore, "relayer receives nothing");
        assertEq(PAYMENTS.payments(7).status, 1);
    }

    /// @dev A delegated EOA still refuses signatures from anyone else (here: the sender's key).
    function test_Payments_ClaimFor_Eip7702DelegatedEoa_OtherKeyRefused() public {
        address delegated = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        assertGt(delegated.code.length, 0);
        uint256 id = _send(alice, delegated, 3e6, uint64(block.timestamp + 1 days));
        uint256 sigDeadline = block.timestamp + 10 minutes;
        bytes memory bySender = _sign(alicePk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, bySender);
    }

    /// @dev ERC-1271 contract wallets still work through the fallback, and a VALID ECDSA signature from a different key
    /// (the sender's, a third key) does not authorize a claim for an ERC-1271 recipient.
    function test_Payments_ClaimFor_Erc1271Wallet_WorksAndRefusesOtherKeys() public {
        Mock1271Wallet wallet = new Mock1271Wallet(bob);
        uint256 id = _send(alice, address(wallet), 9e6, uint64(block.timestamp + 1 days));
        uint256 sigDeadline = block.timestamp + 10 minutes;
        (, uint256 thirdPk) = makeAddrAndKey("third");

        bytes memory bySender = _sign(alicePk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, bySender);
        bytes memory byThird = _sign(thirdPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, byThird);

        bytes memory bySigner = _sign(bobPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.prank(OPERATOR);
        PAYMENTS.claimFor(id, sigDeadline, bySigner);
        assertEq(USDC.balanceOf(address(wallet)), 9e6);
    }

    function test_Payments_ClaimFor_RejectsBadSignatures() public {
        uint64 claimUntil = uint64(block.timestamp + 1 hours);
        uint256 id = _send(alice, bob, 5e6, claimUntil);
        uint256 sigDeadline = block.timestamp + 10 minutes;

        // Wrong signer (the sender signs).
        bytes memory bySender = _sign(alicePk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, bySender);

        // Wrong chainId in the domain (wallet on another chain / bad config).
        bytes memory wrongChain = _sign(bobPk, _claimDigest(1, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, wrongChain);

        // Wrong verifyingContract (the agent address instead of payments).
        bytes memory wrongContract = _sign(bobPk, _claimDigest(CHAIN_ID, address(AGENT), id, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, wrongContract);

        // Signature for another id.
        bytes memory otherId = _sign(bobPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id + 1, sigDeadline));
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, otherId);

        // Good signature, but submitted after its own sigDeadline.
        bytes memory good = _sign(bobPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.warp(sigDeadline + 1);
        vm.expectRevert(NiloPayments.BadSignature.selector);
        PAYMENTS.claimFor(id, sigDeadline, good);

        // sigDeadline == block.timestamp is still accepted (contract: `now > sigDeadline` reverts).
        vm.warp(sigDeadline);
        PAYMENTS.claimFor(id, sigDeadline, good);
        assertEq(USDC.balanceOf(bob), 5e6);
    }

    function test_Payments_Deadline_ClaimRecoverBoundaries() public {
        uint64 claimUntil = uint64(block.timestamp + 1 hours);
        uint256 id = _send(alice, bob, 40e6, claimUntil);

        vm.prank(alice);
        vm.expectRevert(NiloPayments.NotExpired.selector);
        PAYMENTS.recover(id);
        vm.prank(bob);
        vm.expectRevert(NiloPayments.NotSender.selector);
        PAYMENTS.recover(id);
        vm.prank(alice);
        vm.expectRevert(NiloPayments.NotRecipient.selector);
        PAYMENTS.claim(id);

        // One second before the deadline the recipient can still claim (claim.ts allows claim while now < deadline).
        // Use a second payment so the first stays pending for the recover path.
        uint256 id2 = _send(alice, bob, 3e6, claimUntil);
        vm.warp(claimUntil - 1);
        vm.prank(bob);
        PAYMENTS.claim(id2);
        assertEq(USDC.balanceOf(bob), 3e6);

        // At the deadline the recipient is locked out (claim and claimFor), and only the sender can recover.
        vm.warp(claimUntil);
        vm.prank(bob);
        vm.expectRevert(NiloPayments.Expired.selector);
        PAYMENTS.claim(id);
        uint256 sigDeadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(bobPk, _claimDigest(CHAIN_ID, address(PAYMENTS), id, sigDeadline));
        vm.expectRevert(NiloPayments.Expired.selector);
        PAYMENTS.claimFor(id, sigDeadline, sig);

        uint256 aliceBefore = USDC.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        PAYMENTS.recover(id);
        console.log("gas recover         ", g - gasleft());
        assertEq(USDC.balanceOf(alice), aliceBefore + 40e6);
        assertEq(PAYMENTS.payments(id).status, 2);

        vm.prank(alice);
        vm.expectRevert(NiloPayments.NotPending.selector);
        PAYMENTS.recover(id);
    }

    function test_Payments_ClaimByRecipient_GasMeasured() public {
        uint256 id = _send(alice, bob, 10e6, uint64(block.timestamp + 1 days));
        vm.prank(bob);
        uint256 g = gasleft();
        PAYMENTS.claim(id);
        console.log("gas claim           ", g - gasleft());
        assertEq(USDC.balanceOf(bob), 10e6);
    }

    function test_Payments_AddressAndBoundsRules() public {
        vm.startPrank(alice);
        USDC.approve(address(PAYMENTS), 10e6);
        vm.expectRevert(NiloPayments.BadPayment.selector);
        PAYMENTS.send(address(0), 1e6, uint64(block.timestamp + 1 hours), bytes32(0));
        vm.expectRevert(NiloPayments.BadPayment.selector);
        PAYMENTS.send(alice, 1e6, uint64(block.timestamp + 1 hours), bytes32(0));
        vm.expectRevert(NiloPayments.BadPayment.selector);
        PAYMENTS.send(bob, 0, uint64(block.timestamp + 1 hours), bytes32(0));
        // The app caps deadlines at 30 days and requires >= 60 s; the contract wants claimUntil in (now, now + 365d].
        vm.expectRevert(NiloPayments.BadPayment.selector);
        PAYMENTS.send(bob, 1e6, uint64(block.timestamp), bytes32(0));
        vm.expectRevert(NiloPayments.BadPayment.selector);
        PAYMENTS.send(bob, 1e6, uint64(block.timestamp + 365 days + 1), bytes32(0));
        PAYMENTS.send(bob, 1e6, uint64(block.timestamp + 30 days), bytes32(0));
        // Arc USDC refuses to approve the zero address, so there is no zero spender to worry about in the app.
        vm.expectRevert();
        USDC.approve(address(0), 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ agent

    function test_Agent_Mandate_Roundtrip_AndViews() public {
        (NiloAgent.Mandate memory m, uint256 allowance) = _signMandate(alice);
        assertEq(allowance, 500e6, "ceil(30d/7d)=5 windows * 100");
        NiloAgent.Mandate memory got = AGENT.mandateOf(alice);
        assertEq(got.limit, m.limit);
        assertEq(got.period, m.period);
        assertEq(got.expiresAt, m.expiresAt);
        assertEq(got.reserve, m.reserve);
        assertEq(got.profile, m.profile);
        assertEq(got.vaults.length, 2);
        assertEq(got.vaults[0], address(PRIME));
        assertEq(got.vaults[1], address(YIELD));
        assertEq(AGENT.remaining(alice), 100e6);
        (uint64 periodStart, uint128 spent) = AGENT.usageOf(alice);
        assertEq(periodStart, block.timestamp);
        assertEq(spent, 0);
        // An address that never signed has expiresAt == 0, which mandateFromChain turns into "no mandate".
        assertEq(AGENT.mandateOf(bob).expiresAt, 0);
        assertEq(AGENT.remaining(bob), 0);
    }

    function test_Agent_Revoke_ThenInvestFails_AllowanceZeroed() public {
        _signMandate(alice);
        // revokeCalls: revoke() then approve(agent, 0).
        vm.startPrank(alice);
        AGENT.revoke();
        USDC.approve(address(AGENT), 0);
        vm.stopPrank();
        assertEq(AGENT.mandateOf(alice).expiresAt, 0);
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.NoMandate.selector);
        AGENT.invest(alice, address(YIELD), 1e6);
    }

    function test_Agent_Guards_OnRealVaults() public {
        _signMandate(alice);
        // not the operator
        vm.prank(alice);
        vm.expectRevert(NiloAgent.NotOperator.selector);
        AGENT.invest(alice, address(YIELD), 1e6);
        // vault outside the mandate
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.VaultNotAllowed.selector);
        AGENT.invest(alice, address(0xdead), 1e6);
        // above the weekly limit
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.OverLimit.selector);
        AGENT.invest(alice, address(YIELD), 100e6 + 1);
        // reserve: wallet 1000, reserve 1 -> investing everything but 0.5 must fail even if the limit allowed it.
        _fund(alice, 50e6);
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.BelowReserve.selector);
        AGENT.invest(alice, address(YIELD), 49.5e6);
    }

    /// @dev The server's balanced run: 60/40 split with the remainder on vault[0], then the user withdraws everything.
    function test_Agent_BalancedInvest_SharesToUser_ThenRedeem() public {
        (NiloAgent.Mandate memory m,) = _signMandate(alice);
        (uint256 pa, uint256 ya) = _plan(alice, m);
        assertEq(pa, 60e6);
        assertEq(ya, 40e6);

        uint256 walletBefore = USDC.balanceOf(alice);
        _invest(alice, PRIME, pa);
        _invest(alice, YIELD, ya);

        uint256 sharesPrime = PRIME.balanceOf(alice);
        uint256 sharesYield = YIELD.balanceOf(alice);
        assertGt(sharesPrime, 0, "prime shares minted to the user");
        assertGt(sharesYield, 0, "yield shares minted to the user");
        assertEq(USDC.balanceOf(alice), walletBefore - 100e6, "user paid exactly the legs");
        assertEq(USDC.balanceOf(address(AGENT)), 0, "agent holds nothing");
        assertEq(USDC.allowance(address(AGENT), address(PRIME)), 0, "no lingering approval to prime");
        assertEq(USDC.allowance(address(AGENT), address(YIELD)), 0, "no lingering approval to yield");
        assertEq(PRIME.balanceOf(address(AGENT)), 0);
        assertEq(YIELD.balanceOf(address(AGENT)), 0);
        // 1% slippage guard actually holds on the real vaults.
        assertGe(PRIME.convertToAssets(sharesPrime) * 10_000, pa * 9_900);
        assertGe(YIELD.convertToAssets(sharesYield) * 10_000, ya * 9_900);
        console.log("prime: invested / worth now", pa, PRIME.convertToAssets(sharesPrime));
        console.log("yield: invested / worth now", ya, YIELD.convertToAssets(sharesYield));

        // Usage + remaining as /status shows them.
        (, uint128 spent) = AGENT.usageOf(alice);
        assertEq(spent, 100e6);
        assertEq(AGENT.remaining(alice), 0);
        assertEq(USDC.allowance(alice, address(AGENT)), 400e6, "allowance drawn down by what was invested");

        // Weekly cap: one more unit is refused until the window rolls.
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.OverLimit.selector);
        AGENT.invest(alice, address(YIELD), 1);
        vm.warp(block.timestamp + WEEK);
        assertEq(AGENT.remaining(alice), 100e6, "window rolled");

        // withdrawCalls: redeem(shares, user, user) on each vault with the user's own balance.
        vm.startPrank(alice);
        uint256 maxP = PRIME.maxRedeem(alice);
        uint256 maxY = YIELD.maxRedeem(alice);
        console.log("maxRedeem prime/yield vs shares", maxP, maxY);
        console.log("   shares prime/yield", sharesPrime, sharesYield);
        uint256 outY = YIELD.redeem(sharesYield, alice, alice);
        uint256 outP = PRIME.redeem(sharesPrime, alice, alice);
        vm.stopPrank();
        assertEq(YIELD.balanceOf(alice), 0);
        assertEq(PRIME.balanceOf(alice), 0);
        assertGe(outY * 10_000, ya * 9_900);
        assertGe(outP * 10_000, pa * 9_900);
        assertGe(USDC.balanceOf(alice), walletBefore - 2e6, "got (almost) everything back");
        console.log("redeemed prime/yield", outP, outY);
    }

    /// @dev Smallest leg the agent will send (0.01 USDC, run.ts split filter) must pass the on-chain 1% share-value check.
    function test_Agent_MinimumLeg_PassesSlippageCheck() public {
        _signMandate(alice);
        _invest(alice, YIELD, 10_000);
        _invest(alice, PRIME, 10_000);
        assertGt(YIELD.balanceOf(alice), 0);
        assertGt(PRIME.balanceOf(alice), 0);
    }

    /// @dev Trims the window: after a week the agent can spend a full limit again inside the same mandate.
    function test_Agent_WindowRoll_AllowsSecondWeek() public {
        _signMandate(alice);
        _invest(alice, YIELD, 100e6);
        vm.prank(OPERATOR);
        vm.expectRevert(NiloAgent.OverLimit.selector);
        AGENT.invest(alice, address(YIELD), 1e6);
        vm.warp(block.timestamp + WEEK);
        _invest(alice, YIELD, 100e6);
        (uint64 start, uint128 spent) = AGENT.usageOf(alice);
        assertEq(start, block.timestamp);
        assertEq(spent, 100e6);
        // The mandate (30 days) is still valid; the approval covers ceil(30/7)=5 windows -> 300 left.
        assertEq(USDC.allowance(alice, address(AGENT)), 300e6);
    }

    function test_Agent_BadMandates_ZeroAddressAndFriends() public {
        NiloAgent.Mandate memory m = _balancedMandate();
        m.vaults[1] = address(0);
        vm.prank(alice);
        vm.expectRevert(NiloAgent.BadMandate.selector);
        AGENT.setMandate(m);

        // A vault whose asset() is not USDC (the payments contract has no asset()) is rejected, not a raw revert.
        m = _balancedMandate();
        m.vaults[1] = address(PAYMENTS);
        vm.prank(alice);
        vm.expectRevert(NiloAgent.BadMandate.selector);
        AGENT.setMandate(m);

        // expiresAt in the past (e.g. chat rule "days: 0").
        m = _balancedMandate();
        m.expiresAt = uint64(block.timestamp);
        vm.prank(alice);
        vm.expectRevert(NiloAgent.BadMandate.selector);
        AGENT.setMandate(m);
    }
}
