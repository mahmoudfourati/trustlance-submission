import { anyUint, anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const REVIEW = 7n * DAY;
const FEE_BPS = 100n;
const M0 = ethers.parseEther("1");
const M1 = ethers.parseEther("2.5");
const TOTAL = M0 + M1;
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const CID_2 = "bafkreidivzimqfqtoqxkrpge6bjyhlvxqs3rhe73owtmdulaxr5do5in7u";

// Mirrors the contract's enums.
const ProjectStatus = { Open: 0n, Active: 1n, Completed: 2n, Cancelled: 3n } as const;
const MilestoneStatus = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n } as const;
const CreditReason = { Refund: 0n, Approval: 1n } as const;

async function deployAndCreate() {
  const [admin, arbitrator, client, freelancer, other] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, FEE_BPS]);
  const now = BigInt(await networkHelpers.time.latest());
  await escrow.connect(client).createProject(
    {
      freelancer: freelancer.address,
      acceptanceDeadline: now + 7n * DAY,
      reviewWindow: REVIEW,
      title: "Landing page redesign",
      description: "",
      milestones: [
        { amount: M0, deliveryPeriod: 10n * DAY, title: "Wireframes" },
        { amount: M1, deliveryPeriod: 20n * DAY, title: "Build" },
      ],
    },
    { value: TOTAL },
  );
  return { escrow, admin, arbitrator, client, freelancer, other };
}

/** Project #1 is Open (not accepted). */
async function openProjectFixture() {
  return deployAndCreate();
}

/** Project #1 is Active; both milestones are Pending. */
async function activeProjectFixture() {
  const base = await deployAndCreate();
  await base.escrow.connect(base.freelancer).acceptProject(1n);
  const acceptedAt = (await base.escrow.getProject(1n)).acceptedAt;
  return { ...base, acceptedAt };
}

/** Milestone 0 of project #1 is Submitted; returns its review deadline. */
async function submittedFixture() {
  const base = await activeProjectFixture();
  await base.escrow.connect(base.freelancer).submitMilestone(1n, 0n, CID);
  const reviewDeadline = (await base.escrow.getMilestones(1n))[0].reviewDeadline;
  return { ...base, reviewDeadline };
}

type Escrow = Awaited<ReturnType<typeof deployAndCreate>>["escrow"];

/** Accounting invariant 1: every wei the contract holds is either escrowed or withdrawable. */
async function expectFundsAccounted(escrow: Escrow) {
  const balance = await ethers.provider.getBalance(await escrow.getAddress());
  expect(balance).to.equal((await escrow.totalEscrow()) + (await escrow.totalWithdrawable()));
}

/** Accounting invariant 2, before any dispute: every milestone amount sits in exactly one bucket. */
async function expectProjectBucketsBalanced(escrow: Escrow, projectId = 1n) {
  const p = await escrow.getProject(projectId);
  expect(p.pendingAmount + p.submittedAmount + p.approvedAmount + p.refundedAmount).to.equal(p.totalAmount);
}

describe("TrustLanceEscrow: submission", function () {
  it("lets the freelancer submit a Pending milestone and starts the review window", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    const now = BigInt(await networkHelpers.time.latest()) + 1n;
    await networkHelpers.time.setNextBlockTimestamp(now);

    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID))
      .to.emit(escrow, "MilestoneSubmitted")
      .withArgs(1n, 0n, freelancer.address, CID, now + REVIEW);

    const m = (await escrow.getMilestones(1n))[0];
    expect(m.status).to.equal(MilestoneStatus.Submitted);
    expect(m.submittedAt).to.equal(now);
    expect(m.reviewDeadline).to.equal(now + REVIEW);
    expect(m.deliverableCid).to.equal(CID);
    expect(m.revisionCount).to.equal(0n);

    const p = await escrow.getProject(1n);
    expect(p.pendingAmount).to.equal(M1);
    expect(p.submittedAmount).to.equal(M0);
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("allows milestones to be submitted in any order", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
    expect((await escrow.getMilestones(1n))[1].status).to.equal(MilestoneStatus.Submitted);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Pending);
  });

  it("allows a late submission while the milestone is still Pending", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    const deliveryDeadline = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline + 30n * DAY);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID)).to.emit(escrow, "MilestoneSubmitted");
  });

  it("accepts CIDs of exactly 1 and 100 bytes and rejects 0 and 101", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, "")).to.be.revertedWithCustomError(
      escrow,
      "InvalidCid",
    );
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, "b".repeat(101))).to.be.revertedWithCustomError(
      escrow,
      "InvalidCid",
    );
    await escrow.connect(freelancer).submitMilestone(1n, 0n, "b");
    await escrow.connect(freelancer).submitMilestone(1n, 1n, "b".repeat(100));
  });

  it("rejects submission by anyone but the freelancer", async function () {
    const { escrow, client, other, arbitrator } = await networkHelpers.loadFixture(activeProjectFixture);
    for (const caller of [client, other, arbitrator]) {
      await expect(escrow.connect(caller).submitMilestone(1n, 0n, CID))
        .to.be.revertedWithCustomError(escrow, "NotFreelancer")
        .withArgs(caller.address);
    }
  });

  it("rejects submitting a milestone that is already Submitted", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID_2))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Submitted);
  });

  it("rejects submitting an Approved milestone", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID_2))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Approved);
  });

  it("rejects an unknown milestone index and an unknown project", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 2n, CID))
      .to.be.revertedWithCustomError(escrow, "UnknownMilestone")
      .withArgs(2n);
    await expect(escrow.connect(freelancer).submitMilestone(2n, 0n, CID))
      .to.be.revertedWithCustomError(escrow, "UnknownProject")
      .withArgs(2n);
  });
});

describe("TrustLanceEscrow: milestone actions need an Active project", function () {
  it("rejects every milestone action on an Open project", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
    await expect(escrow.connect(client).requestRevision(1n, 0n, "fix"))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
    await expect(escrow.finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
  });

  it("rejects every milestone action on a Cancelled project", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await escrow.connect(client).cancelProject(1n);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Cancelled);
    await expect(escrow.finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Cancelled);
  });

  it("rejects every milestone action once the project is Completed", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await escrow.connect(client).approveMilestone(1n, 1n);
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Completed);

    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
    await expect(escrow.connect(client).requestRevision(1n, 0n, ""))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
    await expect(escrow.finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
  });
});

describe("TrustLanceEscrow: approval", function () {
  it("lets the client approve and credits the freelancer", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);

    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 0n, freelancer.address, M0, false)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, M0, CreditReason.Approval)
      .and.not.to.emit(escrow, "ProjectCompleted");

    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Approved);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(M0);
    expect(await escrow.totalEscrow()).to.equal(M1);
    expect(await escrow.totalWithdrawable()).to.equal(M0);
    const p = await escrow.getProject(1n);
    expect(p.submittedAmount).to.equal(0n);
    expect(p.approvedAmount).to.equal(M0);
    expect(p.status).to.equal(ProjectStatus.Active);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("lets the client approve after the review window ended too", async function () {
    const { escrow, client, reviewDeadline } = await networkHelpers.loadFixture(submittedFixture);
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline + DAY);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 0n, anyValue, M0, false);
  });

  it("rejects approval by anyone but the client", async function () {
    const { escrow, freelancer, other, arbitrator } = await networkHelpers.loadFixture(submittedFixture);
    for (const caller of [freelancer, other, arbitrator]) {
      await expect(escrow.connect(caller).approveMilestone(1n, 0n))
        .to.be.revertedWithCustomError(escrow, "NotClient")
        .withArgs(caller.address);
    }
  });

  it("rejects approving a Pending milestone", async function () {
    const { escrow, client } = await networkHelpers.loadFixture(activeProjectFixture);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotSubmitted")
      .withArgs(MilestoneStatus.Pending);
  });

  it("pays a milestone only once: a second approval or auto-approval reverts", async function () {
    const { escrow, client, freelancer, reviewDeadline } = await networkHelpers.loadFixture(submittedFixture);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotSubmitted")
      .withArgs(MilestoneStatus.Approved);
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    await expect(escrow.finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotSubmitted")
      .withArgs(MilestoneStatus.Approved);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(M0);
  });

  it("rejects an unknown milestone index", async function () {
    const { escrow, client } = await networkHelpers.loadFixture(submittedFixture);
    await expect(escrow.connect(client).approveMilestone(1n, 5n))
      .to.be.revertedWithCustomError(escrow, "UnknownMilestone")
      .withArgs(5n);
  });
});

describe("TrustLanceEscrow: completion", function () {
  it("completes the project exactly once, when the last milestone is approved", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID_2);

    await expect(escrow.connect(client).approveMilestone(1n, 1n)).not.to.emit(escrow, "ProjectCompleted");
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Active);

    const tx = escrow.connect(client).approveMilestone(1n, 0n);
    await expect(tx).to.emit(escrow, "ProjectCompleted").withArgs(1n, client.address, freelancer.address);
    const receipt = await (await tx).wait();
    const completed = receipt!.logs.filter((log) => escrow.interface.parseLog(log)?.name === "ProjectCompleted");
    expect(completed).to.have.length(1);

    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Completed);
    expect(p.approvedAmount).to.equal(TOTAL);
    expect(await escrow.totalEscrow()).to.equal(0n);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(TOTAL);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("completes the project through auto-approval too", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID_2);
    const reviewDeadline = (await escrow.getMilestones(1n))[1].reviewDeadline;
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    const receipt = await (await escrow.finalizeAutoApproval(1n, 1n)).wait();
    const completed = receipt!.logs.filter((log) => escrow.interface.parseLog(log)?.name === "ProjectCompleted");
    expect(completed).to.have.length(1);
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Completed);
  });

  it("lets the freelancer withdraw approved funds and keeps escrow for the rest", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await expect(escrow.connect(freelancer).withdraw()).to.changeEtherBalances(
      ethers,
      [freelancer, escrow],
      [M0, -M0],
    );
    expect(await escrow.totalEscrow()).to.equal(M1);
    await expectFundsAccounted(escrow);
  });
});

describe("TrustLanceEscrow: revision requests", function () {
  it("sends a submission back to Pending and records the note in the event", async function () {
    const { escrow, client, reviewDeadline } = await networkHelpers.loadFixture(submittedFixture);
    const at = reviewDeadline - 1n;
    await networkHelpers.time.setNextBlockTimestamp(at);

    await expect(escrow.connect(client).requestRevision(1n, 0n, "Please fix the header"))
      .to.emit(escrow, "RevisionRequested")
      .withArgs(1n, 0n, client.address, 1n, at + REVIEW, "Please fix the header");

    const m = (await escrow.getMilestones(1n))[0];
    expect(m.status).to.equal(MilestoneStatus.Pending);
    expect(m.revisionCount).to.equal(1n);
    const p = await escrow.getProject(1n);
    expect(p.pendingAmount).to.equal(TOTAL);
    expect(p.submittedAmount).to.equal(0n);
    await expectProjectBucketsBalanced(escrow);
  });

  it("at reviewDeadline - 1 a revision succeeds and auto-approval reverts", async function () {
    const { escrow, client, other, reviewDeadline } = await networkHelpers.loadFixture(submittedFixture);
    const snapshot = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline - 1n);
    await expect(escrow.connect(other).finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ReviewWindowOpen")
      .withArgs(reviewDeadline);

    await snapshot.restore();
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline - 1n);
    await expect(escrow.connect(client).requestRevision(1n, 0n, "")).to.emit(escrow, "RevisionRequested");
  });

  it("at exactly reviewDeadline a revision reverts and auto-approval succeeds", async function () {
    const { escrow, client, freelancer, other, reviewDeadline } = await networkHelpers.loadFixture(submittedFixture);
    const snapshot = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    await expect(escrow.connect(client).requestRevision(1n, 0n, ""))
      .to.be.revertedWithCustomError(escrow, "ReviewWindowClosed")
      .withArgs(reviewDeadline);

    await snapshot.restore();
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    await expect(escrow.connect(other).finalizeAutoApproval(1n, 0n))
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 0n, freelancer.address, M0, true)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, M0, CreditReason.Approval);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(M0);
    expect((await escrow.getProject(1n)).approvedAmount).to.equal(M0);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("lets the client or freelancer record an auto-approval as well", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID_2);
    // Milestone 1 was submitted after milestone 0, so its review deadline is the later one.
    await networkHelpers.time.setNextBlockTimestamp((await escrow.getMilestones(1n))[1].reviewDeadline);
    await escrow.connect(client).finalizeAutoApproval(1n, 0n);
    await escrow.connect(freelancer).finalizeAutoApproval(1n, 1n);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(TOTAL);
  });

  it("rejects auto-approval of a Pending milestone", async function () {
    const { escrow } = await networkHelpers.loadFixture(activeProjectFixture);
    await expect(escrow.finalizeAutoApproval(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotSubmitted")
      .withArgs(MilestoneStatus.Pending);
  });

  it("rejects a revision request by anyone but the client", async function () {
    const { escrow, freelancer, other, arbitrator } = await networkHelpers.loadFixture(submittedFixture);
    for (const caller of [freelancer, other, arbitrator]) {
      await expect(escrow.connect(caller).requestRevision(1n, 0n, ""))
        .to.be.revertedWithCustomError(escrow, "NotClient")
        .withArgs(caller.address);
    }
  });

  it("rejects a revision request on a Pending milestone", async function () {
    const { escrow, client } = await networkHelpers.loadFixture(activeProjectFixture);
    await expect(escrow.connect(client).requestRevision(1n, 0n, ""))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotSubmitted")
      .withArgs(MilestoneStatus.Pending);
  });

  it("accepts a 1000-byte note and rejects 1001 bytes", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await expect(escrow.connect(client).requestRevision(1n, 0n, "n".repeat(1001))).to.be.revertedWithCustomError(
      escrow,
      "NoteTooLong",
    );
    await escrow.connect(client).requestRevision(1n, 0n, "n".repeat(1000));
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID_2);
  });

  it("extends the delivery deadline to now + review window when it would end sooner", async function () {
    const { escrow, client, freelancer, acceptedAt } = await networkHelpers.loadFixture(activeProjectFixture);
    const original = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    expect(original).to.equal(acceptedAt + 10n * DAY);

    // Submit 1 hour before the delivery deadline, revise at the last second of the review window.
    await networkHelpers.time.setNextBlockTimestamp(original - HOUR);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const reviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;
    const revisedAt = reviewDeadline - 1n;
    await networkHelpers.time.setNextBlockTimestamp(revisedAt);
    await escrow.connect(client).requestRevision(1n, 0n, "");

    const extended = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    expect(extended).to.equal(revisedAt + REVIEW);
    // The milestone is not overdue right after the revision: the freelancer has a full review window to redeliver.
    expect(extended - revisedAt).to.equal(REVIEW);
    expect(extended > original).to.equal(true);
  });

  it("keeps a later delivery deadline when the revision comes early", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    const original = (await escrow.getMilestones(1n))[1].deliveryDeadline; // 20 days after acceptance
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
    await escrow.connect(client).requestRevision(1n, 1n, "");
    const m = (await escrow.getMilestones(1n))[1];
    expect(m.deliveryDeadline).to.equal(original);
  });

  it("caps revisions at two, keeps the count through resubmission and then only allows approval paths", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(submittedFixture);
    await escrow.connect(client).requestRevision(1n, 0n, "first");
    expect((await escrow.getMilestones(1n))[0].revisionCount).to.equal(1n);

    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID_2);
    expect((await escrow.getMilestones(1n))[0].revisionCount).to.equal(1n);
    await expect(escrow.connect(client).requestRevision(1n, 0n, "second"))
      .to.emit(escrow, "RevisionRequested")
      .withArgs(1n, 0n, client.address, 2n, anyUint, "second");

    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const m = (await escrow.getMilestones(1n))[0];
    expect(m.revisionCount).to.equal(2n);
    expect(m.deliverableCid).to.equal(CID);

    await expect(escrow.connect(client).requestRevision(1n, 0n, "third"))
      .to.be.revertedWithCustomError(escrow, "RevisionLimitReached")
      .withArgs(0n);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Submitted);
    expect((await escrow.getMilestones(1n))[0].revisionCount).to.equal(2n);

    // The remaining paths: approval now, or auto-approval at the deadline.
    const snapshot = await networkHelpers.takeSnapshot();
    await escrow.connect(client).approveMilestone(1n, 0n);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Approved);
    await snapshot.restore();
    await networkHelpers.time.setNextBlockTimestamp(m.reviewDeadline);
    await escrow.finalizeAutoApproval(1n, 0n);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Approved);
  });

  it("keeps the revision limit per milestone", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeProjectFixture);
    for (let i = 0; i < 2; i++) {
      await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
      await escrow.connect(client).requestRevision(1n, 0n, "");
    }
    await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
    await expect(escrow.connect(client).requestRevision(1n, 1n, "")).to.emit(escrow, "RevisionRequested");
  });

  it("decides payment for on-time work by D0 + 5R even when the client revises at the last second", async function () {
    const { escrow, client, freelancer, other } = await networkHelpers.loadFixture(activeProjectFixture);
    const d0 = (await escrow.getMilestones(1n))[0].deliveryDeadline;

    for (let round = 0; round < 2; round++) {
      // The freelancer delivers in the last second of the delivery window...
      const deliveryDeadline = (await escrow.getMilestones(1n))[0].deliveryDeadline;
      await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline - 1n);
      await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
      // ...and the client revises in the last second of the review window.
      const reviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;
      await networkHelpers.time.setNextBlockTimestamp(reviewDeadline - 1n);
      await escrow.connect(client).requestRevision(1n, 0n, "");
    }

    const deliveryDeadline = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    expect(deliveryDeadline <= d0 + 4n * REVIEW).to.equal(true);
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline - 1n);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const finalReviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;
    // This is the worst case: it lands within a few seconds of the bound, never past it.
    expect(finalReviewDeadline <= d0 + 5n * REVIEW).to.equal(true);
    expect(finalReviewDeadline >= d0 + 5n * REVIEW - 10n).to.equal(true);

    await expect(escrow.connect(client).requestRevision(1n, 0n, "")).to.be.revertedWithCustomError(
      escrow,
      "RevisionLimitReached",
    );
    await networkHelpers.time.setNextBlockTimestamp(finalReviewDeadline);
    await expect(escrow.connect(other).finalizeAutoApproval(1n, 0n))
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 0n, freelancer.address, M0, true);
  });
});
