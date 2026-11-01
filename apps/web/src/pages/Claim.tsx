import { BalanceList } from "../components/Balances";
import { HowItWorks } from "../components/HowItWorks";
import { InboxIcon } from "../components/icons";
import { PageTop } from "../components/Layout";

const STEPS = [
  { title: "Someone sends you a payment", text: "The USDC waits in escrow on Arc until the deadline." },
  { title: "No USDC for gas? No problem", text: "You sign a message and Nilo's relayer pays the gas." },
  { title: "You claim it", text: "The contract pays your own wallet, and nobody else's." },
];

export function ClaimPage() {
  return (
    <div className="view">
      <PageTop
        avatar={
          <span className="row-avatar tone-green mini">
            <InboxIcon width={16} height={16} />
          </span>
        }
        title="Claim"
      />
      <div className="view-scroll">
        <div className="page stack">
          <p className="intro">
            <strong>Payments waiting for you.</strong> Claim before the deadline. If your wallet has no USDC for gas,
            you only sign a message and Nilo submits the claim for you.
          </p>
          <BalanceList role="recipient" />
          <HowItWorks steps={STEPS} />
        </div>
      </div>
    </div>
  );
}
