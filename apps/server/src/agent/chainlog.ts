// Rebuilds the agent's users and history from NiloAgent's own events, so a restart (or a host
// whose disk is wiped on every deploy) loses nothing that happened on-chain: every wallet with
// a mandate is found again, and each mandate, investment and revoke comes back with its hash.
//
// Arc mainnet's agent was deployed hundreds of thousands of blocks ago, and this file is wiped
// whenever the free-tier disk is. One pass therefore reads only a bounded span and checkpoints
// it. The next pass resumes. A kill mid-history no longer starts the walk over.
import type { Address } from "viem";
import { agentAbi, fromUnits, personalityByCode, unitsToUsdc, vaultInfo } from "@nilo/core";
import { getRpc, network, requireContract, txLink } from "../chain";
import { logError } from "../errors";
import { limits } from "../limits";
import { addUser, record, setSyncedBlock, syncedBlock } from "./store";

/** Blocks per getLogs request; halved when the RPC refuses a range. */
const STEP = 10_000n;
const MIN_STEP = 500n;
/** At most one sync every this many ms; status requests call it freely. */
const MIN_GAP_MS = 20_000;

let last = 0;
let running: Promise<void> | null = null;
let continueTimer: ReturnType<typeof setTimeout> | null = null;
const blockTimes = new Map<bigint, string>();

async function timeOf(block: bigint): Promise<string> {
  const known = blockTimes.get(block);
  if (known) return known;
  const { timestamp } = await getRpc().getBlock({ blockNumber: block });
  const iso = new Date(Number(timestamp) * 1000).toISOString();
  if (blockTimes.size > 5_000) blockTimes.clear();
  blockTimes.set(block, iso);
  return iso;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

type Pass = "done" | "continue" | "retry";

async function apply(ev: {
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
  eventName: string;
  args: unknown;
}) {
  if (ev.blockNumber === null || ev.transactionHash === null) return;
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

/** One bounded slice of history. Checkpoints the last block fully read. */
async function syncPass(): Promise<Pass> {
  const agent = requireContract("agent");
  const head = await getRpc().getBlockNumber();
  const from = (syncedBlock() ?? network.agentFromBlock - 1n) + 1n;
  if (from > head) return "done";
  const budgetEnd = from + limits.syncBlockBudget - 1n;
  const passEnd = budgetEnd < head ? budgetEnd : head;
  let step = STEP;
  let calls = 0;
  let cursor = from;
  let advancedTo = from - 1n;
  let failed: unknown = null;

  while (cursor <= passEnd) {
    if (calls >= limits.syncMaxCalls) break;
    const end = cursor + step - 1n < passEnd ? cursor + step - 1n : passEnd;
    try {
      calls++;
      const logs = await getRpc().getContractEvents({ address: agent, abi: agentAbi, fromBlock: cursor, toBlock: end });
      for (const ev of logs) {
        await apply(ev);
        await yieldNow();
      }
      advancedTo = end;
      cursor = end + 1n;
      step = STEP;
      await yieldNow();
    } catch (e) {
      failed = e;
      if (step <= MIN_STEP || calls >= limits.syncMaxCalls) break;
      step /= 2n;
    }
  }

  if (advancedTo >= from) await setSyncedBlock(advancedTo);
  if (failed) {
    logError("agent: could not read NiloAgent events", failed);
    return "retry";
  }
  return advancedTo < head ? "continue" : "done";
}

function schedule(ms: number) {
  if (continueTimer) clearTimeout(continueTimer);
  continueTimer = setTimeout(() => {
    continueTimer = null;
    void syncFromChain(true);
  }, ms);
  continueTimer.unref?.();
}

/** Brings the log toward the chain's head. One pass per call. Never throws. */
export async function syncFromChain(force = false): Promise<void> {
  if (running) return running;
  if (!force && Date.now() - last < MIN_GAP_MS) return;
  last = Date.now();
  let release: () => void = () => undefined;
  running = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const next = await syncPass().catch((e): Pass => {
      logError("agent: could not read NiloAgent events", e);
      return "retry";
    });
    if (next === "continue") schedule(limits.syncContinueMs);
    else if (next === "retry") schedule(limits.syncRetryMs);
  } finally {
    running = null;
    release();
  }
}

export function resetSyncForTests() {
  if (continueTimer) clearTimeout(continueTimer);
  continueTimer = null;
  running = null;
  last = 0;
  blockTimes.clear();
}
