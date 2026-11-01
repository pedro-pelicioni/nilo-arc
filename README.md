# Nilo on Arc

**Your USDC works while you sleep.**

Arc Microgrants · Built with [Arc Studio](https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23) · Arc Testnet (mainnet last)

Nilo is a chat wallet and investing agent for USDC on Arc. You talk to it ("send 5 USDC to maria, she has 10
minutes", "invest at most 30 dollars a week, I'm conservative"), it builds the transaction, and before you sign it
explains the transaction from its own calldata, not from what the AI said. Two contracts make it safe:

- **NiloPayments**: payments that can't get lost. Every payment sits in escrow until a deadline: the recipient claims
  it before, and if nobody does, only you can take it back after. A recipient with an empty wallet still claims: they
  sign a message and Nilo's relayer pays the gas.
- **NiloAgent**: an agent that invests your idle USDC into Morpho vaults on Arc, inside a mandate you sign once.
  It never holds your key or your funds: the vault shares are minted straight to your wallet.

## Contents

- [Built with Arc Studio](#built-with-arc-studio)
- [How investing works](#how-investing-works)
- [The mandate contract](#the-mandate-contract)
- [Payments that can't get lost](#payments-that-cant-get-lost)
- [Why you can trust what you sign](#why-you-can-trust-what-you-sign)
- [Contracts](#contracts)
- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [Limits of v1](#limits-of-v1)

## Built with Arc Studio

Arc Studio project: <https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23>

| Step | What Arc Studio did |
|---|---|
| Contracts | Wrote [`NiloAgent.sol`](contracts/NiloAgent.sol) and [`NiloPayments.sol`](contracts/NiloPayments.sol) from a spec ported from Nilo's Soroban contract. |
| Review | Ran its Solidity auditor and Slither. It found that a vault with weak donation protection could mint too few shares and added a 1% share-value check to `invest` (`SlippageExceeded`). |
| Tests | Wrote the Foundry suite: unit, fuzz (period cap) and invariants (escrow balance always equals the pending sum, funds conserved), with mocks for USDC with permit, ERC-4626 vaults, malicious vaults and ERC-1271 wallets. |
| Deploy | Deployed both contracts to Arc Testnet and read back `usdc()`, `operator()` and each vault's `asset()`. The [deploy script](contracts/script/DeployNilo.s.sol) takes the same arguments on mainnet. |
| App | Reviewed the app's onchain layer against its contracts (ABI and struct encoding, the EIP-712 claim, Arc's USDC decimals, the relayer and agent math) and wrote a [fork test](contracts/test-integration/NiloFork.t.sol) that drives the deployed contracts with the app's exact calldata and signatures (19 tests). It found 11 issues, all fixed (see [the review](docs/arc-studio-integration-review.md)). One was in its own contract: a gasless claim was refused for EIP-7702 delegated wallets. Arc Studio fixed `claimFor` (plain ECDSA first, then ERC-1271), added 28 tests and redeployed NiloPayments. |

Run the tests yourself:

```bash
cd contracts && npm install
npm test           # unit, fuzz and invariant tests, offline
npm run test:fork  # against the contracts deployed on Arc Testnet
```

## How investing works

1. **Find your profile.** On first connect you answer five questions. Each answer scores 1, 3 or 5 points, and the
   total places you as Conservative (up to 12), Moderate (up to 22) or Aggressive (above 22).
2. **Pick a personality.** Each profile maps to a preset:

   | Personality | Profile | Split | Weekly limit | Always kept in wallet |
   |---|---|---|---|---|
   | Guardian | Conservative | 100% steady vault | 50 USDC | 2 USDC |
   | Balanced | Moderate | 60% steady, 40% higher-yield | 100 USDC | 1 USDC |
   | Explorer | Aggressive | 30% steady, 70% higher-yield | 250 USDC | 0.5 USDC |

   The vaults are Morpho USDC vaults on Arc, the ones Circle's [Earn Kit](https://docs.arc.io/app-kit/earn.md)
   lists. On testnet: EarnKit USDC Vault (steady) and Morpho USDC Vault (higher-yield). On mainnet: Steakhouse Prime
   USDC and Gauntlet USDC Balanced. You can also write your own rules in the chat ("invest at most 30 dollars a
   week for 2 weeks"); the model only reads the request, and code builds the mandate within fixed bounds.
3. **Sign the mandate once.** On the **Agent** page you sign a USDC approval to NiloAgent that covers the mandate's
   length, then the mandate itself (weekly cap, the vaults, the reserve, expiry, 30 days by default). Before you
   sign, the browser decodes both calls and refuses anything else.
4. **Nilo invests while you sleep.** The server checks every wallet with a mandate on a schedule
   (`AGENT_INTERVAL_MINUTES`, 60 by default) and splits the USDC above your reserve across your vaults.
5. **Check in when you are back.** The Agent page shows what is invested in each vault, what is in your wallet,
   what is left of this week's limit, and "While you were away", the log of what the agent did.
6. **Withdraw or revoke at any time.** Withdrawing redeems your vault shares straight to your wallet; Nilo isn't
   involved. Revoking ends the mandate and sets the agent's allowance to 0.

## The mandate contract

[`contracts/NiloAgent.sol`](contracts/NiloAgent.sol) is what makes "invest on my behalf" safe without custody.

| Rule | How the contract enforces it |
|---|---|
| Only you set the rules | `setMandate` and `revoke` act on `msg.sender`. |
| The operator can only invest | Nilo's operator key can call `invest`, nothing else. The owner can only rotate the operator. |
| Only vaults you picked | `invest` refuses any vault not in your mandate. Each vault must be an ERC-4626 whose `asset()` is USDC. |
| The shares are yours | `invest` deposits with `receiver = you`, so the shares land in your wallet. The contract checks it keeps nothing. |
| Inside the caps | Each week's total is checked against your limit (`OverLimit`), and your wallet never drops below your reserve (`BelowReserve`). |
| No bad fills | The shares minted must be worth at least 99% of the deposit (`SlippageExceeded`). |
| Until you say stop | Past `expiresAt`, or after `revoke`, `invest` fails. |

## Payments that can't get lost

[`contracts/NiloPayments.sol`](contracts/NiloPayments.sol) holds each payment in escrow with a deadline.

| Step | What happens |
|---|---|
| Send | Your USDC moves into the contract with a recipient and a deadline (up to a year). |
| Claim | Before the deadline, only the recipient can claim it, into their own wallet. |
| Gasless claim | On Arc the gas is USDC, so an empty wallet couldn't claim. The recipient signs an EIP-712 `Claim(id, deadline)` and Nilo's relayer submits `claimFor`, paying the gas. The contract pays the recipient, never the relayer; the server checks the payment and the signature before spending any gas. |
| Recover | From the deadline on, only you can take it back. |

The **Claim** page lists what is waiting for you, the **Sent** page what you sent, and both refresh on their own.

## Why you can trust what you sign

The AI never builds a transaction. It turns your message into a structured request; then code validates it,
builds the calls, and decodes them back:

- [`explainCalls`](packages/core/src/explain.ts) recognizes exactly the shapes Nilo builds: an approval of exactly
  the payment amount to NiloPayments followed by `send`, or a `claim` / `recover`. Anything else, such as an
  approval to another contract or a plain transfer, is shown as "Do not sign it" and the button is disabled.
- [`explainAgentCalls`](packages/core/src/explainAgent.ts) does the same for the mandate, revoke and withdraw
  calls: only vaults Nilo uses, only redeems that pay you.
- The decoded fields are compared with what you asked for (recipient, amount, deadline, limit, vaults, reserve,
  allowance). Any mismatch blocks signing.

The explanation is generated from the calldata with fixed templates; the AI doesn't write it.

## Contracts

| Network | Contract | Address |
|---|---|---|
| Arc Testnet (5042002) | NiloAgent | [`0x16f0819135205b7d710d99ef92c69173e2d464c6`](https://explorer.testnet.arc.io/address/0x16f0819135205b7d710d99ef92c69173e2d464c6) |
| Arc Testnet (5042002) | NiloPayments | [`0x20376ca84c65242097b57ad1e5a122f86e12f305`](https://explorer.testnet.arc.io/address/0x20376ca84c65242097b57ad1e5a122f86e12f305) |
| Arc (5042) | NiloAgent | not deployed yet |
| Arc (5042) | NiloPayments | not deployed yet |

USDC on Arc is the native gas token; its ERC-20 interface is `0x3600000000000000000000000000000000000000`
(6 decimals). Nilo's operator is `0x59782DC984d9F4e6A37c08B9A63B0DCf77954E1f`.

## Quick start

Requires Node 22+ and a browser wallet (MetaMask, Rabby…). Nilo adds the Arc network to the wallet when you sign.

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY and NILO_OPERATOR_KEY
npm run dev            # server on :8787, web on :5173
```

Get test USDC for your wallet (and for the operator, which pays the gas of investments and gasless claims) at
[faucet.circle.com](https://faucet.circle.com), network Arc Testnet.

| Command | What it does |
|---|---|
| `npm test` | Unit tests of the core: validation, call builders and the decoders. |
| `cd contracts && npm test` | The contracts' Foundry suite (`npm run test:fork` runs the fork test against Arc Testnet). |
| `npx tsx --env-file=.env scripts/smoke-testnet.ts` | End to end on Arc Testnet with demo keys: send → gasless claim, send → recover after the deadline, mandate → operator invest → redeem. Needs `.env.demo` and testnet USDC. |
| `npx tsx --env-file=.env scripts/smoke-server.ts` | The same through the running server, the way the app calls it: `/api/sponsor-claim` for an empty wallet (and its refusals), then `/api/agent/activate` splitting across both vaults. Needs `npm run dev`. |
| `npx tsx --env-file=.env scripts/fund-demo.ts 1` | Sends 1 USDC from the operator to each demo account. |

To run on mainnet, set `ARC_NETWORK=mainnet` and `VITE_ARC_NETWORK=mainnet` once the mainnet addresses are in
[`packages/core/src/config.ts`](packages/core/src/config.ts). The Docker image and the server setup are in
[docs/deploy.md](docs/deploy.md).

## Repository layout

| Path | What it does |
|---|---|
| [`contracts`](contracts) | NiloAgent and NiloPayments, their Foundry tests and the deploy script, from Arc Studio. |
| [`packages/core`](packages/core) | Pure TypeScript: Arc networks and addresses, ABIs, intent schema, validation, call builders, the decoders, payment views, the mandate and price math. |
| [`apps/server`](apps/server) | Hono. `POST /api/extract` (chat → structured request), `POST /api/sponsor-claim` (gasless claim relayer), `POST /api/voice/session` (voice mode), and `/api/agent` (status, activate, run) plus the scheduled agent. |
| [`apps/web`](apps/web) | Vite + React. **Chat** (send, balance, prices, voice), **Agent**, **Claim**, **Sent**. Any EIP-1193 browser wallet. |
| [`scripts`](scripts) | The testnet smoke test and demo funding. |

## Limits of v1

- Only USDC can be sent. Prices (USDC, BTC, ETH, EUR, BRL) come from Coinbase's public rates and are shown for
  reference: a conversion ("send R$ 50") is shown before you sign, and what you sign is the USDC amount.
- Recipients are a full `0x…` address or a nickname from a fixed demo list (`alice`, `maria`, `bob`).
- One operator key invests and relays gasless claims. Its gas is paid from its own USDC.
- The agent's activity log lives in a JSON file on the server.
- Not audited beyond Arc Studio's automated review. Use small amounts.

## Next

- Bridge USDC in from other chains with Circle's App Kit before investing, and let the agent rebalance between
  vaults by APY.
- A passkey smart wallet so new users don't need a browser extension.
