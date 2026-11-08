// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";
import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";
import {EscrowHandler} from "./EscrowHandler.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";

/// @notice Stateful invariant suite: the fuzzer calls random sequences of `EscrowHandler` steps across up to 24
/// projects per run (at most 4 live at once) that share participants, and every invariant below is checked after
/// every step. The numbers refer to the spec's "Security invariants" list. Runs and depth are set in
/// hardhat.config.ts (`test.solidity.profiles.<profile>.invariant`).
contract TrustLanceEscrowInvariantTest is StdInvariant, EscrowTestBase {
    uint256 internal constant BPS = 10_000;
    EscrowHandler internal handler;

    function setUp() public {
        _deploy();
        handler = new EscrowHandler(escrow, admin, arbitrator);
        targetContract(address(handler));

        // Lifecycle steps are listed more than once to weight them over the environment steps.
        bytes4[] memory selectors = new bytes4[](31);
        selectors[0] = handler.createProject.selector;
        selectors[1] = handler.createProject.selector;
        selectors[2] = handler.acceptProject.selector;
        selectors[3] = handler.acceptProject.selector;
        selectors[4] = handler.acceptProject.selector;
        selectors[5] = handler.declineProject.selector;
        selectors[6] = handler.cancelProject.selector;
        selectors[7] = handler.submitMilestone.selector;
        selectors[8] = handler.submitMilestone.selector;
        selectors[9] = handler.submitMilestone.selector;
        selectors[10] = handler.approveMilestone.selector;
        selectors[11] = handler.requestRevision.selector;
        selectors[12] = handler.requestRevision.selector;
        selectors[13] = handler.requestRevision.selector;
        selectors[14] = handler.finalizeAutoApproval.selector;
        selectors[15] = handler.finalizeAutoApproval.selector;
        selectors[16] = handler.refundOverdueMilestone.selector;
        selectors[17] = handler.forfeit.selector;
        selectors[18] = handler.raiseDispute.selector;
        selectors[19] = handler.resolveDispute.selector;
        selectors[20] = handler.resolveDispute.selector;
        selectors[21] = handler.settleExpiredDispute.selector;
        selectors[22] = handler.settleExpiredDispute.selector;
        selectors[23] = handler.withdraw.selector;
        selectors[24] = handler.withdraw.selector;
        selectors[25] = handler.warp.selector;
        selectors[26] = handler.warp.selector;
        selectors[27] = handler.probeBoundary.selector;
        selectors[28] = handler.probeBoundary.selector;
        selectors[29] = handler.forceEth.selector;
        selectors[30] = handler.adminAction.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Every per-call rule the handler checks: guards match the spec's state tables (7, 12), balances only rise
    /// outside `withdraw` (10), other projects untouched (13), settled milestones stay settled (3, 4), revision counts
    /// never drop or exceed the limit (11), fees only from resolution and exactly the snapshot rate (6).
    function invariant_handlerRecordedNoViolation() public view {
        assertEq(handler.violationCount(), 0, handler.violationCount() > 0 ? handler.violationAt(0) : "");
    }

    /// Invariant 1, exact: the balance is the two totals plus ETH forced in from outside. Also: deposits minus
    /// withdrawals equal the totals, and the per-account balances add up to `totalWithdrawable`.
    function invariant_1_contractBalanceCoversEveryAccount() public view {
        _assertConservation(handler.ghostForced());
        assertGe(address(escrow).balance, escrow.totalEscrow() + escrow.totalWithdrawable());
        assertEq(handler.ghostDeposited() - handler.ghostWithdrawn(), escrow.totalEscrow() + escrow.totalWithdrawable());
        uint256 sum;
        for (uint256 i = 0; i < handler.accountCount(); i++) sum += escrow.withdrawable(handler.accountAt(i));
        assertEq(sum, escrow.totalWithdrawable(), "balances add up to totalWithdrawable");
    }

    /// Invariants 2 and 3: each project's milestone amounts are accounted for exactly once, by status, and the
    /// project's open amounts add up to `totalEscrow`.
    function invariant_2_3_eachProjectIsAccountedForExactlyOnce() public view {
        uint256 escrowSum;
        for (uint256 k = 0; k < handler.projectCount(); k++) {
            uint256 id = handler.projectIds(k);
            TrustLanceEscrow.Project memory p = escrow.getProject(id);
            TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
            uint256[5] memory byStatus;
            uint256 total;
            for (uint256 i = 0; i < ms.length; i++) {
                byStatus[uint8(ms[i].status)] += ms[i].amount;
                total += ms[i].amount;
            }
            assertEq(total, p.totalAmount, "milestones add up to the total");
            assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Approved)], p.approvedAmount, "approved by status");
            assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Refunded)], p.refundedAmount, "refunded by status");

            uint256 open = p.pendingAmount + p.submittedAmount;
            escrowSum += open;
            if (p.status == TrustLanceEscrow.ProjectStatus.Resolved) {
                assertEq(open, 0, "resolved project holds no escrow");
                assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Pending)] + byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Submitted)], 0, "no open milestone after resolution");
                assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Resolved)], p.frozenAmount, "resolved milestones are the frozen amount");
            } else {
                assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Pending)], p.pendingAmount, "pending by status");
                assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Submitted)], p.submittedAmount, "submitted by status");
                assertEq(byStatus[uint8(TrustLanceEscrow.MilestoneStatus.Resolved)], 0, "no resolved milestone before resolution");
            }
            if (p.status == TrustLanceEscrow.ProjectStatus.Disputed) {
                assertEq(p.frozenAmount, open, "frozen while disputed");
                assertEq(p.frozenPendingAmount, p.pendingAmount, "frozen pending");
                assertEq(p.frozenSubmittedAmount, p.submittedAmount, "frozen submitted");
            }
            if (
                p.status == TrustLanceEscrow.ProjectStatus.Completed || p.status == TrustLanceEscrow.ProjectStatus.Cancelled
                    || p.status == TrustLanceEscrow.ProjectStatus.Resolved
            ) {
                assertEq(open, 0, "terminal project holds no escrow");
            }
            uint256 settled = p.status == TrustLanceEscrow.ProjectStatus.Resolved ? p.frozenAmount : 0;
            assertEq(total, open + p.approvedAmount + p.refundedAmount + settled, "invariant 2");
            // Invariant 3: everything that left escrow was credited exactly once.
            assertEq(handler.ghostCredited(id), total - open, "credited exactly what left escrow");
        }
        assertEq(escrowSum, escrow.totalEscrow(), "projects add up to totalEscrow");
    }

    /// Invariants 5 and 6: at most one settlement per dispute, only for a Resolved project; the fee never exceeds the
    /// snapshot rate.
    function invariant_5_6_disputesPayOnceAndFeesAreCapped() public view {
        for (uint256 k = 0; k < handler.projectCount(); k++) {
            uint256 id = handler.projectIds(k);
            TrustLanceEscrow.Project memory p = escrow.getProject(id);
            uint256 settlements = handler.ghostSettlements(id);
            assertLe(settlements, 1, "a dispute paid out twice");
            assertEq(settlements == 1, p.status == TrustLanceEscrow.ProjectStatus.Resolved, "settled iff Resolved");
            assertLe(handler.ghostFee(id), p.frozenAmount * p.feeBps / BPS, "fee above the snapshot rate");
            assertLe(p.feeBps, escrow.MAX_FEE_BPS());
        }
    }

    /// Invariant 9 (liveness), after every run: from the state the run reached, each party alone can bring every
    /// project to a terminal state and then everyone can withdraw everything, leaving only forced ETH. Tried twice
    /// from the same state: once using only the client's exits, once using only the freelancer's.
    function afterInvariant() public virtual {
        // Non-vacuity: the run reached the escrow. Per-action success counts are reported in docs/security.md.
        assertGt(handler.successes("createProject"), 0, "the run created no project");
        for (uint256 actingParty = 0; actingParty < 2; actingParty++) {
            uint256 snap = vm.snapshotState();
            // Past every delivery, review and arbitration deadline a run can create.
            vm.warp(block.timestamp + 1000 days);
            for (uint256 k = 0; k < handler.projectCount(); k++) {
                _exitAlone(handler.projectIds(k), actingParty == 0);
            }
            for (uint256 i = 0; i < handler.accountCount(); i++) {
                address account = handler.accountAt(i);
                if (escrow.withdrawable(account) == 0) continue;
                vm.prank(account);
                escrow.withdraw();
            }
            assertEq(escrow.totalEscrow(), 0, "liveness: escrow left");
            assertEq(escrow.totalWithdrawable(), 0, "liveness: balances left");
            assertEq(address(escrow).balance, handler.ghostForced(), "liveness: only forced ETH remains");
            vm.revertToState(snap);
        }
        console.log("projects", handler.projectCount(), "exact deadline landings", handler.exactDeadlineLandings());
        console.log("boundary probes", handler.boundaryProbes(), "settlements", _settledCount());
    }

    /// Drives one project to a terminal state with the actions of one party only (anyone may auto-approve).
    function _exitAlone(uint256 id, bool asClient) internal {
        TrustLanceEscrow.Project memory p = escrow.getProject(id);
        address party = asClient ? p.client : p.freelancer;
        if (p.status == TrustLanceEscrow.ProjectStatus.Open) {
            vm.prank(party);
            if (asClient) escrow.cancelProject(id);
            else escrow.declineProject(id);
        } else if (p.status == TrustLanceEscrow.ProjectStatus.Active) {
            if (asClient) {
                TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
                for (uint256 i = 0; i < ms.length; i++) {
                    if (ms[i].status == TrustLanceEscrow.MilestoneStatus.Submitted) {
                        escrow.finalizeAutoApproval(id, i);
                    } else if (ms[i].status == TrustLanceEscrow.MilestoneStatus.Pending) {
                        vm.prank(party);
                        escrow.refundOverdueMilestone(id, i);
                    }
                }
            } else {
                vm.prank(party);
                escrow.forfeit(id);
            }
        } else if (p.status == TrustLanceEscrow.ProjectStatus.Disputed) {
            vm.prank(party);
            escrow.settleExpiredDispute(id);
        }
        TrustLanceEscrow.ProjectStatus status = escrow.getProject(id).status;
        assertTrue(
            status == TrustLanceEscrow.ProjectStatus.Completed || status == TrustLanceEscrow.ProjectStatus.Cancelled
                || status == TrustLanceEscrow.ProjectStatus.Resolved,
            "liveness: project not terminal"
        );
    }

    function _settledCount() internal view returns (uint256 count) {
        for (uint256 k = 0; k < handler.projectCount(); k++) count += handler.ghostSettlements(handler.projectIds(k));
    }
}
