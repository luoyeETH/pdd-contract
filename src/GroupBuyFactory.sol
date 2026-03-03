// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20, IERC20Metadata} from "./interfaces/IERC20.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";
import {DynamicCostSharingRound} from "./DynamicCostSharingRound.sol";

contract GroupBuyFactory {
    using SafeERC20Lite for IERC20;

    struct CreateRoundParams {
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
    error InvalidAddress();
    error InvalidConfig();
    error InvalidSeedData();
    error DuplicateSeedUser(address user);
    error SeedSumMismatch(uint256 expected, uint256 actual);
    error InvalidSeedDistribution(uint256 minExpected, uint256 maxExpected, uint256 actual);
    error UnexpectedTokenDecimals(uint8 expected, uint8 actual);

    event RoundCreated(
        address indexed round,
        address indexed admin,
        address indexed merchant,
        uint256 totalCost,
        uint256 seedCount,
        uint256 deadline
    );

    IERC20 public immutable token;
    address public immutable factoryAdmin;

    constructor(address tokenAddress, address adminAddress, uint8 expectedDecimals) {
        if (tokenAddress == address(0) || adminAddress == address(0)) {
            revert InvalidAddress();
        }

        uint8 actualDecimals = IERC20Metadata(tokenAddress).decimals();
        if (actualDecimals != expectedDecimals) {
            revert UnexpectedTokenDecimals(expectedDecimals, actualDecimals);
        }

        token = IERC20(tokenAddress);
        factoryAdmin = adminAddress;
    }

    function createRoundWithSeed(
        CreateRoundParams calldata params,
        address[] calldata seedUsers,
        uint256[] calldata seedAmounts
    ) external returns (address roundAddress) {
        if (msg.sender != factoryAdmin) {
            revert Unauthorized();
        }

        _validateCreateParams(params, seedUsers, seedAmounts);

        DynamicCostSharingRound.Config memory cfg = DynamicCostSharingRound.Config({
            token: address(token),
            admin: params.admin,
            merchant: params.merchant,
            totalCost: params.totalCost,
            deadline: params.deadline,
            minParticipants: params.minParticipants,
            targetParticipants: params.targetParticipants,
            maxParticipants: params.maxParticipants,
            maxBatchSize: params.maxBatchSize
        });

        DynamicCostSharingRound round = new DynamicCostSharingRound(cfg);
        roundAddress = address(round);

        uint256 len = seedUsers.length;
        uint256 runningTotal;

        for (uint256 i = 0; i < len; ++i) {
            token.safeTransferFromExact(seedUsers[i], roundAddress, seedAmounts[i]);
            runningTotal += seedAmounts[i];
        }

        if (len != 0 && runningTotal != params.totalCost) {
            revert SeedSumMismatch(params.totalCost, runningTotal);
        }

        round.initializeSeeds(seedUsers, seedAmounts, runningTotal);

        emit RoundCreated(roundAddress, params.admin, params.merchant, params.totalCost, len, params.deadline);
    }

    function _validateCreateParams(
        CreateRoundParams calldata params,
        address[] calldata seedUsers,
        uint256[] calldata seedAmounts
    ) internal view {
        if (params.admin == address(0) || params.merchant == address(0)) {
            revert InvalidAddress();
        }
        if (params.totalCost == 0 || params.deadline <= block.timestamp) {
            revert InvalidConfig();
        }
        if (params.minParticipants == 0 || params.maxBatchSize == 0) {
            revert InvalidConfig();
        }
        if (params.targetParticipants != 0 && params.targetParticipants < params.minParticipants) {
            revert InvalidConfig();
        }
        if (params.maxParticipants != 0 && params.maxParticipants < params.minParticipants) {
            revert InvalidConfig();
        }

        uint256 len = seedUsers.length;
        if (len != seedAmounts.length) {
            revert InvalidSeedData();
        }
        if (params.maxParticipants != 0 && len > params.maxParticipants) {
            revert InvalidConfig();
        }

        if (len == 0) {
            return;
        }

        uint256 runningTotal;
        uint256 minSeedAmount = params.totalCost / len;
        uint256 maxSeedAmount = minSeedAmount + (params.totalCost % len == 0 ? 0 : 1);
        for (uint256 i = 0; i < len; ++i) {
            address user = seedUsers[i];
            uint256 amount = seedAmounts[i];

            if (user == address(0) || amount == 0) {
                revert InvalidSeedData();
            }
            if (amount < minSeedAmount || amount > maxSeedAmount) {
                revert InvalidSeedDistribution(minSeedAmount, maxSeedAmount, amount);
            }

            for (uint256 j = 0; j < i; ++j) {
                if (seedUsers[j] == user) {
                    revert DuplicateSeedUser(user);
                }
            }

            runningTotal += amount;
        }

        if (runningTotal != params.totalCost) {
            revert SeedSumMismatch(params.totalCost, runningTotal);
        }
    }
}
