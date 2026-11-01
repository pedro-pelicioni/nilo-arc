// The same flows as smoke-testnet.ts, but through Nilo's server the way the web app calls it:
// 1. alice sends 0.1 USDC to bob (built with buildSendCalls); bob, with an empty wallet, signs and POSTs
//    /api/sponsor-claim. Relaying the same claim again is refused.
// 2. alice sends 0.1 USDC to maria, who has USDC: the relayer refuses her, and she claims paying her own gas.
// 3. alice signs a 1 USDC/week Balanced mandate; POST /api/agent/activate invests across both vaults;
//    GET /api/agent/status shows the positions; alice redeems and revokes.
// Needs the server running (npm run dev). Run with: npx tsx --env-file=.env scripts/smoke-server.ts
import { type Address, parseEventLogs } from "viem";
import {
  CLAIM_TYPES,
  allowanceFor,
  buildClaimCall,
  buildSendCalls,
  claimDomain,
  erc20Abi,
  erc4626Abi,
  mandateFrom,
  paymentsAbi,
  personality,
  revokeCalls,
  setMandateCalls,
  toUnits,
  validateIntent,
  withdrawCalls,
} from "@nilo/core";
import { type Wallet, client, config, demoWallet, fail, network, requireContracts, send, usdc, usdcOf } from "./demo";

const API = process.env.NILO_API ?? "http://localhost:8787/api";
requireContracts();
const alice = demoWallet("alice");
const maria = demoWallet("maria");
const bob = demoWallet("bob");
const me = alice.account.address;

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  if (body === undefined) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) fail(`${path}: ${res.status}`);
    return (await res.json()) as T;
  }
  const r = await post(path, body);
  if (!r.ok) fail(`${path}: ${r.status} ${r.json.message ?? ""}`);
  return r.json as T;
}

/** alice pays 0.1 USDC to a contact, with the calls the chat builds. Returns the payment id. */
async function pay(name: "maria" | "bob"): Promise<bigint> {
  const intent = validateIntent({ amount: "0.1", asset: "USDC", recipient: name, deadlineSeconds: 600 }, { address: me, usdc: await usdcOf(me) }, config);
  if (!intent.ok) fail(intent.reason);
  const allowance = await client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "allowance", args: [me, network.payments] });
  let receipt;
  for (const call of buildSendCalls(intent.intent, allowance, config).calls) receipt = await send(alice, call, `alice → ${name}`);
  const [sent] = parseEventLogs({ abi: paymentsAbi, eventName: "Sent", logs: receipt!.logs });
  if (!sent) fail("No Sent event in the receipt.");
  return sent.args.id;
}

/** What the Claim page sends to the relayer for `w`. */
async function claimRequest(w: Wallet, id: bigint) {
  const sigDeadline = Math.floor(Date.now() / 1000) + 600;
  const signature = await w.signTypedData({
    domain: claimDomain(network.chainId, network.payments),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: { id, deadline: BigInt(sigDeadline) },
  });
  return { id: id.toString(), sigDeadline, signature, claimant: w.account.address as Address };
}

console.log(`Server ${API}, ${network.name}.`);

console.log("\n1. Send to bob (empty wallet), gasless claim through /api/sponsor-claim");
const bobBefore = await usdcOf(bob.account.address);
if (bobBefore >= toUnits("0.05")) fail(`bob already has ${usdc(bobBefore)}, so the relayer would refuse him.`);
const p1 = await pay("bob");
const req1 = await claimRequest(bob, p1);
const claim = await api<{ link: string }>("/sponsor-claim", req1);
console.log(`  relayer claimed #${p1}: ${claim.link}`);
const bobGot = (await usdcOf(bob.account.address)) - bobBefore;
console.log(`  bob received ${usdc(bobGot)} and paid no gas.`);
if (bobGot !== toUnits("0.1")) fail("  bob's balance didn't grow by the payment amount.");
const again = await post("/sponsor-claim", req1);
console.log(`  relaying it again is refused: ${again.status} ${again.json.message}`);
if (again.ok) fail("  the relayer accepted the same claim twice.");

console.log("\n2. Send to maria (has USDC), she claims paying her own gas");
const p2 = await pay("maria");
const refused = await post("/sponsor-claim", await claimRequest(maria, p2));
console.log(`  relayer: ${refused.status} ${refused.json.message}`);
if (refused.ok) fail("  the relayer paid gas for a wallet that has USDC.");
await send(maria, buildClaimCall(p2.toString(), "recipient", config), `maria claims #${p2}`);

console.log("\n3. Balanced mandate, /api/agent/activate, redeem, revoke");
const balanced = personality("balanced")!;
const now = Number((await client.getBlock()).timestamp);
const mandate = mandateFrom(balanced, network, now, 30, 1);
const want = allowanceFor(mandate, now);
const current = await client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "allowance", args: [me, network.agent] });
for (const call of setMandateCalls(mandate, want, current, network)) await send(alice, call, "alice signs the mandate");
const { activity } = await api<{ activity: { kind: string; note: string; link?: string }[] }>("/agent/activate", { address: me });
for (const a of activity) console.log(`  ${a.kind}: ${a.note}${a.link ? ` ${a.link}` : ""}`);
if (!activity.some((a) => a.kind === "invest") || activity.some((a) => a.kind === "error")) fail("  the agent didn't invest cleanly.");
type Status = { remaining: number; invested: number; positions: { vault: `0x${string}`; name: string; shares: string; assets: number }[] };
const status = await api<Status>(`/agent/status/${me}`);
for (const p of status.positions) console.log(`  ${p.name}: ${p.assets} USDC (${p.shares} shares)`);
console.log(`  invested ${status.invested} USDC, ${status.remaining} USDC left this week.`);
const skip = await api<{ activity: { kind: string; note: string }[] }>("/agent/run", { address: me });
console.log(`  a second run: ${skip.activity.map((a) => `${a.kind}: ${a.note}`).join(" ")}`);
const positions = await Promise.all(
  network.vaults.map(async (v) => ({ vault: v.address, shares: await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "balanceOf", args: [me] }) })),
);
for (const call of withdrawCalls(me, positions)) await send(alice, call, "alice redeems");
for (const call of revokeCalls(network)) await send(alice, call, "alice revokes");

console.log(`\nDone. alice now has ${usdc(await usdcOf(me))}.`);
