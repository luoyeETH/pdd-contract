// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeERC20Lite} from "../src/libraries/SafeERC20Lite.sol";
import {DynamicCostSharingRound} from "../src/DynamicCostSharingRound.sol";
import {GroupBuyFactory} from "../src/GroupBuyFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {FeeOnTransferMockERC20} from "../src/mocks/FeeOnTransferMockERC20.sol";

interface Vm {
    function prank(address msgSender) external;
    function prank(address msgSender, address txOrigin) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes calldata revertData) external;
}

contract RoundCaller {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function joinRound(address round, uint256 expectedCount, uint256 maxQuote) external {
        DynamicCostSharingRound(round).join(expectedCount, maxQuote);
    }
}

contract DynamicCostSharingTest {
    error AssertionFailed();

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant TOTAL_COST = 100 ether;
    uint256 internal constant SEED_ALICE = 33333333333333333334;
    uint256 internal constant SEED_BOB = 33333333333333333333;
    uint256 internal constant SEED_CAROL = 33333333333333333333;

    address internal constant ADMIN = address(0xA11CE);
    address internal constant MERCHANT = address(0xBEEF);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant CAROL = address(0x1003);
    address internal constant DAVE = address(0x1004);

    MockERC20 internal token;
    GroupBuyFactory internal factory;

    function setUp() public {
        token = new MockERC20("Mock USDT", "USDT", 18);
        factory = new GroupBuyFactory(address(token), ADMIN, 18);

        token.mint(ALICE, 1_000 ether);
        token.mint(BOB, 1_000 ether);
        token.mint(CAROL, 1_000 ether);
        token.mint(DAVE, 1_000 ether);

        _approve(ALICE, address(factory), type(uint256).max);
        _approve(BOB, address(factory), type(uint256).max);
        _approve(CAROL, address(factory), type(uint256).max);
    }

    function testCreateWithSeedAndQuote() public {
        DynamicCostSharingRound round = _createSeedRound(block.timestamp + 7 days, 2, 4);

        _assertEq(round.participantCount(), 3);
        _assertEq(round.totalContributed(), TOTAL_COST);
        _assertEq(round.viewJoinQuote(), 25 ether);
        _assertEq(uint256(round.state()), uint256(DynamicCostSharingRound.RoundState.OPEN));

        _assertEq(round.paid(ALICE), SEED_ALICE);
        _assertEq(round.paid(BOB), SEED_BOB);
        _assertEq(round.paid(CAROL), SEED_CAROL);
    }

    function testCreateWithoutSeedAndFirstJoinPaysFullTotal() public {
        DynamicCostSharingRound round = _createEmptySeedRound(block.timestamp + 7 days, 1, 0);

        _assertEq(round.participantCount(), 0);
        _assertEq(round.totalContributed(), 0);
        _assertEq(round.viewJoinQuote(), TOTAL_COST);

        _approve(ALICE, address(round), TOTAL_COST);
        vm.prank(ALICE, ALICE);
        round.join(0, TOTAL_COST);

        _assertEq(round.participantCount(), 1);
        _assertEq(round.paid(ALICE), TOTAL_COST);
        _assertEq(round.totalContributed(), TOTAL_COST);
    }

    function testJoinAndManualRefundOpenState() public {
        DynamicCostSharingRound round = _createSeedRound(block.timestamp + 7 days, 2, 5);

        _approve(DAVE, address(round), 25 ether);
        vm.prank(DAVE, DAVE);
        round.join(3, 25 ether);

        _assertEq(round.participantCount(), 4);
        _assertEq(round.paid(DAVE), 25 ether);
        _assertEq(round.viewRefundable(ALICE), 8333333333333333334);

        uint256 aliceBefore = token.balanceOf(ALICE);
        vm.prank(ALICE, ALICE);
        round.claimRefund();
        _assertEq(token.balanceOf(ALICE), aliceBefore + 8333333333333333334);
        _assertEq(round.claimed(ALICE), 8333333333333333334);

        vm.prank(ALICE, ALICE);
        vm.expectRevert(abi.encodeWithSelector(DynamicCostSharingRound.NothingToClaim.selector));
        round.claimRefund();
    }

    function testFinalizeSuccessMerchantWithdrawAndBatchRefund() public {
        DynamicCostSharingRound round = _createSeedRound(block.timestamp + 7 days, 2, 4);

        _approve(DAVE, address(round), 25 ether);
        vm.prank(DAVE, DAVE);
        round.join(3, 25 ether);

        vm.prank(DAVE, DAVE);
        round.finalizeSuccess();

        _assertEq(uint256(round.state()), uint256(DynamicCostSharingRound.RoundState.SUCCESS_FINALIZED));
        _assertEq(round.finalParticipantCount(), 4);
        _assertEq(round.viewUnitCost(), 25 ether);

        uint256 merchantBefore = token.balanceOf(MERCHANT);
        vm.prank(MERCHANT, MERCHANT);
        round.withdrawMerchant();
        _assertEq(token.balanceOf(MERCHANT), merchantBefore + TOTAL_COST);

        address[] memory users = new address[](2);
        users[0] = BOB;
        users[1] = CAROL;

        vm.prank(ADMIN, ADMIN);
        round.batchRefundSurplus(users, 2);

        _assertEq(round.claimed(BOB), 8333333333333333333);
        _assertEq(round.claimed(CAROL), 8333333333333333333);

        vm.prank(ALICE, ALICE);
        round.claimRefund();
        _assertEq(round.claimed(ALICE), 8333333333333333334);
        _assertEq(round.viewOutstandingSurplusRefunds(), 0);
    }

    function testFinalizeFailedAllowsFullUserRefund() public {
        DynamicCostSharingRound round = _createSeedRound(block.timestamp + 1 days, 4, 0);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(ADMIN, ADMIN);
        round.finalizeFailed();

        _assertEq(uint256(round.state()), uint256(DynamicCostSharingRound.RoundState.FAILED_FINALIZED));

        uint256 bobBefore = token.balanceOf(BOB);
        vm.prank(BOB, BOB);
        round.claimRefund();
        _assertEq(token.balanceOf(BOB), bobBefore + SEED_BOB);
        _assertEq(round.claimed(BOB), SEED_BOB);

        address[] memory users = new address[](1);
        users[0] = ALICE;

        vm.prank(ADMIN, ADMIN);
        vm.expectRevert(abi.encodeWithSelector(DynamicCostSharingRound.InvalidState.selector));
        round.batchRefundSurplus(users, 1);
    }

    function testEOARestrictionRejectsContractCaller() public {
        DynamicCostSharingRound round = _createSeedRound(block.timestamp + 7 days, 2, 4);

        RoundCaller caller = new RoundCaller();
        token.mint(address(caller), 50 ether);
        caller.approveToken(address(token), address(round), 50 ether);

        vm.expectRevert(abi.encodeWithSelector(DynamicCostSharingRound.EOAOnly.selector));
        caller.joinRound(address(round), 3, 25 ether);
    }

    function testRejectsFeeOnTransferTokenAtCreation() public {
        FeeOnTransferMockERC20 feeToken = new FeeOnTransferMockERC20("Fee USDT", "fUSDT", 18, 100);
        GroupBuyFactory feeFactory = new GroupBuyFactory(address(feeToken), ADMIN, 18);

        feeToken.mint(ALICE, 1_000 ether);
        feeToken.mint(BOB, 1_000 ether);
        feeToken.mint(CAROL, 1_000 ether);

        _approveFeeToken(feeToken, ALICE, address(feeFactory));
        _approveFeeToken(feeToken, BOB, address(feeFactory));
        _approveFeeToken(feeToken, CAROL, address(feeFactory));

        GroupBuyFactory.CreateRoundParams memory params = GroupBuyFactory.CreateRoundParams({
            admin: ADMIN,
            merchant: MERCHANT,
            totalCost: TOTAL_COST,
            deadline: block.timestamp + 7 days,
            minParticipants: 2,
            targetParticipants: 4,
            maxParticipants: 0,
            maxBatchSize: 50
        });

        address[] memory users = new address[](3);
        users[0] = ALICE;
        users[1] = BOB;
        users[2] = CAROL;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = SEED_ALICE;
        amounts[1] = SEED_BOB;
        amounts[2] = SEED_CAROL;

        vm.prank(ADMIN, ADMIN);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20Lite.NonExactTransferIn.selector));
        feeFactory.createRoundWithSeed(params, users, amounts);
    }

    function testRejectsSkewedSeedDistribution() public {
        GroupBuyFactory.CreateRoundParams memory params = GroupBuyFactory.CreateRoundParams({
            admin: ADMIN,
            merchant: MERCHANT,
            totalCost: TOTAL_COST,
            deadline: block.timestamp + 7 days,
            minParticipants: 2,
            targetParticipants: 4,
            maxParticipants: 0,
            maxBatchSize: 50
        });

        address[] memory users = new address[](3);
        users[0] = ALICE;
        users[1] = BOB;
        users[2] = CAROL;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 40 ether;
        amounts[1] = 30 ether;
        amounts[2] = 30 ether;

        vm.prank(ADMIN, ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(
                GroupBuyFactory.InvalidSeedDistribution.selector,
                33333333333333333333,
                33333333333333333334,
                40 ether
            )
        );
        factory.createRoundWithSeed(params, users, amounts);
    }

    function _createSeedRound(uint256 deadline, uint256 minParticipants, uint256 targetParticipants)
        internal
        returns (DynamicCostSharingRound)
    {
        GroupBuyFactory.CreateRoundParams memory params = GroupBuyFactory.CreateRoundParams({
            admin: ADMIN,
            merchant: MERCHANT,
            totalCost: TOTAL_COST,
            deadline: deadline,
            minParticipants: minParticipants,
            targetParticipants: targetParticipants,
            maxParticipants: 0,
            maxBatchSize: 50
        });

        address[] memory users = new address[](3);
        users[0] = ALICE;
        users[1] = BOB;
        users[2] = CAROL;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = SEED_ALICE;
        amounts[1] = SEED_BOB;
        amounts[2] = SEED_CAROL;

        vm.prank(ADMIN, ADMIN);
        address roundAddress = factory.createRoundWithSeed(params, users, amounts);
        return DynamicCostSharingRound(roundAddress);
    }

    function _createEmptySeedRound(uint256 deadline, uint256 minParticipants, uint256 targetParticipants)
        internal
        returns (DynamicCostSharingRound)
    {
        GroupBuyFactory.CreateRoundParams memory params = GroupBuyFactory.CreateRoundParams({
            admin: ADMIN,
            merchant: MERCHANT,
            totalCost: TOTAL_COST,
            deadline: deadline,
            minParticipants: minParticipants,
            targetParticipants: targetParticipants,
            maxParticipants: 0,
            maxBatchSize: 50
        });

        address[] memory users = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        vm.prank(ADMIN, ADMIN);
        address roundAddress = factory.createRoundWithSeed(params, users, amounts);
        return DynamicCostSharingRound(roundAddress);
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        vm.prank(owner, owner);
        token.approve(spender, amount);
    }

    function _approveFeeToken(FeeOnTransferMockERC20 feeToken, address owner, address spender) internal {
        vm.prank(owner, owner);
        feeToken.approve(spender, type(uint256).max);
    }

    function _assertEq(uint256 a, uint256 b) internal pure {
        if (a != b) {
            revert AssertionFailed();
        }
    }
}
