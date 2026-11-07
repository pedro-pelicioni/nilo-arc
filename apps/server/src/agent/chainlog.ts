// Rebuilds the agent's users and history from NiloAgent's own events, so a restart (or a host
// whose disk is wiped on every deploy) loses nothing that happened on-chain: every wallet with
// a mandate is found again, and each mandate, investment and revoke comes back with its hash.
//
// Arc mainnet's agent was deployed hundreds of thousands of blocks ago, and this file is wiped
// whenever the free-tier disk is. One pass therefore reads only a bounded span and checkpoints
// it. The next pass resumes. A kill mid-history no longer starts the walk over.
import type { Address } from "viem";
import { agentAbi, fromUnits, personalityByCode, unitsToUsdc, vaultInfo } from "@nilo/core";
import { getRpc, network, requireContract, rpcCooldownRemainingMs, txLink } from "../chain";
import { isShrinkableHistoryError, logError } from "../errors";
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

/** Wait out a 429 that would otherwise expire in the same beat as the history retry. */
export function historyRetryDelayMs(fallbackMs: number, remainingMs: number, marginMs = 250): number {
  if (remainingMs <= 0) return fallbackMs;
  return Math.max(fallbackMs, remainingMs + marginMs);
}

type PassOutcome = { pass: Pass; from: bigint | null; calls: number; error?: unknown };

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
async function syncPass(): Promise<PassOutcome> {
  let from: bigint | null = null;
  let calls = 0;
  try {
    const agent = requireContract("agent");
    const head = await getRpc().getBlockNumber();
    from = (syncedBlock() ?? network.agentFromBlock - 1n) + 1n;
    if (from > head) return { pass: "done", from, calls };
    const budgetEnd = from + limits.syncBlockBudget - 1n;
    const passEnd = budgetEnd < head ? budgetEnd : head;
    let step = STEP;
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
        // A refused block range or an oversized body can succeed on a smaller slice.
        // A transport failure must not be retried three more times in the same pass.
        if (!isShrinkableHistoryError(e) || step <= MIN_STEP || calls >= limits.syncMaxCalls) break;
        step /= 2n;
      }
    }

    if (advancedTo >= from) await setSyncedBlock(advancedTo);
    if (failed) return { pass: "retry", from, calls, error: failed };
    return { pass: advancedTo < head ? "continue" : "done", from, calls };
  } catch (e) {
    return { pass: "retry", from, calls, error: e };
  }
}

let lastScheduledDelayMs = 0;
export function scheduledDelayForTests() {
  return lastScheduledDelayMs;
}

function schedule(ms: number) {
  lastScheduledDelayMs = ms;
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
    const outcome = await syncPass();
    if (outcome.error !== undefined) {
      logError(`agent: could not read NiloAgent events from=${outcome.from?.toString() ?? "unknown"} calls=${outcome.calls}`, outcome.error);
    }
    if (outcome.pass === "continue") schedule(limits.syncContinueMs);
    else if (outcome.pass === "retry") schedule(historyRetryDelayMs(limits.syncRetryMs, rpcCooldownRemainingMs()));
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
  lastScheduledDelayMs = 0;
  blockTimes.clear();
}
