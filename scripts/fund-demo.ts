// Sends N USDC (default 1) from Nilo's operator to each demo account, for gas and demo payments.
// Run with: npx tsx --env-file=.env scripts/fund-demo.ts [amount]
import { encodeFunctionData } from "viem";
import { erc20Abi, toUnits } from "@nilo/core";
import { config, demoWallet, fail, network, operator, send, usdc, usdcOf } from "./demo";

const amount = toUnits(process.argv[2] ?? "1");
if (amount <= 0n) fail("The amount must be greater than zero.");
const recipients = Object.entries(config.contacts);
const have = await usdcOf(operator.account.address);
if (have < amount * BigInt(recipients.length) + toUnits("0.05")) {
  fail(`The operator has ${usdc(have)}; it needs ${usdc(amount * BigInt(recipients.length))} plus gas. Fund ${operator.account.address} at ${network.faucetUrl}.`);
}

console.log(`Funding the demo accounts with ${usdc(amount)} each on ${network.name}:`);
for (const [name, address] of recipients) {
  // The keys in .env.demo must match the contacts the app shows.
  if (demoWallet(name as "alice" | "maria" | "bob").account.address.toLowerCase() !== address.toLowerCase()) {
    fail(`${name}'s key in .env.demo doesn't match the contact address ${address}.`);
  }
  await send(operator, { to: network.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, amount] }) }, `${name} ${address}`);
}
for (const [name, address] of recipients) console.log(`  ${name}: ${usdc(await usdcOf(address))}`);
