// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @dev ERC-1271 wallet whose signature is an opaque blob: valid iff keccak256(signature) == `blobHash`.
/// The blob is not an ECDSA signature (any length), so it exercises the ERC-1271 fallback path only.
contract MockOpaque1271Wallet is IERC1271 {
    bytes32 public immutable blobHash;

    constructor(bytes32 blobHash_) {
        blobHash = blobHash_;
    }

    function isValidSignature(bytes32, bytes memory signature) external view returns (bytes4) {
        if (keccak256(signature) == blobHash) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
