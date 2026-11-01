// Client for /api/agent. Mandate, revoke and withdraw calls are built in the browser
// (see @nilo/core) and decoded with explainAgentCalls before the user signs them.
import type { VaultInfo } from "@nilo/core";

export interface AgentActivity {
  id: string;
  at: string;
  kind: "mandate" | "invest" | "withdraw" | "revoke" | "skip" | "error";
  trigger?: "schedule" | "activate" | "manual";
  vault?: string;
  amount?: string;
  hash?: string;
  link?: string;
  note: string;
}

export interface AgentPosition {
  vault: `0x${string}`;
  name: string;
  slot: VaultInfo["slot"];
  /** Vault shares in the user's wallet, as a decimal string (bigint). */
  shares: string;
  /** What those shares are worth now, in USDC. */
  assets: number;
}

export interface AgentStatus {
  mandate: {
    limit: number;
    period: number;
    expiresAt: number;
    reserve: number;
    profile: number;
    personality: string;
    vaults: { address: `0x${string}`; name: string; slot: VaultInfo["slot"] }[];
  } | null;
  spentThisPeriod: number;
  periodStart: number;
  remaining: number;
  wallet: number;
  allowance: number;
  positions: AgentPosition[];
  invested: number;
  activity: AgentActivity[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agent${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? `The agent is unavailable (${res.status}).`);
  return json as T;
}

export const agentStatus = (address: string) => call<AgentStatus>(`/status/${address}`);

/** What the user asked for in the chat; anything left out comes from the personality. */
export interface AgentRequest {
  personality?: "guardian" | "balanced" | "explorer";
  weeklyLimit?: number;
  days?: number;
}

export const activateAgent = (address: string) => call<{ activity: AgentActivity[] }>("/activate", { address });
export const runAgent = (address: string) => call<{ activity: AgentActivity[] }>("/run", { address });
