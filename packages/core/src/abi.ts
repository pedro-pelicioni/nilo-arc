// ABIs of the contracts Nilo calls. NiloPayments and NiloAgent are Nilo's own (contracts/);
// the vaults are standard ERC-4626 (Morpho) and USDC is Arc's ERC-20 interface.
import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);

export const paymentsAbi = parseAbi([
  "struct Payment { address from; address to; uint128 amount; uint64 createdAt; uint64 claimUntil; uint8 status; bytes32 memo; }",
  "function send(address to, uint256 amount, uint64 claimUntil, bytes32 memo) returns (uint256 id)",
  "function claim(uint256 id)",
  "function claimFor(uint256 id, uint256 sigDeadline, bytes signature)",
  "function recover(uint256 id)",
  "function payments(uint256 id) view returns (Payment)",
  "function sentBy(address) view returns (uint256[])",
  "function receivedBy(address) view returns (uint256[])",
  "function nextId() view returns (uint256)",
  "function getPayments(uint256[] ids) view returns (Payment[])",
  "event Sent(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint64 claimUntil, bytes32 memo)",
  "event Claimed(uint256 indexed id, address indexed to, uint256 amount)",
  "event Recovered(uint256 indexed id, address indexed from, uint256 amount)",
  "error NotRecipient()",
  "error NotSender()",
  "error NotPending()",
  "error Expired()",
  "error NotExpired()",
  "error BadPayment()",
  "error BadSignature()",
  "error PermitFailed()",
]);

export const agentAbi = parseAbi([
  "struct Mandate { uint128 limit; uint64 period; uint64 expiresAt; uint128 reserve; uint8 profile; address[] vaults; }",
  "function setMandate(Mandate m)",
  "function revoke()",
  "function invest(address user, address vault, uint256 amount)",
  "function mandateOf(address user) view returns (Mandate)",
  "function usageOf(address user) view returns (uint64 periodStart, uint128 spent)",
  "function remaining(address user) view returns (uint256)",
  "function operator() view returns (address)",
  "function usdc() view returns (address)",
  "event MandateSet(address indexed user, uint128 limit, uint64 period, uint64 expiresAt, uint128 reserve, uint8 profile, address[] vaults)",
  "event Revoked(address indexed user)",
  "event Invested(address indexed user, address indexed vault, uint256 amount, uint256 shares)",
  "error BadMandate()",
  "error NotOperator()",
  "error NoMandate()",
  "error Expired()",
  "error VaultNotAllowed()",
  "error OverLimit()",
  "error BelowReserve()",
  "error BadAmount()",
  "error ZeroShares()",
  "error SlippageExceeded()",
  "error FundsRetained()",
]);

/** EIP-712 claim a recipient signs so a relayer can submit `claimFor` and pay the gas. */
export const CLAIM_TYPES = {
  Claim: [
    { name: "id", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const claimDomain = (chainId: number, payments: `0x${string}`) =>
  ({ name: "NiloPayments", version: "1", chainId, verifyingContract: payments }) as const;
