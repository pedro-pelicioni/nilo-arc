// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice USDC escrow claimable by the recipient before expiry or recoverable by its sender after.
contract NiloPayments is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Payment {
        address from;
        address to;
        uint128 amount;
        uint64 createdAt;
        uint64 claimUntil;
        uint8 status;
        bytes32 memo;
    }

    IERC20 public immutable usdc;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,uint256 deadline)");
    uint256 public nextId = 1;

    mapping(uint256 => Payment) private _payments;
    mapping(address => uint256[]) private _sentBy;
    mapping(address => uint256[]) private _receivedBy;

    error NotRecipient();
    error NotSender();
    error NotPending();
    error Expired();
    error NotExpired();
    error BadPayment();
    error BadSignature();
    error PermitFailed();

    event Sent(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint64 claimUntil,
        bytes32 memo
    );
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Recovered(uint256 indexed id, address indexed from, uint256 amount);

    constructor(IERC20 usdc_) EIP712("NiloPayments", "1") {
        if (address(usdc_) == address(0)) revert BadPayment();
        usdc = usdc_;
    }

    function send(address to, uint256 amount, uint64 claimUntil, bytes32 memo)
        external
        nonReentrant
        returns (uint256 id)
    {
        return _send(msg.sender, to, amount, claimUntil, memo);
    }

    /// @notice An already-used permit is accepted when the existing allowance is sufficient.
    function sendWithPermit(
        address to,
        uint256 amount,
        uint64 claimUntil,
        bytes32 memo,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 id) {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), amount, deadline, v, r, s) {
        } catch {
            if (usdc.allowance(msg.sender, address(this)) < amount) revert PermitFailed();
        }
        return _send(msg.sender, to, amount, claimUntil, memo);
    }

    function claim(uint256 id) external nonReentrant {
        Payment storage payment = _payment(id);
        if (msg.sender != payment.to) revert NotRecipient();
        _claim(id, payment);
    }

    /// @notice Anyone may relay a signature; funds are always sent to the recorded recipient.
    function claimFor(uint256 id, uint256 sigDeadline, bytes calldata signature) external nonReentrant {
        Payment storage payment = _payment(id);
        if (payment.status != 0) revert NotPending();
        if (block.timestamp >= payment.claimUntil) revert Expired();
        if (block.timestamp > sigDeadline) revert BadSignature();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, id, sigDeadline)));
        if (!_isValidClaimSignature(payment.to, digest, signature)) revert BadSignature();
        _claim(id, payment);
    }

    function recover(uint256 id) external nonReentrant {
        Payment storage payment = _payment(id);
        if (msg.sender != payment.from) revert NotSender();
        if (payment.status != 0) revert NotPending();
        if (block.timestamp < payment.claimUntil) revert NotExpired();
        payment.status = 2;
        usdc.safeTransfer(payment.from, payment.amount);
        emit Recovered(id, payment.from, payment.amount);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function payments(uint256 id) external view returns (Payment memory) {
        return _payment(id);
    }

    function sentBy(address sender) external view returns (uint256[] memory) {
        return _sentBy[sender];
    }

    function receivedBy(address recipient) external view returns (uint256[] memory) {
        return _receivedBy[recipient];
    }

    function getPayments(uint256[] calldata ids) external view returns (Payment[] memory result) {
        result = new Payment[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            result[i] = _payment(ids[i]);
        }
    }

    function _send(address from, address to, uint256 amount, uint64 claimUntil, bytes32 memo)
        private
        returns (uint256 id)
    {
        if (
            to == address(0) || to == from || amount == 0 || amount > type(uint128).max
                || claimUntil <= block.timestamp || uint256(claimUntil) > block.timestamp + 365 days
        ) revert BadPayment();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = usdc.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert BadPayment();

        id = nextId++;
        _payments[id] = Payment({
            from: from,
            to: to,
            amount: uint128(amount),
            createdAt: uint64(block.timestamp),
            claimUntil: claimUntil,
            status: 0,
            memo: memo
        });
        _sentBy[from].push(id);
        _receivedBy[to].push(id);
        emit Sent(id, from, to, amount, claimUntil, memo);
    }

    /// @dev A plain ECDSA signature by `signer` is accepted even when `signer` has code: an EIP-7702 delegated EOA
    /// carries 0xef0100... code yet its key still controls it. Otherwise fall back to ERC-1271 (smart wallets).
    function _isValidClaimSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
    }

    function _claim(uint256 id, Payment storage payment) private {
        if (payment.status != 0) revert NotPending();
        if (block.timestamp >= payment.claimUntil) revert Expired();
        payment.status = 1;
        usdc.safeTransfer(payment.to, payment.amount);
        emit Claimed(id, payment.to, payment.amount);
    }

    function _payment(uint256 id) private view returns (Payment storage payment) {
        payment = _payments[id];
        if (payment.from == address(0)) revert BadPayment();
    }
}
