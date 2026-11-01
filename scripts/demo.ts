// Shared setup for the testnet scripts: the network, a public client, and wallets for
// Nilo's operator (.env) and the demo accounts (.env.demo). Testnet only.
import { readFileSync } from "node:fs";
import { type Address, type Hex, type TransactionReceipt, createPublicClient, createWalletClient, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Call, type NetworkId, arcChain, explorerTx, fromUnits, makeConfig, erc20Abi, sameAddress } from "@nilo/core";

const id = (process.env.ARC_NETWORK?.trim() || "testnet") as NetworkId;
if (id !== "testnet") {
  console.error("These scripts use the demo accounts and only run on Arc Testnet (unset ARC_NETWORK).");
  process.exit(1);
}

export const config = makeConfig(id);
export const network = config.network;
export const chain = arcChain(network);
export const client = createPublicClient({ chain, transport: http(network.rpcUrl) });

function demoKeys(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env.demo", "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function wallet(name: string, key: string | undefined) {
  if (!key) fail(`Missing ${name}'s key (${name === "operator" ? "NILO_OPERATOR_KEY in .env" : `${name.toUpperCase()}_KEY in .env.demo`}).`);
  const account = privateKeyToAccount(key as Hex);
  return createWalletClient({ account, chain, transport: http(network.rpcUrl) });
}

export type Wallet = ReturnType<typeof wallet>;

const demo = demoKeys();
export const operator = wallet("operator", process.env.NILO_OPERATOR_KEY?.trim());
if (!sameAddress(operator.account.address, network.operator)) fail("NILO_OPERATOR_KEY is not the operator in the core config.");
export const demoWallet = (name: "alice" | "maria" | "bob") => wallet(name, demo[`${name.toUpperCase()}_KEY`]);

export function requireContracts() {
  for (const name of ["payments", "agent"] as const) {
    if (sameAddress(network[name], zeroAddress)) fail(`Nilo's ${name} contract is not deployed on ${network.name} yet (zero address in packages/core/src/config.ts).`);
  }
}

export const usdcOf = (address: Address) => client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
export const usdc = (units: bigint) => `${fromUnits(units)} USDC`;

/** Sends one call from `w`, waits for it and prints the explorer link. */
export async function send(w: Wallet, call: Call, label: string): Promise<TransactionReceipt> {
  const hash = await w.sendTransaction({ to: call.to, data: call.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`${label}: reverted. ${explorerTx(network, hash)}`);
  console.log(`  ${label}: ${explorerTx(network, hash)}`);
  return receipt;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
