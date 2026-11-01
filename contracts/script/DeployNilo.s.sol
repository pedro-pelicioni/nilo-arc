// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NiloAgent} from "../NiloAgent.sol";
import {NiloPayments} from "../NiloPayments.sol";

/// @notice Deploys NiloAgent and NiloPayments to Arc Testnet (5042002) or Arc Mainnet (5042).
///
/// Env vars:
///   OPERATOR  - address of Nilo's operator (bot) key
///   OWNER     - address allowed to rotate the operator
///   USDC      - optional; defaults to Arc's USDC ERC-20 interface (0x3600...0000, 6 decimals)
///
/// Arc Testnet:
///   forge script contracts/script/DeployNilo.s.sol:DeployNilo \
///     --rpc-url <arc testnet rpc from src/onchain-facts.ts> --private-key $PRIVATE_KEY --broadcast
/// Arc Mainnet: same command with the mainnet RPC (https://rpc.mainnet.arc.io) and the same
/// constructor args. Review everything independently before broadcasting to mainnet.
contract DeployNilo is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC_TESTNET = 5042002;
    uint256 internal constant ARC_MAINNET = 5042;

    function run() external returns (NiloAgent agent, NiloPayments payments) {
        require(block.chainid == ARC_TESTNET || block.chainid == ARC_MAINNET, "DeployNilo: not an Arc chain");

        address operator = vm.envAddress("OPERATOR");
        address owner = vm.envAddress("OWNER");
        address usdc = vm.envOr("USDC", ARC_USDC);

        vm.startBroadcast();
        agent = new NiloAgent(IERC20(usdc), operator, owner);
        payments = new NiloPayments(IERC20(usdc));
        vm.stopBroadcast();

        console.log("chainid", block.chainid);
        console.log("NiloAgent", address(agent));
        console.log("NiloPayments", address(payments));
    }
}
