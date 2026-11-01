// Voice mode: a GPT-Live session the browser joins over WebRTC. This server holds the key,
// creates the session and returns the SDP answer. The voice model only talks; a Responses
// backend turns what was said into calls to tools the browser runs: the text chat's send and
// price requests, plus the balance and pending payments (list, claim, recover).
// The browser validates them again, reads the chain and prices itself and shows the usual
// review: nothing is built or signed from here.
import { VoiceProofSchema, defaultConfig as config, verifyVoiceProof } from "@nilo/core";
import OpenAI from "openai";
import { z } from "zod";

const BACKEND_MODEL = process.env.OPENAI_VOICE_BACKEND_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const VOICE = process.env.OPENAI_VOICE ?? "marin";

const FRONTEND = `You are Nilo, a USDC payments assistant on Arc, Circle's blockchain, talking out loud.
Speak in the user's language (English or Portuguese), in short sentences.
For anything about sending money, prices, amounts, balances or addresses, delegate. Never say a number, price, address or result you did not get back from the backend.
The user sees no text while you talk: say results out loud in full, never point them to the screen. The one exception is a review (a payment, a claim or a recovery): when the backend says a review is on screen, it really is shown, so tell the user to check it and sign there. You cannot sign, send or claim anything yourself.
Never read a full wallet address aloud; say "0x" and its last four characters.`;

const BACKEND = `You turn a spoken request into a tool call. You never build, sign or describe transactions, and you never state prices, balances or payments yourself.

- prepare_send: the user wants to send an amount to someone, who has a limited time to claim it.
- get_price: the user asks what an asset or currency is worth.
- get_balance: the user asks how much they have ("qual é meu saldo?", "what's my balance?").
- list_payments: the user asks about pending payments: sent to them and waiting to be claimed (role "recipient"), or sent by them and not claimed yet (role "sender").
- prepare_claim: the user wants to claim (receive) a payment sent to them.
- prepare_recover: the user wants back a payment they sent that nobody claimed before its deadline.
- request_test_usdc: the user asks for free test USDC (the tool gives the faucet link to say).

Contacts the user can name: ${Object.keys(config.contacts).join(", ")}. Anyone else is a full wallet address starting with 0x.
For prepare_claim and prepare_recover, fill only what the user said to pick the payment: its number in the last list read to them, the other person, the amount or the asset. Leave the rest null; with all null the app picks the only one there is, or asks back.
Speech transcripts can be imperfect. Use earlier turns to fill fields the user already gave. If a field is missing or unclear, ask a short question for only that field instead of calling a tool. Never guess a missing value.
If the request is none of these, say briefly that you can send claimable USDC payments, list, claim and recover pending payments, and check prices and the balance.
After a tool returns, pass on what it says in one or two sentences; for a list, say each payment briefly with its number. Say amounts the way the tool gives them ("12.50 USDC", "about R$ 62"), and never a long decimal digit by digit. The user sees no text in voice mode, so never say the amounts are on screen. Only a review is shown: if the tool says a review is on screen, ask the user to check it and sign there.
Developer messages report what the user did on screen (signed or cancelled a review): say it in one short sentence.`;

/** Arguments that point at one pending payment. Strict mode: every field is required, null when not said. */
const PAYMENT_SELECTOR = {
  type: "object",
  additionalProperties: false,
  required: ["index", "counterparty", "amount", "asset"],
  properties: {
    index: { type: ["integer", "null"], description: "Its number in the last list read to the user, from 1. Otherwise null." },
    counterparty: {
      type: ["string", "null"],
      description: 'The other person: a contact nickname (e.g. "maria") or a full wallet address starting with 0x. Otherwise null.',
    },
    amount: { type: ["string", "null"], description: 'The amount as said, as a decimal string with "." (e.g. "50"). Otherwise null.' },
    asset: { type: ["string", "null"], description: 'Asset code, uppercased (e.g. "USDC"). Otherwise null.' },
  },
};

const TOOLS = [
  {
    type: "function" as const,
    name: "prepare_send",
    description: "Show the user a payment to review and sign. The app checks the balance and the recipient first.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "asset", "fiatCurrency", "recipient", "deadlineSeconds"],
      properties: {
        amount: { type: "string", description: 'The number as said, as a decimal string with "." (e.g. "50", "12.5"). Never round or convert.' },
        asset: { type: "string", description: 'Asset code to send, uppercased: "USDC" (dollars are USDC).' },
        fiatCurrency: {
          type: ["string", "null"],
          description: 'Only when the amount is said in another currency than the asset: its ISO code ("50 reais in USDC" -> "BRL"). Otherwise null.',
        },
        recipient: { type: "string", description: 'A contact nickname (e.g. "maria") or a full wallet address starting with 0x, exactly as given.' },
        deadlineSeconds: { type: "integer", description: 'How long the recipient has to claim, in whole seconds ("2 minutes" -> 120).' },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_balance",
    description: "Read the user's own USDC balance on Arc, with its approximate value in their currency.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    type: "function" as const,
    name: "get_price",
    description: "Read the price of an asset or currency (USDC, BTC, ETH, EUR, BRL) from live market rates.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["asset", "quoteCurrency"],
      properties: {
        asset: { type: "string", description: 'Uppercased ticker or ISO code ("bitcoin" -> "BTC", "EUR").' },
        quoteCurrency: { type: "string", description: 'ISO code to express it in ("reais" -> "BRL"); "USD" if not said.' },
      },
    },
  },
  {
    type: "function" as const,
    name: "list_payments",
    description: "Read the user's pending payments on one side, numbered, with their amounts, the other person and the deadline.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: {
        role: {
          type: "string",
          enum: ["recipient", "sender"],
          description: '"recipient": payments sent to the user. "sender": payments the user sent.',
        },
      },
    },
  },
  {
    type: "function" as const,
    name: "prepare_claim",
    description: "Show the user the claim of a payment sent to them, to review and sign. The app checks it can be claimed first.",
    strict: true,
    parameters: PAYMENT_SELECTOR,
  },
  {
    type: "function" as const,
    name: "prepare_recover",
    description: "Show the user the recovery of a payment they sent that nobody claimed before the deadline, to review and sign.",
    strict: true,
    parameters: PAYMENT_SELECTOR,
  },
  {
    type: "function" as const,
    name: "request_test_usdc",
    description: "Get the link to Circle's faucet, where the user can get free test USDC on Arc Testnet.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
];

/** The browser's WebRTC offer, and a signed proof that it controls a wallet. */
export const VoiceRequest = z.object({ sdp: z.string().min(1).max(20_000), proof: VoiceProofSchema });

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 429 | 502 | 503,
  ) {
    super(message);
  }
}

const HOUR = 60 * 60_000;
export const LIMITS = {
  /** Sessions per wallet per hour. */
  perWallet: 10,
  /** Sessions for the whole server per hour (at most 5 minutes each): anyone can make a new wallet. */
  perHour: 60,
};

/** When set (comma-separated 0x addresses), only these wallets may use voice mode, e.g. the presenter's. */
const ALLOWED = new Set(
  (process.env.VOICE_ALLOWED_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

/** Wallet → times of sessions created in the last hour. Failed attempts are not billed and don't count. */
const byWallet = new Map<string, number[]>();
let recent: number[] = [];

function prune(now: number) {
  for (const [address, times] of byWallet) {
    const kept = times.filter((t) => t > now - HOUR);
    if (kept.length) byWallet.set(address, kept);
    else byWallet.delete(address);
  }
  recent = recent.filter((t) => t > now - HOUR);
}

let client: OpenAI | null = null;

export async function createVoiceSession(req: z.infer<typeof VoiceRequest>): Promise<{ sdp: string; sessionId: string }> {
  if (!process.env.OPENAI_API_KEY) throw new VoiceError("The server has no OPENAI_API_KEY.", 503);
  const now = Date.now();
  const check = await verifyVoiceProof(req.proof, now);
  if (!check.ok) throw new VoiceError(`Sign in again to use voice mode (${check.reason}).`, 401);
  const address = req.proof.address.toLowerCase();
  if (ALLOWED.size && !ALLOWED.has(address)) throw new VoiceError("Voice mode is not enabled for this wallet.", 403);
  prune(now);
  if ((byWallet.get(address)?.length ?? 0) >= LIMITS.perWallet) {
    throw new VoiceError("This wallet used voice mode too often this hour.", 429);
  }
  if (recent.length >= LIMITS.perHour) throw new VoiceError("Voice mode is busy this hour.", 429);

  client ??= new OpenAI({ maxRetries: 0 });
  const live = await client.live.create({
    session: {
      model: "gpt-live-1",
      instructions: FRONTEND,
      audio: { output: { voice: VOICE } },
      delegation: {
        type: "responses",
        responses: { model: BACKEND_MODEL, instructions: BACKEND, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: false },
      },
      // The browser is untrusted: it may return tool results and hang up, not change the prompts or the backend.
      client: { data_channel: { allowed_client_events: ["response.item.create", "response.create", "session.close"] } },
    },
    transport: { type: "webrtc", sdp: req.sdp },
  });
  byWallet.set(address, [...(byWallet.get(address) ?? []), now]);
  recent.push(now);
  return { sdp: live.transport.sdp, sessionId: live.session.id };
}
