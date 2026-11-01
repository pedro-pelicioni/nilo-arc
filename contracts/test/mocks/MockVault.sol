// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @dev Plain OZ ERC4626 over an arbitrary asset (MockUSDC in tests).
contract MockVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Mock Vault", "mVLT") ERC4626(asset_) {}
}
