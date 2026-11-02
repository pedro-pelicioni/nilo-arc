# Arc Microgrants submission: Nilo on Arc (draft)

Fill in the `TODO` lines after the mainnet deploy.

## Links

| Field | Value |
|---|---|
| Arc Studio project | https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23 |
| Live app | https://nilo-arc.onrender.com (Arc mainnet) · https://nilo-arc-testnet.onrender.com (testnet, faucet USDC) |
| Public repo | https://github.com/pedro-pelicioni/nilo-arc |
| NiloAgent (mainnet) | `0x6debfa160cc1fd5ef06251690375d3887137e66c`, https://explorer.arc.io/address/0x6debfa160cc1fd5ef06251690375d3887137e66c |
| NiloPayments (mainnet) | `0xe98557734f797583c0b5e288e2cadfc09e826ab6`, https://explorer.arc.io/address/0xe98557734f797583c0b5e288e2cadfc09e826ab6 |
| Gasless claim on mainnet | `0x7cbbbfb096ea7dfaecb52cb0230db47d42df9f90d8b3bbf3c670f9a5fedf63c6`: an empty wallet claims 0.5 USDC; Nilo's relayer pays the gas, https://explorer.arc.io/tx/0x7cbbbfb096ea7dfaecb52cb0230db47d42df9f90d8b3bbf3c670f9a5fedf63c6 |
| Example mainnet tx moving USDC | `0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda` (the agent invests 1.197068 USDC of a user's wallet into Steakhouse Prime USDC), https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda |
| Video walkthrough | YouTube link pending upload (title and description below) |
| Builder profile | TODO (GitHub / X / Farcaster) |

## DoraHacks fields

**Title:** Nilo: the AI bot that invests your USDC while you sleep

**One-liner:** Chat with Nilo, an AI bot on Arc: it learns your investor profile, you sign one mandate, and it
invests your idle USDC into Morpho vaults while you sleep. Live on Arc mainnet, built with Arc Studio.

**Description:**

```text
Nilo is an AI bot for your USDC on Arc. You talk to it like you'd text a friend ("send 5 USDC to maria, she has 10 minutes", "invest at most 30 a week, I'm conservative") and it does the onchain work for you.

What it does
- Learns who you are: 5 questions set your investor profile, and Nilo suggests a personality (Guardian, Balanced or Explorer).
- Invests while you sleep: you sign one mandate (a weekly cap, a reserve that never leaves your wallet, the Morpho vaults you allow). At night Nilo's agent invests your idle USDC inside those limits, with the vault shares minted straight to your wallet.
- Briefs you in the morning: what it invested, what your vaults are worth now, and how BTC and ETH moved.
- Sends payments that can't get lost: USDC waits in escrow until a deadline; an empty wallet claims by signing a message while Nilo's relayer pays the gas; anything unclaimed goes back to the sender.

Why you can trust it
- The AI never builds a transaction. Code builds it and decodes it back from its own calldata before you sign; anything that differs from your request blocks signing.
- NiloAgent only lets Nilo's operator invest, only into your vaults, within your weekly cap and above your reserve. Withdraw or revoke at any time; Nilo never holds your keys.

Built with Arc Studio
Arc Studio wrote NiloAgent and NiloPayments and their Foundry suite (163 tests plus a 19-test fork suite against the deployed contracts), ran its auditor and Slither (it added a 1% slippage guard), deployed to Arc Testnet, reviewed the app's onchain layer (11 issues, all fixed) and fixed its own EIP-7702 bug in claimFor. Mainnet was deployed with its script.

Live on Arc mainnet (chain 5042)
- NiloAgent 0x6debfa160cc1fd5ef06251690375d3887137e66c
- NiloPayments 0xe98557734f797583c0b5e288e2cadfc09e826ab6
- A real Balanced mandate: the agent invested 1.197068 USDC into Steakhouse Prime and 0.798045 USDC into Gauntlet (60/40), shares minted to the user's wallet.
- A gasless claim by an empty wallet, gas paid by Nilo's relayer.
Evidence and read-only verify commands: docs/JUDGING.md in the repo.

Links
App (Arc mainnet): https://nilo-arc.onrender.com
App (testnet, free faucet USDC): https://nilo-arc-testnet.onrender.com
Repo: https://github.com/pedro-pelicioni/nilo-arc
Arc Studio project: https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23
```

## Short description

Nilo is a chat wallet and investing agent for USDC on Arc. You tell it what you want in plain words; it builds
the transaction and, before you sign, explains it from the calldata itself (not from the AI) and blocks anything
that doesn't match what you asked for.

- **Payments that can't get lost (NiloPayments):** every payment waits in escrow until a deadline. The recipient
  claims it before; if nobody does, only the sender can recover it after. A recipient with an empty wallet still
  claims: they sign an EIP-712 message and Nilo's relayer submits `claimFor` and pays the gas in USDC.
- **An agent that invests while you sleep (NiloAgent):** you sign one mandate (weekly cap, which Morpho USDC vaults,
  a reserve that always stays in your wallet, expiry). Nilo's operator, a server bot, can then only deposit your idle
  USDC into those vaults, with the shares minted straight to your wallet. Withdraw by redeeming your own shares;
  revoke at any time.

It covers two of the round's starting points: escrow and conditional payouts, and software paying on a user's
behalf inside limits the user signed.

## How we used Arc Studio

- **Contracts:** we described both contracts (ported from our Soroban version on Stellar) and Arc Studio wrote
  `NiloAgent.sol` and `NiloPayments.sol`.
- **Review:** its auditor and Slither flagged that a vault with weak donation protection could mint a user too few
  shares; Arc Studio added a 1% share-value check to `invest`.
- **Testing:** 163 Foundry tests plus a 19-test fork suite against the deployed contracts, including fuzzing of the weekly cap and invariants on the escrow (the contract's
  balance always equals the sum of pending payments).
- **Deploy:** Arc Studio deployed both contracts to Arc Testnet and verified `usdc()`, `operator()` and each Morpho
  vault's `asset()`; the same deploy script was used for mainnet.
- **App:** Arc Studio reviewed the app's onchain layer against its contracts (ABI and struct encoding, the EIP-712
  claim domain, Arc's 6- vs 18-decimal USDC, the relayer and agent math) and wrote a fork test against the deployed
  contracts.

## Working on Arc mainnet (2 Nov 2026)

A real user wallet on Arc mainnet signed a Balanced mandate in the live app, and Nilo's agent invested its idle
USDC into the two Morpho vaults, with the shares minted to the user's wallet and 1 USDC kept as the reserve:

| Flow | Transaction |
|---|---|
| The user approves NiloAgent for the mandate's length (500 USDC: 100 a week for 30 days) | [approve](https://explorer.arc.io/tx/0xbb47bdc67fd401abb8b99b488ca4d1ec0ecdc3c2092331a105687628a5c0cf9f) |
| The user signs the mandate (100 USDC a week, keep 1 USDC, Steakhouse Prime + Gauntlet Balanced) | [setMandate](https://explorer.arc.io/tx/0xb85893ab7949ee40060187bcb54be9de745ab9b2fdaa97898654e52a9a818040) |
| The agent invests 1.197068 USDC into Steakhouse Prime USDC (60%) | [invest](https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda) |
| The agent invests 0.798045 USDC into Gauntlet USDC Balanced (40%) | [invest](https://explorer.arc.io/tx/0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6) |

## Working on Arc Testnet (1 Nov 2026)

Run with `scripts/smoke-testnet.ts` (contracts directly) and `scripts/smoke-server.ts` (through Nilo's server, as
the app calls it). Every step below succeeded on chain:

| Flow | Transaction |
|---|---|
| alice escrows 0.1 USDC for maria | [send](https://explorer.testnet.arc.io/tx/0xadf523b6039cd17c0cce4f57adf2ea45d6d73cf26f4320a87dfe062bc1493cb1) |
| maria (0 USDC) claims gaslessly; the operator relays `claimFor` | [claimFor](https://explorer.testnet.arc.io/tx/0x3aac53bac85aa14e28ed7ddfe08f188563e4d812c7ffd1b72c396278e5fda2e8) |
| Unclaimed payment to bob; alice recovers it after the deadline | [recover](https://explorer.testnet.arc.io/tx/0xcf2d9de4530ac0bb7685106e3d4f38307c619cb4e5b8a32b3d8bb0b32cca983f) |
| bob (0 USDC) claims through `/api/sponsor-claim` | [claimFor](https://explorer.testnet.arc.io/tx/0x108c8aec3e87c9e58c75179bad15ba66d97ecc2acaf8751a1ac2119d0f0fb4e6) |
| maria, who has USDC, is refused by the relayer and claims paying her own gas | [claim](https://explorer.testnet.arc.io/tx/0xb17991a2284907dba70ea0c3ad3ceb6dec37763df17ddd544ac7294b3b1a41f4) |
| alice signs a Balanced mandate (1 USDC a week) | [setMandate](https://explorer.testnet.arc.io/tx/0xdc60a331b7e7bf68e1d267792dc4595bf36d8033d91602197c562edbcdddddb9) |
| `/api/agent/activate` invests 0.6 into EarnKit USDC Vault and 0.4 into Morpho USDC Vault | [invest 0.6](https://explorer.testnet.arc.io/tx/0xf8cc5e21e8394b9e5a2e405e889a9ed22564a7cc813b5dc1718b2431d0cee676), [invest 0.4](https://explorer.testnet.arc.io/tx/0x51f209ef29936b027da7b67e36a0ed62d598ae7013f56f7f472e3ddde2d28e70) |
| A second run skips: this week's limit is used | (no transaction) |
| alice redeems her shares straight to her wallet | [redeem](https://explorer.testnet.arc.io/tx/0x3e491721a6a5607e53784f004fdee5cdd6b521bc0f0bfecc702b9e1858f8be1a) |

## Video walkthrough (90 s, v2: the AI bot that invests while you sleep)

Bedtime (Nilo awake) → the real investor quiz → Balanced suggested → the decoded mandate, signed → 00:16 UTC,
Nilo throws your idle USDC into Steakhouse Prime and Gauntlet, shares back to your wallet → the mainnet
transaction → Good morning briefing → withdraw or revoke → payments (fast) → Arc Studio → end card.

## Video walkthrough, v1 plan (superseded)

1. Arc Studio project: the contracts, the test run, the deploy (10 s).
2. Connect a wallet; Nilo adds Arc. Profile quiz → Balanced (10 s).
3. Chat: "send 1 USDC to maria, she has 10 minutes" → the decoded review → sign two transactions (20 s).
4. Maria, with 0 USDC, claims by signing a message; the relayer pays the gas (15 s).
5. Agent page: review the mandate (decoded), sign; the agent invests into the Morpho vault; shares in the wallet (20 s).
6. The mainnet transaction on explorer.arc.io (10 s).

## YouTube

**Title:** Nilo: the AI bot that invests your USDC while you sleep (Built with Arc Studio, live on Arc)

**Description:**

```text
Nilo is an AI bot for your USDC on Arc, Circle's stablecoin-native L1. You chat with it, it learns your investor profile, you sign one mandate, and while you sleep it invests your idle USDC into Morpho vaults, with the shares minted to your own wallet. In the morning it tells you what it did. Built with Arc Studio for Arc Microgrants; everything in this video is real, on Arc mainnet.

0:00 You sleep, Nilo invests: it learns your investor profile (5 questions → Balanced)
0:18 One signature, decoded from the transaction itself before you sign
0:29 00:16 UTC: Nilo invests 1.197068 USDC into Steakhouse Prime and 0.798045 into Gauntlet (60/40)
0:52 Good morning: what it invested, what your vaults are worth now, BTC and ETH over 24h
1:06 Your shares, your rules; and payments that can't get lost (gas paid for empty wallets)
1:19 Built with Arc Studio, live on Arc mainnet

Try it: https://nilo-arc.onrender.com (Arc mainnet)
Test USDC version: https://nilo-arc-testnet.onrender.com (free USDC at https://faucet.circle.com)
Code: https://github.com/pedro-pelicioni/nilo-arc
Arc Studio project: https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23

Contracts on Arc mainnet (chain 5042):
NiloAgent    0x6debfa160cc1fd5ef06251690375d3887137e66c
NiloPayments 0xe98557734f797583c0b5e288e2cadfc09e826ab6

The night in this video, on the explorer:
Invest into Steakhouse Prime: https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda
Invest into Gauntlet: https://explorer.arc.io/tx/0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6
Gasless claim: https://explorer.arc.io/tx/0x7cbbbfb096ea7dfaecb52cb0230db47d42df9f90d8b3bbf3c670f9a5fedf63c6

How it stays safe:
- The AI never builds a transaction. Code builds it, then decodes it back from its own calldata; anything that differs from your request blocks signing.
- The agent can only invest inside the mandate you signed, only into the vaults you picked, above the reserve you keep, and the vault shares are minted to your wallet. Withdraw or revoke at any time.
- A payment can only be claimed by its recipient before the deadline, or recovered by you after it.

Contracts reviewed by Arc Studio's auditor and Slither; not externally audited. Use small amounts.

#Arc #Circle #USDC #ArcStudio #Morpho #DeFi #AIagents
```
