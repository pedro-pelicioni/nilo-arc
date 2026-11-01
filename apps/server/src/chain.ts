// The server's view of Arc: which network (ARC_NETWORK, testnet by default), a client to read it,
// and Nilo's operator key, which invests through NiloAgent and relays gasless claims.
import { type Address, type Hex, createPublicClient, createWalletClient, http, isHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type NetworkId, NETWORKS, arcChain, explorerTx, makeConfig, sameAddress } from "@nilo/core";

const id = (process.env.ARC_NETWORK?.trim() || "testnet") as NetworkId;
if (!(id in NETWORKS)) throw new Error(`ARC_NETWORK must be "testnet" or "mainnet", not "${id}".`);

export const config = makeConfig(id);
export const network = config.network;
export const chain = arcChain(network);
export const client = createPublicClient({ chain, transport: http(process.env.ARC_RPC_URL?.trim() || network.rpcUrl) });
export const txLink = (hash: string) => explorerTx(network, hash);

/** A server error with the HTTP status and message the browser should see. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 | 503 = 400,
  ) {
    super(message);
  }
}

/** Fails while a contract isn't deployed on this network yet (its address is still zero in the core config). */
export function requireContract(name: "payments" | "agent"): Address {
  const address = network[name];
  if (sameAddress(address, zeroAddress)) {
    throw new ChainError(`Nilo's ${name} contract is not deployed on ${network.name} yet.`, 503);
  }
  return address;
}

let operatorAccount: ReturnType<typeof privateKeyToAccount> | null = null;

/** The operator account from NILO_OPERATOR_KEY; it must be the operator the core config names. */
export function operator() {
  if (operatorAccount) return operatorAccount;
  const key = process.env.NILO_OPERATOR_KEY?.trim();
  if (!key || !isHex(key) || key.length !== 66) throw new ChainError("The server has no NILO_OPERATOR_KEY.", 503);
  const account = privateKeyToAccount(key as Hex);
  if (!sameAddress(account.address, network.operator)) {
    throw new ChainError("NILO_OPERATOR_KEY is not the operator Nilo's contracts trust.", 503);
  }
  operatorAccount = account;
  return account;
}

export const hasOperator = () => !!process.env.NILO_OPERATOR_KEY?.trim();

export function operatorWallet() {
  return createWalletClient({ account: operator(), chain, transport: http(process.env.ARC_RPC_URL?.trim() || network.rpcUrl) });
}

/**
 * Transactions from the operator go one at a time so their nonces never collide. Callers wait for
 * the receipt inside the task, so the next one never reads a stale pending nonce.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}
