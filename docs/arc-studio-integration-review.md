# Nilo onchain integration review (balanced)

Scope: the app's onchain layer in the app (`packages/core`, `apps/web`, `apps/server`) (packages/core, apps/web, apps/server) against the DEPLOYED
NiloAgent `0x16f0…64c6` and NiloPayments `0x90ad…67cb` on Arc Testnet (5042002). Verified two ways: reading the code,
and a Foundry fork test (`contracts/test-integration/NiloFork.t.sol`, 17/17 pass) that drives the deployed contracts
with the same calldata, EIP-712 domain/types, split and math as the app. Line numbers refer to the files under the app (`packages/core`, `apps/web`, `apps/server`).

Live chain facts measured during the review: base fee 20 gwei (flat over the last blocks), `eth_maxPriorityFeePerGas`
5 gwei, `eth_gasPrice` 25 gwei. Arc USDC reverts `transfer`/`approve` to address(0) ("ERC20: transfer to the zero
address", "approve to the zero address") and its `decimals()` is 6. The vault `0xaabb…8e88` returns `maxDeposit = 0`
and `maxRedeem = 0` yet `deposit` and `redeem` work (see "Fine").

## Bugs, most important first

### 1. Gasless claim is refused for EIP-7702-delegated recipients (contract side, NiloPayments)
`NiloPayments.claimFor` uses OpenZeppelin `SignatureChecker`: a signer that has code is treated as a contract and only
ERC-1271 is tried. On Arc Testnet `0x7099…79C8` already carries 7702 delegation code (`0xef0100…`). A plain ECDSA
signature from such an EOA (what any browser wallet produces) reverts `BadSignature`, even though the signature is
valid (fork test `test_Payments_ClaimFor_Eip7702DelegatedEoa_EcdsaSigRefused`). Funds are never at risk (the recipient
can still `claim()`, the sender can still `recover()`), but the recipient with an empty wallet is exactly who needs the relayer.
- App impact: `sponsor.ts:74-82` may pass (viem verifies), then `simulateContract` (sponsor.ts:87) fails before any gas is spent
  and the user sees "The contract refused the claim" (sponsor.ts:106-107).
- Fix (next contract version, no redeploy now): try ECDSA first (`ECDSA.tryRecover(...) == payment.to`), then fall back to
  `SignatureChecker`'s ERC-1271 path. App side: when the sponsored claim fails with that message, tell the user to claim with their own gas.

### 2. The free-claim path can be starved by anyone (sponsor.ts:56-61, 96-97; claim.ts:13)
The server never checks that the claimant really has no gas: `SPONSOR_BELOW` exists only in the browser (claim.ts:13).
Anyone who owns a few wallets with a 0.01 USDC payment each can use 120 relays/hour (perHour) and lock out real users,
who are by definition the ones with an empty wallet. The limit checks (58-61) also run before the awaits and are only
recorded at 96-97, so concurrent requests all pass the check.
- Fix: in `sponsorClaim`, read `balanceOf(claimant)` and refuse when it is >= 50_000 units; reserve the slot synchronously
  (push the timestamp before the first `await`, remove it on failure); also rate-limit per payment `from` (payment.from),
  not only per claimant; require `nowSec + 5 < claimUntil` (sponsor.ts:71) so a claim mined one block late is not simulated as valid.

### 3. A relayed claim whose receipt times out is released for a second send (sponsor.ts:98, 101-103)
`waitForTransactionReceipt(..., timeout: 30_000)` throws on timeout; the catch removes the id from `relayed` although the
hash was already broadcast. A retry passes every pre-check (status still Pending), is simulated OK, and a second `claimFor`
is sent; one of the two reverts `NotPending` on chain and the operator pays for it.
- Fix: set a `broadcast` flag after `writeContract` returns and only `relayed.delete(req.id)` when the failure happened before it.

### 4. Withdraw can leave shares behind and does not use fresh balances (Agent.tsx:100, agent.ts:158-162)
`withdrawCalls` redeems the share counts from `/status`, which can be 15 s old (Agent.tsx:53-56) and may predate an hourly
invest. The explanation promises "all your shares" (explainAgent.ts:84).
- Fix: in `actionPrepare("withdraw")` read `balanceOf(user)` of each vault from the chain right before building the calls.
- Do NOT gate or size the redeem with `maxRedeem` (it is in abi.ts:19): on `0xaabb…8e88` it returns 0 while `redeem(shares)` succeeds.

### 5. Fractional or non-positive chat rules crash or revert (agent.ts:72, 82-90, 111-118)
`days: 1.5` makes `expiresAt` a non-integer and `BigInt(m.expiresAt)` (agent.ts:115) throws RangeError. `days <= 0` gives an
`expiresAt` in the past: the `approve` goes out first, then `setMandate` reverts `BadMandate`. `weeklyLimit` of 0, negative,
NaN or above uint128 behaves the same way (limit 0 is `BadMandate`).
- Fix: validate in `mandateFrom`: `Number.isInteger(days) && days >= 1`, `Number.isFinite(weeklyLimit) && weeklyLimit > 0`,
  and `usdcToUnits(weeklyLimit) <= 2^128-1`; throw before building any call.

### 6. An expired mandate is shown as Active and cannot be replaced (Agent.tsx:136, 148, 224, 249; routes.ts:76-87)
The contract keeps an expired mandate (`expiresAt != 0`), `mandateFromChain` returns it, and the UI branches only on
`status.mandate`. After expiry the dashboard still shows the green "Active" pill and the personality picker never appears; the
user has to Revoke first. The server also logs "expired" for each run (run.ts:73).
- Fix: have `/status` return `active: expiresAt > now` and treat expired as "no active mandate" in Agent.tsx (show the picker,
  keep Withdraw). Re-signing replaces the mandate in one `setMandate` call, no revoke needed.

### 7. Short deadlines can expire between the approval and the send (build.ts:23, validate.ts:70, config.ts:126)
`deadline` is computed once, before the wallet shows the first of two confirmations. With the 60 s minimum, a slow approval
makes `send` revert `BadPayment` (`claimUntil <= block.timestamp`), leaving the approval behind. Browser clock skew has the same effect.
- Fix: raise `MIN_DEADLINE_SECONDS` to 300, or rebuild the `send` call (new deadline) right after the approval lands.

### 8. Address checksum protection is switched off for typed recipients (config.ts:137, validate.ts:39)
`isAddress(a, { strict: false })` accepts a mixed-case address with a wrong checksum, which is how most typos are caught.
Funds would be escrowed for the wrong recipient and only come back after the deadline.
- Fix: use viem's default (`strict: true`) for `resolveRecipient`; keep `strict: false` for server inputs that are lowercased anyway.

### 9. Fee floor is not enforced in the browser (wallet.tsx:125, config.ts:112-122)
`sendTransaction` passes no fee fields, so the wallet picks them. Arc requires maxFeePerGas >= 20 gwei and the base fee sits
exactly at that floor, so a wallet estimate that comes in low gets rejected or stuck. Not reproduced (wallet dependent), but
cheap to rule out.
- Fix: `const fees = await publicClient.estimateFeesPerGas(); maxFeePerGas = max(fees.maxFeePerGas, 20_000_000_000n)` and pass
  `maxFeePerGas`/`maxPriorityFeePerGas` in `sendTransaction`. The server needs nothing: viem estimates baseFee x 1.2 + tip = 29 gwei.

### 10. Small amounts invest nothing and report nothing (agent.ts:108, run.ts:80-91, Agent.tsx:80)
`MIN_INVEST` is 0.01 USDC but `split` drops every leg under 0.01. For 0.01 to about 0.0249 USDC both legs are dropped,
`runFor` returns `[]` with no log, and the UI shows an empty notice.
- Fix: if no leg survives, put the whole amount in the first vault, or log a "skip".

### 11. Operator nonce race between agent and relayer (chain.ts:56-62, run.ts:95-105, sponsor.ts:86-98)
`serial()` returns after the broadcast, the receipt is awaited outside it. Two quick tasks rely on the node's pending nonce.
Low risk on Arc (fast finality), but the fix is one line: await the receipt inside `serial`.

### Smaller notes
- `claim.ts:35-37`: below 0.05 USDC the UI always picks the relayer; if it is down ("Claim paying the gas instead",
  sponsor.ts:105) there is no way to pick self-pay. Offer both when the balance covers gas (~0.002 USDC).
- `routes.ts:46-57`: `/activate` and `/run` are unauthenticated. They can only do what the user's mandate allows, but anyone can
  trigger an invest at a moment of their choosing; the 1% check bounds the damage. Fine for a demo, gate them for mainnet.
- Owner and operator are the same key in the deployment you asked for. A leaked operator key can also rotate the operator; use a
  separate cold owner on mainnet (same constructor args shape).
- `config.ts:76`: the on-chain `name()` of `0xaabb…8e88` is empty; the label "EarnKit USDC Vault" is only yours. Agent.tsx:190
  says the vaults are "the same ones Circle's Earn Kit lists"; check that claim for the testnet vault before shipping copy.

## What is fine (checked)

- ABI and struct encoding: every selector in `abi.ts` equals the deployed contract's (`test_AbiParity_SelectorsAndErrors`).
  `Mandate` field order and types, `Payment` (uint128 amount, uint64 times, uint8 status), `usageOf`, events and the error selectors I checked (Expired, SlippageExceeded, FundsRetained, OverLimit)
  errors match. `setMandate(Mandate)` as a dynamic tuple round-trips via `mandateOf`; an empty mandate has `expiresAt == 0`,
  which is what `mandateFromChain` keys on.
- EIP-712: domain `{name:"NiloPayments", version:"1", chainId, verifyingContract}` and `Claim(uint256 id,uint256 deadline)` equal the
  contract's `eip712Domain()` and typehash. A signature produced by viem itself (`signTypedData`, fixed vector) is accepted byte for byte;
  wrong signer, wrong chainId, wrong verifyingContract, other id, expired `sigDeadline` and replay are all refused. `sigDeadline = min(now+600, claimUntil)` is valid.
- Approve-then-call: approving exactly `amount` and sending leaves allowance 0; `setMandate` allowance = `limit x ceil((expiresAt-now)/period)`
  is exactly enough for every possible window (500 USDC for 100/week over 30 days, 400 left after the first 100, 300 after the second week).
  Revoke (`revoke()` then `approve(agent, 0)`) ends the mandate and zeroes the allowance; `approve` to a non-zero spender is the only shape used.
- Relayer pre-checks: status, recipient, deadline, signature and `simulateContract` all happen before any gas; the contract pays only
  `payment.to` (relayer balance unchanged in the fork test). `claimFor` costs ~41k gas, `claim` ~33k: about 0.0012 and 0.001 USDC at 29 gwei.
- Agent math: `idle = wallet - reserve`, `min(idle, remaining, allowance)`, a 60/40 split with the remainder on vault[0], and per-leg reserve
  checks on the running balance never exceed the reserve, the weekly limit or the allowance. Window roll and `remaining()` match the
  contract. The on-chain 1% share-value check passes on both real vaults, including the 0.01 USDC minimum leg (worth 59,999,999 of 60,000,000
  and 9,999 of 10,000). Shares land on the user, the agent holds 0 USDC and 0 allowance to the vaults after each call, and a full redeem
  returns everything within 1 unit.
- Arc specifics: the app reads and compares USDC only in the 6-decimal ERC-20 view and never mixes in the 18-decimal native balance;
  `nativeCurrency.decimals = 18` in `arcChain` and `wallet_addEthereumChain` is correct. address(0): the app rejects it
  (validate.ts:51), the contract reverts `BadPayment` / `BadMandate`, and Arc USDC itself refuses transfers and approvals to it, so the mainnet placeholder
  `ZERO` addresses can never receive an approval. `GAS_BUFFER_UNITS` (0.01 USDC) covers the heaviest user flow measured (approve + send is about 0.0062 USDC at 29 gwei).
  The server's default viem fees (29 gwei) are above the 20 gwei floor.
- "Explain before you sign": the decoders reject any other target, spender, approval amount, recipient or redeem receiver, and the
  builder/decoder pairs agree on every shape the app emits.

## Gas measured on the fork (gas units; cost at 29 gwei)
send 190k (0.0055), claim 33k (0.0010), claimFor 41k (0.0012), recover 33k (0.0010), setMandate 160k (0.0047),
invest 111k to 269k (0.0032 to 0.0078, first deposit into the 18-decimal vault is the heaviest). Arc's native-transfer precompile cost is not included.
