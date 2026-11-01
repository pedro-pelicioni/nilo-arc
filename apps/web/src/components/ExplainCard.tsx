import type { AnyExplanation } from "./SignPanel";
import { formatLocal, formatRelative, useNow } from "../time";

/** Renders the template explanation. Text here comes from the calldata, never from the AI. */
export function ExplainCard({ explanation, problems = [] }: { explanation: AnyExplanation; problems?: string[] }) {
  const now = useNow();
  const bad = explanation.kind === "unrecognized" || problems.length > 0;
  return (
    <section className={`explain ${bad ? "explain-bad" : ""}`} aria-live="polite">
      <header>
        <span className="badge">Decoded from the transaction</span>
        <span className="muted">Generated from the exact calls you are about to sign. Not written by the AI.</span>
      </header>
      {explanation.kind === "send" && (
        <div className="explain-headline">
          <strong>
            {explanation.fields.amount} {explanation.fields.asset.code}
          </strong>{" "}
          to {explanation.fields.recipientName ?? "this address"}, claimable until{" "}
          <strong>{formatLocal(explanation.fields.deadline)}</strong> ({formatRelative(explanation.fields.deadline - now)})
        </div>
      )}
      <ul className="explain-lines">
        {explanation.lines.map((l) => (
          <li key={l} className="mono-wrap">
            {l}
          </li>
        ))}
      </ul>
      {problems.length > 0 && (
        <p className="error">
          The transaction does not match what you asked for ({problems.join(", ")}). Signing is blocked.
        </p>
      )}
    </section>
  );
}
