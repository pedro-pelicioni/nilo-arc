// First sign-in: the user answers the investor questionnaire, which sets their
// profile. The last step checks the wallet is on Arc and holds some USDC (it also
// pays gas on Arc), and points at Circle's faucet on testnet when it doesn't.
import { useEffect, useRef, useState } from "react";
import { FAUCET_BELOW, network, usdcBalance } from "../arc";
import { MAX_SCORE, MIN_SCORE, PROFILES, QUESTIONS, scoreProfile, useProfile } from "../profile";
import { useWallet } from "../wallet";
import { CloseIcon, RefreshIcon } from "./icons";

const ITEMS = [
  { step: "arc", label: `Wallet connected to ${network.name}` },
  { step: "usdc", label: "USDC in your wallet (it also pays the gas)" },
] as const;

/**
 * `first`: the questionnaire is required and the setup step follows.
 * `edit`: retake the questionnaire only; closable like any dialog.
 */
export function Onboarding({ mode, onClose }: { mode: "first" | "edit"; onClose: () => void }) {
  const { address, onArc } = useWallet();
  const [, setProfile] = useProfile(address);
  const [phase, setPhase] = useState<"quiz" | "result" | "setup">("quiz");
  // Index of the chosen option per question; kept so Back shows earlier answers.
  const [answers, setAnswers] = useState<(number | null)[]>(() => QUESTIONS.map(() => null));
  const [current, setCurrent] = useState(0);
  const question = QUESTIONS[current];
  const score = answers.reduce<number>((sum, a, i) => sum + (a === null ? 0 : QUESTIONS[i].options[a].points), 0);
  const result = PROFILES.find((p) => p.id === scoreProfile(score))!;
  const [funded, setFunded] = useState<boolean | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closable = mode === "edit";

  // Checks the balance every few seconds while the setup step is open, so a faucet drip shows up.
  useEffect(() => {
    if (phase !== "setup" || !address) return;
    const check = () => usdcBalance(address).then((b) => setFunded(b >= FAUCET_BELOW), () => setFunded(false));
    check();
    const id = setInterval(check, 4_000);
    return () => clearInterval(id);
  }, [phase, address]);
  const setupIndex = !onArc ? 0 : funded ? ITEMS.length : 1;
  const failed = onArc && funded === false ? "Your wallet has less than 1 USDC." : null;
  const ready = setupIndex === ITEMS.length || !!failed;

  // Tab stays inside the dialog; Escape closes it only when closing is allowed.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = dialog.current;
      if (!el) return;
      if (e.key === "Escape" && closable) {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        // A wallet dialog can open on top: leave its focus alone.
        const other = document.activeElement?.closest('[role="dialog"], [aria-modal="true"]');
        if (other && other !== el) return;
        const items = el.querySelectorAll<HTMLElement>("button:not(:disabled)");
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!active || active === el || !el.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closable, onClose]);

  useEffect(() => dialog.current?.focus(), [phase, current]);

  // Picking an answer moves on by itself (Back and Next still work); the last one waits for "See my profile".
  const advance = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advance.current), []);
  function choose(option: number) {
    setAnswers((a) => a.map((v, q) => (q === current ? option : v)));
    window.clearTimeout(advance.current);
    if (current < QUESTIONS.length - 1) advance.current = window.setTimeout(() => setCurrent(current + 1), 260);
  }

  function next() {
    if (answers[current] === null) return;
    if (current < QUESTIONS.length - 1) {
      setCurrent(current + 1);
      return;
    }
    // Saved now, so a reload during setup does not ask again.
    setProfile(result.id);
    setPhase("result");
  }

  function finishResult() {
    if (mode === "first") setPhase("setup");
    else onClose();
  }

  const title =
    phase === "quiz" ? "What kind of investor are you?" : phase === "result" ? "Your investor profile" : "Getting your account ready";

  return (
    <div
      className="modal-backdrop under-wallet"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget || !closable) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div ref={dialog} className="modal onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabIndex={-1}>
        <header className="modal-head">
          <h2 id="onboarding-title">{title}</h2>
          {closable && (
            <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          )}
        </header>

        {phase === "quiz" ? (
          <div className="modal-body onboarding-body quiz">
            {current === 0 && mode === "first" && (
              <p className="muted small">Five quick questions to find your profile.</p>
            )}
            <div className="quiz-progress" aria-label={`Question ${current + 1} of ${QUESTIONS.length}`}>
              <ol className="quiz-steps" aria-hidden="true">
                {QUESTIONS.map((q, i) => (
                  <li key={q.id} className={i < current ? "done" : i === current ? "current" : ""} />
                ))}
              </ol>
              <span className="quiz-count">
                {current + 1}/{QUESTIONS.length}
              </span>
            </div>
            <div className="quiz-question">
              <span className="quiz-category">{question.category}</span>
              <p className="quiz-prompt" id="quiz-prompt">
                {question.prompt}
              </p>
            </div>
            <div className="quiz-options" role="radiogroup" aria-labelledby="quiz-prompt">
              {question.options.map((o, i) => (
                <button
                  key={o.letter}
                  type="button"
                  role="radio"
                  className="quiz-option"
                  aria-checked={answers[current] === i}
                  onClick={() => choose(i)}
                >
                  <span className="quiz-letter" aria-hidden="true">
                    {o.letter}
                  </span>
                  <span className="quiz-text">{o.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : phase === "result" ? (
          <div className="modal-body onboarding-body quiz-result">
            <span className="quiz-category">Your profile</span>
            <p className="quiz-profile">{result.label}</p>
            <p className="quiz-detail">{result.detail}</p>
            <div className="score-meter" role="img" aria-label={`Score ${score} of ${MAX_SCORE}`}>
              <div className="score-zones" aria-hidden="true">
                {PROFILES.map((p) => (
                  <span key={p.id} className={p.id === result.id ? "on" : ""}>
                    {p.label}
                  </span>
                ))}
              </div>
              <div className="score-track" aria-hidden="true">
                <i style={{ left: `${((score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)) * 100}%` }} />
              </div>
              <span className="muted small">
                Score {score} of {MAX_SCORE}
              </span>
            </div>
          </div>
        ) : (
          <div className="modal-body onboarding-body">
            <ul className="setup-list" aria-live="polite">
              {ITEMS.map((item, i) => {
                const state = i < setupIndex ? "done" : i === setupIndex ? (failed ? "failed" : "running") : "pending";
                return (
                  <li key={item.step} className={`setup-item ${state}`}>
                    <span className="setup-mark" aria-hidden="true">
                      {state === "done" ? "✓" : state === "failed" ? "!" : state === "running" ? <RefreshIcon width={16} height={16} className="spin" /> : "•"}
                    </span>
                    <span>{item.label}</span>
                    <span className="sr-only">{state === "done" ? "done" : state === "running" ? "in progress" : state}</span>
                  </li>
                );
              })}
            </ul>
            {failed && (
              <p className="warning small">
                {failed}{" "}
                {network.faucetUrl ? (
                  <>
                    Get free test USDC on{" "}
                    <a href={network.faucetUrl} target="_blank" rel="noreferrer">
                      Circle's faucet
                    </a>{" "}
                    (pick Arc Testnet). It shows up here on its own.
                  </>
                ) : (
                  "Add some USDC on Arc to send payments or let the agent invest."
                )}
              </p>
            )}
            {!onArc && <p className="warning small">Switch your wallet to {network.name} (Nilo asks when you sign).</p>}
          </div>
        )}

        <footer className={`modal-foot${phase === "quiz" ? " split" : ""}`}>
          {phase === "quiz" ? (
            <>
              <button
                type="button"
                className="secondary quiz-back"
                onClick={() => setCurrent(current - 1)}
                disabled={current === 0}
                style={current === 0 ? { visibility: "hidden" } : undefined}
              >
                Back
              </button>
              <button type="button" disabled={answers[current] === null} onClick={next}>
                {current < QUESTIONS.length - 1 ? "Next" : "See my profile"}
              </button>
            </>
          ) : phase === "result" ? (
            <button type="button" onClick={finishResult}>
              {mode === "first" ? "Continue" : "Done"}
            </button>
          ) : (
            <button type="button" disabled={!ready && onArc} onClick={onClose}>
              {ready || !onArc ? "Start chatting" : "Checking…"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
