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

## Video walkthrough (about 90 s)

1. Arc Studio project: the contracts, the test run, the deploy (10 s).
2. Connect a wallet; Nilo adds Arc. Profile quiz → Balanced (10 s).
3. Chat: "send 1 USDC to maria, she has 10 minutes" → the decoded review → sign two transactions (20 s).
4. Maria, with 0 USDC, claims by signing a message; the relayer pays the gas (15 s).
5. Agent page: review the mandate (decoded), sign; the agent invests into the Morpho vault; shares in the wallet (20 s).
6. The mainnet transaction on explorer.arc.io (10 s).

## YouTube

**Title:** Nilo on Arc: a USDC agent that invests while you sleep (Built with Arc Studio)

**Description:**

```text
Nilo is a chat wallet and investing agent for USDC on Arc, Circle's stablecoin-native L1. Built with Arc Studio for Arc Microgrants. Everything in this video runs on Arc mainnet.

0:00 Maria needs 0.5 USDC in 10 minutes: tell Nilo in plain words
0:12 Would you sign raw calldata? Nilo decodes it first and checks it against what you asked
0:31 Maria's wallet is empty: she signs a message and Nilo's relayer pays the gas
0:42 One mandate: a weekly cap, a reserve and the Morpho vaults you allow
0:56 Good morning: what the agent invested overnight, what your vaults are worth, BTC and ETH over 24h
1:09 Built with Arc Studio, live on Arc mainnet

Try it: https://nilo-arc.onrender.com (Arc mainnet)
Test USDC version: https://nilo-arc-testnet.onrender.com (free USDC at https://faucet.circle.com)
Code: https://github.com/pedro-pelicioni/nilo-arc
Arc Studio project: https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23

Contracts on Arc mainnet (chain 5042):
NiloAgent    0x6debfa160cc1fd5ef06251690375d3887137e66c
NiloPayments 0xe98557734f797583c0b5e288e2cadfc09e826ab6

First mainnet investment: https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda
Gasless claim on mainnet: https://explorer.arc.io/tx/0x7cbbbfb096ea7dfaecb52cb0230db47d42df9f90d8b3bbf3c670f9a5fedf63c6

How it stays safe:
- The AI never builds a transaction. Code builds it, then decodes it back from its own calldata; anything that differs from your request blocks signing.
- The agent can only invest inside the mandate you signed, only into the vaults you picked, and the vault shares are minted to your wallet. Withdraw or revoke at any time.
- A payment can only be claimed by its recipient before the deadline, or recovered by you after it.

Contracts reviewed by Arc Studio's auditor and Slither; not externally audited. Use small amounts.

#Arc #Circle #USDC #ArcStudio #Morpho #DeFi #AIagents
```
