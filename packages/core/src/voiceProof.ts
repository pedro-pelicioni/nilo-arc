import { type Hex, verifyMessage } from "viem";
import { z } from "zod";

/**
 * Proof that the browser controls a wallet, for voice mode: an EIP-191 signed message naming the
 * address and an expiry. The server only creates voice sessions (billed to its OpenAI key) for
 * a valid proof, so its limits count wallets, not IPs.
 */
export const VoiceProofSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not a 0x address"),
  message: z.string().max(200),
  /** EIP-191 personal_sign signature, hex. */
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(400),
});
export type VoiceProof = z.infer<typeof VoiceProofSchema>;

/** The longest a proof may be valid for, whatever the message says. */
export const VOICE_PROOF_MAX_MS = 24 * 60 * 60_000;

const TITLE = "Nilo voice mode";
const MESSAGE_RE = /^Nilo voice mode\nAddress: (0x[0-9a-fA-F]{40})\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** What the wallet signs. */
export function voiceProofMessage(address: string, expiresAt: Date): string {
  return `${TITLE}\nAddress: ${address}\nExpires: ${expiresAt.toISOString()}`;
}

/** When a proof's message expires (unix ms), or null if it is not a voice proof message. */
export function voiceProofExpiry(message: string): number | null {
  const m = MESSAGE_RE.exec(message);
  return m ? Date.parse(m[2]) : null;
}

export async function verifyVoiceProof(proof: VoiceProof, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const m = MESSAGE_RE.exec(proof.message);
  if (!m) return { ok: false, reason: "not a voice mode message" };
  if (m[1].toLowerCase() !== proof.address.toLowerCase()) return { ok: false, reason: "the message names another address" };
  const expires = Date.parse(m[2]);
  if (!(expires > now)) return { ok: false, reason: "expired" };
  if (expires > now + VOICE_PROOF_MAX_MS) return { ok: false, reason: "valid for too long" };
  let valid = false;
  try {
    valid = await verifyMessage({ address: proof.address as Hex, message: proof.message, signature: proof.signature as Hex });
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad signature" };
}
