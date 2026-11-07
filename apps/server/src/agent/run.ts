// The agent itself: for each user with a mandate, invest their idle USDC the way
// their personality says. Every move goes through the NiloAgent contract, which
// re-checks the mandate and mints the vault shares to the user; this code only
// decides how much and where.
import type { Address } from "viem";
import {
  type Mandate,
  agentAbi,
  erc20Abi,
  fromUnits,
  mandateFromChain,
  personality,
  personalityByCode,
  split,
  usdcToUnits,
  vaultInfo,
} from "@nilo/core";
import { ChainError, getRpc, hasOperator, network, operator, operatorWallet, requireContract, serial, txLink } from "../chain";
import { errorText, logError } from "../errors";
import { syncFromChain } from "./chainlog";
import { type Activity, addUser, log, users } from "./store";

/** Below this the agent doesn't bother: the vault would mint almost nothing. */
const MIN_INVEST = usdcToUnits(0.01);

export { ChainError as AgentError };

type ReadOpts = { signal?: AbortSignal };

export async function mandateOf(user: Address, opts?: ReadOpts): Promise<Mandate | null> {
  const raw = await getRpc().readContract({ address: requireContract("agent"), abi: agentAbi, functionName: "mandateOf", args: [user], ...opts });
  return mandateFromChain(raw);
}

export const walletUsdc = (user: Address, opts?: ReadOpts) =>
  getRpc().readContract({ address: network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [user], ...opts });

export const agentAllowance = (user: Address, opts?: ReadOpts) =>
  getRpc().readContract({ address: network.usdc, abi: erc20Abi, functionName: "allowance", args: [user, requireContract("agent")], ...opts });

export const remainingFor = (user: Address, opts?: ReadOpts) =>
  getRpc().readContract({ address: requireContract("agent"), abi: agentAbi, functionName: "remaining", args: [user], ...opts });

// NiloAgent's custom errors (in its ABI, so viem names them), to say why the contract refused an invest.
const AGENT_ERRORS: Record<string, string> = {
  NoMandate: "there is no active mandate.",
  Expired: "the mandate has expired.",
  VaultNotAllowed: "the mandate doesn't allow that vault.",
  OverLimit: "this week's limit is already used.",
  BelowReserve: "it would leave less than your reserve in the wallet.",
  SlippageExceeded: "the vault would have minted shares worth less than the deposit.",
  ZeroShares: "the vault would have minted no shares for it.",
};

export function investFailure(e: unknown): string {
  const message = errorText(e);
  const name = Object.keys(AGENT_ERRORS).find((n) => message.includes(n));
  if (name) return AGENT_ERRORS[name];
  if (/allowance/i.test(message)) return "the mandate's allowance is used up. Sign a new mandate to continue.";
  if (/exceeds balance|transfer amount/i.test(message)) return "the wallet no longer had that much USDC.";
  if (/insufficient funds/i.test(message)) return "Nilo's operator is out of gas right now.";
  return "the network refused the transaction.";
}

const running = new Set<string>();

/** Runs the agent once for one user and returns what it did. */
export async function runFor(user: Address, trigger: NonNullable<Activity["trigger"]>): Promise<Activity[]> {
  const key = user.toLowerCase();
  if (running.has(key)) throw new ChainError("The agent is already working on this account.", 409);
  running.add(key);
  try {
    const agent = requireContract("agent");
    const signer = operator();
    const mandate = await mandateOf(user);
    if (!mandate) return [log({ user, trigger, kind: "skip", note: "No active mandate, so the agent did nothing." })];
    const now = Math.floor(Date.now() / 1000);
    if (now >= mandate.expiresAt) return [log({ user, trigger, kind: "skip", note: "The mandate has expired. Sign a new one to keep investing." })];

    const p = personalityByCode(mandate.profile) ?? personality("balanced")!;
    const [wallet, left, allowance] = await Promise.all([walletUsdc(user), remainingFor(user), agentAllowance(user)]);
    const idle = wallet - mandate.reserve;
    let amount = idle < left ? idle : left;
    if (allowance < amount) amount = allowance;
    if (amount < MIN_INVEST) {
      const note =
        left < MIN_INVEST
          ? `This week's limit of ${fromUnits(mandate.limit)} USDC is already invested.`
          : allowance < MIN_INVEST
            ? "The agent's USDC allowance is used up. Sign a new mandate to keep investing."
            : `Nothing is idle above the ${fromUnits(mandate.reserve)} USDC kept in your wallet, so nothing was invested.`;
      return [log({ user, trigger, kind: "skip", note })];
    }

    const legs = split(amount, p, mandate.vaults, network);
    if (legs.length === 0) return [log({ user, trigger, kind: "skip", note: `${fromUnits(amount)} USDC is too little to invest, so nothing was invested.` })];
    const done: Activity[] = [];
    for (const leg of legs) {
      const usdc = fromUnits(leg.amount);
      const name = vaultInfo(network, leg.vault)?.name ?? leg.vault;
      try {
        const hash = await serial(async () => {
          const { request } = await getRpc().simulateContract({
            account: signer,
            address: agent,
            abi: agentAbi,
            functionName: "invest",
            args: [user, leg.vault, leg.amount],
          });
          const sent = await operatorWallet().writeContract(request);
          const receipt = await getRpc().waitForTransactionReceipt({ hash: sent, timeout: 30_000 });
          if (receipt.status !== "success") throw new Error("reverted");
          return sent;
        });
        done.push(
          log({ user, trigger, kind: "invest", vault: leg.vault, amount: usdc, hash, link: txLink(hash), note: `Invested ${usdc} USDC into ${name}. The vault shares are in your wallet.` }),
        );
      } catch (e) {
        logError(`agent invest failed for ${user}`, e);
        done.push(log({ user, trigger, kind: "error", vault: leg.vault, amount: usdc, note: `${usdc} USDC was not invested: ${investFailure(e)} Your USDC stayed in your wallet.` }));
      }
    }
    return done;
  } finally {
    running.delete(key);
  }
}

/** Registers a user whose mandate is on-chain, then invests right away. */
export async function activate(user: Address): Promise<Activity[]> {
  const mandate = await mandateOf(user);
  if (!mandate) throw new ChainError("No mandate found on-chain for this account. Sign it first.", 404);
  addUser(user);
  // The MandateSet event goes into the log with its transaction.
  await syncFromChain(true);
  return runFor(user, "activate");
}

export async function runAll() {
  try {
    // Finds every wallet with a mandate, even after a restart wiped the local file.
    await syncFromChain(true);
    for (const user of users()) {
      await runFor(user as Address, "schedule").catch((e) => logError(`agent run failed for ${user}`, e));
    }
  } catch (e) {
    logError("agent run failed", e);
  }
}

/** Starts the schedule when the operator key is configured. AGENT_INTERVAL_MINUTES, default 60. */
export function startSchedule() {
  if (!hasOperator()) {
    console.warn("No NILO_OPERATOR_KEY set: the investing agent and gasless claims are off.");
    return;
  }
  void syncFromChain(true);
  const minutes = Number(process.env.AGENT_INTERVAL_MINUTES ?? 60);
  setInterval(() => void runAll(), Math.max(1, minutes) * 60_000);
  console.log(`Investing agent on ${network.name} runs every ${minutes} min for ${users().length} account(s).`);
}
