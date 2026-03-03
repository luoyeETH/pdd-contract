// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

contract DynamicCostSharingRound is ReentrancyGuard {
    using SafeERC20Lite for IERC20;

    enum RoundState {
        UNINITIALIZED,
        OPEN,
        SUCCESS_FINALIZED,
        FAILED_FINALIZED
    }

    struct Config {
        address token;
        address admin;
        address merchant;
        uint256 totalCost;
        uint256 deadline;
        uint256 minParticipants;
        uint256 targetParticipants;
        uint256 maxParticipants;
        uint256 maxBatchSize;
    }

    error Unauthorized();
    error EOAOnly();
    error InvalidAddress();
    error InvalidConfig();
    error InvalidState();
    error DeadlineNotReached();
    error JoinClosed();
    error AlreadyJoined();
    error NotParticipant();
    error NoParticipants();
    error NothingToClaim();
    error EmptyBatch();
    error BatchTooLarge();
    error MaxParticipantsReached();
    error UnexpectedCount(uint256 expected, uint256 actual);
    error QuoteExceedsMax(uint256 quote, uint256 maxQuote);
    error CannotFinalizeSuccess();
    error CannotFinalizeFailed();
    error SeedSumMismatch(uint256 expected, uint256 actual);
    error InvalidSeedDistribution(uint256 minExpected, uint256 maxExpected, uint256 actual);
    error InsufficientLiquidityForMerchant(uint256 available, uint256 requiredAmount);

    event SeedsInitialized(uint256 indexed participantCount, uint256 totalSeeded);
    event Joined(address indexed user, uint256 amount, uint256 newCount);
    event RefundClaimed(address indexed user, uint256 amount);
    event BatchRefundProcessed(uint256 indexed processedCount, uint256 totalAmount);
    event SuccessFinalized(uint256 indexed finalCount, uint256 finalUnitCost);
    event FailedFinalized(uint256 indexed countAtFailure);
    event MerchantWithdrawn(address indexed merchant, uint256 amount);

    IERC20 public immutable token;
    address public immutable factory;

    address public immutable admin;
    address public immutable merchant;

    uint256 public immutable totalCost;
    uint256 public immutable deadline;
    uint256 public immutable minParticipants;
    uint256 public immutable targetParticipants;
    uint256 public immutable maxParticipants;
    uint256 public immutable maxBatchSize;

    RoundState public state;

    uint256 public participantCount;
    uint256 public finalParticipantCount;

    uint256 public totalContributed;
    uint256 public totalRefundClaimed;
    uint256 public merchantWithdrawn;

    mapping(address => uint256) public paid;
    mapping(address => uint256) public claimed;
    mapping(address => bool) public hasJoined;

    modifier onlyFactory() {
        if (msg.sender != factory) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyMerchant() {
        if (msg.sender != merchant) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyEOA() {
        if (msg.sender != tx.origin) {
            revert EOAOnly();
        }
        _;
    }

    constructor(Config memory cfg) {
        if (cfg.token == address(0) || cfg.admin == address(0) || cfg.merchant == address(0)) {
            revert InvalidAddress();
        }
        if (cfg.totalCost == 0 || cfg.deadline <= block.timestamp || cfg.minParticipants == 0 || cfg.maxBatchSize == 0) {
            revert InvalidConfig();
        }
        if (cfg.targetParticipants != 0 && cfg.targetParticipants < cfg.minParticipants) {
            revert InvalidConfig();
        }
        if (cfg.maxParticipants != 0 && cfg.maxParticipants < cfg.minParticipants) {
            revert InvalidConfig();
        }

        token = IERC20(cfg.token);
        factory = msg.sender;
        admin = cfg.admin;
        merchant = cfg.merchant;
        totalCost = cfg.totalCost;
        deadline = cfg.deadline;
        minParticipants = cfg.minParticipants;
        targetParticipants = cfg.targetParticipants;
        maxParticipants = cfg.maxParticipants;
        maxBatchSize = cfg.maxBatchSize;
        state = RoundState.UNINITIALIZED;
    }

    function initializeSeeds(address[] calldata users, uint256[] calldata amounts, uint256 totalSeeded)
        external
        onlyFactory
    {
        if (state != RoundState.UNINITIALIZED) {
            revert InvalidState();
        }

        uint256 len = users.length;
        if (len != amounts.length) {
            revert InvalidConfig();
        }
        if (maxParticipants != 0 && len > maxParticipants) {
            revert MaxParticipantsReached();
        }

        if (len == 0) {
            if (totalSeeded != 0) {
                revert SeedSumMismatch(0, totalSeeded);
            }

            participantCount = 0;
            totalContributed = 0;
            state = RoundState.OPEN;

            emit SeedsInitialized(0, 0);
            return;
        }

        uint256 runningTotal;
        uint256 minSeedAmount = totalCost / len;
        uint256 maxSeedAmount = minSeedAmount + (totalCost % len == 0 ? 0 : 1);
        for (uint256 i = 0; i < len; ++i) {
            address user = users[i];
            uint256 amount = amounts[i];
            if (user == address(0)) {
                revert InvalidAddress();
            }
            if (amount == 0) {
                revert InvalidConfig();
            }
            if (amount < minSeedAmount || amount > maxSeedAmount) {
                revert InvalidSeedDistribution(minSeedAmount, maxSeedAmount, amount);
            }
            if (hasJoined[user]) {
                revert AlreadyJoined();
            }

            hasJoined[user] = true;
            paid[user] = amount;
            runningTotal += amount;
        }

        if (runningTotal != totalCost || totalSeeded != totalCost) {
            revert SeedSumMismatch(totalCost, runningTotal);
        }

        participantCount = len;
        totalContributed = totalSeeded;
        state = RoundState.OPEN;

        emit SeedsInitialized(len, totalSeeded);
    }

    function join(uint256 expectedCount, uint256 maxQuote) external onlyEOA nonReentrant {
        if (state != RoundState.OPEN) {
            revert InvalidState();
        }
        if (block.timestamp >= deadline) {
            revert JoinClosed();
        }
        if (hasJoined[msg.sender]) {
            revert AlreadyJoined();
        }
        if (expectedCount != participantCount) {
            revert UnexpectedCount(expectedCount, participantCount);
        }

        uint256 nextCount = participantCount + 1;
        if (maxParticipants != 0 && nextCount > maxParticipants) {
            revert MaxParticipantsReached();
        }

        uint256 quote = _ceilDiv(totalCost, nextCount);
        if (quote > maxQuote) {
            revert QuoteExceedsMax(quote, maxQuote);
        }

        token.safeTransferFromExact(msg.sender, address(this), quote);

        hasJoined[msg.sender] = true;
        paid[msg.sender] = quote;
        participantCount = nextCount;
        totalContributed += quote;

        emit Joined(msg.sender, quote, nextCount);
    }

    function finalizeSuccess() external onlyEOA nonReentrant {
        if (state != RoundState.OPEN) {
            revert InvalidState();
        }

        uint256 count = participantCount;
        if (count == 0) {
            revert NoParticipants();
        }

        bool hitTarget = targetParticipants != 0 && count >= targetParticipants;
        bool metDeadlineAndMin = block.timestamp >= deadline && count >= minParticipants;
        if (!hitTarget && !metDeadlineAndMin) {
            revert CannotFinalizeSuccess();
        }

        state = RoundState.SUCCESS_FINALIZED;
        finalParticipantCount = count;

        emit SuccessFinalized(count, _unitCost(count));
    }

    function finalizeFailed() external onlyEOA onlyAdmin nonReentrant {
        if (state != RoundState.OPEN) {
            revert InvalidState();
        }
        if (block.timestamp < deadline) {
            revert DeadlineNotReached();
        }
        if (participantCount >= minParticipants) {
            revert CannotFinalizeFailed();
        }

        state = RoundState.FAILED_FINALIZED;
        emit FailedFinalized(participantCount);
    }

    function claimRefund() external onlyEOA nonReentrant {
        if (state == RoundState.UNINITIALIZED) {
            revert InvalidState();
        }
        if (!hasJoined[msg.sender]) {
            revert NotParticipant();
        }

        uint256 amount = _refundable(msg.sender);
        if (amount == 0) {
            revert NothingToClaim();
        }

        claimed[msg.sender] += amount;
        totalRefundClaimed += amount;

        token.safeTransfer(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    function batchRefundSurplus(address[] calldata users, uint256 maxUsers)
        external
        onlyEOA
        onlyAdmin
        nonReentrant
    {
        if (state != RoundState.SUCCESS_FINALIZED) {
            revert InvalidState();
        }

        uint256 len = users.length;
        if (len == 0) {
            revert EmptyBatch();
        }
        if (len > maxUsers || len > maxBatchSize) {
            revert BatchTooLarge();
        }

        uint256 unitCost = _unitCost(finalParticipantCount);
        uint256 processed;
        uint256 totalAmount;

        for (uint256 i = 0; i < len; ++i) {
            address user = users[i];
            if (!hasJoined[user]) {
                continue;
            }

            uint256 amount = _refundableWithUnit(user, unitCost);
            if (amount == 0) {
                continue;
            }

            claimed[user] += amount;
            totalRefundClaimed += amount;
            totalAmount += amount;
            processed += 1;

            token.safeTransfer(user, amount);
            emit RefundClaimed(user, amount);
        }

        emit BatchRefundProcessed(processed, totalAmount);
    }

    function withdrawMerchant() external onlyEOA onlyMerchant nonReentrant {
        if (state != RoundState.SUCCESS_FINALIZED) {
            revert InvalidState();
        }

        uint256 entitlement = totalCost - merchantWithdrawn;
        if (entitlement == 0) {
            revert NothingToClaim();
        }

        uint256 outstandingRefunds = viewOutstandingSurplusRefunds();
        uint256 balance = token.balanceOf(address(this));
        uint256 requiredAmount = outstandingRefunds + entitlement;
        if (balance < requiredAmount) {
            revert InsufficientLiquidityForMerchant(balance, requiredAmount);
        }

        merchantWithdrawn += entitlement;
        token.safeTransfer(merchant, entitlement);

        emit MerchantWithdrawn(merchant, entitlement);
    }

    function viewJoinQuote() external view returns (uint256) {
        if (state != RoundState.OPEN || block.timestamp >= deadline) {
            return 0;
        }

        uint256 nextCount = participantCount + 1;
        if (maxParticipants != 0 && nextCount > maxParticipants) {
            return 0;
        }

        return _ceilDiv(totalCost, nextCount);
    }

    function viewUnitCost() external view returns (uint256) {
        if (state == RoundState.UNINITIALIZED || participantCount == 0 || state == RoundState.FAILED_FINALIZED) {
            return 0;
        }

        uint256 count = state == RoundState.SUCCESS_FINALIZED ? finalParticipantCount : participantCount;
        return _unitCost(count);
    }

    function viewRefundable(address user) external view returns (uint256) {
        if (!hasJoined[user]) {
            return 0;
        }
        return _refundable(user);
    }

    function viewOutstandingSurplusRefunds() public view returns (uint256) {
        if (state == RoundState.UNINITIALIZED || state == RoundState.FAILED_FINALIZED || participantCount == 0) {
            return 0;
        }

        uint256 count = state == RoundState.SUCCESS_FINALIZED ? finalParticipantCount : participantCount;
        uint256 unitCost = _unitCost(count);
        uint256 aggregateFinalCost = unitCost * count;

        if (totalContributed <= aggregateFinalCost) {
            return 0;
        }

        uint256 grossRefundable = totalContributed - aggregateFinalCost;
        if (grossRefundable <= totalRefundClaimed) {
            return 0;
        }

        return grossRefundable - totalRefundClaimed;
    }

    function _refundable(address user) internal view returns (uint256) {
        uint256 alreadyClaimed = claimed[user];
        uint256 userPaid = paid[user];

        if (state == RoundState.FAILED_FINALIZED) {
            if (userPaid <= alreadyClaimed) {
                return 0;
            }
            return userPaid - alreadyClaimed;
        }

        uint256 count = state == RoundState.SUCCESS_FINALIZED ? finalParticipantCount : participantCount;
        if (count == 0) {
            return 0;
        }

        uint256 unitCost = _unitCost(count);
        return _refundableWithUnit(user, unitCost);
    }

    function _refundableWithUnit(address user, uint256 unitCost) internal view returns (uint256) {
        uint256 userPaid = paid[user];
        if (userPaid <= unitCost) {
            return 0;
        }

        uint256 gross = userPaid - unitCost;
        uint256 alreadyClaimed = claimed[user];
        if (gross <= alreadyClaimed) {
            return 0;
        }

        return gross - alreadyClaimed;
    }

    function _unitCost(uint256 count) internal view returns (uint256) {
        return _ceilDiv(totalCost, count);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }
}
