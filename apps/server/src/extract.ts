// Turns chat text into a structured send intent or price question. The model sees only what the
// user typed: no keys, no chain data, no transactions. Its output is untrusted
// and is validated again by the core before anything is built.
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { PriceQuerySchema, SendIntentSchema, type PriceQuery, type SendIntent } from "@nilo/core";
import { z } from "zod";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

const SYSTEM = `You extract a request from a chat in Nilo, a USDC wallet on Arc, Circle's blockchain. You never build, sign or describe transactions, and you never state prices.

There are three kinds of request. Set "kind" accordingly.

1. kind "send": the user wants to send an amount to someone, who has a limited time to claim it. Fill:
- amount: the number exactly as written, as a decimal string with "." as separator (e.g. "50", "12.5"). Never round or convert.
- asset: the asset code to send, uppercased. Only USDC can be sent; if the user names another asset, still copy it and the app will refuse it.
- fiatCurrency: only when the amount is written in another currency than the asset, the ISO code of that money (e.g. "send R$ 50 in USDC" -> amount "50", fiatCurrency "BRL", asset "USDC"; "20 euros em USDC" -> "EUR"). Dollars ("$10", "10 dólares") are USDC itself: asset "USDC", fiatCurrency null. Otherwise null. Never convert the amount yourself.
- recipient: exactly what the user wrote to identify the recipient: either a nickname (alice, maria or bob) or a full wallet address starting with 0x (42 characters). Copy addresses character by character. Never complete, fix or invent an address.
- deadlineSeconds: how long the recipient has to claim, converted to whole seconds (e.g. "2 minutes" -> 120, "1 hour" -> 3600, "2 dias" -> 172800).

2. kind "price": the user asks what an asset or currency is worth (e.g. "how much is USDC in reais?", "quanto está o bitcoin em reais?", "price of ETH", "price of EUR"). Fill:
- asset: the asset or currency to price, as an uppercased ticker or ISO code. Supported: USDC, BTC, ETH, EUR, BRL ("bitcoin" -> "BTC", "dólar" -> "USDC").
- quoteCurrency: the currency to express it in, as an ISO code; "USD" if the user did not say ("reais" -> "BRL", "euros" -> "EUR").
Leave amount, recipient, deadlineSeconds and fiatCurrency null. Never answer the price yourself; the app reads it from live market rates.

3. kind "agent": the user wants Nilo to invest their USDC for them in Morpho vaults on Arc, put their money to work, earn yield, or set up or change the investing agent (e.g. "invest my money while I sleep", "quero investir no máximo 30 dólares por semana", "be conservative with my savings"). Fill only what the user said:
- agentPersonality: "guardian" if they want to be careful or conservative, "balanced" for moderate, "explorer" for aggressive or higher yield; otherwise null.
- weeklyLimit: the most they want invested per week, as a number of dollars or USDC (e.g. "30 dólares por semana" -> 30); otherwise null.
- days: how long the agent may keep investing, in whole days (e.g. "for two weeks" -> 14); otherwise null.
Leave the payment and price fields null. A request to invest is complete even when all three are null.

The user may write in English or Portuguese. Reply in the user's language.

If any field the request needs is missing or ambiguous, set status to "needs_clarification", put a short question in "question" asking only for what is missing, and set the unknown fields to null. Never guess a missing value.
If the message is none of these, set status to "needs_clarification" and briefly say you can send claimable payments, check prices and invest for the user.
When everything is clear, set status to "complete" and question to null.
Use earlier messages in the conversation to fill fields the user already gave.`;

const ExtractionSchema = z.object({
  status: z.enum(["complete", "needs_clarification"]),
  kind: z.enum(["send", "price", "agent"]),
  amount: z.string().nullable(),
  asset: z.string().nullable(),
  fiatCurrency: z.string().nullable(),
  recipient: z.string().nullable(),
  deadlineSeconds: z.number().int().nullable(),
  quoteCurrency: z.string().nullable(),
  agentPersonality: z.enum(["guardian", "balanced", "explorer"]).nullable(),
  weeklyLimit: z.number().nullable(),
  days: z.number().int().nullable(),
  question: z.string().nullable(),
});

/** What the user asked of the investing agent. Validated again when the mandate is built. */
export const AgentRequestSchema = z.object({
  personality: z.enum(["guardian", "balanced", "explorer"]).optional(),
  weeklyLimit: z.number().positive().max(1_000).optional(),
  days: z.number().int().min(1).max(90).optional(),
});

export const ChatSchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) }))
  .min(1)
  .max(30)
  .refine((m) => m[0].role === "user" && m[m.length - 1].role === "user", "conversation must start and end with the user");

export type ExtractResult =
  | { status: "complete"; intent: SendIntent }
  | { status: "price"; query: PriceQuery }
  | { status: "agent"; request: z.infer<typeof AgentRequestSchema> }
  | { status: "needs_clarification"; question: string };

// Created on first use: the constructor throws when OPENAI_API_KEY is missing,
// and the server should still start (the form flow does not need the model).
let client: OpenAI | null = null;

export async function extractIntent(messages: z.infer<typeof ChatSchema>): Promise<ExtractResult> {
  client ??= new OpenAI();
  const response = await client.responses.parse({
    model: MODEL,
    instructions: SYSTEM,
    input: messages,
    text: { format: zodTextFormat(ExtractionSchema, "chat_request") },
    max_output_tokens: 1024,
  });

  const refused = response.output.some(
    (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
  );
  if (refused) {
    return { status: "needs_clarification", question: "I can only help send claimable payments, check prices and invest for you." };
  }
  const out = response.output_parsed;
  if (!out) throw new Error(`model returned no parseable output (status: ${response.status})`);

  if (out.status === "complete" && out.kind === "agent") {
    const request = AgentRequestSchema.safeParse({
      personality: out.agentPersonality ?? undefined,
      weeklyLimit: out.weeklyLimit ?? undefined,
      days: out.days ?? undefined,
    });
    if (request.success) return { status: "agent", request: request.data };
    return { status: "needs_clarification", question: "I can invest up to 1,000 USDC a week for up to 90 days. What limit would you like?" };
  }
  if (out.status === "complete" && out.kind === "price") {
    const query = PriceQuerySchema.safeParse({ asset: out.asset, quoteCurrency: out.quoteCurrency ?? "USD" });
    if (query.success) return { status: "price", query: query.data };
  } else if (out.status === "complete") {
    const intent = SendIntentSchema.safeParse({ ...out, fiatCurrency: out.fiatCurrency ?? undefined });
    if (intent.success) return { status: "complete", intent: intent.data };
  }
  return {
    status: "needs_clarification",
    question: out.question ?? "Could you tell me the amount, asset, recipient and how long they have to claim?",
  };
}
