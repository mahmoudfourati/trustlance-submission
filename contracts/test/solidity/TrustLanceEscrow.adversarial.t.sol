// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {stdError} from "forge-std/StdError.sol";
import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";
import {AttackerParty, ForceSender} from "./Attackers.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";

/// @notice Malicious-actor tests: contract parties that re-enter, refuse ETH or burn gas, forced ETH, repeated
/// actions, unauthorized callers and cross-project interference.
contract TrustLanceEscrowAdversarialTest is EscrowTestBase {
    uint256 internal constant SEED_AMOUNT = 1 ether;

    function setUp() public {
        _deploy();
    }

    // ---------------------------------------------------------------- helpers

    /// An attacker contract with `SEED_AMOUNT` withdrawable, from a project it created and cancelled.
    function _fundedAttacker() internal returns (AttackerParty attacker) {
        attacker = new AttackerParty(escrow);
        (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) =
            _params(freelancer, _amounts(SEED_AMOUNT), REVIEW);
        vm.deal(address(this), total);
        bytes memory created = attacker.exec{value: total}(abi.encodeCall(escrow.createProject, (params)));
        attacker.exec(abi.encodeCall(escrow.cancelProject, (abi.decode(created, (uint256)))));
        assertEq(escrow.withdrawable(address(attacker)), SEED_AMOUNT);
    }

    /// The attacker withdraws and, from inside its `receive`, sends `reentry` to the escrow. Checks that it was paid
    /// exactly its balance once and that the books still balance; returns whether the re-entrant call succeeded.
    function _withdrawReentering(AttackerParty attacker, bytes memory reentry) internal returns (bool) {
        uint256 balance = escrow.withdrawable(address(attacker));
        attacker.setMode(AttackerParty.Mode.Reenter, reentry);
        attacker.exec(abi.encodeCall(escrow.withdraw, ()));
        assertEq(attacker.receiveCount(), 1, "paid once");
        assertEq(attacker.received(), balance, "paid exactly the balance");
        _assertConservation(0);
        return attacker.reentrySucceeded();
    }

    // ---------------------------------------------------------------- re-entrancy

    function test_ReenteringWithdrawIsBlocked() public {
        AttackerParty attacker = _fundedAttacker();
        assertFalse(_withdrawReentering(attacker, abi.encodeCall(escrow.withdraw, ())));
        assertEq(
            attacker.reentryResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(escrow.withdrawable(address(attacker)), 0);
        assertEq(escrow.totalWithdrawable(), 0);
    }

    function test_ReentryIntoCancelCreditsOnceAndStaysWithdrawable() public {
        AttackerParty attacker = _fundedAttacker();
        (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) = _params(freelancer, _amounts(3 ether), REVIEW);
        vm.deal(address(this), total);
        uint256 id = abi.decode(attacker.exec{value: total}(abi.encodeCall(escrow.createProject, (params))), (uint256));

        assertTrue(_withdrawReentering(attacker, abi.encodeCall(escrow.cancelProject, (id))));
        // The refund credited during the withdrawal is a new balance, neither lost nor paid in the same call.
        assertEq(escrow.withdrawable(address(attacker)), 3 ether);
        attacker.setMode(AttackerParty.Mode.Accept, "");
        attacker.exec(abi.encodeCall(escrow.withdraw, ()));
        assertEq(attacker.received(), SEED_AMOUNT + 3 ether);
        vm.expectRevert(TrustLanceEscrow.NothingToWithdraw.selector);
        attacker.exec(abi.encodeCall(escrow.withdraw, ()));
        _assertConservation(0);
    }

    /// The attacker is the client of a second project and re-enters each client crediting path from `receive`.
    function test_ReentryIntoClientCreditingPaths() public {
        bytes4[4] memory paths = [
            escrow.approveMilestone.selector,
            escrow.refundOverdueMilestone.selector,
            escrow.raiseDispute.selector,
            escrow.settleExpiredDispute.selector
        ];
        for (uint256 k = 0; k < paths.length; k++) {
            uint256 snap = vm.snapshotState();
            AttackerParty attacker = _fundedAttacker();
            (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) =
                _params(freelancer, _amounts(2 ether + 1, 3 ether), REVIEW);
            vm.deal(address(this), total);
            uint256 id = abi.decode(attacker.exec{value: total}(abi.encodeCall(escrow.createProject, (params))), (uint256));
            vm.prank(freelancer);
            escrow.acceptProject(id);
            vm.prank(freelancer);
            escrow.submitMilestone(id, 0, CID);

            bytes memory call;
            uint256 attackerCredit;
            uint256 freelancerCredit;
            if (paths[k] == escrow.approveMilestone.selector) {
                call = abi.encodeCall(escrow.approveMilestone, (id, 0));
                freelancerCredit = 2 ether + 1;
            } else if (paths[k] == escrow.refundOverdueMilestone.selector) {
                vm.warp(block.timestamp + DELIVERY);
                call = abi.encodeCall(escrow.refundOverdueMilestone, (id, 1));
                attackerCredit = 3 ether;
            } else if (paths[k] == escrow.raiseDispute.selector) {
                vm.warp(block.timestamp + REVIEW); // milestone 0's review window has ended: credited first
                call = abi.encodeCall(escrow.raiseDispute, (id, "re-entrant dispute"));
                freelancerCredit = 2 ether + 1;
            } else {
                attacker.exec(abi.encodeCall(escrow.raiseDispute, (id, "dispute")));
                vm.warp(block.timestamp + escrow.ARBITRATION_PERIOD());
                call = abi.encodeCall(escrow.settleExpiredDispute, (id));
                freelancerCredit = uint256(2 ether + 1) / 2;
                attackerCredit = 3 ether + (2 ether + 1) - freelancerCredit;
            }

            assertTrue(_withdrawReentering(attacker, call), "re-entrant call is a normal call");
            assertEq(escrow.withdrawable(address(attacker)), attackerCredit, "attacker credited once");
            assertEq(escrow.withdrawable(freelancer), freelancerCredit, "freelancer credited once");
            vm.revertToState(snap);
        }
    }

    /// The attacker is the freelancer, then the arbitrator, of a second project and re-enters their crediting paths.
    function test_ReentryIntoFreelancerAndArbitratorCreditingPaths() public {
        // Freelancer: forfeit credits the expired review to the attacker and refunds the rest to the client.
        AttackerParty attacker = _fundedAttacker();
        uint256 id = _createAccepted(client, address(attacker), _amounts(1 ether, 2 ether));
        attacker.exec(abi.encodeCall(escrow.submitMilestone, (id, 0, CID)));
        vm.warp(block.timestamp + REVIEW);
        assertTrue(_withdrawReentering(attacker, abi.encodeCall(escrow.forfeit, (id))));
        assertEq(escrow.withdrawable(address(attacker)), 1 ether);
        assertEq(escrow.withdrawable(client), 2 ether);

        // Arbitrator: resolving a dispute from inside the arbitrator's own withdrawal.
        AttackerParty arbitratorContract = _fundedAttacker();
        vm.prank(admin);
        escrow.setDefaultArbitrator(address(arbitratorContract));
        uint256 disputed = _createAccepted(client, freelancer, _amounts(1 ether + 1));
        vm.prank(client);
        escrow.raiseDispute(disputed, "dispute");
        assertTrue(
            _withdrawReentering(arbitratorContract, abi.encodeCall(escrow.resolveDispute, (disputed, 0.5 ether)))
        );
        uint256 fee = uint256(1 ether + 1) * FEE_BPS / 10_000;
        assertEq(escrow.withdrawable(address(arbitratorContract)), fee);
        assertEq(escrow.withdrawable(freelancer), 0.5 ether);
        assertEq(escrow.withdrawable(client), 2 ether + (1 ether + 1 - fee - 0.5 ether));
    }

    /// The two remaining crediting paths, each from inside a fresh attacker's withdrawal: declining an offer (credits
    /// the client) and recording an auto-approval (credits the attacker as freelancer).
    function test_ReentryIntoDeclineAndAutoApproval() public {
        AttackerParty decliner = _fundedAttacker();
        uint256 offer = _create(client, address(decliner), _amounts(4 ether));
        assertTrue(_withdrawReentering(decliner, abi.encodeCall(escrow.declineProject, (offer))));
        assertEq(escrow.withdrawable(client), 4 ether, "client refunded once");
        assertEq(escrow.withdrawable(address(decliner)), 0);

        AttackerParty finisher = _fundedAttacker();
        uint256 id = _createAccepted(client, address(finisher), _amounts(1 ether, 2 ether));
        finisher.exec(abi.encodeCall(escrow.submitMilestone, (id, 0, CID)));
        vm.warp(block.timestamp + REVIEW);
        assertTrue(_withdrawReentering(finisher, abi.encodeCall(escrow.finalizeAutoApproval, (id, 0))));
        assertEq(escrow.withdrawable(address(finisher)), 1 ether, "auto-approval credited once, after the withdrawal");
        assertEq(uint8(escrow.getMilestones(id)[0].status), uint8(TrustLanceEscrow.MilestoneStatus.Approved));
        _assertConservation(0);
    }

    // ---------------------------------------------------------------- recipients that refuse ETH

    /// No crediting path calls a recipient: every one succeeds even when client, freelancer and arbitrator all
    /// reject ETH. Each party's own withdrawal fails and leaves its balance intact; nobody else is affected.
    function test_RejectingPartiesCannotBlockAnyCreditingPath() public {
        AttackerParty rejectingClient = new AttackerParty(escrow);
        AttackerParty rejectingFreelancer = new AttackerParty(escrow);
        AttackerParty rejectingArbitrator = new AttackerParty(escrow);
        rejectingClient.setMode(AttackerParty.Mode.Revert, "");
        rejectingFreelancer.setMode(AttackerParty.Mode.Revert, "");
        rejectingArbitrator.setMode(AttackerParty.Mode.Revert, "");
        vm.prank(admin);
        escrow.setDefaultArbitrator(address(rejectingArbitrator));
        vm.deal(address(this), 100 ether);

        bytes memory createCall;
        uint256 id;
        // Open project: decline, then cancel.
        for (uint256 k = 0; k < 2; k++) {
            (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) =
                _params(address(rejectingFreelancer), _amounts(1 ether), REVIEW);
            createCall = abi.encodeCall(escrow.createProject, (params));
            id = abi.decode(rejectingClient.exec{value: total}(createCall), (uint256));
            if (k == 0) rejectingFreelancer.exec(abi.encodeCall(escrow.declineProject, (id)));
            else rejectingClient.exec(abi.encodeCall(escrow.cancelProject, (id)));
        }
        // Active project: approve, auto-approve, overdue refund, forfeit.
        (TrustLanceEscrow.CreateProjectParams memory p2, uint256 t2) =
            _params(address(rejectingFreelancer), _amounts(1 ether, 2 ether, 3 ether), REVIEW);
        id = abi.decode(rejectingClient.exec{value: t2}(abi.encodeCall(escrow.createProject, (p2))), (uint256));
        rejectingFreelancer.exec(abi.encodeCall(escrow.acceptProject, (id)));
        rejectingFreelancer.exec(abi.encodeCall(escrow.submitMilestone, (id, 0, CID)));
        rejectingClient.exec(abi.encodeCall(escrow.approveMilestone, (id, 0)));
        rejectingFreelancer.exec(abi.encodeCall(escrow.submitMilestone, (id, 1, CID)));
        vm.warp(block.timestamp + DELIVERY);
        escrow.finalizeAutoApproval(id, 1);
        rejectingClient.exec(abi.encodeCall(escrow.refundOverdueMilestone, (id, 2)));
        // Disputed project: resolve with a fee, and an expired settlement.
        for (uint256 k = 0; k < 2; k++) {
            (TrustLanceEscrow.CreateProjectParams memory p3, uint256 t3) =
                _params(address(rejectingFreelancer), _amounts(1 ether + 1), REVIEW);
            id = abi.decode(rejectingClient.exec{value: t3}(abi.encodeCall(escrow.createProject, (p3))), (uint256));
            rejectingFreelancer.exec(abi.encodeCall(escrow.acceptProject, (id)));
            rejectingFreelancer.exec(abi.encodeCall(escrow.raiseDispute, (id, "dispute")));
            if (k == 0) {
                rejectingArbitrator.exec(abi.encodeCall(escrow.resolveDispute, (id, 0.25 ether)));
            } else {
                vm.warp(block.timestamp + escrow.ARBITRATION_PERIOD());
                rejectingClient.exec(abi.encodeCall(escrow.settleExpiredDispute, (id)));
            }
        }
        _assertConservation(0);

        AttackerParty[3] memory parties = [rejectingClient, rejectingFreelancer, rejectingArbitrator];
        for (uint256 k = 0; k < parties.length; k++) {
            uint256 balance = escrow.withdrawable(address(parties[k]));
            assertGt(balance, 0);
            vm.expectRevert(TrustLanceEscrow.WithdrawalFailed.selector);
            parties[k].exec(abi.encodeCall(escrow.withdraw, ()));
            assertEq(escrow.withdrawable(address(parties[k])), balance, "balance kept for a retry");
            parties[k].setMode(AttackerParty.Mode.Accept, "");
            parties[k].exec(abi.encodeCall(escrow.withdraw, ()));
            assertEq(parties[k].received(), balance);
        }
        assertEq(escrow.totalWithdrawable(), 0);
        assertEq(address(escrow).balance, 0, "no ETH left behind");
    }

    function test_GasBurningRecipientOnlyFailsItsOwnWithdrawal() public {
        AttackerParty burner = _fundedAttacker();
        burner.setMode(AttackerParty.Mode.BurnGas, "");
        uint256 id = _create(client, freelancer, _amounts(1 ether));
        vm.prank(client);
        escrow.cancelProject(id);

        vm.expectRevert(TrustLanceEscrow.WithdrawalFailed.selector);
        burner.exec{gas: 2_000_000}(abi.encodeCall(escrow.withdraw, ()));
        assertEq(escrow.withdrawable(address(burner)), SEED_AMOUNT);

        vm.prank(client);
        escrow.withdraw();
        assertEq(client.balance, 1 ether);
        _assertConservation(0);
    }

    // ---------------------------------------------------------------- forced ETH

    function test_ForcedEthIsIgnoredByTheAccountsAndCantBeWithdrawn() public {
        uint256 id = _createAccepted(client, freelancer, _amounts(1 ether, 2 ether));
        new ForceSender{value: 5 ether}(payable(address(escrow)));
        assertEq(address(escrow).balance, 8 ether);
        _assertConservation(5 ether);

        vm.prank(freelancer);
        escrow.submitMilestone(id, 0, CID);
        vm.prank(client);
        escrow.approveMilestone(id, 0);
        vm.prank(freelancer);
        escrow.forfeit(id);
        vm.prank(client);
        escrow.withdraw();
        vm.prank(freelancer);
        escrow.withdraw();

        assertEq(client.balance, 2 ether);
        assertEq(freelancer.balance, 1 ether);
        assertEq(escrow.totalEscrow() + escrow.totalWithdrawable(), 0);
        // The forced ETH belongs to no account: it stays locked (accepted risk; no sweep function by design).
        assertEq(address(escrow).balance, 5 ether);
    }

    function test_PlainEthTransfersAreRejected() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "no receive");
        vm.prank(outsider);
        (ok,) = address(escrow).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "no fallback");
    }

    // ---------------------------------------------------------------- repeated actions

    function test_EveryRepeatedActionReverts() public {
        uint256 id = _createAccepted(client, freelancer, _amounts(1 ether, 2 ether, 3 ether));
        vm.startPrank(freelancer);
        escrow.submitMilestone(id, 0, CID);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.MilestoneNotPending.selector, 1));
        escrow.submitMilestone(id, 0, CID);
        vm.stopPrank();

        vm.startPrank(client);
        escrow.approveMilestone(id, 0);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.MilestoneNotSubmitted.selector, 2));
        escrow.approveMilestone(id, 0);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.MilestoneNotPending.selector, 2));
        escrow.refundOverdueMilestone(id, 0);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.MilestoneNotSubmitted.selector, 2));
        escrow.finalizeAutoApproval(id, 0);

        vm.warp(block.timestamp + DELIVERY);
        vm.startPrank(client);
        escrow.refundOverdueMilestone(id, 1);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.MilestoneNotPending.selector, 3));
        escrow.refundOverdueMilestone(id, 1);
        escrow.raiseDispute(id, "dispute");
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.ProjectNotActive.selector, 4));
        escrow.raiseDispute(id, "again");
        vm.stopPrank();

        vm.prank(arbitrator);
        escrow.resolveDispute(id, 1 ether);
        vm.prank(arbitrator);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.NotDisputed.selector, 5));
        escrow.resolveDispute(id, 1 ether);
        vm.warp(block.timestamp + escrow.ARBITRATION_PERIOD());
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.NotDisputed.selector, 5));
        escrow.settleExpiredDispute(id);

        vm.startPrank(client);
        escrow.withdraw();
        vm.expectRevert(TrustLanceEscrow.NothingToWithdraw.selector);
        escrow.withdraw();
        vm.stopPrank();

        uint256 open = _create(client, freelancer, _amounts(1 ether));
        vm.startPrank(client);
        escrow.cancelProject(open);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.ProjectNotOpen.selector, 3));
        escrow.cancelProject(open);
        vm.stopPrank();
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.ProjectNotOpen.selector, 3));
        escrow.declineProject(open);
        _assertConservation(0);
    }

    // ---------------------------------------------------------------- authorization

    /// Every restricted function rejects every account without the role, including the admin, which can't move
    /// project funds at all.
    function test_RestrictedFunctionsRejectEveryOtherAccount() public {
        uint256 open = _create(client, freelancer, _amounts(1 ether));
        uint256 active = _createAccepted(client, freelancer, _amounts(1 ether, 2 ether));
        vm.prank(freelancer);
        escrow.submitMilestone(active, 0, CID);
        uint256 disputed = _createAccepted(client, freelancer, _amounts(1 ether));
        vm.prank(client);
        escrow.raiseDispute(disputed, "dispute");

        address[4] memory notClient = [freelancer, arbitrator, admin, outsider];
        address[4] memory notFreelancer = [client, arbitrator, admin, outsider];
        address[3] memory notParty = [arbitrator, admin, outsider];
        address[4] memory notArbitrator = [client, freelancer, admin, outsider];

        for (uint256 k = 0; k < notClient.length; k++) {
            address a = notClient[k];
            _expectRevertFrom(a, abi.encodeCall(escrow.cancelProject, (open)), abi.encodeWithSelector(TrustLanceEscrow.NotClient.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.approveMilestone, (active, 0)), abi.encodeWithSelector(TrustLanceEscrow.NotClient.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.requestRevision, (active, 0, "")), abi.encodeWithSelector(TrustLanceEscrow.NotClient.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.refundOverdueMilestone, (active, 1)), abi.encodeWithSelector(TrustLanceEscrow.NotClient.selector, a));
        }
        for (uint256 k = 0; k < notFreelancer.length; k++) {
            address a = notFreelancer[k];
            _expectRevertFrom(a, abi.encodeCall(escrow.acceptProject, (open)), abi.encodeWithSelector(TrustLanceEscrow.NotFreelancer.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.declineProject, (open)), abi.encodeWithSelector(TrustLanceEscrow.NotFreelancer.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.submitMilestone, (active, 1, CID)), abi.encodeWithSelector(TrustLanceEscrow.NotFreelancer.selector, a));
            _expectRevertFrom(a, abi.encodeCall(escrow.forfeit, (active)), abi.encodeWithSelector(TrustLanceEscrow.NotFreelancer.selector, a));
        }
        for (uint256 k = 0; k < notParty.length; k++) {
            address a = notParty[k];
            _expectRevertFrom(a, abi.encodeCall(escrow.raiseDispute, (active, "x")), abi.encodeWithSelector(TrustLanceEscrow.NotProjectParty.selector, a));
        }
        for (uint256 k = 0; k < notArbitrator.length; k++) {
            address a = notArbitrator[k];
            _expectRevertFrom(a, abi.encodeCall(escrow.resolveDispute, (disputed, 0)), abi.encodeWithSelector(TrustLanceEscrow.NotArbitrator.selector, a));
        }
        vm.warp(block.timestamp + escrow.ARBITRATION_PERIOD());
        for (uint256 k = 0; k < notParty.length; k++) {
            address a = notParty[k];
            _expectRevertFrom(a, abi.encodeCall(escrow.settleExpiredDispute, (disputed)), abi.encodeWithSelector(TrustLanceEscrow.NotProjectParty.selector, a));
        }
        // Admin functions reject everyone but the admin.
        address[4] memory notAdmin = [client, freelancer, arbitrator, outsider];
        for (uint256 k = 0; k < notAdmin.length; k++) {
            address a = notAdmin[k];
            bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, a);
            _expectRevertFrom(a, abi.encodeCall(escrow.pause, ()), err);
            _expectRevertFrom(a, abi.encodeCall(escrow.unpause, ()), err);
            _expectRevertFrom(a, abi.encodeCall(escrow.setDefaultArbitrator, (a)), err);
            _expectRevertFrom(a, abi.encodeCall(escrow.setArbitrationFeeBps, (0)), err);
            _expectRevertFrom(a, abi.encodeCall(escrow.transferOwnership, (a)), err);
        }
        // Admin settings never reach existing projects.
        bytes32 before = _recordHash(disputed);
        vm.startPrank(admin);
        escrow.setDefaultArbitrator(outsider);
        escrow.setArbitrationFeeBps(1000);
        escrow.pause();
        vm.stopPrank();
        assertEq(_recordHash(disputed), before);
        vm.prank(client);
        escrow.settleExpiredDispute(disputed);
    }

    function _expectRevertFrom(address caller, bytes memory data, bytes memory err) internal {
        vm.prank(caller);
        (bool ok, bytes memory result) = address(escrow).call(data);
        assertFalse(ok, "unauthorized call succeeded");
        assertEq(result, err);
    }

    // ---------------------------------------------------------------- isolation

    /// Two projects with the same client and freelancer: every action on one leaves the other's record unchanged.
    function test_ProjectsSharingPartiesAreIsolated() public {
        uint256 a = _createAccepted(client, freelancer, _amounts(1 ether, 2 ether, 3 ether));
        uint256 b = _createAccepted(client, freelancer, _amounts(5 ether, 7 ether));
        vm.prank(freelancer);
        escrow.submitMilestone(b, 0, CID);
        bytes32 bRecord = _recordHash(b);

        vm.startPrank(freelancer);
        escrow.submitMilestone(a, 0, CID);
        escrow.submitMilestone(a, 1, CID);
        vm.stopPrank();
        vm.startPrank(client);
        escrow.requestRevision(a, 1, "again");
        escrow.approveMilestone(a, 0);
        escrow.raiseDispute(a, "dispute");
        vm.stopPrank();
        uint256 escrowBefore = escrow.totalEscrow();
        uint256 withdrawableBefore = escrow.totalWithdrawable();
        vm.prank(arbitrator);
        escrow.resolveDispute(a, 1 ether);
        // Invariant 13: settling changes the totals by exactly the frozen amount.
        assertEq(escrowBefore - escrow.totalEscrow(), 5 ether);
        assertEq(escrow.totalWithdrawable() - withdrawableBefore, 5 ether);
        vm.prank(client);
        escrow.withdraw();
        vm.prank(freelancer);
        escrow.withdraw();

        assertEq(_recordHash(b), bRecord, "project b untouched");
        TrustLanceEscrow.Project memory pb = escrow.getProject(b);
        assertEq(uint8(pb.status), uint8(TrustLanceEscrow.ProjectStatus.Active));
        assertEq(pb.pendingAmount + pb.submittedAmount, 12 ether);
        _assertConservation(0);
    }

    // ---------------------------------------------------------------- boundaries and gas

    /// Invariant 8: the per-project loops are bounded by MAX_MILESTONES. The heaviest paths on a 20-milestone project
    /// stay far below the block gas limit.
    function test_LoopsOnTwentyMilestonesStayCheap() public {
        uint256[] memory amounts = new uint256[](20);
        for (uint256 i = 0; i < 20; i++) amounts[i] = 1 ether + i;
        uint256 id = _createAccepted(client, freelancer, amounts);
        vm.startPrank(freelancer);
        for (uint256 i = 0; i < 20; i++) escrow.submitMilestone(id, i, CID);
        vm.stopPrank();
        vm.warp(block.timestamp + REVIEW - 1);

        uint256 gasBefore = gasleft();
        vm.prank(client);
        escrow.raiseDispute(id, "dispute");
        uint256 raiseGas = gasBefore - gasleft();
        gasBefore = gasleft();
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 0);
        uint256 resolveGas = gasBefore - gasleft();

        uint256 other = _createAccepted(client, freelancer, amounts);
        vm.startPrank(freelancer);
        for (uint256 i = 0; i < 20; i++) escrow.submitMilestone(other, i, CID);
        vm.warp(block.timestamp + REVIEW);
        gasBefore = gasleft();
        escrow.forfeit(other);
        uint256 forfeitGas = gasBefore - gasleft();
        vm.stopPrank();

        emit log_named_uint("raiseDispute, 20 milestones", raiseGas);
        emit log_named_uint("resolveDispute, 20 milestones", resolveGas);
        emit log_named_uint("forfeit crediting 20 expired reviews", forfeitGas);
        assertLt(raiseGas, 1_000_000);
        assertLt(resolveGas, 1_000_000);
        assertLt(forfeitGas, 2_000_000);
    }

    /// Invariant 8 beyond one project: an action costs no more after 50 more projects for the same parties and 50
    /// more clients. Each measurement uses a new project of the same shape, so any growth would come from a loop over
    /// projects or users (the later calls can only be cheaper, because some shared slots are already warm).
    function test_GasDoesNotGrowWithProjectsOrUsers() public {
        uint256[4] memory first = _gasOfEachAction();
        for (uint256 i = 0; i < 50; i++) {
            _create(client, freelancer, _amounts(1 ether));
            _create(makeAddr(string.concat("client", vm.toString(i))), freelancer, _amounts(1 ether));
        }
        uint256[4] memory later = _gasOfEachAction();
        string[4] memory names = ["createProject", "approveMilestone", "raise and resolve", "withdraw"];
        for (uint256 k = 0; k < 4; k++) assertLe(later[k], first[k], names[k]);
    }

    /// Gas of creating, approving, disputing and withdrawing on a new two-milestone project.
    function _gasOfEachAction() internal returns (uint256[4] memory gas) {
        (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) =
            _params(freelancer, _amounts(1 ether, 2 ether), REVIEW);
        vm.deal(client, client.balance + total);
        uint256 start = gasleft();
        vm.prank(client);
        uint256 id = escrow.createProject{value: total}(params);
        gas[0] = start - gasleft();
        vm.startPrank(freelancer);
        escrow.acceptProject(id);
        escrow.submitMilestone(id, 0, CID);
        vm.stopPrank();
        start = gasleft();
        vm.prank(client);
        escrow.approveMilestone(id, 0);
        gas[1] = start - gasleft();
        start = gasleft();
        vm.prank(client);
        escrow.raiseDispute(id, "dispute");
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 1 ether);
        gas[2] = start - gasleft();
        start = gasleft();
        vm.prank(freelancer);
        escrow.withdraw();
        gas[3] = start - gasleft();
    }

    /// Fee arithmetic: `frozen * feeBps` can only overflow above 2^256 / feeBps wei (about 10^74), far beyond all ETH
    /// in existence (about 10^26 wei). Even then the project isn't stuck: expired-dispute settlement doesn't multiply.
    /// Accepted risk, recorded in docs/security.md: resolution reverts at such amounts rather than capping the fee.
    function test_HugeFrozenAmountStillSettles() public {
        uint256 huge = type(uint256).max / 200; // * 250 bps overflows
        uint256 id = _createAccepted(client, freelancer, _amounts(huge));
        vm.prank(client);
        escrow.raiseDispute(id, "dispute");
        vm.prank(arbitrator);
        vm.expectRevert(stdError.arithmeticError); // frozen * feeBps overflows
        escrow.resolveDispute(id, 0);
        vm.warp(block.timestamp + escrow.ARBITRATION_PERIOD());
        vm.prank(freelancer);
        escrow.settleExpiredDispute(id);
        assertEq(escrow.withdrawable(client), huge);
        _assertConservation(0);
    }
}
