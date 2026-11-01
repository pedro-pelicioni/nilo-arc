import {
  PERSONALITIES,
  type PersonalityId,
  allowanceFor,
  mandateFrom,
  mandateMismatches,
  personality,
  personalityFor,
  revokeCalls,
  setMandateCalls,
  vaultsFor,
  withdrawCalls,
} from "@nilo/core";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useLocation } from "react-router-dom";
import { type AgentActivity, type AgentRequest, type AgentStatus, activateAgent, agentStatus, runAgent } from "../agent";
import { contractsReady, explorerTx, network, usdcAllowance, vaultShares } from "../arc";
import { AgentIcon, MoonIcon } from "../components/icons";
import { PageTop } from "../components/Layout";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { useProfile } from "../profile";
import { formatLocal } from "../time";
import { useWallet } from "../wallet";

const usdc = (n: number, digits = 2) => `${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: 6 })} USDC`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Flow = { kind: "mandate"; personality: PersonalityId } | { kind: "withdraw" } | { kind: "revoke" } | null;

export function AgentPage() {
  const { address, connect } = useWallet();
  const [profile] = useProfile(address);
  // Rules an advanced user wrote in the chat arrive as router state.
  const rules = ((useLocation().state as { agent?: AgentRequest } | null)?.agent ?? {}) as AgentRequest;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>(null);
  const [chosen, setChosen] = useState<PersonalityId | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      setStatus(await agentStatus(address));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [address]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  // An expired mandate stays on chain until replaced; it no longer lets the agent invest, so offer a new one.
  const active = status?.mandate && status.mandate.expiresAt > Math.floor(Date.now() / 1000) ? status.mandate : null;

  const suggested = rules.personality ?? (profile ? personalityFor(profile).id : "balanced");
  const pick = chosen ?? suggested;

  // The RPC node may answer a moment before it serves the new mandate; give activation a few tries.
  async function activate() {
    for (let i = 0; i < 6; i++) {
      try {
        await activateAgent(address!);
        return;
      } catch (e) {
        if (i === 5 || !/No mandate found/.test((e as Error).message)) throw e;
        await sleep(2_000);
      }
    }
  }

  async function runNow() {
    setRunning(true);
    setNotice(null);
    try {
      const { activity } = await runAgent(address!);
      setNotice(activity.map((a) => a.note).join(" "));
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Built here from the personality and the chat's rules, then decoded back before signing.
  const mandatePrepare = async (): Promise<Prepared> => {
    const p = personality(flow?.kind === "mandate" ? flow.personality : pick)!;
    const now = Math.floor(Date.now() / 1000);
    const m = mandateFrom(p, network, now, rules.days ?? 30, rules.weeklyLimit ?? p.weeklyLimit);
    const allowance = allowanceFor(m, now);
    const current = await usdcAllowance(address!, network.agent);
    const calls = setMandateCalls(m, allowance, current, network);
    return { calls, agent: true, check: (e) => mandateMismatches(e, address!, m, allowance) };
  };
  const actionPrepare = (action: "withdraw" | "revoke") => async (): Promise<Prepared> => {
    // Share balances read now, not from the last status: an invest may have landed since.
    const positions = await Promise.all(
      network.vaults.map(async (v) => ({ vault: v.address, shares: await vaultShares(v.address, address as Address) })),
    );
    const calls = action === "withdraw" ? withdrawCalls(address as Address, positions) : revokeCalls(network);
    if (calls.length === 0) throw new Error("There is nothing invested to withdraw.");
    return { calls, agent: true, check: (e) => (e.kind === "agent" && e.fields.action === action ? [] : ["action"]) };
  };

  return (
    <div className="view">
      <PageTop
        avatar={
          <span className="row-avatar tone-violet mini">
            <AgentIcon width={16} height={16} />
          </span>
        }
        title="Agent"
      />
      <div className="view-scroll">
        <div className="page stack">
          <p className="intro">
            <strong>Invests while you sleep.</strong> You sign one mandate. The agent can only invest your USDC inside
            it, and every withdrawal comes back to your wallet. Revoke it whenever you want.
          </p>

          {!address && (
            <section className="panel empty">
              <strong>Sign in to set up your agent</strong>
              <p className="muted">Your wallet stays yours. Nilo never holds your keys.</p>
              <button onClick={connect}>Sign in</button>
            </section>
          )}

          {!contractsReady && <p className="warning">Nilo's agent contract is not deployed on {network.name} yet.</p>}

          {address && error && <p className="error">{status ? `Couldn't refresh: ${error}` : error}</p>}
          {address && !status && !error && <p className="muted">Loading your agent…</p>}

          {address && status && !active && !flow && status.invested > 0 && (
            <section className="panel">
              <p>
                You still have <strong>{usdc(status.invested, 6)}</strong> invested from an earlier mandate. It stays in your
                wallet as vault shares until you withdraw it.
              </p>
              <button className="secondary" onClick={() => setFlow({ kind: "withdraw" })}>
                Withdraw everything
              </button>
            </section>
          )}

          {address && status && !active && flow?.kind !== "mandate" && (
            <>
              <div className="personas" role="radiogroup" aria-label="Personality">
                {PERSONALITIES.map((p) => {
                  const vaults = vaultsFor(p, network);
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={pick === p.id}
                      className={`persona ${pick === p.id ? "on" : ""}`}
                      onClick={() => setChosen(p.id)}
                    >
                      <span className="persona-head">
                        <strong>{p.name}</strong>
                        {p.id === suggested && (
                          <span className="pill">{rules.personality ? "You asked for this" : profile ? "Fits your profile" : "Suggested"}</span>
                        )}
                      </span>
                      <span className="muted">{p.summary}</span>
                      <span className="persona-facts">
                        <span>Up to {rules.weeklyLimit ?? p.weeklyLimit} USDC a week</span>
                        <span>Keeps {p.keep} USDC in your wallet</span>
                      </span>
                      <span className="persona-venues">
                        {vaults.map((v) => (
                          <span key={v.address}>
                            {(p.weights[v.slot]! / 100).toFixed(0)}% {v.name} · Morpho on Arc
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
              {(rules.weeklyLimit || rules.days) && (
                <p className="notice">
                  Your rules from the chat: {rules.weeklyLimit ? `at most ${rules.weeklyLimit} USDC a week` : "the personality's weekly limit"}
                  {rules.days ? ` for ${rules.days} days` : " for 30 days"}. The mandate you sign will say exactly this.
                </p>
              )}
              <p className="muted small">
                The vaults are Morpho USDC vaults on Arc, the same ones Circle's Earn Kit lists. Their shares are minted
                to your own wallet, so you can redeem them yourself at any time. You have {usdc(status.wallet)} in your
                wallet.
              </p>
              <button className="primary-cta" onClick={() => setFlow({ kind: "mandate", personality: pick })}>
                Review the mandate
              </button>
            </>
          )}

          {address && flow && (
            <SignPanel
              key={flow.kind}
              prepare={flow.kind === "mandate" ? mandatePrepare : actionPrepare(flow.kind)}
              signLabel={flow.kind === "mandate" ? "Sign mandate" : flow.kind === "withdraw" ? "Withdraw everything" : "Revoke mandate"}
              onCancel={() => setFlow(null)}
              onDone={async () => {
                if (flow.kind === "mandate") {
                  setNotice("Mandate signed. The agent is making its first investment…");
                  try {
                    await activate();
                    setNotice(null);
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                }
                setFlow(null);
                await refresh();
              }}
            />
          )}

          {notice && <p className="notice">{notice}</p>}

          {address && status && active && !flow && <Dashboard status={status} running={running} onRun={runNow} onFlow={setFlow} />}
        </div>
      </div>
    </div>
  );
}

function Dashboard({ status, running, onRun, onFlow }: { status: AgentStatus; running: boolean; onRun: () => void; onFlow: (f: Flow) => void }) {
  const m = status.mandate!;
  return (
    <>
      <div className="stats">
        <Stat label="Invested" value={usdc(status.invested)} />
        <Stat label="In your wallet" value={usdc(status.wallet)} />
        <Stat label="Left this week" value={usdc(status.remaining)} />
        {status.positions
          .filter((p) => BigInt(p.shares) > 0n)
          .map((p) => (
            <Stat key={p.vault} label={p.name} value={usdc(p.assets, 6)} />
          ))}
      </div>

      <section className="panel mandate">
        <div className="mandate-head">
          <strong>{m.personality}</strong>
          <span className="pill claimable">Active</span>
        </div>
        <p className="muted">
          Up to {usdc(m.limit, 0)} a week into {m.vaults.map((v) => v.name).join(" and ")}, {usdc(status.spentThisPeriod)} used
          this week. Always keeps {usdc(m.reserve)} in your wallet. Invests until {formatLocal(m.expiresAt)}.
        </p>
        <div className="row">
          <button onClick={onRun} disabled={running}>
            <MoonIcon width={16} height={16} /> {running ? "The agent is working…" : "Run tonight's check now"}
          </button>
          <button className="secondary" onClick={() => onFlow({ kind: "withdraw" })} disabled={status.invested <= 0}>
            Withdraw everything
          </button>
          <button className="secondary" onClick={() => onFlow({ kind: "revoke" })}>
            Revoke
          </button>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">While you were away</h3>
        {status.activity.length === 0 && <p className="muted">Nothing yet. The agent checks your wallet every hour.</p>}
        <ul className="activity">
          {status.activity.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </ul>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const KIND_LABEL: Record<AgentActivity["kind"], string> = {
  mandate: "Mandate",
  invest: "Invested",
  withdraw: "Withdrew",
  revoke: "Revoked",
  skip: "Checked",
  error: "Problem",
};

function ActivityRow({ a }: { a: AgentActivity }) {
  return (
    <li className={`activity-row kind-${a.kind}`}>
      <span className="activity-kind">{KIND_LABEL[a.kind]}</span>
      <span className="activity-note">
        {a.note}
        {(a.hash || a.link) && (
          <>
            {" "}
            <a href={a.link ?? explorerTx(a.hash!)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </>
        )}
      </span>
      <time className="activity-time">{formatLocal(Date.parse(a.at) / 1000)}</time>
    </li>
  );
}
