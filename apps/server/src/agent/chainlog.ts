// Rebuilds the agent's users and history from NiloAgent's own events, so a restart (or a host
// whose disk is wiped on every deploy) loses nothing that happened on-chain: every wallet with
// a mandate is found again, and each mandate, investment and revoke comes back with its hash.
import type { Address } from "viem";
import { agentAbi, fromUnits, personalityByCode, unitsToUsdc, vaultInfo } from "@nilo/core";
import { client, network, requireContract, txLink } from "../chain";
import { addUser, record, setSyncedBlock, syncedBlock } from "./store";

/** Blocks per getLogs request; halved when the RPC refuses a range. */
const STEP = 10_000n;
/** At most one sync every this many ms; status requests call it freely. */
const MIN_GAP_MS = 20_000;

let last = 0;
let running: Promise<void> | null = null;
const blockTimes = new Map<bigint, string>();

async function timeOf(block: bigint): Promise<string> {
  const known = blockTimes.get(block);
  if (known) return known;
  const { timestamp } = await client.getBlock({ blockNumber: block });
  const iso = new Date(Number(timestamp) * 1000).toISOString();
  blockTimes.set(block, iso);
  return iso;
}

async function logsBetween(address: Address, from: bigint, to: bigint) {
  let step = STEP;
  const out = [];
  for (let start = from; start <= to; ) {
    const end = start + step - 1n < to ? start + step - 1n : to;
    try {
      out.push(...(await client.getContractEvents({ address, abi: agentAbi, fromBlock: start, toBlock: end })));
      start = end + 1n;
    } catch (e) {
      if (step <= 500n) throw e;
      step /= 2n;
    }
  }
  return out;
}

async function sync() {
  const agent = requireContract("agent");
  const head = await client.getBlockNumber();
  const from = (syncedBlock() ?? network.agentFromBlock - 1n) + 1n;
  if (from > head) return;
  for (const ev of await logsBetween(agent, from, head)) {
    if (ev.blockNumber === null || ev.transactionHash === null) continue;
    const id = `${ev.transactionHash}:${ev.logIndex}`;
    const base = { id, at: await timeOf(ev.blockNumber), hash: ev.transactionHash, link: txLink(ev.transactionHash) };
    if (ev.eventName === "MandateSet") {
      const { user, limit, profile } = ev.args as { user: Address; limit: bigint; profile: number };
      addUser(user);
      const name = personalityByCode(Number(profile))?.name ?? `profile ${profile}`;
      record({ ...base, user, kind: "mandate", note: `Mandate active: up to ${unitsToUsdc(limit)} USDC per week as ${name}.` });
    } else if (ev.eventName === "Invested") {
      const { user, vault, amount } = ev.args as { user: Address; vault: Address; amount: bigint };
      const usdc = fromUnits(amount);
      const vaultName = vaultInfo(network, vault)?.name ?? vault;
      record({ ...base, user, kind: "invest", vault, amount: usdc, note: `Invested ${usdc} USDC into ${vaultName}. The vault shares are in your wallet.` });
    } else if (ev.eventName === "Revoked") {
      const { user } = ev.args as { user: Address };
      record({ ...base, user, kind: "revoke", note: "Mandate revoked. The agent can no longer invest for you." });
    }
  }
  setSyncedBlock(head);
}

/** Brings the log up to the chain's head; at most one sync at a time, throttled. Never throws. */
export async function syncFromChain(force = false): Promise<void> {
  if (running) return running;
  if (!force && Date.now() - last < MIN_GAP_MS) return;
  last = Date.now();
  running = sync()
    .catch((e) => console.warn("agent: could not read NiloAgent events:", (e as Error).message))
    .finally(() => {
      running = null;
    });
  return running;
}
