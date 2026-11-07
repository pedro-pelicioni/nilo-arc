// Written by scripts/agent-history-seed.ts: NiloAgent's events up to a recent block, so a server
// whose disk was wiped (Render's free plan, on every restart) starts there instead of re-reading
// every block since the deploy. Refresh it with: npx tsx scripts/agent-history-seed.ts <network>
import type { Activity } from "./store";

export interface HistorySeed {
  /** Last block whose events are included. */
  block: string;
  users: string[];
  activity: Activity[];
}

export const HISTORY_SEED: Partial<Record<"testnet" | "mainnet", HistorySeed>> = {
  "mainnet": {
    "block": "30020214",
    "users": [
      "0xbae414d4481d17c6fc96885935881b2ac3bda8f4"
    ],
    "activity": [
      {
        "id": "0xb85893ab7949ee40060187bcb54be9de745ab9b2fdaa97898654e52a9a818040:3",
        "at": "2026-11-02T00:16:23.000Z",
        "hash": "0xb85893ab7949ee40060187bcb54be9de745ab9b2fdaa97898654e52a9a818040",
        "link": "https://explorer.arc.io/tx/0xb85893ab7949ee40060187bcb54be9de745ab9b2fdaa97898654e52a9a818040",
        "user": "0xbae414d4481d17c6fc96885935881b2ac3bda8f4",
        "kind": "mandate",
        "note": "Mandate active: up to 100 USDC per week as Balanced."
      },
      {
        "id": "0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda:22",
        "at": "2026-11-02T00:16:24.000Z",
        "hash": "0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda",
        "link": "https://explorer.arc.io/tx/0x9f9d7e2e20dde8071ae83ad6f6bdf2a03530e51d5271710ba1f92c869c47acda",
        "user": "0xbae414d4481d17c6fc96885935881b2ac3bda8f4",
        "kind": "invest",
        "vault": "0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298",
        "amount": "1.197068",
        "note": "Invested 1.197068 USDC into Steakhouse Prime USDC. The vault shares are in your wallet."
      },
      {
        "id": "0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6:33",
        "at": "2026-11-02T00:16:26.000Z",
        "hash": "0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6",
        "link": "https://explorer.arc.io/tx/0xad4643200a79cf75daff69859b9f2fdcae35ae7e95307461eb9dd64644b4f2f6",
        "user": "0xbae414d4481d17c6fc96885935881b2ac3bda8f4",
        "kind": "invest",
        "vault": "0x10AF7238C6355Aa8dDB5eD60E2e9b55a72827B51",
        "amount": "0.798045",
        "note": "Invested 0.798045 USDC into Gauntlet USDC Balanced. The vault shares are in your wallet."
      }
    ]
  },
  "testnet": {
    "block": "71210723",
    "users": [
      "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59"
    ],
    "activity": [
      {
        "id": "0x8fd6d17aa093b00ed80ed8c02d15c2973915d01841f3dab96cfd63eaee48e149:14",
        "at": "2026-11-01T21:03:39.000Z",
        "hash": "0x8fd6d17aa093b00ed80ed8c02d15c2973915d01841f3dab96cfd63eaee48e149",
        "link": "https://explorer.testnet.arc.io/tx/0x8fd6d17aa093b00ed80ed8c02d15c2973915d01841f3dab96cfd63eaee48e149",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "mandate",
        "note": "Mandate active: up to 1 USDC per week as Guardian."
      },
      {
        "id": "0x1f3395c1f1fb55bc0233702c8a2ae43eb4d1245fdad23f10d683a1a452091b53:26",
        "at": "2026-11-01T21:03:44.000Z",
        "hash": "0x1f3395c1f1fb55bc0233702c8a2ae43eb4d1245fdad23f10d683a1a452091b53",
        "link": "https://explorer.testnet.arc.io/tx/0x1f3395c1f1fb55bc0233702c8a2ae43eb4d1245fdad23f10d683a1a452091b53",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
        "amount": "0.2",
        "note": "Invested 0.2 USDC into EarnKit USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x08cecb2a74995be38bcb98b69486ae9d9a7b15576af539ebfab0379a86ef6261:21",
        "at": "2026-11-01T21:03:53.000Z",
        "hash": "0x08cecb2a74995be38bcb98b69486ae9d9a7b15576af539ebfab0379a86ef6261",
        "link": "https://explorer.testnet.arc.io/tx/0x08cecb2a74995be38bcb98b69486ae9d9a7b15576af539ebfab0379a86ef6261",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "revoke",
        "note": "Mandate revoked. The agent can no longer invest for you."
      },
      {
        "id": "0xdc60a331b7e7bf68e1d267792dc4595bf36d8033d91602197c562edbcdddddb9:16",
        "at": "2026-11-01T21:06:46.000Z",
        "hash": "0xdc60a331b7e7bf68e1d267792dc4595bf36d8033d91602197c562edbcdddddb9",
        "link": "https://explorer.testnet.arc.io/tx/0xdc60a331b7e7bf68e1d267792dc4595bf36d8033d91602197c562edbcdddddb9",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "mandate",
        "note": "Mandate active: up to 1 USDC per week as Balanced."
      },
      {
        "id": "0xf8cc5e21e8394b9e5a2e405e889a9ed22564a7cc813b5dc1718b2431d0cee676:96",
        "at": "2026-11-01T21:06:49.000Z",
        "hash": "0xf8cc5e21e8394b9e5a2e405e889a9ed22564a7cc813b5dc1718b2431d0cee676",
        "link": "https://explorer.testnet.arc.io/tx/0xf8cc5e21e8394b9e5a2e405e889a9ed22564a7cc813b5dc1718b2431d0cee676",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
        "amount": "0.6",
        "note": "Invested 0.6 USDC into EarnKit USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x51f209ef29936b027da7b67e36a0ed62d598ae7013f56f7f472e3ddde2d28e70:65",
        "at": "2026-11-01T21:06:50.000Z",
        "hash": "0x51f209ef29936b027da7b67e36a0ed62d598ae7013f56f7f472e3ddde2d28e70",
        "link": "https://explorer.testnet.arc.io/tx/0x51f209ef29936b027da7b67e36a0ed62d598ae7013f56f7f472e3ddde2d28e70",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
        "amount": "0.4",
        "note": "Invested 0.4 USDC into Morpho USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0xa800ee143a8ee7a8b577cd02c5c58fb4d8a4add4595d2060f2d2c0779279098a:21",
        "at": "2026-11-01T21:07:02.000Z",
        "hash": "0xa800ee143a8ee7a8b577cd02c5c58fb4d8a4add4595d2060f2d2c0779279098a",
        "link": "https://explorer.testnet.arc.io/tx/0xa800ee143a8ee7a8b577cd02c5c58fb4d8a4add4595d2060f2d2c0779279098a",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "revoke",
        "note": "Mandate revoked. The agent can no longer invest for you."
      },
      {
        "id": "0x23d317988a1c3119ce9ccf028a4ac349ed81cef6d6e3172084badc0f5f573e53:6",
        "at": "2026-11-01T21:07:50.000Z",
        "hash": "0x23d317988a1c3119ce9ccf028a4ac349ed81cef6d6e3172084badc0f5f573e53",
        "link": "https://explorer.testnet.arc.io/tx/0x23d317988a1c3119ce9ccf028a4ac349ed81cef6d6e3172084badc0f5f573e53",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "mandate",
        "note": "Mandate active: up to 1 USDC per week as Balanced."
      },
      {
        "id": "0x5c5b1105ffbbfdf3665aa9d5fba273163ad7b870434e4bf1f49b582dce86ca65:19",
        "at": "2026-11-01T21:07:52.000Z",
        "hash": "0x5c5b1105ffbbfdf3665aa9d5fba273163ad7b870434e4bf1f49b582dce86ca65",
        "link": "https://explorer.testnet.arc.io/tx/0x5c5b1105ffbbfdf3665aa9d5fba273163ad7b870434e4bf1f49b582dce86ca65",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
        "amount": "0.6",
        "note": "Invested 0.6 USDC into EarnKit USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0xee62c22e4ddde8bce86a8cd9870bf075404951c5b30353d809749da9fbcce5b9:33",
        "at": "2026-11-01T21:07:56.000Z",
        "hash": "0xee62c22e4ddde8bce86a8cd9870bf075404951c5b30353d809749da9fbcce5b9",
        "link": "https://explorer.testnet.arc.io/tx/0xee62c22e4ddde8bce86a8cd9870bf075404951c5b30353d809749da9fbcce5b9",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
        "amount": "0.4",
        "note": "Invested 0.4 USDC into Morpho USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x406ef379c17e4e6f9dd6763ff2a19897c6b07488d01c6095bd2a43257ea325e3:48",
        "at": "2026-11-01T22:04:13.000Z",
        "hash": "0x406ef379c17e4e6f9dd6763ff2a19897c6b07488d01c6095bd2a43257ea325e3",
        "link": "https://explorer.testnet.arc.io/tx/0x406ef379c17e4e6f9dd6763ff2a19897c6b07488d01c6095bd2a43257ea325e3",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "mandate",
        "note": "Mandate active: up to 1 USDC per week as Balanced."
      },
      {
        "id": "0x79db4d6b858c2ca46b65807f872bb0f5da8640b082ee8079d32f1efc9aee5967:21",
        "at": "2026-11-01T22:04:18.000Z",
        "hash": "0x79db4d6b858c2ca46b65807f872bb0f5da8640b082ee8079d32f1efc9aee5967",
        "link": "https://explorer.testnet.arc.io/tx/0x79db4d6b858c2ca46b65807f872bb0f5da8640b082ee8079d32f1efc9aee5967",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
        "amount": "0.6",
        "note": "Invested 0.6 USDC into EarnKit USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x05e0843d3feb54af3ea86c163b79b3317903cd39ec5223e3f7c7b282a4c3dcbb:16",
        "at": "2026-11-01T22:04:22.000Z",
        "hash": "0x05e0843d3feb54af3ea86c163b79b3317903cd39ec5223e3f7c7b282a4c3dcbb",
        "link": "https://explorer.testnet.arc.io/tx/0x05e0843d3feb54af3ea86c163b79b3317903cd39ec5223e3f7c7b282a4c3dcbb",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
        "amount": "0.4",
        "note": "Invested 0.4 USDC into Morpho USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x9833931cb1a32f92d2a98e19c546f2897ec8dfe97fda220ab89558f9af518f8e:6",
        "at": "2026-11-01T22:04:36.000Z",
        "hash": "0x9833931cb1a32f92d2a98e19c546f2897ec8dfe97fda220ab89558f9af518f8e",
        "link": "https://explorer.testnet.arc.io/tx/0x9833931cb1a32f92d2a98e19c546f2897ec8dfe97fda220ab89558f9af518f8e",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "revoke",
        "note": "Mandate revoked. The agent can no longer invest for you."
      },
      {
        "id": "0xb9d38aa64baacc18a156a04cd2e6b33d6c444220e16bd372c3eff0487f40dfb0:18",
        "at": "2026-11-01T22:50:08.000Z",
        "hash": "0xb9d38aa64baacc18a156a04cd2e6b33d6c444220e16bd372c3eff0487f40dfb0",
        "link": "https://explorer.testnet.arc.io/tx/0xb9d38aa64baacc18a156a04cd2e6b33d6c444220e16bd372c3eff0487f40dfb0",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "mandate",
        "note": "Mandate active: up to 5 USDC per week as Balanced."
      },
      {
        "id": "0x55281ed9fe88560e4ebeb47df5aded1580576ddb740ec47b093ff912c84c2c24:30",
        "at": "2026-11-01T22:50:14.000Z",
        "hash": "0x55281ed9fe88560e4ebeb47df5aded1580576ddb740ec47b093ff912c84c2c24",
        "link": "https://explorer.testnet.arc.io/tx/0x55281ed9fe88560e4ebeb47df5aded1580576ddb740ec47b093ff912c84c2c24",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
        "amount": "3",
        "note": "Invested 3 USDC into EarnKit USDC Vault. The vault shares are in your wallet."
      },
      {
        "id": "0x974dd817406a312c9670f2978210a2230376a07f6b63013d9836c4a2b29f7c9a:27",
        "at": "2026-11-01T22:50:19.000Z",
        "hash": "0x974dd817406a312c9670f2978210a2230376a07f6b63013d9836c4a2b29f7c9a",
        "link": "https://explorer.testnet.arc.io/tx/0x974dd817406a312c9670f2978210a2230376a07f6b63013d9836c4a2b29f7c9a",
        "user": "0xa1a66ad3c702260e0626e7bea9e6482bb5c5eb59",
        "kind": "invest",
        "vault": "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
        "amount": "2",
        "note": "Invested 2 USDC into Morpho USDC Vault. The vault shares are in your wallet."
      }
    ]
  }
};
