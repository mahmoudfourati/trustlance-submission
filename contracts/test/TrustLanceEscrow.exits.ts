import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const REVIEW = 7n * DAY;
const FEE_BPS = 100n;
const AMOUNTS = [ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3"), ethers.parseEther("4")];
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0n);
const PERIODS = [10n * DAY, 10n * DAY, 20n * DAY, 30n * DAY];
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

// Mirrors the contract's enums.
const ProjectStatus = { Open: 0n, Active: 1n, Completed: 2n, Cancelled: 3n } as const;
const MilestoneStatus = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n } as const;
const CreditReason = { Refund: 0n, Approval: 1n } as const;

async function createProject(escrow: Escrow, client: Signer, freelancer: Signer) {
  const now = BigInt(await networkHelpers.time.latest());
  await escrow.connect(client).createProject(
    {
      freelancer: freelancer.address,
      acceptanceDeadline: now + 7n * DAY,
      reviewWindow: REVIEW,
      title: "Mobile app",
      description: "",
      milestones: AMOUNTS.map((amount, i) => ({ amount, deliveryPeriod: PERIODS[i], title: `M${i}` })),
    },
    { value: TOTAL },
  );
  return escrow.projectCount();
}

async function deploy() {
  const [admin, arbitrator, client, freelancer, other] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, FEE_BPS]);
  return { escrow, admin, arbitrator, client, freelancer, other };
}

type Escrow = Awaited<ReturnType<typeof deploy>>["escrow"];
type Signer = Awaited<ReturnType<typeof deploy>>["client"];

/** Project #1 is Active with four Pending milestones. */
async function activeFixture() {
  const base = await deploy();
  await createProject(base.escrow, base.client, base.freelancer);
  await base.escrow.connect(base.freelancer).acceptProject(1n);
  const milestones = await base.escrow.getMilestones(1n);
  return { ...base, deliveryDeadline: milestones[0].deliveryDeadline };
}

/**
 * Project #1 with one milestone in each state forfeit has to handle:
 * M0 Approved, M1 Submitted with its review window ended, M2 Submitted inside its review window, M3 Pending.
 */
async function mixedFixture() {
  const base = await activeFixture();
  const { escrow, client, freelancer } = base;
  await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
  await escrow.connect(client).approveMilestone(1n, 0n);
  await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
  const m1ReviewDeadline = (await escrow.getMilestones(1n))[1].reviewDeadline;
  await networkHelpers.time.increaseTo(m1ReviewDeadline - 2n * DAY);
  await escrow.connect(freelancer).submitMilestone(1n, 2n, CID);
  return { ...base, m1ReviewDeadline };
}

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

async function eventCount(escrow: Escrow, tx: Promise<{ wait(): Promise<unknown> }>, name: string) {
  const receipt = (await (await tx).wait()) as { logs: Parameters<Escrow["interface"]["parseLog"]>[0][] };
  return receipt.logs.filter((log) => escrow.interface.parseLog(log)?.name === name).length;
}

describe("TrustLanceEscrow: overdue refund", function () {
  it("reverts at deliveryDeadline - 1 and refunds the client at exactly deliveryDeadline", async function () {
    const { escrow, client, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);

    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline - 1n);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "DeliveryWindowOpen")
      .withArgs(deliveryDeadline);

    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.emit(escrow, "MilestoneRefunded")
      .withArgs(1n, 0n, AMOUNTS[0])
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(client.address, 1n, AMOUNTS[0], CreditReason.Refund)
      .and.not.to.emit(escrow, "ProjectCompleted");

    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Refunded);
    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Active);
    expect(p.refundedAmount).to.equal(AMOUNTS[0]);
    expect(p.pendingAmount).to.equal(TOTAL - AMOUNTS[0]);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[0]);
    expect(await escrow.totalEscrow()).to.equal(TOTAL - AMOUNTS[0]);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("refunds a milestone only once", async function () {
    const { escrow, client, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline);
    await escrow.connect(client).refundOverdueMilestone(1n, 0n);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Refunded);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[0]);
  });

  it("rejects a refund by anyone but the client", async function () {
    const { escrow, freelancer, other, arbitrator, admin, deliveryDeadline } =
      await networkHelpers.loadFixture(activeFixture);
    await networkHelpers.time.increaseTo(deliveryDeadline);
    for (const caller of [freelancer, other, arbitrator, admin]) {
      await expect(escrow.connect(caller).refundOverdueMilestone(1n, 0n))
        .to.be.revertedWithCustomError(escrow, "NotClient")
        .withArgs(caller.address);
    }
  });

  it("lets a late submission made before the refund block it", async function () {
    const { escrow, client, freelancer, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline + DAY);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Submitted);
  });

  it("settles a refund and a late submission mined in the same block at D: exactly one wins", async function () {
    const { escrow, client, freelancer, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const gasLimit = 500_000n;
      const submit = await escrow.connect(freelancer).submitMilestone(1n, 0n, CID, { gasLimit });
      const refund = await escrow.connect(client).refundOverdueMilestone(1n, 0n, { gasLimit });
      await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline);
      await networkHelpers.mine();
      const receipts = await Promise.all([submit, refund].map((tx) => ethers.provider.getTransactionReceipt(tx.hash)));
      expect(receipts[0]!.blockNumber).to.equal(receipts[1]!.blockNumber);
      expect(receipts.map((r) => r!.status).sort()).to.deep.equal([0, 1]);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }

    const m = (await escrow.getMilestones(1n))[0];
    const p = await escrow.getProject(1n);
    if (m.status === MilestoneStatus.Submitted) {
      expect(await escrow.withdrawable(client.address)).to.equal(0n);
    } else {
      expect(m.status).to.equal(MilestoneStatus.Refunded);
      expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[0]);
    }
    expect(p.pendingAmount + p.submittedAmount + p.refundedAmount).to.equal(TOTAL);
    await expectFundsAccounted(escrow);
  });

  it("blocks a late submission once the milestone is refunded", async function () {
    const { escrow, client, freelancer, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline);
    await escrow.connect(client).refundOverdueMilestone(1n, 0n);
    await expect(escrow.connect(freelancer).submitMilestone(1n, 0n, CID))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Refunded);
  });

  it("never refunds an Approved milestone", async function () {
    const { escrow, client, freelancer, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await escrow.connect(client).approveMilestone(1n, 0n);
    await networkHelpers.time.increaseTo(deliveryDeadline + 30n * DAY);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "MilestoneNotPending")
      .withArgs(MilestoneStatus.Approved);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0]);
  });

  it("after a last-second revision, refuses a refund until the extended delivery deadline", async function () {
    const { escrow, client, freelancer, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    // The freelancer delivers 1 hour before the deadline; the client revises in the last second of the review window.
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline - HOUR);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const reviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;
    const revisedAt = reviewDeadline - 1n;
    await networkHelpers.time.setNextBlockTimestamp(revisedAt);
    await escrow.connect(client).requestRevision(1n, 0n, "");
    const extended = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    expect(extended).to.equal(revisedAt + REVIEW);

    // The original delivery deadline is long gone, yet the client can't refund straight away...
    await networkHelpers.time.setNextBlockTimestamp(revisedAt + 1n);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "DeliveryWindowOpen")
      .withArgs(extended);
    // ...nor at extended - 1...
    await networkHelpers.time.setNextBlockTimestamp(extended - 1n);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n)).to.be.revertedWithCustomError(
      escrow,
      "DeliveryWindowOpen",
    );
    // ...only from exactly the extended deadline.
    await networkHelpers.time.setNextBlockTimestamp(extended);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 0n)).to.emit(escrow, "MilestoneRefunded");
  });

  it("completes the project exactly once when the last open milestone is refunded", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    for (const i of [0n, 1n, 2n]) {
      await escrow.connect(freelancer).submitMilestone(1n, i, CID);
      await escrow.connect(client).approveMilestone(1n, i);
    }
    await networkHelpers.time.increaseTo((await escrow.getMilestones(1n))[3].deliveryDeadline);
    const tx = escrow.connect(client).refundOverdueMilestone(1n, 3n);
    expect(await eventCount(escrow, tx, "ProjectCompleted")).to.equal(1);

    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Completed);
    expect(p.refundedAmount).to.equal(AMOUNTS[3]);
    expect(p.approvedAmount).to.equal(TOTAL - AMOUNTS[3]);
    expect(await escrow.totalEscrow()).to.equal(0n);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("rejects a refund on a project that isn't Active, and on an unknown milestone", async function () {
    const base = await networkHelpers.loadFixture(deploy);
    await createProject(base.escrow, base.client, base.freelancer);
    await expect(base.escrow.connect(base.client).refundOverdueMilestone(1n, 0n))
      .to.be.revertedWithCustomError(base.escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
    await base.escrow.connect(base.freelancer).acceptProject(1n);
    await expect(base.escrow.connect(base.client).refundOverdueMilestone(1n, 4n))
      .to.be.revertedWithCustomError(base.escrow, "UnknownMilestone")
      .withArgs(4n);
  });

  it("lets the client withdraw the refund", async function () {
    const { escrow, client, deliveryDeadline } = await networkHelpers.loadFixture(activeFixture);
    await networkHelpers.time.increaseTo(deliveryDeadline);
    await escrow.connect(client).refundOverdueMilestone(1n, 0n);
    await expect(escrow.connect(client).withdraw()).to.changeEtherBalances(
      ethers,
      [client, escrow],
      [AMOUNTS[0], -AMOUNTS[0]],
    );
    await expectFundsAccounted(escrow);
  });
});

describe("TrustLanceEscrow: forfeit", function () {
  it("credits expired reviews to the freelancer, refunds the rest and completes the project", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    const refunded = AMOUNTS[2] + AMOUNTS[3];

    const tx = escrow.connect(freelancer).forfeit(1n);
    await expect(tx)
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 1n, freelancer.address, AMOUNTS[1], true)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, AMOUNTS[1], CreditReason.Approval)
      .and.to.emit(escrow, "MilestoneRefunded")
      .withArgs(1n, 2n, AMOUNTS[2])
      .and.to.emit(escrow, "MilestoneRefunded")
      .withArgs(1n, 3n, AMOUNTS[3])
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(client.address, 1n, refunded, CreditReason.Refund)
      .and.to.emit(escrow, "ProjectForfeited")
      .withArgs(1n, client.address, freelancer.address, AMOUNTS[1], refunded);

    const statuses = (await escrow.getMilestones(1n)).map((m) => m.status);
    expect(statuses).to.deep.equal([
      MilestoneStatus.Approved,
      MilestoneStatus.Approved,
      MilestoneStatus.Refunded,
      MilestoneStatus.Refunded,
    ]);
    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Completed);
    expect(p.approvedAmount).to.equal(AMOUNTS[0] + AMOUNTS[1]);
    expect(p.refundedAmount).to.equal(refunded);
    expect(p.pendingAmount).to.equal(0n);
    expect(p.submittedAmount).to.equal(0n);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0] + AMOUNTS[1]);
    expect(await escrow.withdrawable(client.address)).to.equal(refunded);
    expect(await escrow.totalEscrow()).to.equal(0n);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("emits one ProjectForfeited and no ProjectCompleted", async function () {
    const { escrow, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    const snapshot = await networkHelpers.takeSnapshot();
    expect(await eventCount(escrow, escrow.connect(freelancer).forfeit(1n), "ProjectForfeited")).to.equal(1);
    await snapshot.restore();
    expect(await eventCount(escrow, escrow.connect(freelancer).forfeit(1n), "ProjectCompleted")).to.equal(0);
  });

  it("at reviewDeadline - 1 refunds a submitted milestone; at reviewDeadline credits it", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    const snapshot = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline - 1n);
    await escrow.connect(freelancer).forfeit(1n);
    expect((await escrow.getMilestones(1n))[1].status).to.equal(MilestoneStatus.Refunded);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0]);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[1] + AMOUNTS[2] + AMOUNTS[3]);

    await snapshot.restore();
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    await escrow.connect(freelancer).forfeit(1n);
    expect((await escrow.getMilestones(1n))[1].status).to.equal(MilestoneStatus.Approved);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0] + AMOUNTS[1]);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[2] + AMOUNTS[3]);
  });

  it("never lowers the freelancer's credited total, including balances from other projects", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    // A second project between the same parties, with one approved milestone.
    await createProject(escrow, client, freelancer);
    await escrow.connect(freelancer).acceptProject(2n);
    await escrow.connect(freelancer).submitMilestone(2n, 0n, CID);
    await escrow.connect(client).approveMilestone(2n, 0n);

    const before = await escrow.withdrawable(freelancer.address);
    const otherProjectBefore = await escrow.getProject(2n);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline - 1n);
    await escrow.connect(freelancer).forfeit(1n);

    expect(await escrow.withdrawable(freelancer.address)).to.be.greaterThanOrEqual(before);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0] + AMOUNTS[0]);
    const otherProject = await escrow.getProject(2n);
    expect(otherProject.status).to.equal(ProjectStatus.Active);
    expect(otherProject.pendingAmount).to.equal(otherProjectBefore.pendingAmount);
    expect(otherProject.approvedAmount).to.equal(otherProjectBefore.approvedAmount);
    expect(await escrow.totalEscrow()).to.equal(otherProject.pendingAmount);
    await expectProjectBucketsBalanced(escrow, 1n);
    await expectProjectBucketsBalanced(escrow, 2n);
    await expectFundsAccounted(escrow);
  });

  it("credits everything to the freelancer when every open milestone's review has ended", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    for (const i of [0n, 1n, 2n, 3n]) await escrow.connect(freelancer).submitMilestone(1n, i, CID);
    await networkHelpers.time.increaseTo((await escrow.getMilestones(1n))[3].reviewDeadline);
    await expect(escrow.connect(freelancer).forfeit(1n))
      .to.emit(escrow, "ProjectForfeited")
      .withArgs(1n, client.address, freelancer.address, TOTAL, 0n)
      .and.not.to.emit(escrow, "MilestoneRefunded");
    expect(await escrow.withdrawable(freelancer.address)).to.equal(TOTAL);
    expect(await escrow.withdrawable(client.address)).to.equal(0n);
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Completed);
    await expectFundsAccounted(escrow);
  });

  it("refunds everything when nothing was delivered", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(freelancer).forfeit(1n))
      .to.emit(escrow, "ProjectForfeited")
      .withArgs(1n, client.address, freelancer.address, 0n, TOTAL)
      .and.not.to.emit(escrow, "MilestoneApproved");
    expect(await escrow.withdrawable(client.address)).to.equal(TOTAL);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(0n);
    expect(await escrow.totalEscrow()).to.equal(0n);
    await expectFundsAccounted(escrow);
  });

  it("rejects forfeit by anyone but the freelancer", async function () {
    const { escrow, client, other, arbitrator, admin } = await networkHelpers.loadFixture(activeFixture);
    for (const caller of [client, other, arbitrator, admin]) {
      await expect(escrow.connect(caller).forfeit(1n))
        .to.be.revertedWithCustomError(escrow, "NotFreelancer")
        .withArgs(caller.address);
    }
  });

  it("rejects forfeit on an Open, Cancelled or Completed project, and on an unknown one", async function () {
    const base = await networkHelpers.loadFixture(deploy);
    const { escrow, client, freelancer } = base;
    await createProject(escrow, client, freelancer);
    await expect(escrow.connect(freelancer).forfeit(1n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);
    await escrow.connect(client).cancelProject(1n);
    await expect(escrow.connect(freelancer).forfeit(1n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Cancelled);

    await createProject(escrow, client, freelancer);
    await escrow.connect(freelancer).acceptProject(2n);
    await escrow.connect(freelancer).forfeit(2n);
    await expect(escrow.connect(freelancer).forfeit(2n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
    await expect(escrow.connect(freelancer).forfeit(3n))
      .to.be.revertedWithCustomError(escrow, "UnknownProject")
      .withArgs(3n);
  });

  it("leaves no milestone action open after a forfeit", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline - 1n);
    await escrow.connect(freelancer).forfeit(1n);
    await expect(escrow.connect(client).approveMilestone(1n, 2n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);
    await expect(escrow.finalizeAutoApproval(1n, 2n)).to.be.revertedWithCustomError(escrow, "ProjectNotActive");
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 3n)).to.be.revertedWithCustomError(
      escrow,
      "ProjectNotActive",
    );
    await expect(escrow.connect(freelancer).submitMilestone(1n, 3n, CID)).to.be.revertedWithCustomError(
      escrow,
      "ProjectNotActive",
    );
  });

  it("lets both parties withdraw after a forfeit, leaving the contract with nothing for this project", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    await escrow.connect(freelancer).forfeit(1n);
    await escrow.connect(client).withdraw();
    await escrow.connect(freelancer).withdraw();
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    expect(await escrow.totalWithdrawable()).to.equal(0n);
    await expectFundsAccounted(escrow);
  });
});
