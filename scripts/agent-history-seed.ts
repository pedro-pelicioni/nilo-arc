// Reads NiloAgent's whole history once and writes it to apps/server/src/agent/history-seed.ts, so a server
// whose disk was wiped starts from a recent block instead of walking every block since the deploy.
// Read-only: no keys. Run with: npx tsx scripts/agent-history-seed.ts testnet|mainnet
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const id = process.argv[2];
if (id !== "testnet" && id !== "mainnet") {
  console.error("Usage: npx tsx scripts/agent-history-seed.ts testnet|mainnet");
  process.exit(1);
}
process.env.ARC_NETWORK = id;

const { agentAbi } = await import("@nilo/core");
const { getRpc, network } = await import("../apps/server/src/chain");
const { STEP, activityFrom } = await import("../apps/server/src/agent/chainlog");
const { HISTORY_SEED } = await import("../apps/server/src/agent/history-seed");
type Activity = Parameters<typeof activityFrom>[0] extends never ? never : NonNullable<ReturnType<typeof activityFrom>>["entry"];

const rpc = getRpc();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A few blocks behind the head, so every provider has them.
const end = (await rpc.getBlockNumber()) - 20n;
const users = new Set<string>();
const activity: Activity[] = [];
const times = new Map<bigint, string>();

for (let from = network.agentFromBlock; from <= end; from += STEP) {
  const to = from + STEP - 1n < end ? from + STEP - 1n : end;
  let events;
  for (let attempt = 1; ; attempt++) {
    try {
      events = await rpc.getContractEvents({ address: network.agent, abi: agentAbi, fromBlock: from, toBlock: to });
      break;
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(1_500 * attempt);
    }
  }
  for (const ev of events) {
    if (ev.blockNumber === null) continue;
    let at = times.get(ev.blockNumber);
    if (!at) {
      at = new Date(Number((await rpc.getBlock({ blockNumber: ev.blockNumber })).timestamp) * 1000).toISOString();
      times.set(ev.blockNumber, at);
    }
    const out = activityFrom(ev, at);
    if (!out) continue;
    if (out.mandateUser) users.add(out.mandateUser.toLowerCase());
    activity.push(out.entry);
  }
  process.stdout.write(`\r${network.name}: block ${to} of ${end}, ${activity.length} events`);
  await sleep(80);
}

const seeds = { ...HISTORY_SEED, [id]: { block: end.toString(), users: [...users], activity } };
const file = join(import.meta.dirname, "../apps/server/src/agent/history-seed.ts");
writeFileSync(
  file,
  `// Written by scripts/agent-history-seed.ts: NiloAgent's events up to a recent block, so a server
// whose disk was wiped (Render's free plan, on every restart) starts there instead of re-reading
// every block since the deploy. Refresh it with: npx tsx scripts/agent-history-seed.ts <network>
import type { Activity } from "./store";

export interface HistorySeed {
  /** Last block whose events are included. */
  block: string;
  users: string[];
  activity: Activity[];
}

export const HISTORY_SEED: Partial<Record<"testnet" | "mainnet", HistorySeed>> = ${JSON.stringify(seeds, null, 2)};
`,
);
console.log(`\n${network.name}: ${users.size} wallet(s) with a mandate, ${activity.length} events up to block ${end}.`);
