import { BalanceList } from "../components/Balances";
import { HowItWorks } from "../components/HowItWorks";
import { HistoryIcon } from "../components/icons";
import { PageTop } from "../components/Layout";

const STEPS = [
  { title: "You send a payment", text: "It waits on the network until someone claims it." },
  { title: "The recipient claims it", text: "They can claim it any time before the deadline you set." },
  { title: "Unclaimed? It comes back", text: "After the deadline, only you can recover it here." },
];

export function SentPage() {
  return (
    <div className="view">
      <PageTop
        avatar={
          <span className="row-avatar tone-blue mini">
            <HistoryIcon width={16} height={16} />
          </span>
        }
        title="Sent"
      />
      <div className="view-scroll">
        <div className="page stack">
          <p className="intro">
            <strong>Payments you sent.</strong> Nothing gets lost: anything not claimed before its deadline can be
            recovered here.
          </p>
          <BalanceList role="sender" />
          <HowItWorks steps={STEPS} />
        </div>
      </div>
    </div>
  );
}
