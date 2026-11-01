import {
  type BalanceSelector,
  BalanceSelectorSchema,
  type BalanceView,
  FIAT_SIGNS,
  PaymentRoleSchema,
  UNITS_PER_USDC,
  type PriceQuery,
  PriceQuerySchema,
  type ResolvedIntent,
  type SendIntent,
  SendIntentSchema,
  assetToFiat,
  buildSendCalls,
  crossRate,
  fiatToAsset,
  formatFiat,
  formatRate,
  formatScaled,
  formatUtc,
  fromUnits,
  isFiat,
  type Explanation,
  mismatches,
  nicknameFor,
  pickBalances,
  priceSymbol,
  toUnits,
  validateIntent,
} from "@nilo/core";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type Bot, type ChatMessage, DEFAULT_BOT, loadChat, useBots } from "../bots/store";
import type { Address } from "viem";
import { claimReady, loadPayments, prepareClaim } from "../claim";
import { MascotAvatar } from "../bots/MascotAvatar";
import {
  ArrowUpIcon,
  CloseIcon,
  EraseIcon,
  MicIcon,
  MoreIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
  WalletIcon,
  WaveformIcon,
} from "../components/icons";
import { type ChatActionState, MoreMenu, PageTop, QUICK_ACTIONS, TRUST_URL, useQuickAction } from "../components/Layout";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { VoiceBar } from "../components/VoiceBar";
import { VoiceOverlay } from "../components/VoiceOverlay";
import { FAUCET_BELOW, config, network, publicClient, usdcAllowance, usdcBalance } from "../arc";
import { getQuote } from "../prices";
import { formatLocal, formatRelative } from "../time";
import { useVoiceSession } from "../voice";
import type { AgentRequest } from "../agent";
import { useVoiceProof, useWallet } from "../wallet";

type ExtractResponse =
  | { status: "complete"; intent: SendIntent }
  | { status: "price"; query: PriceQuery }
  | { status: "agent"; request: AgentRequest }
  | { status: "needs_clarification"; question: string }
  | { status: "error"; message: string };

const EXAMPLE = "Send 50 USDC to maria, she has 2 minutes";
const VOICE_TASKS: Record<string, string> = {
  get_price: "Checking prices…",
  get_balance: "Checking your balance…",
  prepare_send: "Preparing your payment…",
  list_payments: "Checking your payments…",
  prepare_claim: "Preparing your claim…",
  prepare_recover: "Preparing the recovery…",
  request_test_usdc: "Asking the faucet…",
};
const VOICE_LABEL = {
  idle: "Voice mode",
  connecting: "Connecting voice mode… (tap to cancel)",
  live: "End voice mode",
  closing: "Ending voice mode…",
} as const;
/** Pixels from the bottom that still count as "following" the conversation. */
const STICK_PX = 80;

const CHECKING = "Checking and building the transaction…";
const DONE = "Sent. The recipient can now claim it.";
const CANCELLED = "Cancelled. Nothing was sent.";
const INTERRUPTED = "That review was closed. If you didn't sign it, nothing was sent.";
const CLAIMED = "Claimed. The funds are in your account.";
const RECOVERED = "Recovered. The funds are back in your account.";
const CLAIM_CANCELLED = "Cancelled. Nothing was claimed.";
const ENDINGS = [DONE, CANCELLED, INTERRUPTED, CLAIMED, RECOVERED, CLAIM_CANCELLED];

/** A saved chat can end mid-review (reload, other bot); the sign panel is not saved, so say so. */
function loadSettled(botId: string): ChatMessage[] {
  const saved = loadChat(botId);
  return saved[saved.length - 1]?.content.endsWith(CHECKING) ? [...saved, { role: "assistant", content: INTERRUPTED }] : saved;
}

/** What /api/extract gets: the turns since the last finished payment, within the server's limits (≤ 30, user first). */
function forExtract(messages: ChatMessage[]): ChatMessage[] {
  let from = messages.length;
  while (from > 0 && !(messages[from - 1].role === "assistant" && ENDINGS.includes(messages[from - 1].content))) from--;
  const turns = messages
    .slice(from)
    .slice(-30)
    .map((m) => ({ ...m, content: m.content.slice(0, 2000) }))
    .filter((m) => m.content.trim());
  const start = turns.findIndex((m) => m.role === "user");
  return start < 0 ? [] : turns.slice(start);
}

/** Drafts the quick actions put in the composer. */
const DRAFTS = {
  example: EXAMPLE,
  price: "How much is USDC in BRL?",
  fiat: "Send R$ 5 in USDC to maria, she has 2 minutes",
};
/** Currency the "≈" values are shown in. */
const DISPLAY_FIAT = "USD";

/** How a money amount became an asset amount. Shown on review; not part of the transaction. */
interface Conversion {
  fiatAmount: string;
  currency: string;
  /** Price of one unit of the asset in `currency`, scaled by PRICE_SCALE. */
  rate: bigint;
  /** Oldest of the oracle records used, unix seconds. */
  timestamp: number;
  oracles: string[];
  /** Set when a test asset is priced as a real one. */
  pricedAs?: string;
}

/** Turns "R$ 50 in USDC" into "<n> USDC" with oracle prices. The model never does this math. */
async function convertFiat(intent: SendIntent): Promise<{ intent: SendIntent; conversion: Conversion }> {
  const currency = intent.fiatCurrency!.trim().toUpperCase();
  if (!isFiat(config, currency)) {
    throw new Error(`Payments can be written in ${config.prices!.fiat.join(", ")}, not ${currency}.`);
  }
  const symbol = priceSymbol(config, intent.asset);
  const [fiat, asset] = await Promise.all([getQuote(currency), getQuote(symbol)]);
  const amount = fiatToAsset(intent.amount, fiat, asset);
  return {
    intent: { ...intent, amount, fiatCurrency: undefined },
    conversion: {
      fiatAmount: intent.amount.trim(),
      currency,
      rate: crossRate(asset, fiat),
      timestamp: Math.min(fiat.timestamp, asset.timestamp),
      oracles: [...new Set([fiat.oracle, asset.oracle].filter(Boolean))],
      pricedAs: symbol !== intent.asset.trim().toUpperCase() ? symbol : undefined,
    },
  };
}

/** Value in DISPLAY_FIAT as a 6-decimal amount, or null when there is no price for the asset. */
async function fiatValue(amount: string, assetCode: string): Promise<string | null> {
  try {
    const [asset, fiat] = await Promise.all([getQuote(priceSymbol(config, assetCode)), getQuote(DISPLAY_FIAT)]);
    return assetToFiat(amount, asset, fiat);
  } catch {
    return null;
  }
}

/** "≈ US$ 12.34", or null when there is no price for the asset (never blocks a payment). */
async function approxValue(amount: string, assetCode: string): Promise<string | null> {
  const value = await fiatValue(amount, assetCode);
  return value === null ? null : `≈ ${formatFiat(value, DISPLAY_FIAT)}`;
}

/** An amount rounded for speech ("9999.999990" -> "10,000"); the chat history keeps the exact one. */
function spokenAmount(amount: string): string {
  const units = toUnits(amount);
  const digits = units >= 100n * UNITS_PER_USDC ? 0 : units >= UNITS_PER_USDC ? 2 : 4;
  const text = formatScaled(units, UNITS_PER_USDC, digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A contact's nickname, or the first and last four characters of an address (how voice mode says one). */
function who(address?: string): string {
  if (!address) return "an unknown account";
  return nicknameFor(config, address) ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Why a pending payment can or can't be claimed now, in one clause. */
function paymentStatus(v: BalanceView, now: number): string {
  const due = v.deadline && formatRelative(v.deadline - now);
  switch (v.status) {
    case "claimable":
      return due ? `you can claim it; the deadline is ${due}` : "you can claim it";
    case "expired":
      return `the deadline passed${due ? ` ${due}` : ""}; only the sender can recover it`;
    case "waiting":
      return due ? `waiting for them to claim it; the deadline is ${due}, and you can recover it after that` : "waiting for them to claim it";
    case "recoverable":
      return claimReady(v, now) ? "nobody claimed it; you can recover it" : "the deadline just passed; you can recover it in a few seconds";
  }
}

/** Numbered lines for a list of pending payments: exact amounts on screen, money aloud. */
async function paymentLines(views: BalanceView[], now: number): Promise<{ text: string; spoken: string }> {
  const rows = await Promise.all(
    views.map(async (v, i) => {
      const code = v.asset.code;
      const value = await fiatValue(v.amount, code);
      const money = value && formatFiat(value, DISPLAY_FIAT);
      const side = v.role === "recipient" ? `from ${who(v.sender)}` : `to ${who(v.recipient)}`;
      const status = paymentStatus(v, now);
      return {
        text: `${i + 1}. ${v.amount} ${code}${money ? ` (≈ ${money})` : ""} ${side}: ${status}.`,
        spoken: `${i + 1}: ${money ? `${money} in ${code}` : `about ${spokenAmount(v.amount)} ${code}`} ${side}, ${status}.`,
      };
    }),
  );
  return { text: rows.map((r) => r.text).join("\n"), spoken: rows.map((r) => r.spoken).join(" ") };
}

async function validateFresh(intent: SendIntent, address: Address): Promise<ResolvedIntent> {
  const v = validateIntent(intent, { address, usdc: await usdcBalance(address) }, config);
  if (!v.ok) {
    const lowUsdc = /^Insufficient USDC\b/.test(v.reason) && network.faucetUrl;
    throw new Error(lowUsdc ? `${v.reason} Get free test USDC at ${network.faucetUrl} (Arc Testnet).` : v.reason);
  }
  return v.intent;
}

export function ChatPage({ bot }: { bot: Bot }) {
  const { address, connect, error: walletError } = useWallet();
  const { saveChat, deleteBot } = useBots();
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadSettled(bot.id));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"chat" | "form">("chat");
  const [pending, setPending] = useState<{
    intent: SendIntent;
    resolved: ResolvedIntent;
    warning?: string;
    conversion?: Conversion;
    approx?: string | null;
  } | null>(null);
  const [sent, setSent] = useState<{ deadline: number } | null>(null);
  /** A claim or recovery asked for by voice, waiting to be reviewed and signed. */
  const [pendingClaim, setPendingClaim] = useState<{ view: BalanceView; prepare: () => Promise<Prepared> } | null>(null);
  /** The last list of pending payments read to the user, per side: what "the second one" refers to. */
  const listed = useRef<Partial<Record<BalanceView["role"], BalanceView[]>>>({});
  const reviewing = !!pending || !!pendingClaim;
  const fresh = messages.length === 0 && !reviewing;
  // The welcome screen reads from the top; only a conversation (or the form) follows the bottom.
  const idle = fresh && mode === "chat";

  /** While a voice tool call runs, what the app says is also its result, spoken back. */
  const voiceOut = useRef<string[] | null>(null);
  /** `spoken` replaces `content` in voice mode when the text doesn't read well aloud (long decimals). */
  const say = (content: string, spoken = content) => {
    voiceOut.current?.push(spoken);
    setMessages((m) => [...m, { role: "assistant", content }]);
  };
  const voiceProof = useVoiceProof();
  /** What a voice tool call is doing, shown under the orb. */
  const [voiceTask, setVoiceTask] = useState<string | null>(null);
  const voice = useVoiceSession({
    onToolCall: runVoiceTool,
    onTranscript: (role, content) => setMessages((m) => [...m, { role, content }]),
    onError: say,
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const stick = useRef(!idle);
  const request = useRef<AbortController | null>(null);
  const chatPath = `/chat/${bot.id}`;
  const runQuick = useQuickAction(chatPath);
  const location = useLocation();
  const navigate = useNavigate();

  // A question still waiting for its reply is not saved: leaving the bot drops the request.
  useEffect(() => {
    const unanswered = busy && messages[messages.length - 1]?.role === "user";
    saveChat(bot.id, unanswered ? messages.slice(0, -1) : messages);
  }, [bot.id, messages, busy, saveChat]);
  useEffect(() => () => request.current?.abort(), []);

  // Quick actions arrive as router state; run once, then clear it.
  useEffect(() => {
    const state = location.state as ChatActionState | null;
    if (!state?.action) return;
    navigate(location.pathname, { replace: true, state: null });
    if (state.action === "balance") {
      checkBalance();
    } else {
      setMode("chat");
      setDraft(DRAFTS[state.action]);
      setTimeout(() => input.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Follow the conversation as it grows (new messages, the sign panel building), unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    const content = flow.current;
    if (!el || !content) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX);
    const ro = new ResizeObserver(() => stick.current && el.scrollTo({ top: el.scrollHeight }));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(content);
    if (stick.current) el.scrollTo({ top: el.scrollHeight });
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    stick.current = !idle;
    scroller.current?.scrollTo({ top: idle ? 0 : scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy, mode, pending, pendingClaim, idle]);

  // Grow the composer with its text, up to six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 22)}px`;
  }, [draft, voice.state]);

  /** Says why the wallet can't be used yet, if it can't. */
  function blocked(): boolean {
    if (!address) {
      say(walletError ?? "Connect your wallet first (the button at the bottom of the sidebar), then try again.");
      connect();
      return true;
    }
    return false;
  }

  /** From the menu or a quick action: shows the question it answers. Voice already has the user's words. */
  function checkBalance() {
    setMessages((m) => [...m, { role: "user", content: "What's my balance?" }]);
    return answerBalance();
  }

  async function answerBalance() {
    if (!address) {
      say(walletError ?? "Connect your wallet first (the button at the bottom of the sidebar), then I can check your balance.");
      connect();
      return;
    }
    try {
      const balance = fromUnits(await usdcBalance(address));
      const value = await fiatValue(balance, "USDC");
      const money = value && formatFiat(value, DISPLAY_FIAT);
      const low = toUnits(balance) < FAUCET_BELOW && network.faucetUrl;
      say(
        `Your available funds on ${network.name}:\n• ${balance} USDC${money ? ` (≈ ${money})` : ""}` +
          "\n\nOn Arc, USDC also pays the gas, so a little of it goes to each transaction (fractions of a cent)." +
          (low ? `\nGet free test USDC at ${network.faucetUrl}.` : ""),
        `The user has ${money ? `${money} in USDC` : `about ${spokenAmount(balance)} USDC`} on ${network.name}.`,
      );
    } catch (e) {
      say(`I couldn't load your balance: ${(e as Error).message}`);
    }
  }

  /** True when the review is on screen. */
  async function startReview(intent: SendIntent): Promise<boolean> {
    const from = address;
    if (!from) {
      say(walletError ?? "Connect your wallet first (the button at the bottom of the sidebar), then try again.");
      connect();
      return false;
    }
    try {
      let conversion: Conversion | undefined;
      if (intent.fiatCurrency) {
        ({ intent, conversion } = await convertFiat(intent));
        say(
          `${formatFiat(conversion.fiatAmount, conversion.currency)} is ${intent.amount} ${intent.asset.toUpperCase()} ` +
            `at ${formatRate(conversion.rate)} ${conversion.currency} per ${intent.asset.toUpperCase()} (market rate).`,
        );
      }
      const resolved = await validateFresh(intent, from);
      const [code, approx] = await Promise.all([
        publicClient.getCode({ address: resolved.recipient }),
        conversion ? null : approxValue(resolved.amount, resolved.asset.code),
      ]);
      const warning =
        code && code !== "0x"
          ? "This address is a contract. Make sure it can claim payments; if nobody claims, you can recover the funds after the deadline."
          : undefined;
      setSent(null);
      setPendingClaim(null);
      setPending({ intent, resolved, warning, conversion, approx });
      return true;
    } catch (e) {
      say(`I can't prepare that: ${(e as Error).message}`);
      return false;
    }
  }

  async function answerPayments(role: BalanceView["role"]) {
    if (blocked()) return;
    try {
      const now = nowSec();
      const views = await loadPayments(address!, role, now);
      listed.current[role] = views;
      if (!views.length) {
        say(role === "recipient" ? "No payments are waiting for you." : "You have no pending payments that you sent.");
        return;
      }
      const lines = await paymentLines(views, now);
      const title = role === "recipient" ? "Payments waiting for you" : "Payments you sent that are still pending";
      say(`${title}:\n${lines.text}`, `${title}: ${lines.spoken}`);
    } catch (e) {
      say(`I couldn't load your payments: ${(e as Error).message}`);
    }
  }

  /** Claims (recipient) or recovers (sender) one pending payment. True when the review is on screen. */
  async function startClaim(role: BalanceView["role"], selector: BalanceSelector): Promise<boolean> {
    if (blocked()) return false;
    const verb = role === "recipient" ? "claim" : "recover";
    try {
      const now = nowSec();
      const current = await loadPayments(address!, role, now);
      // Positions refer to the list the user heard; the payments themselves are checked again on chain.
      const picked = pickBalances(listed.current[role] ?? current, selector, config);
      const live = picked.flatMap((p) => current.find((c) => c.id === p.id) ?? []);
      const usable = live.filter((v) => v.claimableNow);
      if (usable.length === 1) {
        const v = usable[0];
        if (!claimReady(v, now)) {
          say("The deadline has just passed. Try again in a few seconds.");
          return false;
        }
        // Built once here so a problem is said out loud; the panel rebuilds it only if asked to.
        let first: Prepared | null = await prepareClaim(v, address!);
        setPending(null);
        setSent(null);
        setPendingClaim({
          view: v,
          prepare: async () => {
            const p = first;
            first = null;
            return p ?? prepareClaim(v, address!);
          },
        });
        return true;
      }
      if (usable.length > 1) {
        listed.current[role] = usable;
        const lines = await paymentLines(usable, now);
        say(`Which one do you want to ${verb}?\n${lines.text}`, `More than one payment matches. Which one should be ${verb}ed? ${lines.spoken}`);
      } else if (live.length === 1) {
        say(`That payment can't be ${verb}ed now: ${paymentStatus(live[0], now)}.`);
      } else if (live.length > 1) {
        say(`None of those payments can be ${verb}ed now.`);
      } else if (picked.length) {
        say("That payment is no longer pending: it was already claimed or recovered.");
      } else if (current.length) {
        say(`No pending payment matches that. Ask me to list your ${role === "recipient" ? "incoming" : "sent"} payments.`);
      } else {
        say(role === "recipient" ? "No payments are waiting for you." : "You have no pending payments that you sent.");
      }
      return false;
    } catch (e) {
      say(`I can't prepare that: ${(e as Error).message}`);
      return false;
    }
  }

  /** Test USDC comes from Circle's faucet, which needs a human (captcha): point there. */
  async function answerFaucet() {
    if (blocked()) return;
    if (!network.faucetUrl) {
      say(`${network.name} uses real USDC. There is no faucet here.`);
      return;
    }
    const balance = fromUnits(await usdcBalance(address!).catch(() => 0n));
    say(
      `You have ${balance} USDC. Get free test USDC at ${network.faucetUrl}: pick Arc Testnet and paste your address ${address}.`,
      `The user has about ${spokenAmount(balance)} USDC. Free test USDC comes from Circle's faucet at faucet dot circle dot com: pick Arc Testnet and paste the wallet address. The link is in the chat.`,
    );
  }

  /** Voice mode is billed per minute to the server's key: only for a signed-in wallet, which proves it once. */
  function startVoice() {
    if (!address) {
      say(walletError ?? "Connect your wallet to use voice mode (the button at the bottom of the sidebar).");
      connect();
      return;
    }
    voice.start(() => voiceProof(address));
  }

  /** A tool the voice backend asked for. Its arguments are untrusted, like /api/extract's output. */
  async function runVoiceTool(name: string, args: unknown): Promise<string> {
    voiceOut.current = [];
    setVoiceTask(VOICE_TASKS[name] ?? null);
    try {
      if (name === "get_balance") {
        await answerBalance();
      } else if (name === "get_price") {
        const query = PriceQuerySchema.safeParse(args);
        if (!query.success) return "That price request was incomplete.";
        await answerPrice(query.data);
      } else if (name === "prepare_send") {
        const raw = (args ?? {}) as Record<string, unknown>;
        const intent = SendIntentSchema.safeParse({ ...raw, fiatCurrency: raw.fiatCurrency ?? undefined });
        if (!intent.success) return "That payment request was incomplete.";
        if (await startReview(intent.data)) {
          voiceOut.current.push("The review is on screen. Nothing is sent until the user checks it and taps Sign and send.");
        }
      } else if (name === "list_payments") {
        const role = PaymentRoleSchema.safeParse((args as { role?: unknown } | null)?.role);
        if (!role.success) return "That request was incomplete: say whether it is about payments received or sent.";
        await answerPayments(role.data);
      } else if (name === "prepare_claim" || name === "prepare_recover") {
        const selector = BalanceSelectorSchema.safeParse(args);
        if (!selector.success) return "That request was incomplete.";
        const recover = name === "prepare_recover";
        if (await startClaim(recover ? "sender" : "recipient", selector.data)) {
          voiceOut.current.push(
            `The review is on screen. Nothing is ${recover ? "recovered" : "claimed"} until the user checks it and taps Sign and ${recover ? "recover" : "claim"}.`,
          );
        }
      } else if (name === "request_test_usdc") {
        await answerFaucet();
      } else {
        return `There is no tool called ${name}.`;
      }
      return voiceOut.current.join("\n");
    } finally {
      voiceOut.current = null;
      setVoiceTask(null);
    }
  }

  async function onChat(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    // The send button is swapped out once the draft clears; keep the keyboard in the composer.
    input.current?.focus();
    const ctrl = new AbortController();
    request.current = ctrl;
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: forExtract(next) }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as ExtractResponse;
      if (data.status === "complete") {
        const { amount, asset, fiatCurrency, recipient, deadlineSeconds } = data.intent;
        say(
          `Got it: ${fiatCurrency ? `${fiatCurrency} ${amount} in ${asset}` : `${amount} ${asset}`} to ${recipient}, ` +
            `claimable for ${deadlineSeconds} seconds. ${CHECKING}`,
        );
        await startReview(data.intent);
      } else if (data.status === "price") {
        await answerPrice(data.query);
      } else if (data.status === "agent") {
        say("I'll set up your investing agent. Review the mandate: it says exactly what the agent may do, and you sign it once.");
        navigate("/agent", { state: { agent: data.request } });
      } else if (data.status === "needs_clarification") {
        say(data.question);
      } else {
        say(data.message);
      }
    } catch {
      if (!ctrl.signal.aborted) say("I couldn't reach the assistant. You can use the form instead.");
    } finally {
      setBusy(false);
    }
  }

  /** The answer comes from the oracle, never from the model. */
  async function answerPrice(query: PriceQuery) {
    const base = query.asset.trim().toUpperCase();
    const quote = query.quoteCurrency.trim().toUpperCase();
    try {
      const baseSymbol = priceSymbol(config, base);
      const [b, q] = await Promise.all([getQuote(baseSymbol), getQuote(quote)]);
      const sign = FIAT_SIGNS[quote];
      const value = formatRate(crossRate(b, q));
      say(
        `1 ${base} = ${sign ? `${sign} ${value}` : `${value} ${quote}`}` +
          `\nMarket rate from Coinbase's public rates, fetched ${formatUtc(Math.min(b.timestamp, q.timestamp))}.`,
      );
    } catch (e) {
      say(`I couldn't get that price: ${(e as Error).message}`);
    }
  }

  const prepare = useMemo(() => {
    if (!pending || !address) return null;
    return async (): Promise<Prepared> => {
      const resolved = await validateFresh(pending.intent, address);
      const allowance = await usdcAllowance(address, network.payments);
      const built = buildSendCalls(resolved, allowance, config);
      return {
        calls: built.calls,
        check: (e: Explanation) => {
          setSent({ deadline: built.deadline });
          return mismatches(e, resolved, address, built.deadline);
        },
      };
    };
  }, [pending, address]);

  function reset() {
    setMessages([]);
    setPending(null);
    setSent(null);
    setPendingClaim(null);
    setDraft("");
    setMode("chat");
  }

  function cancel() {
    setPending(null);
    setSent(null);
    say(CANCELLED);
    voice.notify("The user cancelled the payment review. Nothing was sent.");
  }

  function cancelClaim() {
    setPendingClaim(null);
    say(CLAIM_CANCELLED);
    voice.notify("The user cancelled the review. Nothing was claimed or recovered.");
  }

  function fillExample() {
    setMode("chat");
    setDraft(EXAMPLE);
    input.current?.focus();
  }

  const hasText = draft.trim().length > 0;
  const deletable = bot.id !== DEFAULT_BOT.id;

  return (
    <div className="view">
      <PageTop
        avatar={<MascotAvatar variant={bot.variant} color={bot.color} size={28} />}
        title={bot.name}
        actions={
          <MoreMenu label="Chat options" trigger={<MoreIcon />}>
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    close();
                    reset();
                  }}
                >
                  <EraseIcon width={18} height={18} /> Clear chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy || reviewing}
                  onClick={() => {
                    close();
                    checkBalance();
                  }}
                >
                  <WalletIcon width={18} height={18} /> Check balance
                </button>
                {deletable && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      close();
                      if (!window.confirm(`Delete ${bot.name}? Its chat history is deleted too.`)) return;
                      navigate(`/chat/${DEFAULT_BOT.id}`);
                      deleteBot(bot.id);
                    }}
                  >
                    <TrashIcon width={18} height={18} /> Delete bot
                  </button>
                )}
              </>
            )}
          </MoreMenu>
        }
      />

      <div className="view-scroll" ref={scroller}>
        <div className="flow" ref={flow} role="log" aria-label="Conversation">
          {fresh && (
            <section className="hero">
              <MascotAvatar variant={bot.variant} color={bot.color} size={96} />
              <h1>Hi! I'm {bot.name}</h1>
              <p className="hero-sub">
                <strong>Your USDC agent on Arc.</strong> Tell me who should get what and how long they have. I build the
                transaction, explain it in plain words before you sign, and you get it back if nobody claims it.
              </p>
              <div className="suggestions">
                {QUICK_ACTIONS.map((a) => (
                  <button key={a.title} type="button" className="suggestion" title={a.hint} onClick={() => runQuick(a)}>
                    <a.Icon className={`tone-${a.tone}`} />
                    {a.title}
                  </button>
                ))}
              </div>
              <button type="button" className="suggestion try" onClick={fillExample}>
                Try: {EXAMPLE}
              </button>
              <p className="muted small">
                Contacts: {Object.keys(config.contacts).join(", ")}. Or paste a full 0x… address.
              </p>
              <a className="safe-note" href={TRUST_URL} target="_blank" rel="noreferrer">
                <ShieldIcon width={16} height={16} />
                Safe by design: every transaction is decoded and explained before you sign.
              </a>
            </section>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className={`bubble ${m.role}`}>{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="msg assistant">
              <div className="bubble assistant typing" role="status">
                <span className="sr-only">{bot.name} is typing…</span>
                <i aria-hidden="true" />
                <i aria-hidden="true" />
                <i aria-hidden="true" />
              </div>
            </div>
          )}

          {mode === "form" && (
            <div className="msg assistant wide">
              <section className="panel form-card">
                <div className="form-head">
                  <strong>New payment</strong>
                  <button type="button" className="icon-btn ghost small-btn" onClick={() => setMode("chat")} title="Back to chat" aria-label="Back to chat">
                    <CloseIcon width={18} height={18} />
                  </button>
                </div>
                <IntentForm disabled={reviewing} onSubmit={startReview} />
              </section>
            </div>
          )}

          {pending && address && prepare && (
            <div className="msg assistant wide">
              <p className="review-note">
                <strong>Check it, then sign.</strong> Nothing is sent until you sign. Every line below is decoded from
                the transaction itself, not written by the AI.
              </p>
              {pending.warning && <p className="warning">{pending.warning}</p>}
              {pending.conversion ? (
                <ConversionNote conversion={pending.conversion} resolved={pending.resolved} />
              ) : (
                pending.approx && (
                  <p className="muted small">
                    {pending.resolved.amount} {pending.resolved.asset.code} is {pending.approx} (market rate).
                  </p>
                )
              )}
              <SignPanel
                key={JSON.stringify(pending.intent)}
                prepare={prepare}
                signLabel="Sign and send"
                onCancel={cancel}
                onDone={() => {
                  say(DONE);
                  voice.notify("The user signed and sent the payment. The recipient can now claim it.");
                }}
                doneMessage={
                  sent && (
                    <>
                      <p>
                        The recipient can claim it on the <Link to="/claim">Claim</Link> page until{" "}
                        {formatLocal(sent.deadline)}. After that, recover it on <Link to="/sent">Sent</Link>.
                      </p>
                      <button className="secondary" onClick={() => setPending(null)}>
                        New payment
                      </button>
                    </>
                  )
                }
              />
            </div>
          )}

          {pendingClaim && address && (
            <div className="msg assistant wide">
              <p className="review-note">
                <strong>Check it, then sign.</strong> Nothing is {pendingClaim.view.role === "recipient" ? "claimed" : "recovered"} until
                you sign. Every line below is decoded from the transaction itself, not written by the AI.
              </p>
              <SignPanel
                key={pendingClaim.view.id}
                prepare={pendingClaim.prepare}
                signLabel={pendingClaim.view.role === "recipient" ? "Sign and claim" : "Sign and recover"}
                onCancel={cancelClaim}
                onDone={() => {
                  const recovered = pendingClaim.view.role === "sender";
                  say(recovered ? RECOVERED : CLAIMED);
                  voice.notify(`The user signed the ${recovered ? "recovery" : "claim"}. The funds are in their account.`);
                }}
                doneMessage={
                  <button className="secondary" onClick={() => setPendingClaim(null)}>
                    Done
                  </button>
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Voice only, no transcript. It steps aside for a review, which has to be read and signed. */}
      {voice.state !== "idle" && !reviewing && (
        <VoiceOverlay
          state={voice.state}
          levels={voice.levels}
          spectrum={voice.spectrum}
          task={voiceTask}
          name={bot.name}
          onEnd={voice.stop}
        />
      )}

      <div className="composer-wrap">
        <form onSubmit={onChat} className="composer">
          <button
            type="button"
            className={`icon-btn${mode === "form" ? " on" : ""}`}
            onClick={() => setMode((m) => (m === "form" ? "chat" : "form"))}
            title={mode === "form" ? "Back to chat" : "Use the form instead"}
            aria-label={mode === "form" ? "Back to chat" : "Use the form instead"}
            aria-pressed={mode === "form"}
          >
            <PlusIcon />
          </button>
          {voice.state !== "idle" ? (
            <VoiceBar state={voice.state} levels={voice.levels} name={bot.name} />
          ) : (
            <>
              <textarea
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                  // Enter also confirms an IME candidate; only send once composition is over.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    onChat();
                  }
                }}
                placeholder={`Message ${bot.name}`}
                readOnly={busy}
                disabled={reviewing}
                aria-label="Message"
                rows={1}
              />
              <button
                type="button"
                className="icon-btn ghost voice"
                disabled
                aria-disabled="true"
                title="Voice input — coming soon"
                aria-label="Voice input — coming soon"
              >
                <MicIcon />
              </button>
            </>
          )}
          {hasText && voice.state === "idle" ? (
            <button type="submit" className="round-send" disabled={busy || reviewing} aria-label="Send" title="Send">
              <ArrowUpIcon />
            </button>
          ) : (
            <button
              type="button"
              className={`round-send voice ${voice.state}`}
              onClick={voice.state === "idle" ? startVoice : voice.stop}
              disabled={voice.state === "closing"}
              aria-pressed={voice.state !== "idle"}
              title={VOICE_LABEL[voice.state]}
              aria-label={VOICE_LABEL[voice.state]}
            >
              <WaveformIcon />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

/** Where the asset amount came from. Kept apart from the decoded explanation: the transaction holds no price. */
function ConversionNote({ conversion: c, resolved }: { conversion: Conversion; resolved: ResolvedIntent }) {
  return (
    <div className="panel conversion">
      <strong>
        {formatFiat(c.fiatAmount, c.currency)} → {resolved.amount} {resolved.asset.code}
      </strong>
      <p className="small">
        Rate: 1 {resolved.asset.code} = {formatRate(c.rate)} {c.currency}
        {c.pricedAs && ` (priced as ${c.pricedAs})`}, from Coinbase's public rates, fetched {formatUtc(c.timestamp)}. Rounded
        down to 6 decimals.
      </p>
      <p className="muted small">
        The conversion is not part of the transaction: what you sign is the {resolved.asset.code} amount explained below.
      </p>
    </div>
  );
}

function IntentForm({ onSubmit, disabled }: { onSubmit: (i: SendIntent) => void; disabled: boolean }) {
  const [amount, setAmount] = useState("1");
  const [asset, setAsset] = useState(config.assets[0].code);
  const [recipient, setRecipient] = useState("maria");
  const [minutes, setMinutes] = useState("2");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ amount, asset, recipient, deadlineSeconds: Math.round(Number(minutes) * 60) });
      }}
    >
      <label>
        Amount <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Asset
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          {config.assets.map((a) => (
            <option key={a.code}>{a.code}</option>
          ))}
        </select>
      </label>
      <label>
        Recipient <input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>
      <label>
        Minutes to claim <input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="decimal" />
      </label>
      <button disabled={disabled}>Review</button>
    </form>
  );
}
