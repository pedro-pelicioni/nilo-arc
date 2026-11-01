// End-to-end check of Nilo's contracts on Arc Testnet, without a browser wallet:
// 1. alice sends 0.1 USDC to maria; maria claims it gaslessly (she signs, the operator relays claimFor).
// 2. alice sends 0.1 USDC to bob, nobody claims, and alice recovers it after the deadline.
// 3. alice signs a tiny mandate; the operator invests 0.2 USDC into the prime vault; alice redeems and revokes.
// Run with: npx tsx --env-file=.env scripts/smoke-testnet.ts
import { type Address, encodeFunctionData, parseEventLogs, zeroHash } from "viem";
import {
  CLAIM_TYPES,
  agentAbi,
  buildClaimCall,
  claimDomain,
  erc20Abi,
  erc4626Abi,
  investCall,
  mandateFrom,
  paymentsAbi,
  personality,
  revokeCalls,
  setMandateCalls,
  toUnits,
  withdrawCalls,
} from "@nilo/core";
import { client, config, demoWallet, fail, network, operator, requireContracts, send, sleep, usdc, usdcOf, type Wallet } from "./demo";

requireContracts();
const alice = demoWallet("alice");
const maria = demoWallet("maria");
const bob = config.contacts.bob;
const AMOUNT = toUnits("0.1");
const INVEST = toUnits("0.2");

console.log(`Network: ${network.name}. Payments ${network.payments}, agent ${network.agent}.`);
const [a0, m0, o0] = await Promise.all([usdcOf(alice.account.address), usdcOf(maria.account.address), usdcOf(operator.account.address)]);
console.log(`alice ${usdc(a0)}, maria ${usdc(m0)}, operator ${usdc(o0)}`);
if (a0 < toUnits("0.5")) fail(`alice needs at least 0.5 USDC. Run scripts/fund-demo.ts or use ${network.faucetUrl} for ${alice.account.address}.`);
if (o0 < toUnits("0.05")) fail(`The operator needs a little USDC for gas. Fund ${operator.account.address} at ${network.faucetUrl}.`);

const chainNow = async () => Number((await client.getBlock()).timestamp);

/** alice escrows AMOUNT for `to`, claimable for `seconds`. Returns the payment id and deadline. */
async function sendPayment(from: Wallet, to: Address, seconds: number, label: string) {
  const claimUntil = BigInt((await chainNow()) + seconds);
  await send(from, { to: network.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [network.payments, AMOUNT] }) }, `${label}: approve`);
  const receipt = await send(
    from,
    { to: network.payments, data: encodeFunctionData({ abi: paymentsAbi, functionName: "send", args: [to, AMOUNT, claimUntil, zeroHash] }) },
    `${label}: send`,
  );
  const [sent] = parseEventLogs({ abi: paymentsAbi, eventName: "Sent", logs: receipt.logs });
  if (!sent) fail(`${label}: no Sent event in the receipt.`);
  return { id: sent.args.id, claimUntil };
}

console.log("\n1. Send to maria, gasless claim");
const p1 = await sendPayment(alice, maria.account.address, 90, "alice → maria");
const sigDeadline = BigInt((await chainNow()) + 600);
const signature = await maria.signTypedData({
  domain: claimDomain(network.chainId, network.payments),
  types: CLAIM_TYPES,
  primaryType: "Claim",
  message: { id: p1.id, deadline: sigDeadline },
});
const mariaBefore = await usdcOf(maria.account.address);
await send(
  operator,
  { to: network.payments, data: encodeFunctionData({ abi: paymentsAbi, functionName: "claimFor", args: [p1.id, sigDeadline, signature] }) },
  `operator relays maria's claim of #${p1.id}`,
);
const mariaGot = (await usdcOf(maria.account.address)) - mariaBefore;
console.log(`  maria received ${usdc(mariaGot)} and paid no gas.`);
if (mariaGot !== AMOUNT) fail("  maria's balance didn't grow by the payment amount.");

console.log("\n2. Send to bob, recover after the deadline");
const p2 = await sendPayment(alice, bob, 60, "alice → bob");
process.stdout.write("  waiting for the deadline");
while ((await chainNow()) < Number(p2.claimUntil)) {
  process.stdout.write(".");
  await sleep(5_000);
}
console.log("");
await send(alice, buildClaimCall(p2.id.toString(), "sender", config), `alice recovers #${p2.id}`);

console.log("\n3. Mandate, invest, redeem, revoke");
const guardian = personality("guardian")!;
const mandate = { ...mandateFrom(guardian, network, await chainNow(), 30, 1), reserve: 0n };
const allowance = await client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "allowance", args: [alice.account.address, network.agent] });
for (const call of setMandateCalls(mandate, mandate.limit, allowance, network)) await send(alice, call, "alice signs the mandate");
const prime = mandate.vaults[0];
await send(operator, investCall(alice.account.address, prime, INVEST, network), `operator invests ${usdc(INVEST)} into the prime vault`);
const shares = await client.readContract({ address: prime, abi: erc4626Abi, functionName: "balanceOf", args: [alice.account.address] });
const worth = await client.readContract({ address: prime, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] });
console.log(`  alice holds ${shares} shares of ${prime}, worth ${usdc(worth)}.`);
const remaining = await client.readContract({ address: network.agent, abi: agentAbi, functionName: "remaining", args: [alice.account.address] });
console.log(`  ${usdc(remaining)} left to invest this week.`);
for (const call of withdrawCalls(alice.account.address, [{ vault: prime, shares }])) await send(alice, call, "alice redeems her shares");
for (const call of revokeCalls(network)) await send(alice, call, "alice revokes");

console.log(`\nDone. alice now has ${usdc(await usdcOf(alice.account.address))}.`);
