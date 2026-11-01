import { ChevronIcon, InfoIcon } from "./icons";

export interface Step {
  title: string;
  text: string;
}

/** Numbered three-step explainer shown under a payment list. */
export function HowItWorks({ steps }: { steps: Step[] }) {
  return (
    <section className="panel how">
      <h2>
        <InfoIcon width={16} height={16} /> How it works
      </h2>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <span className="step-num">{i + 1}</span>
            <div>
              <strong>{s.title}</strong>
              <p>{s.text}</p>
            </div>
            {i < steps.length - 1 && <ChevronIcon className="step-arrow" width={16} height={16} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
