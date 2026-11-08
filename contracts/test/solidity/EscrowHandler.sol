// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";
import {ForceSender} from "./Attackers.sol";

/// @notice Stateful fuzzing handler. Every public function is one randomized step: an escrow call by a randomly
/// chosen account (usually the authorized one, often not), a time jump that often lands exactly on a deadline, a
/// forced-ETH transfer, or an admin change. For each escrow call it predicts from the spec's state tables whether the
/// call must succeed, makes it, and records a violation when the contract disagrees or when the call breaks a
/// per-call rule (balances only rise, other projects untouched, fees only from resolution, totals move together).
/// The invariant test asserts that no violation was recorded and checks the global invariants after every step.
contract EscrowHandler is Test {
    /// @dev Projects that may be open, active or disputed at once, and created over a whole run.
    uint256 internal constant MAX_LIVE = 4;
    uint256 internal constant MAX_PROJECTS = 24;
    uint256 internal constant BPS = 10_000;
    string internal constant CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

    TrustLanceEscrow public immutable escrow;
    address public immutable admin;
    /// @dev Four accounts that act as clients and freelancers, so projects share participants in both roles.
    address[4] internal parties;
    address[2] internal arbitrators;
    address internal outsider;
    /// @dev Every account that can hold a balance or call the escrow.
    address[] internal accounts;

    uint256[] public projectIds;

    // Ghost state, written only after successful calls.
    mapping(uint256 projectId => uint256) public ghostCredited;
    mapping(uint256 projectId => uint256) public ghostFee;
    mapping(uint256 projectId => uint256) public ghostSettlements;
    mapping(uint256 projectId => uint256) public ghostApproved;
    /// @dev Hash of what may never change after creation: parties, fee rate, windows and milestone amounts.
    mapping(uint256 projectId => bytes32) internal ghostTerms;
    mapping(uint256 projectId => mapping(uint256 index => uint8)) internal ghostStatus;
    mapping(uint256 projectId => mapping(uint256 index => uint8)) internal ghostRevisions;
    uint256 public ghostForced;
    uint256 public ghostWithdrawn;
    uint256 public ghostDeposited;

    string[] internal violations;
    mapping(bytes32 action => uint256) public successes;
    mapping(bytes32 action => uint256) public failures;
    uint256 public exactDeadlineLandings;
    uint256 public boundaryProbes;

    constructor(TrustLanceEscrow escrow_, address admin_, address arbitrator_) {
        escrow = escrow_;
        admin = admin_;
        for (uint256 i = 0; i < parties.length; i++) {
            parties[i] = makeAddr(string.concat("party", vm.toString(i)));
            accounts.push(parties[i]);
        }
        arbitrators = [arbitrator_, makeAddr("arbitrator2")];
        outsider = makeAddr("outsider");
        accounts.push(arbitrators[0]);
        accounts.push(arbitrators[1]);
        accounts.push(admin_);
        accounts.push(outsider);
    }

    // ================================================================== views for the invariant test

    function projectCount() external view returns (uint256) {
        return projectIds.length;
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    function accountAt(uint256 i) external view returns (address) {
        return accounts[i];
    }

    function violationCount() external view returns (uint256) {
        return violations.length;
    }

    function violationAt(uint256 i) external view returns (string memory) {
        return violations[i];
    }

    // ================================================================== project lifecycle

    function createProject(uint256 clientSeed, uint256 freelancerSeed, uint256 shapeSeed, uint256 amountSeed) external {
        if (projectIds.length >= MAX_PROJECTS || _liveIds().length >= MAX_LIVE) return;
        address client = parties[clientSeed % parties.length];
        address freelancer = parties[(clientSeed % parties.length + 1 + freelancerSeed % (parties.length - 1)) % parties.length];

        uint256 count = 1 + shapeSeed % 4;
        TrustLanceEscrow.MilestoneInput[] memory milestones = new TrustLanceEscrow.MilestoneInput[](count);
        uint256 total;
        for (uint256 i = 0; i < count; i++) {
            uint256 seed = uint256(keccak256(abi.encode(amountSeed, i)));
            // Mostly odd, ETH-sized amounts; sometimes 1 wei.
            uint256 amount = seed % 7 == 0 ? 1 : bound(seed, 1, 50 ether) | 1;
            milestones[i] = TrustLanceEscrow.MilestoneInput({
                amount: amount,
                deliveryPeriod: uint32(bound(_rand(seed, 64), 1 hours, 40 days)),
                title: "Milestone"
            });
            total += amount;
        }
        TrustLanceEscrow.CreateProjectParams memory params = TrustLanceEscrow.CreateProjectParams({
            freelancer: freelancer,
            acceptanceDeadline: uint64(block.timestamp + bound(_rand(shapeSeed, 8), 1 days, 30 days)),
            reviewWindow: uint32(bound(_rand(shapeSeed, 40), 1 days, shapeSeed % 4 == 0 ? 30 days : 3 days)),
            title: "Project",
            description: "",
            milestones: milestones
        });

        // A pause would otherwise last until a rare unpause step and starve the run of projects: half the time the
        // admin lifts it first, the other half the paused create is tried and must fail.
        if (escrow.paused() && _rand(shapeSeed, 300) % 2 == 0) {
            vm.prank(admin);
            escrow.unpause();
        }
        // Sometimes break one creation bound, which must be rejected whatever the rest of the input.
        uint256 broken = _rand(amountSeed, 300) % 12;
        if (broken == 0) params.acceptanceDeadline = uint64(block.timestamp);
        else if (broken == 1) params.acceptanceDeadline = uint64(block.timestamp + escrow.MAX_ACCEPTANCE_WINDOW() + 1);
        else if (broken == 2) params.reviewWindow = escrow.MIN_REVIEW_WINDOW() - 1;
        else if (broken == 3) params.milestones[0].deliveryPeriod = escrow.MAX_DELIVERY_PERIOD() + 1;
        else if (broken == 4) params.freelancer = client;
        else if (broken == 5) params.milestones = new TrustLanceEscrow.MilestoneInput[](0);

        // Sometimes send the wrong amount, which must be rejected.
        uint256 value = _rand(amountSeed, 200) % 8 == 0 ? total + 1 : total;
        bool expected = !escrow.paused() && value == total && client != escrow.defaultArbitrator() && broken > 5;
        vm.deal(client, client.balance + value);
        Snapshot memory before = _snapshot();
        vm.prank(client);
        (bool ok, bytes memory result) = address(escrow).call{value: value}(abi.encodeCall(escrow.createProject, (params)));
        _check("createProject", ok, expected);
        if (!ok) return;

        uint256 id = abi.decode(result, (uint256));
        projectIds.push(id);
        ghostTerms[id] = _termsHash(id);
        ghostDeposited += total;
        _expectTotals(before, int256(total), 0, "createProject");
        _expectNoBalanceDecrease(before, "createProject");
        _expectOthersUnchanged(before, id, "createProject");
        _record(id);
    }

    function acceptProject(uint256 projectSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Open);
        if (id == 0) return;
        address caller = _caller(callerSeed, p.freelancer);
        bool expected = p.status == TrustLanceEscrow.ProjectStatus.Open && caller == p.freelancer
            && block.timestamp < p.acceptanceDeadline;
        _run("acceptProject", id, caller, abi.encodeCall(escrow.acceptProject, (id)), expected);
    }

    /// Decline, cancel and forfeit end a project at once, so they act only a third of the time and pick any live
    /// project rather than one in the right state; otherwise they end most projects before the later steps run.
    function declineProject(uint256 projectSeed, uint256 callerSeed) external {
        if (_rand(callerSeed, 99) % 3 != 0) return;
        (uint256 id, TrustLanceEscrow.Project memory p) = _pick(projectSeed);
        if (id == 0) return;
        address caller = _caller(callerSeed, p.freelancer);
        bool expected = p.status == TrustLanceEscrow.ProjectStatus.Open && caller == p.freelancer;
        _run("declineProject", id, caller, abi.encodeCall(escrow.declineProject, (id)), expected);
    }

    function cancelProject(uint256 projectSeed, uint256 callerSeed) external {
        if (_rand(callerSeed, 99) % 3 != 0) return;
        (uint256 id, TrustLanceEscrow.Project memory p) = _pick(projectSeed);
        if (id == 0) return;
        address caller = _caller(callerSeed, p.client);
        bool expected = p.status == TrustLanceEscrow.ProjectStatus.Open && caller == p.client;
        _run("cancelProject", id, caller, abi.encodeCall(escrow.cancelProject, (id)), expected);
    }

    // ================================================================== milestones

    function submitMilestone(uint256 projectSeed, uint256 indexSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Pending);
        address caller = _caller(callerSeed, p.freelancer);
        bool expected = _active(p) && exists && caller == p.freelancer && m.status == TrustLanceEscrow.MilestoneStatus.Pending;
        _run("submitMilestone", id, caller, abi.encodeCall(escrow.submitMilestone, (id, index, CID)), expected);
    }

    function approveMilestone(uint256 projectSeed, uint256 indexSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Submitted);
        address caller = _caller(callerSeed, p.client);
        bool expected = _active(p) && exists && caller == p.client && m.status == TrustLanceEscrow.MilestoneStatus.Submitted;
        _run("approveMilestone", id, caller, abi.encodeCall(escrow.approveMilestone, (id, index)), expected);
    }

    function requestRevision(uint256 projectSeed, uint256 indexSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Submitted);
        address caller = _caller(callerSeed, p.client);
        bool expected = _active(p) && exists && caller == p.client && m.status == TrustLanceEscrow.MilestoneStatus.Submitted
            && block.timestamp < m.reviewDeadline && m.revisionCount < escrow.MAX_REVISIONS();
        bool ok = _run("requestRevision", id, caller, abi.encodeCall(escrow.requestRevision, (id, index, "fix it")), expected);
        // Invariant 11: each accepted request uses up exactly one of the milestone's revisions.
        if (ok && escrow.getMilestones(id)[index].revisionCount != m.revisionCount + 1) {
            _violate("invariant 11", "a revision request didn't count");
        }
    }

    function finalizeAutoApproval(uint256 projectSeed, uint256 indexSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Submitted);
        // Anyone may record an auto-approval.
        address caller = accounts[callerSeed % accounts.length];
        bool expected = _active(p) && exists && m.status == TrustLanceEscrow.MilestoneStatus.Submitted
            && block.timestamp >= m.reviewDeadline;
        _run("finalizeAutoApproval", id, caller, abi.encodeCall(escrow.finalizeAutoApproval, (id, index)), expected);
    }

    function refundOverdueMilestone(uint256 projectSeed, uint256 indexSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Pending);
        address caller = _caller(callerSeed, p.client);
        bool expected = _active(p) && exists && caller == p.client && m.status == TrustLanceEscrow.MilestoneStatus.Pending
            && block.timestamp >= m.deliveryDeadline;
        _run("refundOverdueMilestone", id, caller, abi.encodeCall(escrow.refundOverdueMilestone, (id, index)), expected);
    }

    function forfeit(uint256 projectSeed, uint256 callerSeed) external {
        if (_rand(callerSeed, 99) % 3 != 0) return;
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        address caller = _caller(callerSeed, p.freelancer);
        bool expected = _active(p) && caller == p.freelancer;
        _expectEarnedCredited("forfeit", id, p.freelancer, abi.encodeCall(escrow.forfeit, (id)), caller, expected);
    }

    // ================================================================== disputes

    /// Half the time only: a dispute freezes the whole project for up to 30 days.
    function raiseDispute(uint256 projectSeed, uint256 callerSeed) external {
        if (_rand(callerSeed, 99) % 2 != 0) return;
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Active);
        if (id == 0) return;
        address caller = _caller(callerSeed, callerSeed % 2 == 0 ? p.client : p.freelancer);
        bool expected = _active(p) && (caller == p.client || caller == p.freelancer) && _leftToFreeze(id) > 0;
        _expectEarnedCredited("raiseDispute", id, p.freelancer, abi.encodeCall(escrow.raiseDispute, (id, "dispute")), caller, expected);
    }

    function resolveDispute(uint256 projectSeed, uint256 callerSeed, uint256 shareSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Disputed);
        if (id == 0) return;
        address caller = _caller(callerSeed, p.arbitrator);
        uint256 maxShare = p.frozenAmount - p.frozenAmount * p.feeBps / BPS;
        // 0%, 100%, one wei too much, or anything in between.
        uint256 mode = shareSeed % 5;
        uint256 share = mode == 0 ? 0 : mode == 1 ? maxShare : mode == 2 ? maxShare + 1 : bound(shareSeed, 0, maxShare);
        bool expected = p.status == TrustLanceEscrow.ProjectStatus.Disputed && caller == p.arbitrator
            && block.timestamp < p.raisedAt + escrow.ARBITRATION_PERIOD() && share <= maxShare;
        _run("resolveDispute", id, caller, abi.encodeCall(escrow.resolveDispute, (id, share)), expected);
    }

    function settleExpiredDispute(uint256 projectSeed, uint256 callerSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pickIn(projectSeed, TrustLanceEscrow.ProjectStatus.Disputed);
        if (id == 0) return;
        address caller = _caller(callerSeed, callerSeed % 2 == 0 ? p.client : p.freelancer);
        bool expected = p.status == TrustLanceEscrow.ProjectStatus.Disputed && (caller == p.client || caller == p.freelancer)
            && block.timestamp >= p.raisedAt + escrow.ARBITRATION_PERIOD();
        uint256 freelancerBefore = escrow.withdrawable(p.freelancer);
        bool ok = _run("settleExpiredDispute", id, caller, abi.encodeCall(escrow.settleExpiredDispute, (id)), expected);
        // The fallback split: half the frozen submissions to the freelancer, the odd wei and the pending to the client.
        if (ok && escrow.withdrawable(p.freelancer) - freelancerBefore != p.frozenSubmittedAmount / 2) {
            _violate("settleExpiredDispute", "freelancer's share isn't half the frozen submissions, rounded down");
        }
    }

    // ================================================================== balances

    /// Withdrawals by anyone at any time, including while disputes are open.
    function withdraw(uint256 callerSeed) external {
        address caller = accounts[callerSeed % accounts.length];
        uint256 amount = escrow.withdrawable(caller);
        uint256 ethBefore = caller.balance;
        Snapshot memory before = _snapshot();
        vm.prank(caller);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.withdraw, ()));
        _check("withdraw", ok, amount > 0);
        if (!ok) return;
        ghostWithdrawn += amount;
        if (caller.balance - ethBefore != amount) _violate("withdraw", "paid a different amount than the balance");
        if (escrow.withdrawable(caller) != 0) _violate("withdraw", "balance not emptied");
        // Invariant 10: only the caller's own balance goes down.
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] != caller && escrow.withdrawable(accounts[i]) != before.balances[i]) {
                _violate("withdraw", "changed another account's balance");
            }
        }
        _expectTotals(before, 0, -int256(amount), "withdraw");
        _expectOthersUnchanged(before, 0, "withdraw");
    }

    // ================================================================== environment

    /// Moves time forward: a random jump, or exactly onto D - 1, D or D + 1 of a live deadline of a random project
    /// (acceptance, delivery, review or arbitration).
    function warp(uint256 seed) external {
        uint256 target;
        if (seed % 4 == 0 || projectIds.length == 0) {
            // Mostly short steps, so projects progress; sometimes a long jump past many deadlines at once.
            target = block.timestamp + bound(_rand(seed, 8), 1, seed % 32 == 0 ? 30 days : 3 days);
        } else {
            uint256 deadline = _liveDeadline(_rand(seed, 8));
            if (deadline == 0) return;
            target = deadline - 1 + _rand(seed, 128) % 3;
            if (target <= block.timestamp) return;
            exactDeadlineLandings++;
        }
        vm.warp(target);
    }

    /// Invariant 12 at the current timestamp, which `warp` often puts on D - 1 or D: for a review deadline exactly one
    /// of revision request and auto-approval works, and for an arbitration deadline exactly one of resolution and
    /// expired-dispute settlement. Both are tried from the same state and rolled back.
    function probeBoundary(uint256 projectSeed, uint256 indexSeed) external {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pick(projectSeed);
        if (id == 0) return;
        bool windowOk;
        bool expiryOk;
        if (p.status == TrustLanceEscrow.ProjectStatus.Disputed) {
            windowOk = _tryRolledBack(p.arbitrator, abi.encodeCall(escrow.resolveDispute, (id, 0)));
            expiryOk = _tryRolledBack(p.client, abi.encodeCall(escrow.settleExpiredDispute, (id)));
        } else if (_active(p)) {
            (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m) = _milestoneIn(id, indexSeed, TrustLanceEscrow.MilestoneStatus.Submitted);
            if (!exists || m.status != TrustLanceEscrow.MilestoneStatus.Submitted || m.revisionCount >= escrow.MAX_REVISIONS()) return;
            windowOk = _tryRolledBack(p.client, abi.encodeCall(escrow.requestRevision, (id, index, "")));
            expiryOk = _tryRolledBack(outsider, abi.encodeCall(escrow.finalizeAutoApproval, (id, index)));
        } else {
            return;
        }
        boundaryProbes++;
        if (windowOk == expiryOk) _violate("invariant 12", "window and expiry actions not exclusive");
    }

    /// Forces ETH in without calling the escrow.
    function forceEth(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        new ForceSender{value: amount}(payable(address(escrow)));
        ghostForced += amount;
    }

    /// Admin changes, which may only affect projects created later. Callers other than the admin must fail.
    function adminAction(uint256 actionSeed, uint256 callerSeed) external {
        address caller = callerSeed % 3 == 0 ? accounts[callerSeed % accounts.length] : admin;
        uint256 action = actionSeed % 4;
        bytes memory data;
        bool expected = caller == admin;
        if (action == 0) {
            data = abi.encodeCall(escrow.setArbitrationFeeBps, (uint16(bound(_rand(actionSeed, 8), 0, escrow.MAX_FEE_BPS()))));
        } else if (action == 1) {
            // Never a current or possible party, which createProject would then reject as client or freelancer.
            data = abi.encodeCall(escrow.setDefaultArbitrator, (arbitrators[_rand(actionSeed, 8) % 2]));
        } else if (action == 2) {
            data = abi.encodeCall(escrow.pause, ());
            expected = expected && !escrow.paused();
        } else {
            data = abi.encodeCall(escrow.unpause, ());
            expected = expected && escrow.paused();
        }
        Snapshot memory before = _snapshot();
        vm.prank(caller);
        (bool ok,) = address(escrow).call(data);
        _check("adminAction", ok, expected);
        if (!ok) return;
        // Invariant 7: the admin never moves funds or touches an existing project.
        _expectTotals(before, 0, 0, "adminAction");
        _expectNoBalanceDecrease(before, "adminAction");
        _expectOthersUnchanged(before, 0, "adminAction");
    }

    // ================================================================== call wrapper and per-call rules

    struct Snapshot {
        uint256 totalEscrow;
        uint256 totalWithdrawable;
        uint256[] balances;
        bytes32[] records;
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        s.totalEscrow = escrow.totalEscrow();
        s.totalWithdrawable = escrow.totalWithdrawable();
        s.balances = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) s.balances[i] = escrow.withdrawable(accounts[i]);
        s.records = new bytes32[](projectIds.length);
        for (uint256 i = 0; i < projectIds.length; i++) s.records[i] = _recordHash(projectIds[i]);
    }

    /// Makes one escrow call on project `id` as `caller` and checks every per-call rule.
    function _run(bytes32 action, uint256 id, address caller, bytes memory data, bool expected)
        internal
        returns (bool ok)
    {
        TrustLanceEscrow.Project memory p = escrow.getProject(id);
        Snapshot memory before = _snapshot();
        vm.prank(caller);
        (ok,) = address(escrow).call(data);
        _check(action, ok, expected);
        if (!ok) return false;

        // Invariant 10: a project action only ever raises balances.
        _expectNoBalanceDecrease(before, action);
        // Invariant 13 and project isolation: no other project's record changes.
        _expectOthersUnchanged(before, id, action);

        uint256 credited;
        uint256 arbitratorCredit;
        for (uint256 i = 0; i < accounts.length; i++) {
            uint256 delta = escrow.withdrawable(accounts[i]) - before.balances[i];
            credited += delta;
            if (accounts[i] == p.arbitrator) arbitratorCredit = delta;
            else if (delta > 0 && accounts[i] != p.client && accounts[i] != p.freelancer) {
                _violate(action, "credited an account outside the project");
            }
        }
        // Every credited wei left this project's escrow: the totals move together by exactly that much.
        _expectTotals(before, -int256(credited), int256(credited), action);
        ghostCredited[id] += credited;

        // Invariant 6: only resolution pays the arbitrator, at most the snapshot fee.
        if (arbitratorCredit > 0 && action != "resolveDispute") {
            _violate(action, "paid the arbitrator");
        }
        ghostFee[id] += arbitratorCredit;

        if (action == "resolveDispute" || action == "settleExpiredDispute") {
            ghostSettlements[id]++;
            // Invariant 13: totals change by exactly this project's frozen amount.
            if (credited != p.frozenAmount) _violate(action, "credits differ from the frozen amount");
            if (action == "resolveDispute" && arbitratorCredit != p.frozenAmount * p.feeBps / BPS) {
                _violate("resolveDispute", "fee differs from floor(frozen * feeBps / 10000)");
            }
        }
        _record(id);
    }

    /// Records the milestone statuses, revision counts and approved total after a successful call, after checking
    /// that settled milestones stayed settled (invariants 3 and 4), revision counts didn't drop (11) and the approved
    /// total didn't drop (4).
    function _record(uint256 id) internal {
        TrustLanceEscrow.Project memory p = escrow.getProject(id);
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        if (p.approvedAmount < ghostApproved[id]) _violate("invariant 4", "approved total went down");
        // Invariant 4 ("never reassigned") and 7: the parties, fee rate, windows and amounts are fixed at creation.
        if (_termsHash(id) != ghostTerms[id]) _violate("invariant 4", "a project's parties or terms changed");
        ghostApproved[id] = p.approvedAmount;
        for (uint256 i = 0; i < ms.length; i++) {
            uint8 previous = ghostStatus[id][i];
            uint8 current = uint8(ms[i].status);
            // Approved, Refunded and Resolved (the last three statuses) are final: the amount left escrow exactly once.
            if (previous >= uint8(TrustLanceEscrow.MilestoneStatus.Approved) && current != previous) _violate("invariant 3/4", "a settled milestone changed status");
            if (ms[i].revisionCount < ghostRevisions[id][i]) _violate("invariant 11", "revision count went down");
            if (ms[i].revisionCount > escrow.MAX_REVISIONS()) _violate("invariant 11", "revision count above the limit");
            ghostStatus[id][i] = current;
            ghostRevisions[id][i] = ms[i].revisionCount;
        }
    }

    function _check(bytes32 action, bool ok, bool expected) internal {
        if (ok) successes[action]++;
        else failures[action]++;
        if (ok && !expected) _violate(action, "succeeded although the guards forbid it");
        if (!ok && expected) _violate(action, "reverted although the guards allow it");
    }

    function _expectNoBalanceDecrease(Snapshot memory before, bytes32 action) internal {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (escrow.withdrawable(accounts[i]) < before.balances[i]) {
                _violate(action, "lowered a withdrawable balance");
            }
        }
    }

    function _expectOthersUnchanged(Snapshot memory before, uint256 id, bytes32 action) internal {
        for (uint256 i = 0; i < before.records.length; i++) {
            if (projectIds[i] != id && _recordHash(projectIds[i]) != before.records[i]) {
                _violate(action, "changed another project's record");
            }
        }
    }

    function _expectTotals(Snapshot memory before, int256 escrowDelta, int256 withdrawableDelta, bytes32 action) internal {
        if (int256(escrow.totalEscrow()) - int256(before.totalEscrow) != escrowDelta) {
            _violate(action, "totalEscrow moved by the wrong amount");
        }
        if (int256(escrow.totalWithdrawable()) - int256(before.totalWithdrawable) != withdrawableDelta) {
            _violate(action, "totalWithdrawable moved by the wrong amount");
        }
    }

    function _tryRolledBack(address caller, bytes memory data) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.prank(caller);
        (ok,) = address(escrow).call(data);
        vm.revertToState(snap);
    }

    function _violate(bytes32 context, string memory message) internal {
        violations.push(string.concat(_name(context), ": ", message));
    }

    // ================================================================== picking

    function _pick(uint256 seed) internal view returns (uint256 id, TrustLanceEscrow.Project memory p) {
        if (projectIds.length == 0) return (0, p);
        // Mostly a live project, so finished ones don't absorb the run; sometimes any, to try actions on finished ones.
        uint256[] memory live = _liveIds();
        id = live.length > 0 && seed % 5 != 0 ? live[_rand(seed, 16) % live.length] : projectIds[seed % projectIds.length];
        p = escrow.getProject(id);
    }

    /// Mostly a project in `status` when there is one, so each action usually meets a state where it can succeed;
    /// otherwise as `_pick`, which tries it on projects in the wrong state.
    function _pickIn(uint256 seed, TrustLanceEscrow.ProjectStatus status)
        internal
        view
        returns (uint256 id, TrustLanceEscrow.Project memory p)
    {
        if (seed % 5 != 0) {
            uint256 offset = _rand(seed, 32);
            for (uint256 k = 0; k < projectIds.length; k++) {
                uint256 candidate = projectIds[(offset + k) % projectIds.length];
                TrustLanceEscrow.Project memory q = escrow.getProject(candidate);
                // An expired open project can only be cancelled or declined, so it doesn't count as open here.
                bool expired = q.status == TrustLanceEscrow.ProjectStatus.Open && block.timestamp >= q.acceptanceDeadline;
                if (q.status == status && !expired) return (candidate, q);
            }
        }
        return _pick(seed);
    }

    function _liveIds() internal view returns (uint256[] memory live) {
        live = new uint256[](projectIds.length);
        uint256 n;
        for (uint256 k = 0; k < projectIds.length; k++) {
            TrustLanceEscrow.ProjectStatus status = escrow.getProject(projectIds[k]).status;
            if (
                status == TrustLanceEscrow.ProjectStatus.Open || status == TrustLanceEscrow.ProjectStatus.Active
                    || status == TrustLanceEscrow.ProjectStatus.Disputed
            ) live[n++] = projectIds[k];
        }
        assembly {
            mstore(live, n)
        }
    }

    /// Four times in five the authorized account, otherwise any account (including the admin and the other roles).
    function _caller(uint256 seed, address authorized) internal view returns (address) {
        return seed % 5 != 0 ? authorized : accounts[_rand(seed, 8) % accounts.length];
    }

    /// A milestone index: usually valid, sometimes one past the end, which must be rejected.
    function _milestone(uint256 id, uint256 seed)
        internal
        view
        returns (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m)
    {
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        index = seed % 10 == 0 ? ms.length : seed % ms.length;
        exists = index < ms.length;
        if (exists) m = ms[index];
    }

    /// Mostly a milestone in `status` when the project has one; otherwise as `_milestone`.
    function _milestoneIn(uint256 id, uint256 seed, TrustLanceEscrow.MilestoneStatus status)
        internal
        view
        returns (uint256 index, bool exists, TrustLanceEscrow.Milestone memory m)
    {
        if (seed % 5 != 0) {
            TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
            uint256 offset = _rand(seed, 32);
            for (uint256 k = 0; k < ms.length; k++) {
                uint256 i = (offset + k) % ms.length;
                if (ms[i].status == status) return (i, true, ms[i]);
            }
        }
        return _milestone(id, seed);
    }

    function _active(TrustLanceEscrow.Project memory p) internal pure returns (bool) {
        return p.status == TrustLanceEscrow.ProjectStatus.Active;
    }

    /// Runs a forfeit or dispute and checks invariant 4 (ADR 0003): the freelancer is first credited exactly the
    /// Submitted milestones whose review window has ended, which are earned and can't be refunded or frozen.
    function _expectEarnedCredited(
        bytes32 action,
        uint256 id,
        address projectFreelancer,
        bytes memory data,
        address caller,
        bool expected
    ) internal {
        uint256 earned;
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        for (uint256 i = 0; i < ms.length; i++) {
            if (ms[i].status == TrustLanceEscrow.MilestoneStatus.Submitted && block.timestamp >= ms[i].reviewDeadline) {
                earned += ms[i].amount;
            }
        }
        uint256 before = escrow.withdrawable(projectFreelancer);
        if (_run(action, id, caller, data, expected) && escrow.withdrawable(projectFreelancer) - before != earned) {
            _violate(action, "didn't credit the freelancer exactly the milestones whose review window ended");
        }
    }

    /// What `raiseDispute` would freeze now: Pending milestones and submissions still in review.
    function _termsHash(uint256 id) internal view returns (bytes32) {
        TrustLanceEscrow.Project memory p = escrow.getProject(id);
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        uint256[] memory amounts = new uint256[](ms.length);
        for (uint256 i = 0; i < ms.length; i++) amounts[i] = ms[i].amount;
        return keccak256(
            abi.encode(
                p.client, p.freelancer, p.arbitrator, p.feeBps, p.totalAmount, p.reviewWindow, p.acceptanceDeadline, amounts
            )
        );
    }

    function _leftToFreeze(uint256 id) internal view returns (uint256 left) {
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        for (uint256 i = 0; i < ms.length; i++) {
            if (ms[i].status == TrustLanceEscrow.MilestoneStatus.Pending) left += ms[i].amount;
            if (ms[i].status == TrustLanceEscrow.MilestoneStatus.Submitted && block.timestamp < ms[i].reviewDeadline) {
                left += ms[i].amount;
            }
        }
    }

    /// A deadline that still matters for a random project: its acceptance deadline while Open, a milestone's
    /// delivery or review deadline while Active, or its arbitration deadline while Disputed. 0 if there is none.
    function _liveDeadline(uint256 seed) internal view returns (uint256) {
        (uint256 id, TrustLanceEscrow.Project memory p) = _pick(seed);
        if (p.status == TrustLanceEscrow.ProjectStatus.Open) return p.acceptanceDeadline;
        if (p.status == TrustLanceEscrow.ProjectStatus.Disputed) return p.raisedAt + escrow.ARBITRATION_PERIOD();
        if (!_active(p)) return 0;
        TrustLanceEscrow.Milestone[] memory ms = escrow.getMilestones(id);
        uint256 offset = _rand(seed, 64);
        for (uint256 k = 0; k < ms.length; k++) {
            TrustLanceEscrow.Milestone memory m = ms[(offset + k) % ms.length];
            if (m.status == TrustLanceEscrow.MilestoneStatus.Pending) return m.deliveryDeadline;
            if (m.status == TrustLanceEscrow.MilestoneStatus.Submitted) return m.reviewDeadline;
        }
        return 0;
    }

    /// An independent pseudo-random value derived from `seed`. Bit shifts would be 0 for the small seeds the fuzzer
    /// often supplies, which made every derived choice take its minimum.
    function _rand(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _recordHash(uint256 id) internal view returns (bytes32) {
        return keccak256(abi.encode(escrow.getProject(id), escrow.getMilestones(id)));
    }

    function _name(bytes32 action) internal pure returns (string memory) {
        uint256 length;
        while (length < 32 && action[length] != 0) length++;
        bytes memory name = new bytes(length);
        for (uint256 i = 0; i < length; i++) name[i] = action[i];
        return string(name);
    }
}
