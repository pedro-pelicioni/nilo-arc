import { z } from "zod";

/** What the chat agent (or the plain form) produces. Nothing here is trusted yet. */
export const SendIntentSchema = z.object({
  /** In `asset` units, or in `fiatCurrency` units when that is set. */
  amount: z.string().min(1),
  /** Asset code: "USDC". */
  asset: z.string().min(1),
  /** A 0x… wallet address or a nickname from the fixed contact list. */
  recipient: z.string().min(1),
  deadlineSeconds: z.number().int(),
  /** Set when the user wrote the amount in money ("R$ 50 in USDC"): the app converts it with the oracle. */
  fiatCurrency: z.string().min(1).optional(),
});
export type SendIntent = z.infer<typeof SendIntentSchema>;

/** "How much is USDC in BRL?": answered from the oracle, never by the model. */
export const PriceQuerySchema = z.object({
  /** Asset or currency to price, e.g. "USDC", "BTC", "EUR". */
  asset: z.string().min(1),
  /** Currency to express it in, e.g. "USD" or "BRL". */
  quoteCurrency: z.string().min(1),
});
export type PriceQuery = z.infer<typeof PriceQuerySchema>;

/** Which side of the user's pending payments a voice request is about. */
export const PaymentRoleSchema = z.enum(["recipient", "sender"]);

/** How a spoken request points at one of the user's pending payments (see pickBalances). Null fields are not used. */
export const BalanceSelectorSchema = z.object({
  /** Position (from 1) in the list the user was last given. */
  index: z.number().int().nullable(),
  /** The other side of the payment: a contact nickname or a full address. */
  counterparty: z.string().nullable(),
  amount: z.string().nullable(),
  /** Asset code. */
  asset: z.string().nullable(),
});
export type BalanceSelector = z.infer<typeof BalanceSelectorSchema>;
