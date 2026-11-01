import { encodeFunctionData, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import {
  agentAbi,
  allowanceFor,
  buildClaimCall,
  buildSendCalls,
  erc20Abi,
  erc4626Abi,
  explainAgentCalls,
  explainCalls,
  makeConfig,
  mandateFrom,
  mandateMismatches,
  mismatches,
  personality,
  revokeCalls,
  setMandateCalls,
  split,
  toUnits,
  validateIntent,
  withdrawCalls,
} from "../src";

const config = makeConfig("testnet");
const n = config.network;
const ALICE = "0xA1a66Ad3c702260e0626e7Bea9E6482bb5c5eB59" as const;
const MARIA = "0x90053310B651E4a857854Ab7fC210B8aFdE23a78" as const;
const EVIL = "0x000000000000000000000000000000000000dEaD" as const;
const NOW = new Date("2026-11-01T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function resolved(amount = "1.5") {
  const v = validateIntent({ amount, asset: "usdc", recipient: "maria", deadlineSeconds: 300 }, { address: ALICE, usdc: toUnits("10") }, config);
  if (!v.ok) throw new Error(v.reason);
  return v.intent;
}

describe("validateIntent", () => {
  it("resolves a contact and keeps the exact amount", () => {
    const r = resolved();
    expect(r.recipient).toBe(MARIA);
    expect(r.amount).toBe("1.5");
  });
  it("refuses more than the balance minus gas, self-sends and 7 decimals", () => {
    const acct = { address: ALICE, usdc: toUnits("1") };
    expect(validateIntent({ amount: "1", asset: "USDC", recipient: "maria", deadlineSeconds: 300 }, acct, config).ok).toBe(false);
    expect(validateIntent({ amount: "0.1", asset: "USDC", recipient: ALICE, deadlineSeconds: 300 }, acct, config).ok).toBe(false);
    expect(validateIntent({ amount: "0.1234567", asset: "USDC", recipient: "maria", deadlineSeconds: 300 }, acct, config).ok).toBe(false);
    expect(validateIntent({ amount: "0.1", asset: "XLM", recipient: "maria", deadlineSeconds: 300 }, acct, config).ok).toBe(false);
  });
});

describe("explainCalls", () => {
  it("explains a send built by the app, approval included, with no mismatches", () => {
    const r = resolved();
    const built = buildSendCalls(r, 0n, config, NOW);
    expect(built.calls).toHaveLength(2);
    const e = explainCalls(built.calls, ALICE, config);
    expect(e.kind).toBe("send");
    if (e.kind !== "send") return;
    expect(e.fields.amount).toBe("1.5");
    expect(e.fields.approval).toBe("1.5");
    expect(e.fields.recipientName).toBe("maria");
    expect(mismatches(e, r, ALICE, built.deadline)).toEqual([]);
    expect(mismatches(e, { ...r, amount: "2" }, ALICE, built.deadline)).toEqual(["amount"]);
  });
  it("skips the approval when the allowance already covers it", () => {
    expect(buildSendCalls(resolved(), toUnits("5"), config, NOW).calls).toHaveLength(1);
  });
  it("rejects an approval to anyone but the payments contract, or for more than the payment", () => {
    const r = resolved();
    const [, send] = buildSendCalls(r, 0n, config, NOW).calls;
    const toEvil = { to: n.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [EVIL, toUnits("1.5")] }) };
    expect(explainCalls([toEvil, send], ALICE, config).kind).toBe("unrecognized");
    const tooMuch = { to: n.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.payments, toUnits("100")] }) };
    expect(explainCalls([tooMuch, send], ALICE, config).kind).toBe("unrecognized");
  });
  it("rejects a plain USDC transfer and a call to another contract", () => {
    const transfer = { to: n.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [EVIL, 1n] }) };
    expect(explainCalls([transfer], ALICE, config).kind).toBe("unrecognized");
    const elsewhere = { ...buildClaimCall("1", "recipient", config), to: EVIL };
    expect(explainCalls([elsewhere], ALICE, config).kind).toBe("unrecognized");
  });
  it("explains claim and recover", () => {
    const c = explainCalls([buildClaimCall("7", "recipient", config)], MARIA, config);
    const r = explainCalls([buildClaimCall("7", "sender", config)], ALICE, config);
    expect(c.kind === "claim" && c.fields.role).toBe("recipient");
    expect(r.kind === "claim" && r.fields.role).toBe("sender");
  });
  it("rejects a send whose recipient is the signer", () => {
    const send = { to: n.payments, data: buildSendCalls(resolved(), toUnits("5"), config, NOW).calls[0].data };
    expect(explainCalls([send], MARIA, config).kind).toBe("unrecognized");
    expect(zeroHash).toBeTruthy();
  });
});

describe("agent mandate", () => {
  const p = personality("balanced")!;
  const m = mandateFrom(p, n, nowSec, 30);
  const allowance = allowanceFor(m, nowSec);

  it("builds approve + setMandate and decodes it back without mismatches", () => {
    const calls = setMandateCalls(m, allowance, 0n, n);
    expect(calls).toHaveLength(2);
    const e = explainAgentCalls(calls, ALICE, config);
    expect(e.kind).toBe("agent");
    expect(mandateMismatches(e, ALICE, m, allowance)).toEqual([]);
    expect(mandateMismatches(e, ALICE, { ...m, limit: m.limit + 1n }, allowance)).toEqual(["limit"]);
  });
  it("rejects a mandate allowing a vault Nilo doesn't use", () => {
    const bad = { ...m, vaults: [EVIL] };
    const data = encodeFunctionData({
      abi: agentAbi,
      functionName: "setMandate",
      args: [{ limit: bad.limit, period: BigInt(bad.period), expiresAt: BigInt(bad.expiresAt), reserve: bad.reserve, profile: bad.profile, vaults: bad.vaults }],
    });
    expect(explainAgentCalls([{ to: n.agent, data }], ALICE, config).kind).toBe("unrecognized");
  });
  it("revoke zeroes the allowance; withdraw only redeems to the user", () => {
    expect(explainAgentCalls(revokeCalls(n), ALICE, config).kind).toBe("agent");
    const vault = n.vaults[0].address;
    expect(explainAgentCalls(withdrawCalls(ALICE, [{ vault, shares: 10n }]), ALICE, config).kind).toBe("agent");
    const steal = { to: vault, data: encodeFunctionData({ abi: erc4626Abi, functionName: "redeem", args: [10n, EVIL, ALICE] }) };
    expect(explainAgentCalls([steal], ALICE, config).kind).toBe("unrecognized");
  });
  it("splits by the personality's weights and keeps the remainder in the first vault", () => {
    const legs = split(toUnits("10"), p, m.vaults, n);
    expect(legs.map((l) => l.amount)).toEqual([toUnits("6"), toUnits("4")]);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).toBe(toUnits("10"));
  });
});

describe("review fixes", () => {
  it("rejects bad chat rules before building any call", () => {
    const p = personality("guardian")!;
    expect(() => mandateFrom(p, n, nowSec, 1.5)).toThrow();
    expect(() => mandateFrom(p, n, nowSec, 0)).toThrow();
    expect(() => mandateFrom(p, n, nowSec, 30, 0)).toThrow();
    expect(() => mandateFrom(p, n, nowSec, 30, Number.NaN)).toThrow();
  });
  it("still invests a small amount whole instead of dropping it", () => {
    const p = personality("explorer")!;
    const m = mandateFrom(p, n, nowSec);
    const legs = split(toUnits("0.012"), p, m.vaults, n);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).toBe(toUnits("0.012"));
  });
  it("refuses a mixed-case address with a bad checksum", () => {
    const bad = "0x90053310b651E4a857854Ab7fC210B8aFdE23a78";
    expect(validateIntent({ amount: "0.1", asset: "USDC", recipient: bad, deadlineSeconds: 300 }, { address: ALICE, usdc: toUnits("1") }, config).ok).toBe(false);
    expect(validateIntent({ amount: "0.1", asset: "USDC", recipient: bad.toLowerCase(), deadlineSeconds: 300 }, { address: ALICE, usdc: toUnits("1") }, config).ok).toBe(true);
  });
});
