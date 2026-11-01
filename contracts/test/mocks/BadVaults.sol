// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockVault} from "./MockVault.sol";

/// @dev asset() reports a different token than the one the agent is configured with.
contract MaliciousVault {
    address public asset;

    constructor(address asset_) {
        asset = asset_;
    }
}

/// @dev Has code, but asset() reverts.
contract RevertingAssetVault {
    function asset() external pure returns (address) {
        revert("no asset");
    }
}

/// @dev Has code but no asset() function at all (and no fallback) -> staticcall fails.
contract NoAssetVault {
    function foo() external pure returns (uint256) {
        return 1;
    }
}

/// @dev asset() returns a value that is not a valid address encoding (dirty upper bits).
contract DirtyAssetVault {
    function asset() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @dev Donation/inflation-like behaviour: shares are minted but are redeemable for only half the
/// deposited value, so the agent's share-price sanity check must trip.
contract InflatedVault is MockVault {
    constructor(IERC20 asset_) MockVault(asset_) {}

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return super.convertToAssets(shares) / 2;
    }
}

/// @dev Pulls the assets but mints nothing and returns 0 shares.
contract ZeroSharesVault is MockVault {
    constructor(IERC20 asset_) MockVault(asset_) {}

    function deposit(uint256 assets, address) public override returns (uint256) {
        IERC20(asset()).transferFrom(msg.sender, address(this), assets);
        return 0;
    }
}

/// @dev Mints shares without pulling assets, so the agent would be left holding the USDC.
contract FreeSharesVault is MockVault {
    constructor(IERC20 asset_) MockVault(asset_) {}

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        _mint(receiver, assets);
        return assets;
    }

    function convertToAssets(uint256 shares) public pure override returns (uint256) {
        return shares;
    }
}
