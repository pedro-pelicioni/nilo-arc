import {
  type AgentExplanation,
  type Call,
  CLAIM_TYPES,
  type Explanation,
  claimDomain,
  explainAgentCalls,
  explainCalls,
  explainSponsoredClaim,
} from "@nilo/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { config, explorerTx, network, requestSponsoredClaim } from "../arc";
import { UserCancelled, isSubmitFailure, useWallet } from "../wallet";
import { ExplainCard } from "./ExplainCard";

/** What a panel can show: a payment or claim, or a call to Nilo's agent contract. */
export type AnyExplanation = Explanation | AgentExplanation;

/** What to sign, plus how to check it against what was requested. */
export type Prepared =
  | {
      /** Calls the wallet sends, one transaction each, in order. */
      calls: Call[];
      /** Names of fields where the decoded calls disagree with what was requested. */
      check: (e: Explanation) => string[];
      agent?: undefined;
      sponsored?: undefined;
    }
  | { calls: Call[]; check: (e: AgentExplanation) => string[]; agent: true; sponsored?: undefined }
  | {
      /** A gasless claim: the wallet signs a message and Nilo's relayer submits it. */
      sponsored: { id: string; sigDeadline: number };
      check: (e: Explanation) => string[];
      calls?: undefined;
      agent?: undefined;
    };

type Review = { prepared: Prepared; explanation: AnyExplanation; problems: string[] };
type State =
  | { step: "building"; notice?: string }
  | ({ step: "review"; notice?: string } & Review)
  | ({ step: "signing"; index: number } & Review)
  | { step: "done"; hash: string }
  | { step: "error"; message: string };

interface Props {
  /** Builds (or rebuilds) the calls from fresh chain state. Throws with a user-facing message. */
  prepare: () => Promise<Prepared>;
  signLabel: string;
  onCancel: () => void;
  onDone: (hash: string) => void;
  doneMessage?: React.ReactNode;
}

export function SignPanel({ prepare, signLabel, onCancel, onDone, doneMessage }: Props) {
  const { address, sendCalls, signTypedData } = useWallet();
  const [state, setState] = useState<State>({ step: "building" });
  // Build once per panel, on mount. Callers may pass a new `prepare` on every
  // render (lists re-render each second for countdowns); rebuilding on each one
  // would reset the panel mid-signature.
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;

  const build = useCallback(
    async (notice?: string) => {
      setState({ step: "building", notice });
      try {
        if (!address) throw new Error("Connect your wallet first.");
        const p = await prepareRef.current();
        if (p.agent) {
          const explanation = explainAgentCalls(p.calls, address, config);
          setState({ step: "review", prepared: p, explanation, problems: p.check(explanation), notice });
        } else {
          const explanation = p.sponsored
            ? explainSponsoredClaim(p.sponsored.id, p.sponsored.sigDeadline, address, config)
            : explainCalls(p.calls, address, config);
          setState({ step: "review", prepared: p, explanation, problems: p.check(explanation), notice });
        }
      } catch (e) {
        setState({ step: "error", message: (e as Error).message });
      }
    },
    [address],
  );

  useEffect(() => {
    build();
  }, [build]);

  async function sign() {
    if (state.step !== "review") return;
    const { prepared, explanation, problems } = state;
    setState({ step: "signing", index: 0, prepared, explanation, problems });
    try {
      let hash: string;
      if (prepared.sponsored) {
        const { id, sigDeadline } = prepared.sponsored;
        const signature = await signTypedData({
          domain: claimDomain(network.chainId, network.payments),
          types: CLAIM_TYPES,
          primaryType: "Claim",
          message: { id: BigInt(id), deadline: BigInt(sigDeadline) },
        });
        hash = await requestSponsoredClaim({ id, sigDeadline, signature, claimant: address as Address });
      } else {
        const hashes = await sendCalls(prepared.calls, (index) => setState({ step: "signing", index, prepared, explanation, problems }));
        hash = hashes[hashes.length - 1];
      }
      setState({ step: "done", hash });
      onDone(hash);
    } catch (e) {
      if (e instanceof UserCancelled) {
        onCancel();
      } else if (isSubmitFailure(e) && e.retryable) {
        await build(`${e.message} The transaction was rebuilt. Review it and sign again.`);
      } else {
        setState({ step: "error", message: isSubmitFailure(e) ? e.message : (e as Error).message });
      }
    }
  }

  if (state.step === "building") return <p className="muted">{state.notice ?? "Building transaction…"}</p>;
  if (state.step === "error")
    return (
      <div className="panel">
        <p className="error">{state.message}</p>
        <div className="row">
          <button onClick={() => build()}>Try again</button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  if (state.step === "done")
    return (
      <div className="panel success">
        <p>
          Done.{" "}
          <a href={explorerTx(state.hash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
        {doneMessage}
      </div>
    );

  const blocked = state.explanation.kind === "unrecognized" || state.problems.length > 0;
  const busy = state.step !== "review";
  const count = state.prepared.calls?.length ?? 1;
  const waiting =
    state.step === "signing"
      ? state.prepared.sponsored
        ? "Waiting for your signature…"
        : count > 1
          ? `Waiting for your wallet (${state.index + 1} of ${count})…`
          : "Waiting for your wallet…"
      : null;
  return (
    <div className="panel">
      {state.step === "review" && state.notice && <p className="warning">{state.notice}</p>}
      <ExplainCard explanation={state.explanation} problems={state.problems} />
      {count > 1 && state.step === "review" && (
        <p className="muted small">Your wallet will ask you to confirm {count} transactions, one after the other.</p>
      )}
      <div className="row">
        <button disabled={blocked || busy} onClick={sign}>
          {waiting ?? signLabel}
        </button>
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
