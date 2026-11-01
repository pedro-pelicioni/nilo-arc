import { type BalanceView, fromUnits } from "@nilo/core";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { FAUCET_BELOW, loadPayments, network, usdcBalance } from "../arc";
import { claimReady, prepareClaim } from "../claim";
import { formatLocal, formatRelative, short, useNow } from "../time";
import { useWallet } from "../wallet";
import { EmptyWallet } from "./EmptyWallet";
import { RefreshIcon } from "./icons";
import { type Prepared, SignPanel } from "./SignPanel";

/** How often the list reloads from the chain on its own, so new payments show up without a click. */
const POLL_MS = 10_000;

/** Pending payments on `role`'s side. Re-evaluated against the clock on every render via `now`. */
export function useBalances(address: Address | null, role: BalanceView["role"], now: number) {
  const [views, setViews] = useState<BalanceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      setViews(await loadPayments(address, role, Math.floor(Date.now() / 1000)));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address, role]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  // Status flips at the deadline without waiting for the next poll.
  const live = views.map((v) => {
    if (!v.deadline) return v;
    const before = now < v.deadline;
    const claimableNow = v.role === "recipient" ? before : !before;
    const status: BalanceView["status"] = v.role === "recipient" ? (before ? "claimable" : "expired") : before ? "waiting" : "recoverable";
    return { ...v, claimableNow, status };
  });
  return { views: live, error, loading, loaded, refresh };
}

const STATUS_TEXT: Record<BalanceView["status"], string> = {
  claimable: "You can claim this now.",
  expired: "The deadline passed. Only the sender can recover these funds now.",
  recoverable: "Nobody claimed it before the deadline. You can recover it.",
  waiting: "Waiting for the recipient.",
};

export function BalanceList({ role }: { role: BalanceView["role"] }) {
  const { address, connect, error: walletError } = useWallet();
  const now = useNow();
  const { views, error, loading, loaded, refresh } = useBalances(address, role, now);
  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!address)
    return (
      <div className="panel">
        <button onClick={connect}>Connect wallet</button>
        {walletError && <p className="error">{walletError}</p>}
      </div>
    );

  return (
    <div className="stack">
      <div className="row">
        <button
          className="connected"
          onClick={refresh}
          disabled={loading}
          title="Connected. The list refreshes on its own; click to refresh now."
        >
          <RefreshIcon width={16} height={16} className={loading ? "spin" : undefined} /> Connected
        </button>
        <span className="muted small">as {short(address)}</span>
      </div>
      {error && <p className="error">{error}</p>}
      {role === "recipient" && <FaucetCard address={address} />}
      {message && <p className="success">{message}</p>}
      {views.length === 0 && loaded && (
        <div className="panel empty">
          <EmptyWallet />
          <strong>{role === "recipient" ? "No pending payments for you." : "No pending payments you sent."}</strong>
          <p className="muted">
            {role === "recipient"
              ? "When someone sends you a payment, it will appear here and you'll be able to claim it."
              : "When you send a payment, it stays here until it is claimed or you recover it."}
          </p>
        </div>
      )}
      {views.map((v) => (
        <BalanceRow
          key={v.id}
          view={v}
          now={now}
          address={address}
          active={active === v.id}
          onMessage={setMessage}
          onOpen={() => {
            setMessage(null);
            setActive(v.id);
          }}
          onClose={() => setActive(null)}
          onDone={() => {
            setMessage(role === "recipient" ? "Claimed. The funds are in your account." : "Recovered. The funds are back in your account.");
            setActive(null);
            refresh();
          }}
        />
      ))}
    </div>
  );
}

function BalanceRow(props: {
  view: BalanceView;
  now: number;
  address: string;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: () => void;
  onMessage: (m: string) => void;
}) {
  const { view: v, now, address } = props;
  const isRecipient = v.role === "recipient";
  const ready = claimReady(v, now);

  const prepare = useCallback((): Promise<Prepared> => prepareClaim(v, address as Address), [v, address]);

  return (
    <article className="card">
      <div className="card-head">
        <strong>
          {v.amount} {v.asset.code}
        </strong>
        <span className={`pill ${v.status}`}>{v.status}</span>
      </div>
      <p className="mono-wrap small">
        {isRecipient ? `From ${v.sender ?? "unknown"}` : `To ${v.recipient ?? "unknown"}`}
      </p>
      {v.deadline && (
        <p className="small">
          Deadline {formatLocal(v.deadline)} ({formatRelative(v.deadline - now)})
        </p>
      )}
      <p className="small">{STATUS_TEXT[v.status]}</p>
      {props.active ? (
        <SignPanel
          prepare={prepare}
          signLabel={isRecipient ? "Sign and claim" : "Sign and recover"}
          onCancel={props.onClose}
          onDone={props.onDone}
        />
      ) : (
        v.claimableNow && (
          <button disabled={!ready} onClick={props.onOpen}>
            {isRecipient ? "Claim" : ready ? "Recover" : "Recover (a few seconds…)"}
          </button>
        )
      )}
    </article>
  );
}

/** Points a wallet with little USDC at Circle's faucet (testnet), since USDC also pays the gas on Arc. */
function FaucetCard({ address }: { address: Address }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    const check = () => usdcBalance(address).then(setBalance, () => {});
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [address]);
  if (balance === null || balance >= FAUCET_BELOW || !network.faucetUrl) return null;
  return (
    <div className="panel">
      <p>
        You have {fromUnits(balance)} USDC. You can still claim: with no USDC for gas, Nilo's relayer submits the claim for
        you. To send payments, get free test USDC on{" "}
        <a href={network.faucetUrl} target="_blank" rel="noreferrer">
          Circle's faucet
        </a>{" "}
        (pick Arc Testnet and paste {short(address)}).
      </p>
    </div>
  );
}
