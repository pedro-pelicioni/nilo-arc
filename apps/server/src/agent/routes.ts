// /api/agent: turns the agent on for a user, runs it on request, and reports status.
// The transactions a user signs (mandate, revoke, withdraw) are built in the browser
// from @nilo/core and decoded there before signing; nothing here builds them.
import { type Address, isAddress } from "viem";
import { Hono } from "hono";
import { z } from "zod";
import { agentAbi, erc4626Abi, personalityByCode, unitsToUsdc, vaultInfo } from "@nilo/core";
import { ChainError, getRpc, network, requireContract } from "../chain";
import { isTimeout, logError } from "../errors";
import { limits } from "../limits";
import { activate, agentAllowance, mandateOf, remainingFor, runFor, walletUsdc } from "./run";
import { syncFromChain } from "./chainlog";
import { activityFor } from "./store";

const Account = z
  .string()
  .refine((a) => isAddress(a, { strict: false }), "Invalid wallet address.")
  .transform((a) => a.toLowerCase() as Address);
const AddressRequest = z.object({ address: Account });

const lastManualRun = new Map<string, number>();
const MANUAL_RUN_GAP_MS = 15_000;

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ChainError(parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

/** The user's shares in every vault Nilo uses, and what they are worth now. */
async function positions(user: Address) {
  return Promise.all(
    network.vaults.map(async (v) => {
      const shares = await getRpc().readContract({ address: v.address, abi: erc4626Abi, functionName: "balanceOf", args: [user] });
      const assets = shares > 0n ? await getRpc().readContract({ address: v.address, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] }) : 0n;
      return { vault: v.address, name: v.name, slot: v.slot, shares: shares.toString(), assets: unitsToUsdc(assets) };
    }),
  );
}

export const agent = new Hono();

agent.onError((e, c) => {
  if (e instanceof ChainError) return c.json({ message: e.message }, e.status);
  if (isTimeout(e)) return c.json({ message: `${network.name} did not answer in time. Try again in a moment.` }, 503);
  logError("agent route failed", e);
  return c.json({ message: `${network.name} did not answer. Try again in a moment.` }, 502);
});

let statusInflight = 0;

function deadline<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Arc did not answer in time."), { name: "TimeoutError" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

agent.post("/activate", async (c) => {
  const { address } = await body(c.req.raw, AddressRequest);
  return c.json({ activity: await activate(address) });
});

agent.post("/run", async (c) => {
  const { address } = await body(c.req.raw, AddressRequest);
  const last = lastManualRun.get(address) ?? 0;
  if (Date.now() - last < MANUAL_RUN_GAP_MS) throw new ChainError("The agent just ran for this account. Try again in a few seconds.", 409);
  lastManualRun.set(address, Date.now());
  return c.json({ activity: await runFor(address, "manual") });
});

agent.get("/status/:address", async (c) => {
  const parsed = Account.safeParse(c.req.param("address"));
  if (!parsed.success) throw new ChainError("Invalid wallet address.");
  const address = parsed.data;
  if (statusInflight >= limits.maxStatusInflight) {
    return c.json({ message: "The agent is busy reading Arc. Try again in a moment." }, 503);
  }
  statusInflight++;
  try {
    const agentAddress = requireContract("agent");
    // History catch-up can be tens of RPC calls on a cold disk. It must not hold this response,
    // and it must not be what a health probe waits on.
    void syncFromChain();
    const [mandate, usage, remaining, wallet, allowance, held] = await deadline(
      limits.routeBudgetMs,
      Promise.all([
        mandateOf(address),
        getRpc().readContract({ address: agentAddress, abi: agentAbi, functionName: "usageOf", args: [address] }),
        remainingFor(address),
        walletUsdc(address),
        agentAllowance(address),
        positions(address),
      ]),
    );
    const [periodStart, spent] = usage;
    const p = mandate ? personalityByCode(mandate.profile) : undefined;
    return c.json({
      network: { id: network.id, name: network.name, agent: agentAddress },
      mandate: mandate && {
        limit: unitsToUsdc(mandate.limit),
        period: mandate.period,
        expiresAt: mandate.expiresAt,
        reserve: unitsToUsdc(mandate.reserve),
        profile: mandate.profile,
        personality: p?.name ?? `Profile ${mandate.profile}`,
        vaults: mandate.vaults.map((v) => {
          const info = vaultInfo(network, v);
          return { address: v, name: info?.name ?? v, slot: info?.slot ?? null };
        }),
      },
      // The contract starts a new window once a period has passed; until someone invests, usage still shows the old one.
      spentThisPeriod: mandate && Math.floor(Date.now() / 1000) < Number(periodStart) + mandate.period ? unitsToUsdc(spent) : 0,
      periodStart: Number(periodStart),
      remaining: unitsToUsdc(remaining),
      wallet: unitsToUsdc(wallet),
      allowance: unitsToUsdc(allowance),
      positions: held,
      invested: held.reduce((s, h) => s + h.assets, 0),
      // Rates come from Circle's Earn API; the server doesn't call it yet.
      apy: null,
      activity: activityFor(address),
    });
  } finally {
    statusInflight--;
  }
});

export function resetRouteLimitsForTests() {
  statusInflight = 0;
}
