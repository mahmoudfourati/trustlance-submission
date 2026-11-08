// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";

/// @notice Stateless fuzz tests for the arithmetic and the deadline boundaries: dispute splits over random amounts,
/// fee rates and shares, and every window/expiry pair at random times around its deadline. Runs and seed are set in
/// hardhat.config.ts (`test.solidity.profiles.<profile>.fuzz`).
contract TrustLanceEscrowFuzzTest is EscrowTestBase {
    uint256 internal constant BPS = 10_000;

    function setUp() public {
        _deploy();
    }

    /// A disputed project with milestone 0 Submitted (`submitted` wei) and milestone 1 Pending (`pending` wei), at
    /// fee rate `feeBps`, raised by the client.
    function _disputed(uint256 submitted, uint256 pending, uint16 feeBps) internal returns (uint256 id) {
        vm.prank(admin);
        escrow.setArbitrationFeeBps(feeBps);
        id = _createAccepted(client, freelancer, _amounts(submitted, pending));
        vm.prank(freelancer);
        escrow.submitMilestone(id, 0, CID);
        vm.prank(client);
        escrow.raiseDispute(id, "dispute");
    }

    /// Invariants 5, 6 and 13 for resolution: fee = ⌊frozen × feeBps / 10 000⌋, the freelancer gets exactly the share,
    /// the client the rest, every wei of the frozen amount is credited once, and one wei more than the cap reverts.
    function testFuzz_ResolutionSplitsTheFrozenAmountExactly(
        uint256 submitted,
        uint256 pending,
        uint16 feeBps,
        uint256 share
    ) public {
        submitted = bound(submitted, 1, 1e30);
        pending = bound(pending, 1, 1e30);
        feeBps = uint16(bound(feeBps, 0, escrow.MAX_FEE_BPS()));
        uint256 id = _disputed(submitted, pending, feeBps);

        uint256 frozen = submitted + pending;
        uint256 fee = frozen * feeBps / BPS;
        share = bound(share, 0, frozen - fee);

        vm.prank(arbitrator);
        vm.expectRevert(abi.encodeWithSelector(TrustLanceEscrow.ShareTooLarge.selector, frozen - fee + 1, frozen - fee));
        escrow.resolveDispute(id, frozen - fee + 1);

        vm.prank(arbitrator);
        escrow.resolveDispute(id, share);
        assertEq(escrow.withdrawable(arbitrator), fee, "fee");
        assertEq(escrow.withdrawable(freelancer), share, "freelancer share");
        assertEq(escrow.withdrawable(client), frozen - fee - share, "client rest");
        assertEq(escrow.totalEscrow(), 0);
        assertEq(escrow.totalWithdrawable(), frozen);
        _assertConservation(0);

        vm.prank(arbitrator);
        vm.expectRevert(
            abi.encodeWithSelector(TrustLanceEscrow.NotDisputed.selector, TrustLanceEscrow.ProjectStatus.Resolved)
        );
        escrow.resolveDispute(id, 0);
    }

    /// Expired settlement: pending back to the client, submitted halved with the odd wei to the client, no fee.
    function testFuzz_ExpiredSettlementSplitsWithoutAFee(uint256 submitted, uint256 pending, uint16 feeBps) public {
        submitted = bound(submitted, 1, 1e30);
        pending = bound(pending, 1, 1e30);
        uint256 id = _disputed(submitted, pending, uint16(bound(feeBps, 0, escrow.MAX_FEE_BPS())));

        vm.warp(escrow.getProject(id).raisedAt + escrow.ARBITRATION_PERIOD());
        vm.prank(freelancer);
        escrow.settleExpiredDispute(id);
        assertEq(escrow.withdrawable(freelancer), submitted / 2, "freelancer half, rounded down");
        assertEq(escrow.withdrawable(client), pending + submitted - submitted / 2, "client: pending and the odd wei");
        assertEq(escrow.withdrawable(arbitrator), 0, "no fee");
        assertEq(escrow.totalWithdrawable(), submitted + pending);
        _assertConservation(0);
    }

    /// Invariant 12 for a review window: at any time from submission on, exactly one of revision request (window) and
    /// auto-approval (expiry) is valid, and which one depends only on `now < reviewDeadline`. D - 1 and D are always
    /// tried as well as a random time.
    function testFuzz_ReviewDeadlineIsHalfOpen(uint32 reviewWindow, uint256 offset) public {
        reviewWindow = uint32(bound(reviewWindow, escrow.MIN_REVIEW_WINDOW(), escrow.MAX_REVIEW_WINDOW()));
        (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) = _params(freelancer, _amounts(1 ether), reviewWindow);
        vm.deal(client, total);
        vm.prank(client);
        uint256 id = escrow.createProject{value: total}(params);
        vm.prank(freelancer);
        escrow.acceptProject(id);
        vm.prank(freelancer);
        escrow.submitMilestone(id, 0, CID);
        uint256 deadline = escrow.getMilestones(id)[0].reviewDeadline;

        uint256[3] memory times = [deadline - 1, deadline, block.timestamp + bound(offset, 0, 2 * uint256(reviewWindow))];
        for (uint256 k = 0; k < times.length; k++) {
            uint256 snap = vm.snapshotState();
            vm.warp(times[k]);
            bool windowOk = _tryRolledBack(client, abi.encodeCall(escrow.requestRevision, (id, 0, "")));
            bool expiryOk = _tryRolledBack(outsider, abi.encodeCall(escrow.finalizeAutoApproval, (id, 0)));
            assertTrue(windowOk != expiryOk, "exactly one of revision and auto-approval");
            assertEq(windowOk, times[k] < deadline, "revision only before the deadline");
            vm.revertToState(snap);
        }
    }

    /// Invariants 5 and 12 for arbitration, as a same-block race: resolution and expired settlement are sent at the
    /// same timestamp in either order. Exactly the one valid at that time succeeds, and the other then reverts.
    function testFuzz_ResolveAndSettleInTheSameBlock(uint256 offset, bool resolveFirst, uint16 feeBps) public {
        uint256 id = _disputed(1 ether + 1, 2 ether, uint16(bound(feeBps, 0, escrow.MAX_FEE_BPS())));
        uint256 deadline = escrow.getProject(id).raisedAt + escrow.ARBITRATION_PERIOD();

        uint256[3] memory times = [deadline - 1, deadline, block.timestamp + bound(offset, 0, 60 days)];
        for (uint256 k = 0; k < times.length; k++) {
            uint256 snap = vm.snapshotState();
            vm.warp(times[k]);
            bool resolved;
            bool settled;
            if (resolveFirst) {
                resolved = _try(arbitrator, abi.encodeCall(escrow.resolveDispute, (id, 1 ether)));
                settled = _try(client, abi.encodeCall(escrow.settleExpiredDispute, (id)));
            } else {
                settled = _try(client, abi.encodeCall(escrow.settleExpiredDispute, (id)));
                resolved = _try(arbitrator, abi.encodeCall(escrow.resolveDispute, (id, 1 ether)));
            }
            assertTrue(resolved != settled, "exactly one settlement");
            assertEq(resolved, times[k] < deadline, "resolution only before the deadline");
            assertEq(escrow.totalWithdrawable(), 3 ether + 1, "the frozen amount was credited exactly once");
            _assertConservation(0);
            vm.revertToState(snap);
        }
    }

    /// The accepted delivery race (spec, known edge cases): before the delivery deadline only submission works; from
    /// the deadline on, both a late submission and an overdue refund are valid and whichever is mined first wins, the
    /// other then reverting. Either way the milestone leaves Pending once and nothing is credited twice.
    function testFuzz_DeliveryDeadlineRaceHasOneWinner(uint256 offset, bool submitFirst) public {
        uint256 id = _createAccepted(client, freelancer, _amounts(1 ether, 2 ether));
        uint256 deadline = escrow.getMilestones(id)[0].deliveryDeadline;

        uint256[3] memory times = [deadline - 1, deadline, block.timestamp + bound(offset, 0, 2 * uint256(DELIVERY))];
        for (uint256 k = 0; k < times.length; k++) {
            uint256 snap = vm.snapshotState();
            vm.warp(times[k]);
            bool submitted;
            bool refunded;
            if (submitFirst) {
                submitted = _try(freelancer, abi.encodeCall(escrow.submitMilestone, (id, 0, CID)));
                refunded = _try(client, abi.encodeCall(escrow.refundOverdueMilestone, (id, 0)));
            } else {
                refunded = _try(client, abi.encodeCall(escrow.refundOverdueMilestone, (id, 0)));
                submitted = _try(freelancer, abi.encodeCall(escrow.submitMilestone, (id, 0, CID)));
            }
            assertTrue(submitted != refunded, "exactly one of late submission and refund");
            if (times[k] < deadline) assertTrue(submitted, "only submission before the deadline");
            else assertEq(refunded, !submitFirst, "the first transaction wins from the deadline on");
            assertEq(escrow.withdrawable(client), refunded ? 1 ether : 0, "refunded once");
            _assertConservation(0);
            vm.revertToState(snap);
        }
    }

    function _try(address caller, bytes memory data) internal returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(escrow).call(data);
    }

    function _tryRolledBack(address caller, bytes memory data) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        ok = _try(caller, data);
        vm.revertToState(snap);
    }
}
