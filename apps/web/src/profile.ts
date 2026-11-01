// The investor profile a user gets from the questionnaire on first sign-in, kept
// in localStorage per address. It is only stored and shown for now; nothing else
// depends on it.
import { useCallback, useSyncExternalStore } from "react";

export type InvestorProfile = "conservative" | "moderate" | "aggressive";

export const PROFILES: { id: InvestorProfile; label: string; detail: string }[] = [
  {
    id: "conservative",
    label: "Conservative",
    detail: "Your focus is safety. Recommended: short-term government bonds, bank CDs and simple fixed-income funds.",
  },
  {
    id: "moderate",
    label: "Moderate",
    detail: "Your focus is balance. Recommended: tax-advantaged fixed income, multi-strategy funds and inflation-linked government bonds.",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    detail: "Your focus is growth. Recommended: stocks, real estate funds (REITs) and index funds (ETFs).",
  },
];

export interface Question {
  id: number;
  category: string;
  prompt: string;
  options: { letter: string; text: string; points: number }[];
}

/** The investor questionnaire: each answer scores 1, 3 or 5, so a total runs from 5 to 25. */
export const QUESTIONS: Question[] = [
  {
    id: 1,
    category: "Time horizon (goals)",
    prompt: "How long do you plan to keep your money invested?",
    options: [
      { letter: "A", text: "Less than 1 year (I need immediate liquidity).", points: 1 },
      { letter: "B", text: "1 to 3 years (medium term).", points: 3 },
      { letter: "C", text: "More than 3 years (long term, focused on growth).", points: 5 },
    ],
  },
  {
    id: 2,
    category: "Financial situation",
    prompt: "How stable are your finances, and how much do you have in reserve?",
    options: [
      { letter: "A", text: "I spend almost everything I earn and have no savings.", points: 1 },
      { letter: "B", text: "I have a stable income and save part of it every month.", points: 3 },
      { letter: "C", text: "I have solid assets and a good emergency fund.", points: 5 },
    ],
  },
  {
    id: 3,
    category: "Market knowledge",
    prompt: "What is your experience with investment products?",
    options: [
      { letter: "A", text: "Only savings accounts, simple CDs, or I have never invested.", points: 1 },
      { letter: "B", text: "I have invested in mutual funds or government bonds.", points: 3 },
      { letter: "C", text: "I trade on the stock market (stocks, REITs, derivatives or crypto).", points: 5 },
    ],
  },
  {
    id: 4,
    category: "Risk tolerance",
    prompt: "If your investments dropped 15% because of a crisis, what would you do?",
    options: [
      { letter: "A", text: "Withdraw everything right away so I don't lose any more.", points: 1 },
      { letter: "B", text: "Keep my money invested and wait for the market to recover.", points: 3 },
      { letter: "C", text: "Take advantage of the drop and invest even more at lower prices.", points: 5 },
    ],
  },
  {
    id: 5,
    category: "Return expectations",
    prompt: "When choosing a financial product, what matters most to you?",
    options: [
      { letter: "A", text: "The guarantee that I won't lose my original money (safety).", points: 1 },
      { letter: "B", text: "Beating inflation, accepting small swings (balance).", points: 3 },
      { letter: "C", text: "Maximizing long-term gains, accepting the risk of losses (return).", points: 5 },
    ],
  },
];

export const MIN_SCORE = QUESTIONS.reduce((sum, q) => sum + Math.min(...q.options.map((o) => o.points)), 0);
export const MAX_SCORE = QUESTIONS.reduce((sum, q) => sum + Math.max(...q.options.map((o) => o.points)), 0);

/** Total of the points answered: up to 12 is conservative, up to 22 moderate, above that aggressive. */
export function scoreProfile(score: number): InvestorProfile {
  return score <= 12 ? "conservative" : score <= 22 ? "moderate" : "aggressive";
}

const key = (address: string) => `nilo.profile.v1.${address}`;
const isProfile = (v: unknown): v is InvestorProfile => PROFILES.some((p) => p.id === v);

// Storage can be missing or full (private windows); the in-memory copy still works.
const memory = new Map<string, InvestorProfile | null>();
const listeners = new Set<() => void>();

function read(address: string): InvestorProfile | null {
  if (!memory.has(address)) {
    let saved: unknown = null;
    try {
      saved = localStorage.getItem(key(address));
    } catch {
      // Not readable; start without a profile.
    }
    memory.set(address, isProfile(saved) ? saved : null);
  }
  return memory.get(address) ?? null;
}

function write(address: string, profile: InvestorProfile) {
  memory.set(address, profile);
  try {
    localStorage.setItem(key(address), profile);
  } catch {
    // Not persisted; the in-memory copy still holds it.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved profile for `address` (null when none) and a setter. */
export function useProfile(address: string | null): [InvestorProfile | null, (p: InvestorProfile) => void] {
  const profile = useSyncExternalStore(subscribe, () => (address ? read(address) : null));
  const set = useCallback((p: InvestorProfile) => address && write(address, p), [address]);
  return [profile, set];
}

export const profileLabel = (p: InvestorProfile) => PROFILES.find((x) => x.id === p)!.label;
