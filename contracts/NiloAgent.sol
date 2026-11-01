// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice User-authorized, capped USDC investments with shares delivered to the user.
contract NiloAgent is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Mandate {
        uint128 limit;
        uint64 period;
        uint64 expiresAt;
        uint128 reserve;
        uint8 profile;
        address[] vaults;
    }

    struct Usage {
        uint64 periodStart;
        uint128 spent;
    }

    uint256 private constant BPS = 10_000;
    /// @notice Max tolerated gap (1%) between USDC invested and the redeemable value of the minted shares.
    uint256 public constant MAX_SLIPPAGE_BPS = 100;

    IERC20 public immutable usdc;
    address public operator;
    mapping(address => Mandate) private _mandates;
    mapping(address => Usage) private _usage;

    error BadAddress();
    error BadMandate();
    error PermitFailed();
    error NotOperator();
    error OwnershipChangeDisabled();
    error NoMandate();
    error Expired();
    error VaultNotAllowed();
    error OverLimit();
    error BelowReserve();
    error BadAmount();
    error ZeroShares();
    error SlippageExceeded();
    error FundsRetained();

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event MandateSet(
        address indexed user,
        uint128 limit,
        uint64 period,
        uint64 expiresAt,
        uint128 reserve,
        uint8 profile,
        address[] vaults
    );
    event Revoked(address indexed user);
    event Invested(address indexed user, address indexed vault, uint256 amount, uint256 shares);

    constructor(IERC20 usdc_, address operator_, address owner_) Ownable(owner_) {
        if (address(usdc_) == address(0) || operator_ == address(0)) revert BadAddress();
        usdc = usdc_;
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert BadAddress();
        address previousOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(previousOperator, newOperator);
    }

    /// @dev The owner's only administrative capability is operator rotation. Renouncing is disabled so
    /// the operator can always be rotated; ownership may still be transferred (e.g. key rotation).
    function renounceOwnership() public override onlyOwner {
        revert OwnershipChangeDisabled();
    }

    function setMandate(Mandate calldata m) external nonReentrant {
        _setMandate(msg.sender, m);
    }

    /// @notice A previously submitted permit is accepted if its allowance remains sufficient.
    function setMandateWithPermit(
        Mandate calldata m,
        uint256 allowance,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), allowance, deadline, v, r, s) {
        } catch {
            if (usdc.allowance(msg.sender, address(this)) < allowance) revert PermitFailed();
        }
        _setMandate(msg.sender, m);
    }

    function revoke() external nonReentrant {
        delete _mandates[msg.sender];
        delete _usage[msg.sender];
        emit Revoked(msg.sender);
    }

    function invest(address user, address vault, uint256 amount) external onlyOperator nonReentrant {
        Mandate storage m = _mandates[user];
        if (m.limit == 0) revert NoMandate();
        if (block.timestamp >= m.expiresAt) revert Expired();
        if (amount == 0) revert BadAmount();

        bool allowed;
        for (uint256 i; i < m.vaults.length; ++i) {
            if (m.vaults[i] == vault) {
                allowed = true;
                break;
            }
        }
        if (!allowed) revert VaultNotAllowed();

        Usage storage u = _usage[user];
        if (block.timestamp >= uint256(u.periodStart) + m.period) {
            u.periodStart = uint64(block.timestamp);
            u.spent = 0;
        }
        if (amount > uint256(m.limit) - u.spent) revert OverLimit();
        uint256 userBalance = usdc.balanceOf(user);
        if (userBalance < amount || userBalance - amount < m.reserve) revert BelowReserve();
        u.spent += uint128(amount);

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(user, address(this), amount);
        usdc.forceApprove(vault, amount);
        uint256 shares = IERC4626(vault).deposit(amount, user);
        if (shares == 0) revert ZeroShares();
        // Share-price sanity: minted shares must be worth at least (100% - MAX_SLIPPAGE_BPS) of the
        // amount invested, which defeats donation/inflation-style rounding attacks on weak vaults.
        if (IERC4626(vault).convertToAssets(shares) * BPS < amount * (BPS - MAX_SLIPPAGE_BPS)) {
            revert SlippageExceeded();
        }
        usdc.forceApprove(vault, 0);
        if (usdc.balanceOf(address(this)) != balanceBefore) revert FundsRetained();
        emit Invested(user, vault, amount, shares);
    }

    function mandateOf(address user) external view returns (Mandate memory) {
        return _mandates[user];
    }

    function usageOf(address user) external view returns (uint64 periodStart, uint128 spent) {
        Usage storage u = _usage[user];
        return (u.periodStart, u.spent);
    }

    /// @notice Remaining cap, independent of the user's balance and token allowance.
    function remaining(address user) external view returns (uint256) {
        Mandate storage m = _mandates[user];
        if (m.limit == 0 || block.timestamp >= m.expiresAt) return 0;
        Usage storage u = _usage[user];
        if (block.timestamp >= uint256(u.periodStart) + m.period) return m.limit;
        return uint256(m.limit) - u.spent;
    }

    function _setMandate(address user, Mandate calldata m) private {
        if (
            m.limit == 0 || m.period < 60 || m.expiresAt <= block.timestamp || m.profile > 2
                || m.vaults.length == 0 || m.vaults.length > 4
        ) revert BadMandate();

        for (uint256 i; i < m.vaults.length; ++i) {
            address vault = m.vaults[i];
            if (vault == address(0) || vault.code.length == 0) revert BadMandate();
            for (uint256 j; j < i; ++j) {
                if (m.vaults[j] == vault) revert BadMandate();
            }
            (bool success, bytes memory result) = vault.staticcall(abi.encodeCall(IERC4626.asset, ()));
            // Decode as an integer so malformed address encodings also produce BadMandate.
            if (!success || result.length < 32) revert BadMandate();
            if (abi.decode(result, (uint256)) != uint256(uint160(address(usdc)))) revert BadMandate();
        }

        _mandates[user] = m;
        _usage[user] = Usage({periodStart: uint64(block.timestamp), spent: 0});
        emit MandateSet(user, m.limit, m.period, m.expiresAt, m.reserve, m.profile, m.vaults);
    }
}
