// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TrustLance milestone escrow
/// @notice Holds test ETH for freelance projects, released milestone by milestone.
/// @dev Vocabulary follows CONTEXT.md; state machines and invariants live in .scratch/trustlance/spec.md.
contract TrustLanceEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    enum ProjectStatus {
        Open,
        Active,
        Completed,
        Cancelled,
        Disputed,
        Resolved
    }

    enum MilestoneStatus {
        Pending,
        Submitted,
        Approved,
        Refunded,
        Resolved
    }

    /// @dev Why a withdrawable balance was credited. New reasons are appended in later tickets.
    enum CreditReason {
        Refund,
        Approval,
        ArbitrationFee,
        DisputeSettlement
    }

    struct MilestoneInput {
        uint256 amount;
        uint32 deliveryPeriod;
        string title;
    }

    struct CreateProjectParams {
        address freelancer;
        uint64 acceptanceDeadline;
        uint32 reviewWindow;
        string title;
        string description;
        MilestoneInput[] milestones;
    }

    struct Project {
        address client;
        address freelancer;
        address arbitrator;
        uint16 feeBps;
        ProjectStatus status;
        uint8 milestoneCount;
        uint32 reviewWindow;
        uint64 createdAt;
        uint64 acceptanceDeadline;
        uint64 acceptedAt;
        uint256 totalAmount;
        uint256 pendingAmount;
        uint256 submittedAmount;
        uint256 approvedAmount;
        uint256 refundedAmount;
        /// @dev Dispute data, zero until a dispute is raised. While Disputed, the frozen milestones stay in
        /// `pendingAmount`/`submittedAmount`; resolution zeroes those and the frozen amounts remain as the record of
        /// what was paid out.
        address raisedBy;
        uint64 raisedAt;
        uint256 frozenAmount;
        uint256 frozenPendingAmount;
        uint256 frozenSubmittedAmount;
    }

    struct Milestone {
        uint256 amount;
        uint32 deliveryPeriod;
        /// @dev Zero until the project is accepted.
        uint64 deliveryDeadline;
        MilestoneStatus status;
        /// @dev Revision requests so far; only ever goes up.
        uint8 revisionCount;
        /// @dev Time of the latest submission; zero until the first one.
        uint64 submittedAt;
        /// @dev First second at which the latest submission counts as approved.
        uint64 reviewDeadline;
        /// @dev IPFS CID of the latest submission's deliverable manifest.
        string deliverableCid;
    }

    uint256 public constant MAX_MILESTONES = 20;
    uint32 public constant MIN_DELIVERY_PERIOD = 1 hours;
    uint32 public constant MAX_DELIVERY_PERIOD = 365 days;
    uint32 public constant MIN_REVIEW_WINDOW = 1 days;
    uint32 public constant MAX_REVIEW_WINDOW = 30 days;
    uint256 public constant MAX_ACCEPTANCE_WINDOW = 90 days;
    uint256 public constant MAX_TITLE_BYTES = 100;
    uint256 public constant MAX_DESCRIPTION_BYTES = 1000;
    uint256 public constant MAX_NOTE_BYTES = 1000;
    uint256 public constant MAX_CID_BYTES = 100;
    uint8 public constant MAX_REVISIONS = 2;

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 private constant BPS_DENOMINATOR = 10_000;
    /// @notice How long the arbitrator has to resolve a dispute, counted from when it was raised.
    uint64 public constant ARBITRATION_PERIOD = 30 days;

    /// @notice Block the contract was deployed in; event-log scans start here.
    uint256 public immutable deploymentBlock;

    address public defaultArbitrator;
    uint16 public arbitrationFeeBps;

    uint256 public projectCount;
    uint256 public totalEscrow;
    uint256 public totalWithdrawable;

    mapping(address account => uint256) public withdrawable;

    mapping(uint256 projectId => Project) private _projects;
    mapping(uint256 projectId => Milestone[]) private _milestones;

    // Append-only per-account indexes for dashboards. Read by views only, never looped over in a write path.
    mapping(address account => uint256[]) private _clientProjectIds;
    mapping(address account => uint256[]) private _freelancerProjectIds;
    mapping(address account => uint256[]) private _arbitratorProjectIds;

    error InvalidArbitrator(address arbitrator);
    error FeeTooHigh(uint16 feeBps);
    error UnknownProject(uint256 projectId);
    error IncorrectDeposit(uint256 expected, uint256 received);
    error InvalidFreelancer(address freelancer);
    error ClientIsArbitrator();
    error InvalidAcceptanceDeadline(uint64 deadline);
    error InvalidReviewWindow(uint32 reviewWindow);
    error InvalidTitle();
    error DescriptionTooLong();
    error InvalidMilestoneCount(uint256 count);
    error ZeroMilestoneAmount(uint256 index);
    error InvalidDeliveryPeriod(uint256 index, uint32 deliveryPeriod);
    error InvalidMilestoneTitle(uint256 index);
    error MilestoneTotalOverflow(uint256 index);
    error NotClient(address caller);
    error NotFreelancer(address caller);
    error ProjectNotOpen(ProjectStatus status);
    error AcceptanceDeadlinePassed(uint64 deadline);
    error ProjectNotActive(ProjectStatus status);
    error UnknownMilestone(uint256 index);
    error MilestoneNotPending(MilestoneStatus status);
    error MilestoneNotSubmitted(MilestoneStatus status);
    error InvalidCid();
    error NoteTooLong();
    error ReviewWindowClosed(uint64 reviewDeadline);
    error ReviewWindowOpen(uint64 reviewDeadline);
    error RevisionLimitReached(uint256 index);
    error DeliveryWindowOpen(uint64 deliveryDeadline);
    error NotProjectParty(address caller);
    error NotArbitrator(address caller);
    error InvalidReason();
    error NothingToDispute();
    error NotDisputed(ProjectStatus status);
    error ArbitrationPeriodEnded(uint64 arbitrationDeadline);
    error ArbitrationPeriodOpen(uint64 arbitrationDeadline);
    error ShareTooLarge(uint256 freelancerShare, uint256 maxShare);
    error NothingToWithdraw();
    error WithdrawalFailed();

    /// @dev Title and description live only in event data, never in storage.
    event ProjectCreated(
        uint256 indexed projectId,
        address indexed client,
        address indexed freelancer,
        address arbitrator,
        uint256 totalAmount,
        uint16 feeBps,
        uint64 acceptanceDeadline,
        uint32 reviewWindow,
        string title,
        string description
    );
    event MilestoneDefined(
        uint256 indexed projectId, uint256 indexed index, uint256 amount, uint32 deliveryPeriod, string title
    );
    event ProjectAccepted(uint256 indexed projectId, address indexed freelancer, uint64 acceptedAt);
    event ProjectDeclined(uint256 indexed projectId, address indexed freelancer);
    event ProjectCancelled(uint256 indexed projectId, address indexed client);
    event MilestoneSubmitted(
        uint256 indexed projectId, uint256 indexed index, address indexed freelancer, string cid, uint64 reviewDeadline
    );
    /// @dev The note lives only in event data.
    event RevisionRequested(
        uint256 indexed projectId,
        uint256 indexed index,
        address indexed client,
        uint8 revisionCount,
        uint64 deliveryDeadline,
        string note
    );
    event MilestoneApproved(
        uint256 indexed projectId, uint256 indexed index, address indexed freelancer, uint256 amount, bool automatic
    );
    event ProjectCompleted(uint256 indexed projectId, address indexed client, address indexed freelancer);
    /// @dev `creditedAmount` counts only the expired reviews this forfeit credited, not earlier approvals.
    event ProjectForfeited(
        uint256 indexed projectId,
        address indexed client,
        address indexed freelancer,
        uint256 creditedAmount,
        uint256 refundedAmount
    );
    event MilestoneRefunded(uint256 indexed projectId, uint256 indexed index, uint256 amount);
    event BalanceCredited(address indexed account, uint256 indexed projectId, uint256 amount, CreditReason reason);
    /// @dev The reason lives only in event data.
    event DisputeRaised(
        uint256 indexed projectId,
        address indexed raisedBy,
        address indexed arbitrator,
        uint256 frozenAmount,
        uint64 arbitrationDeadline,
        string reason
    );
    event DisputeResolved(
        uint256 indexed projectId, address indexed arbitrator, uint256 freelancerAmount, uint256 clientAmount, uint256 fee
    );
    event ExpiredDisputeSettled(
        uint256 indexed projectId, address indexed settledBy, uint256 freelancerAmount, uint256 clientAmount
    );
    event Withdrawn(address indexed account, uint256 amount);
    event DefaultArbitratorChanged(address indexed previousArbitrator, address indexed arbitrator);
    event ArbitrationFeeChanged(uint16 previousFeeBps, uint16 feeBps);

    constructor(address admin, address arbitrator, uint16 feeBps) Ownable(admin) {
        if (arbitrator == address(0)) revert InvalidArbitrator(arbitrator);
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        deploymentBlock = block.number;
        defaultArbitrator = arbitrator;
        arbitrationFeeBps = feeBps;
    }

    /// @notice Creates a project and funds every milestone in the same transaction.
    function createProject(CreateProjectParams calldata params) external payable whenNotPaused returns (uint256 projectId) {
        uint256 total = _validateCreateParams(params);
        if (msg.value != total) revert IncorrectDeposit(total, msg.value);

        projectId = ++projectCount;

        Project storage project = _projects[projectId];
        project.client = msg.sender;
        project.freelancer = params.freelancer;
        project.arbitrator = defaultArbitrator;
        project.feeBps = arbitrationFeeBps;
        project.status = ProjectStatus.Open;
        project.milestoneCount = uint8(params.milestones.length);
        project.reviewWindow = params.reviewWindow;
        project.createdAt = uint64(block.timestamp);
        project.acceptanceDeadline = params.acceptanceDeadline;
        project.totalAmount = msg.value;
        project.pendingAmount = msg.value;

        _clientProjectIds[msg.sender].push(projectId);
        _freelancerProjectIds[params.freelancer].push(projectId);
        _arbitratorProjectIds[project.arbitrator].push(projectId);

        emit ProjectCreated(
            projectId,
            msg.sender,
            params.freelancer,
            project.arbitrator,
            msg.value,
            project.feeBps,
            params.acceptanceDeadline,
            params.reviewWindow,
            params.title,
            params.description
        );

        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < params.milestones.length; i++) {
            MilestoneInput calldata input = params.milestones[i];
            milestones.push(
                Milestone({
                    amount: input.amount,
                    deliveryPeriod: input.deliveryPeriod,
                    deliveryDeadline: 0,
                    status: MilestoneStatus.Pending,
                    revisionCount: 0,
                    submittedAt: 0,
                    reviewDeadline: 0,
                    deliverableCid: ""
                })
            );
            emit MilestoneDefined(projectId, i, input.amount, input.deliveryPeriod, input.title);
        }

        totalEscrow += msg.value;
    }

    /// @notice The freelancer accepts an Open project; every delivery period starts now.
    function acceptProject(uint256 projectId) external {
        Project storage project = _openProject(projectId);
        if (msg.sender != project.freelancer) revert NotFreelancer(msg.sender);
        if (block.timestamp >= project.acceptanceDeadline) revert AcceptanceDeadlinePassed(project.acceptanceDeadline);

        project.status = ProjectStatus.Active;
        project.acceptedAt = uint64(block.timestamp);

        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < milestones.length; i++) {
            milestones[i].deliveryDeadline = uint64(block.timestamp) + milestones[i].deliveryPeriod;
        }

        emit ProjectAccepted(projectId, msg.sender, uint64(block.timestamp));
    }

    /// @notice The freelancer turns down an Open project; the client is refunded in full.
    function declineProject(uint256 projectId) external {
        Project storage project = _openProject(projectId);
        if (msg.sender != project.freelancer) revert NotFreelancer(msg.sender);

        project.status = ProjectStatus.Cancelled;
        emit ProjectDeclined(projectId, msg.sender);
        _refundAll(projectId, project);
    }

    /// @notice The client cancels a project that hasn't been accepted, including after the acceptance deadline.
    function cancelProject(uint256 projectId) external {
        Project storage project = _openProject(projectId);
        if (msg.sender != project.client) revert NotClient(msg.sender);

        project.status = ProjectStatus.Cancelled;
        emit ProjectCancelled(projectId, msg.sender);
        _refundAll(projectId, project);
    }

    /// @notice The freelancer submits a Pending milestone with its deliverable manifest CID, late or not.
    function submitMilestone(uint256 projectId, uint256 index, string calldata cid) external {
        (Project storage project, Milestone storage milestone) = _activeMilestone(projectId, index);
        if (msg.sender != project.freelancer) revert NotFreelancer(msg.sender);
        if (milestone.status != MilestoneStatus.Pending) revert MilestoneNotPending(milestone.status);
        if (bytes(cid).length == 0 || bytes(cid).length > MAX_CID_BYTES) revert InvalidCid();

        uint64 reviewDeadline = uint64(block.timestamp) + project.reviewWindow;
        milestone.status = MilestoneStatus.Submitted;
        milestone.submittedAt = uint64(block.timestamp);
        milestone.reviewDeadline = reviewDeadline;
        milestone.deliverableCid = cid;
        project.pendingAmount -= milestone.amount;
        project.submittedAmount += milestone.amount;

        emit MilestoneSubmitted(projectId, index, msg.sender, cid, reviewDeadline);
    }

    /// @notice The client approves a Submitted milestone and its amount is credited to the freelancer.
    function approveMilestone(uint256 projectId, uint256 index) external {
        (Project storage project, Milestone storage milestone) = _activeMilestone(projectId, index);
        if (msg.sender != project.client) revert NotClient(msg.sender);
        if (milestone.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted(milestone.status);

        _approve(projectId, index, project, milestone, false);
        _completeIfSettled(projectId, project);
    }

    /// @notice The client sends a Submitted milestone back inside its review window, at most MAX_REVISIONS times.
    /// @dev The delivery deadline moves to at least now + review window, so the client can't refund it straight away.
    function requestRevision(uint256 projectId, uint256 index, string calldata note) external {
        (Project storage project, Milestone storage milestone) = _activeMilestone(projectId, index);
        if (msg.sender != project.client) revert NotClient(msg.sender);
        if (milestone.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted(milestone.status);
        if (block.timestamp >= milestone.reviewDeadline) revert ReviewWindowClosed(milestone.reviewDeadline);
        if (milestone.revisionCount >= MAX_REVISIONS) revert RevisionLimitReached(index);
        if (bytes(note).length > MAX_NOTE_BYTES) revert NoteTooLong();

        uint64 extended = uint64(block.timestamp) + project.reviewWindow;
        if (extended > milestone.deliveryDeadline) milestone.deliveryDeadline = extended;
        milestone.status = MilestoneStatus.Pending;
        milestone.revisionCount += 1;
        project.submittedAmount -= milestone.amount;
        project.pendingAmount += milestone.amount;

        emit RevisionRequested(projectId, index, msg.sender, milestone.revisionCount, milestone.deliveryDeadline, note);
    }

    /// @notice Anyone records the approval of a Submitted milestone whose review window has ended (ADR 0003).
    function finalizeAutoApproval(uint256 projectId, uint256 index) external {
        (Project storage project, Milestone storage milestone) = _activeMilestone(projectId, index);
        if (milestone.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted(milestone.status);
        if (block.timestamp < milestone.reviewDeadline) revert ReviewWindowOpen(milestone.reviewDeadline);

        _approve(projectId, index, project, milestone, true);
        _completeIfSettled(projectId, project);
    }

    /// @notice The client takes back a Pending milestone from its delivery deadline on. A late submission mined
    /// first wins: the milestone is then Submitted and can't be refunded.
    function refundOverdueMilestone(uint256 projectId, uint256 index) external {
        (Project storage project, Milestone storage milestone) = _activeMilestone(projectId, index);
        if (msg.sender != project.client) revert NotClient(msg.sender);
        if (milestone.status != MilestoneStatus.Pending) revert MilestoneNotPending(milestone.status);
        if (block.timestamp < milestone.deliveryDeadline) revert DeliveryWindowOpen(milestone.deliveryDeadline);

        uint256 amount = _refundMilestone(projectId, index, project, milestone);
        totalEscrow -= amount;
        _credit(project.client, projectId, amount, CreditReason.Refund);
        _completeIfSettled(projectId, project);
    }

    /// @notice The freelancer gives up the rest of an Active project. Submitted milestones whose review window has
    /// ended are credited to the freelancer first (ADR 0003); every other unapproved milestone is refunded to the
    /// client, and the project is Completed. Forfeit emits `ProjectForfeited` in place of `ProjectCompleted`, after
    /// the credits it causes.
    function forfeit(uint256 projectId) external {
        _requireProject(projectId);
        Project storage project = _projects[projectId];
        if (project.status != ProjectStatus.Active) revert ProjectNotActive(project.status);
        if (msg.sender != project.freelancer) revert NotFreelancer(msg.sender);

        project.status = ProjectStatus.Completed;
        uint256 credited = _creditExpiredReviews(projectId, project);
        uint256 refunded;
        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < milestones.length; i++) {
            Milestone storage milestone = milestones[i];
            if (milestone.status == MilestoneStatus.Pending || milestone.status == MilestoneStatus.Submitted) {
                refunded += _refundMilestone(projectId, i, project, milestone);
            }
        }

        if (refunded > 0) {
            totalEscrow -= refunded;
            _credit(project.client, projectId, refunded, CreditReason.Refund);
        }
        emit ProjectForfeited(projectId, project.client, msg.sender, credited, refunded);
    }

    /// @notice The client or freelancer hands the rest of an Active project to its arbitrator. Submitted milestones
    /// whose review window has ended are credited to the freelancer first (ADR 0003); every other Pending or
    /// Submitted milestone is frozen and keeps its status until the dispute settles.
    function raiseDispute(uint256 projectId, string calldata reason) external {
        _requireProject(projectId);
        Project storage project = _projects[projectId];
        if (project.status != ProjectStatus.Active) revert ProjectNotActive(project.status);
        if (msg.sender != project.client && msg.sender != project.freelancer) revert NotProjectParty(msg.sender);
        if (bytes(reason).length == 0 || bytes(reason).length > MAX_NOTE_BYTES) revert InvalidReason();

        project.status = ProjectStatus.Disputed;
        _creditExpiredReviews(projectId, project);

        uint256 frozen = project.pendingAmount + project.submittedAmount;
        if (frozen == 0) revert NothingToDispute();
        project.raisedBy = msg.sender;
        project.raisedAt = uint64(block.timestamp);
        project.frozenAmount = frozen;
        project.frozenPendingAmount = project.pendingAmount;
        project.frozenSubmittedAmount = project.submittedAmount;

        emit DisputeRaised(
            projectId, msg.sender, project.arbitrator, frozen, _arbitrationDeadline(project), reason
        );
    }

    /// @notice The project's arbitrator splits the frozen funds before the arbitration period ends: the fee (at the
    /// rate snapshotted at creation) to the arbitrator, `freelancerShare` to the freelancer and the rest to the client.
    function resolveDispute(uint256 projectId, uint256 freelancerShare) external {
        Project storage project = _disputedProject(projectId);
        if (msg.sender != project.arbitrator) revert NotArbitrator(msg.sender);
        uint64 arbitrationDeadline = _arbitrationDeadline(project);
        if (block.timestamp >= arbitrationDeadline) revert ArbitrationPeriodEnded(arbitrationDeadline);

        uint256 frozen = project.frozenAmount;
        uint256 fee = frozen * project.feeBps / BPS_DENOMINATOR;
        if (freelancerShare > frozen - fee) revert ShareTooLarge(freelancerShare, frozen - fee);
        uint256 clientAmount = frozen - fee - freelancerShare;

        _payOutDispute(projectId, project, fee, freelancerShare, clientAmount);
        emit DisputeResolved(projectId, msg.sender, freelancerShare, clientAmount, fee);
    }

    /// @notice From the end of the arbitration period, the client or freelancer applies the fixed fallback split the
    /// arbitrator didn't replace: frozen pending milestones go back to the client, frozen submitted milestones are
    /// split in half (the odd wei to the client), and no fee is charged.
    function settleExpiredDispute(uint256 projectId) external {
        Project storage project = _disputedProject(projectId);
        if (msg.sender != project.client && msg.sender != project.freelancer) revert NotProjectParty(msg.sender);
        uint64 arbitrationDeadline = _arbitrationDeadline(project);
        if (block.timestamp < arbitrationDeadline) revert ArbitrationPeriodOpen(arbitrationDeadline);

        uint256 freelancerAmount = project.frozenSubmittedAmount / 2;
        uint256 clientAmount = project.frozenPendingAmount + (project.frozenSubmittedAmount - freelancerAmount);

        _payOutDispute(projectId, project, 0, freelancerAmount, clientAmount);
        emit ExpiredDisputeSettled(projectId, msg.sender, freelancerAmount, clientAmount);
    }

    /// @notice Sets the arbitrator copied into projects created from now on. Existing projects keep theirs.
    function setDefaultArbitrator(address arbitrator) external onlyOwner {
        if (arbitrator == address(0)) revert InvalidArbitrator(arbitrator);
        emit DefaultArbitratorChanged(defaultArbitrator, arbitrator);
        defaultArbitrator = arbitrator;
    }

    /// @notice Sets the fee rate copied into projects created from now on, at most MAX_FEE_BPS.
    function setArbitrationFeeBps(uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        emit ArbitrationFeeChanged(arbitrationFeeBps, feeBps);
        arbitrationFeeBps = feeBps;
    }

    /// @notice Stops new projects. Existing projects, disputes and withdrawals are unaffected.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Sends the caller's whole withdrawable balance. The only function that sends ETH.
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[msg.sender] = 0;
        totalWithdrawable -= amount;
        emit Withdrawn(msg.sender, amount);

        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert WithdrawalFailed();
    }

    /// @dev Refunds every milestone of a project that was never accepted, so all of them are still Pending.
    function _refundAll(uint256 projectId, Project storage project) private {
        uint256 amount;
        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < milestones.length; i++) {
            amount += _refundMilestone(projectId, i, project, milestones[i]);
        }

        totalEscrow -= amount;
        _credit(project.client, projectId, amount, CreditReason.Refund);
    }

    /// @dev Marks a milestone Refunded and moves its amount into the project's refunded total. Precondition: the
    /// milestone is Pending or Submitted; every caller checks this, since Approved and Refunded milestones are final.
    /// The caller lowers `totalEscrow` and credits the client, so several refunds can share one credit.
    function _refundMilestone(uint256 projectId, uint256 index, Project storage project, Milestone storage milestone)
        private
        returns (uint256 amount)
    {
        amount = milestone.amount;
        if (milestone.status == MilestoneStatus.Submitted) {
            project.submittedAmount -= amount;
        } else {
            // Pending, by the precondition above.
            project.pendingAmount -= amount;
        }
        project.refundedAmount += amount;
        milestone.status = MilestoneStatus.Refunded;
        emit MilestoneRefunded(projectId, index, amount);
    }

    /// @dev Moves a Submitted milestone to Approved and credits the freelancer. Callers decide whether the project
    /// completes.
    function _approve(
        uint256 projectId,
        uint256 index,
        Project storage project,
        Milestone storage milestone,
        bool automatic
    ) private {
        uint256 amount = milestone.amount;
        milestone.status = MilestoneStatus.Approved;
        project.submittedAmount -= amount;
        project.approvedAmount += amount;
        totalEscrow -= amount;

        emit MilestoneApproved(projectId, index, project.freelancer, amount, automatic);
        _credit(project.freelancer, projectId, amount, CreditReason.Approval);
    }

    /// @dev Approves every Submitted milestone whose review window has ended (ADR 0003), so a forfeit or dispute
    /// can't refund or freeze money the freelancer has already earned. Returns the amount credited.
    function _creditExpiredReviews(uint256 projectId, Project storage project) private returns (uint256 credited) {
        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < milestones.length; i++) {
            Milestone storage milestone = milestones[i];
            if (milestone.status == MilestoneStatus.Submitted && block.timestamp >= milestone.reviewDeadline) {
                credited += milestone.amount;
                _approve(projectId, i, project, milestone, true);
            }
        }
    }

    /// @dev Ends a dispute, by resolution or expired settlement: the project is Resolved before anything is credited, so
    /// it can't pay out twice. The three amounts must add up to the frozen amount; zero amounts aren't credited.
    function _payOutDispute(
        uint256 projectId,
        Project storage project,
        uint256 fee,
        uint256 freelancerAmount,
        uint256 clientAmount
    ) private {
        project.status = ProjectStatus.Resolved;
        _resolveFrozenMilestones(projectId, project);
        totalEscrow -= project.frozenAmount;

        if (fee > 0) _credit(project.arbitrator, projectId, fee, CreditReason.ArbitrationFee);
        if (freelancerAmount > 0) _credit(project.freelancer, projectId, freelancerAmount, CreditReason.DisputeSettlement);
        if (clientAmount > 0) _credit(project.client, projectId, clientAmount, CreditReason.DisputeSettlement);
    }

    /// @dev Marks every frozen (Pending or Submitted) milestone Resolved and empties the project's open totals.
    function _resolveFrozenMilestones(uint256 projectId, Project storage project) private {
        Milestone[] storage milestones = _milestones[projectId];
        for (uint256 i = 0; i < milestones.length; i++) {
            MilestoneStatus status = milestones[i].status;
            if (status == MilestoneStatus.Pending || status == MilestoneStatus.Submitted) {
                milestones[i].status = MilestoneStatus.Resolved;
            }
        }
        project.pendingAmount = 0;
        project.submittedAmount = 0;
    }

    function _completeIfSettled(uint256 projectId, Project storage project) private {
        if (project.pendingAmount != 0 || project.submittedAmount != 0) return;
        project.status = ProjectStatus.Completed;
        emit ProjectCompleted(projectId, project.client, project.freelancer);
    }

    function _credit(address account, uint256 projectId, uint256 amount, CreditReason reason) private {
        withdrawable[account] += amount;
        totalWithdrawable += amount;
        emit BalanceCredited(account, projectId, amount, reason);
    }

    /// @dev First second of expired settlement; the arbitrator can resolve until one second before (half-open).
    function _arbitrationDeadline(Project storage project) private view returns (uint64) {
        return project.raisedAt + ARBITRATION_PERIOD;
    }

    function _disputedProject(uint256 projectId) private view returns (Project storage project) {
        _requireProject(projectId);
        project = _projects[projectId];
        if (project.status != ProjectStatus.Disputed) revert NotDisputed(project.status);
    }

    function _openProject(uint256 projectId) private view returns (Project storage project) {
        _requireProject(projectId);
        project = _projects[projectId];
        if (project.status != ProjectStatus.Open) revert ProjectNotOpen(project.status);
    }

    function _activeMilestone(uint256 projectId, uint256 index)
        private
        view
        returns (Project storage project, Milestone storage milestone)
    {
        _requireProject(projectId);
        project = _projects[projectId];
        if (project.status != ProjectStatus.Active) revert ProjectNotActive(project.status);
        Milestone[] storage milestones = _milestones[projectId];
        if (index >= milestones.length) revert UnknownMilestone(index);
        milestone = milestones[index];
    }

    /// @dev Checks every creation bound and returns the milestone total.
    function _validateCreateParams(CreateProjectParams calldata params) private view returns (uint256 total) {
        address arbitrator = defaultArbitrator;
        if (msg.sender == arbitrator) revert ClientIsArbitrator();
        if (params.freelancer == address(0) || params.freelancer == msg.sender || params.freelancer == arbitrator) {
            revert InvalidFreelancer(params.freelancer);
        }
        if (params.acceptanceDeadline <= block.timestamp || params.acceptanceDeadline > block.timestamp + MAX_ACCEPTANCE_WINDOW)
        {
            revert InvalidAcceptanceDeadline(params.acceptanceDeadline);
        }
        if (params.reviewWindow < MIN_REVIEW_WINDOW || params.reviewWindow > MAX_REVIEW_WINDOW) {
            revert InvalidReviewWindow(params.reviewWindow);
        }
        if (bytes(params.title).length == 0 || bytes(params.title).length > MAX_TITLE_BYTES) revert InvalidTitle();
        if (bytes(params.description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();

        uint256 count = params.milestones.length;
        if (count == 0 || count > MAX_MILESTONES) revert InvalidMilestoneCount(count);
        for (uint256 i = 0; i < count; i++) {
            MilestoneInput calldata input = params.milestones[i];
            if (input.amount == 0) revert ZeroMilestoneAmount(i);
            if (input.deliveryPeriod < MIN_DELIVERY_PERIOD || input.deliveryPeriod > MAX_DELIVERY_PERIOD) {
                revert InvalidDeliveryPeriod(i, input.deliveryPeriod);
            }
            if (bytes(input.title).length == 0 || bytes(input.title).length > MAX_TITLE_BYTES) {
                revert InvalidMilestoneTitle(i);
            }
            if (input.amount > type(uint256).max - total) revert MilestoneTotalOverflow(i);
            total += input.amount;
        }
    }

    function getProject(uint256 projectId) external view returns (Project memory) {
        _requireProject(projectId);
        return _projects[projectId];
    }

    function getMilestones(uint256 projectId) external view returns (Milestone[] memory) {
        _requireProject(projectId);
        return _milestones[projectId];
    }

    function projectIdsAsClient(address account) external view returns (uint256[] memory) {
        return _clientProjectIds[account];
    }

    function projectIdsAsFreelancer(address account) external view returns (uint256[] memory) {
        return _freelancerProjectIds[account];
    }

    function projectIdsAsArbitrator(address account) external view returns (uint256[] memory) {
        return _arbitratorProjectIds[account];
    }

    function _requireProject(uint256 projectId) private view {
        if (projectId == 0 || projectId > projectCount) revert UnknownProject(projectId);
    }
}
