# Nilo on Arc — evidence for reviewers

This page maps each requirement of **Arc Microgrants: Built with Arc Studio** to evidence you can check yourself,
most of it on chain. Every address and hash below is real; the commands at the end verify them in a few minutes
with Foundry's `cast` (no keys needed).

## What Nilo is, in three lines

- A chat wallet for USDC on Arc: you write "send 0.5 USDC to maria, she has 10 minutes"; code (not the AI) builds
  the transaction and decodes it back from its own calldata before you sign, blocking anything that differs.
- **NiloPayments**: payments wait in escrow until a deadline; an empty wallet claims by signing a message and
  Nilo's relayer pays the gas; unclaimed payments go back to the sender.
- **NiloAgent**: you sign one mandate (weekly cap, reserve, which Morpho vaults); Nilo's agent invests your idle
  USDC inside it while you sleep, with the vault shares minted to your wallet, and leaves you a morning briefing.

## Requirements → evidence

| Requirement | Evidence |
|---|---|
| Built with Arc Studio | Project: <https://studio.arc.io/app/7a700c29-561b-4cb6-98f2-826fbaa03a23>. Arc Studio wrote both contracts and the Foundry suite, ran its auditor and Slither (it added the 1% `SlippageExceeded` guard), deployed to Arc Testnet, reviewed the app's onchain layer (11 issues, all fixed: [review](arc-studio-integration-review.md)) and fixed its own EIP-7702 bug in `claimFor`. Mainnet used its [deploy script](../contracts/script/DeployNilo.s.sol). |
| Contracts on Arc mainnet | NiloAgent [`0x6debfa160cc1fd5ef06251690375d3887137e66c`](https://explorer.arc.io/address/0x6debfa160cc1fd5ef06251690375d3887137e66c) (deploy tx [`0x539d4ae9…`](https://explorer.arc.io/tx/0x539d4ae9dda248754501e3b52d6e177645d67659d27e0b0bfaa4e4f0d9908221)) and NiloPayments [`0xe98557734f797583c0b5e288e2cadfc09e826ab6`](https://explorer.arc.io/address/0xe98557734f797583c0b5e288e2cadfc09e826ab6) (deploy tx [`0x7655df8a…`](https://explorer.arc.io/tx/0x7655df8a45d99f34176058e75190899ef7942e442405c35ac04d2a0ba041b654)), chain 5042. Source: [`contracts/`](../contracts). |
| Live public app | Mainnet: <https://nilo-arc.onrender.com>. Testnet (free faucet USDC): <https://nilo-arc-testnet.onrender.com>. Both on Render's free plan: the first visit can take ~1 minute to wake. On a phone, the app opens itself inside the MetaMask app. |
| At least one mainnet transaction moving USDC | A real user mandate: the agent [invested 1.197068 USDC into Steakhouse Prime USDC](https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda) and [0.798045 USDC into Gauntlet USDC Balanced](https://explorer.arc.io/tx/0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6) (shares minted to the user). A gasless payment: [0.5 USDC escrowed](https://explorer.arc.io/tx/0xa51ed23b79df3cbe090fb80b9ca436f4695a27d15602e91b98dfaac5775aed63), then [claimed by an empty wallet through the relayer](https://explorer.arc.io/tx/0x7cbbbfb096ea7dfaecb52cb0230db47d42df9f90d8b3bbf3c670f9a5fedf63c6). |
| Public repository | <https://github.com/pedro-pelicioni/nilo-arc> |
| Video walkthrough | See [hackathon-submission.md](hackathon-submission.md) (link added on upload). |

## Circle and Arc pieces used

| Piece | Where |
|---|---|
| USDC as Arc's native gas, read and moved through its ERC-20 interface (`0x3600…0000`, 6 decimals; 18 for native gas) | [`packages/core/src/config.ts`](../packages/core/src/config.ts), [`apps/web/src/wallet.tsx`](../apps/web/src/wallet.tsx) (fee floor), [`packages/core/src/validate.ts`](../packages/core/src/validate.ts) (gas buffer) |
| Morpho USDC vaults listed by Circle's Earn Kit (ERC-4626): Steakhouse Prime USDC and Gauntlet USDC Balanced on mainnet | [`contracts/NiloAgent.sol`](../contracts/NiloAgent.sol), [`packages/core/src/agent.ts`](../packages/core/src/agent.ts) |
| EIP-712 gasless claims (`claimFor`), ECDSA first, then ERC-1271 (smart and EIP-7702 wallets) | [`contracts/NiloPayments.sol`](../contracts/NiloPayments.sol), [`apps/server/src/sponsor.ts`](../apps/server/src/sponsor.ts) |
| Arc Studio (contracts, audit, tests, deploy, integration review) | [`contracts/`](../contracts), [review](arc-studio-integration-review.md) |

## Safety model (why a user can trust it)

- The AI never builds a transaction: it extracts a structured request; code validates it, builds the calls and
  decodes them back ([`explainCalls`](../packages/core/src/explain.ts), [`explainAgentCalls`](../packages/core/src/explainAgent.ts));
  any field that differs from the request blocks signing.
- NiloAgent: only the user sets or revokes a mandate; the operator can only call `invest`, only into the user's
  vaults, within the weekly cap and above the reserve; shares are minted to the user; a 1% share-value check
  stops bad fills. The operator never holds user funds.
- NiloPayments: only the recipient can claim before the deadline (the relayer cannot redirect funds), only the
  sender can recover after it.

## Tests

| Suite | Result | Command |
|---|---|---|
| Contracts: unit, fuzz, invariants | 163 passed | `cd contracts && npm install && npm test` |
| Contracts: fork suite against the deployed testnet contracts, with the app's exact calldata | 19 passed | `cd contracts && npm run test:fork` |
| Core: validation, builders, decoders, agent math | 15 passed | `npm install && npm test` |
| End to end on testnet (contracts, then through the server) | passing | `scripts/smoke-testnet.ts`, `scripts/smoke-server.ts` |

## Verify it yourself (read-only)

```bash
R=https://rpc.mainnet.arc.io
A=0x6debfa160cc1fd5ef06251690375d3887137e66c   # NiloAgent
P=0xe98557734f797583c0b5e288e2cadfc09e826ab6   # NiloPayments
U=0xbaE414d4481d17c6Fc96885935881B2AC3BdA8f4   # the first mainnet user

cast call $A 'usdc()(address)' --rpc-url $R                     # 0x3600…0000, Arc's USDC
cast call $A 'operator()(address)' --rpc-url $R                 # Nilo's operator
cast call $A 'mandateOf(address)((uint256,uint64,uint64,uint256,uint8,address[]))' $U --rpc-url $R
cast call 0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298 'balanceOf(address)(uint256)' $U --rpc-url $R   # Steakhouse shares
cast receipt 0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda status --rpc-url $R
curl -s https://nilo-arc.onrender.com/api/agent/status/$U       # what the Agent page shows: positions, log, briefing data
curl -s https://nilo-arc.onrender.com/api/market                # BTC/ETH over 24 h for the briefing (Coinbase)
```

## Known limits (stated, not hidden)

- Render's free plan sleeps after 15 minutes without visits: the hourly agent run waits for the next visit. The
  agent's users and history are rebuilt from NiloAgent's events on every start, so nothing on chain is lost.
- The morning briefing shows the agent's moves, vault values and BTC/ETH prices; market news is not in v1.
- Contracts reviewed by Arc Studio's auditor and Slither only; not externally audited. Use small amounts.
