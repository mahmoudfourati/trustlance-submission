import { expect } from "chai";
import type { Result } from "ethers";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const REVIEW = 7n * DAY;
const ARBITRATION_PERIOD = 30n * DAY;
const FEE_BPS = 100n;
const AMOUNTS = [ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3"), ethers.parseEther("4")];
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0n);
const PERIODS = [10n * DAY, 10n * DAY, 20n * DAY, 30n * DAY];
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const REASON = "The delivered app crashes on start.";

// Mirrors the contract's enums.
const ProjectStatus = { Open: 0n, Active: 1n, Completed: 2n, Cancelled: 3n, Disputed: 4n, Resolved: 5n } as const;
const MilestoneStatus = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n, Resolved: 4n } as const;
const CreditReason = { Refund: 0n, Approval: 1n, ArbitrationFee: 2n, DisputeSettlement: 3n } as const;
const ReceiveMode = { Accept: 0n, Revert: 1n, Reenter: 2n } as const;

async function deploy() {
  const [admin, arbitrator, client, freelancer, other, arbitrator2] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, FEE_BPS]);
  return { escrow, admin, arbitrator, client, freelancer, other, arbitrator2 };
}

type Escrow = Awaited<ReturnType<typeof deploy>>["escrow"];
type Signer = Awaited<ReturnType<typeof deploy>>["client"];

async function createProject(
  escrow: Escrow,
  client: Signer,
  freelancer: Signer,
  amounts: bigint[] = AMOUNTS,
  periods: bigint[] = PERIODS,
) {
  const now = BigInt(await networkHelpers.time.latest());
  await escrow.connect(client).createProject(
    {
      freelancer: freelancer.address,
      acceptanceDeadline: now + 7n * DAY,
      reviewWindow: REVIEW,
      title: "Mobile app",
      description: "",
      milestones: amounts.map((amount, i) => ({ amount, deliveryPeriod: periods[i] ?? 10n * DAY, title: `M${i}` })),
    },
    { value: amounts.reduce((a, b) => a + b, 0n) },
  );
  return escrow.projectCount();
}

async function createActiveProject(
  escrow: Escrow,
  client: Signer,
  freelancer: Signer,
  amounts: bigint[] = AMOUNTS,
  periods: bigint[] = PERIODS,
) {
  const id = await createProject(escrow, client, freelancer, amounts, periods);
  await escrow.connect(freelancer).acceptProject(id);
  return id;
}

/** Project #1 is Active with four Pending milestones. */
async function activeFixture() {
  const base = await deploy();
  await createActiveProject(base.escrow, base.client, base.freelancer);
  return base;
}

/** Project #1 is Disputed by the client with all four milestones Pending, so the whole TOTAL is frozen. */
async function disputedFixture() {
  const base = await activeFixture();
  await base.escrow.connect(base.client).raiseDispute(1n, REASON);
  const raisedAt = (await base.escrow.getProject(1n)).raisedAt;
  return { ...base, raisedAt, arbitrationDeadline: raisedAt + ARBITRATION_PERIOD };
}

/**
 * Project #1 with one milestone in each state a dispute has to handle:
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

/**
 * Accounting invariant 2. While a project is Disputed its frozen milestones stay in the pending and submitted
 * totals; once Resolved those totals are zero and the frozen amount has been paid out.
 */
async function expectProjectBucketsBalanced(escrow: Escrow, projectId = 1n) {
  const p = await escrow.getProject(projectId);
  const settled = p.status === ProjectStatus.Resolved ? p.frozenAmount : 0n;
  expect(p.pendingAmount + p.submittedAmount + p.approvedAmount + p.refundedAmount + settled).to.equal(p.totalAmount);
  if (p.status === ProjectStatus.Disputed) {
    expect(p.pendingAmount).to.equal(p.frozenPendingAmount);
    expect(p.submittedAmount).to.equal(p.frozenSubmittedAmount);
  }
}

async function balancesOf(escrow: Escrow, accounts: Signer[]) {
  return Promise.all(accounts.map((a) => escrow.withdrawable(a.address)));
}

async function eventCount(escrow: Escrow, tx: Promise<{ wait(): Promise<unknown> }>, name: string) {
  const receipt = (await (await tx).wait()) as { logs: Parameters<Escrow["interface"]["parseLog"]>[0][] };
  return receipt.logs.filter((log) => escrow.interface.parseLog(log)?.name === name).length;
}

/** Plain-object snapshot of a project and its milestones, for "unchanged" comparisons. */
async function snapshot(escrow: Escrow, projectId: bigint) {
  return {
    project: (await escrow.getProject(projectId) as unknown as Result).toObject(true),
    milestones: (await escrow.getMilestones(projectId)).map((m) => (m as unknown as Result).toObject(true)),
  };
}

describe("TrustLanceEscrow: raise a dispute", function () {
  it("lets the client freeze every unsettled milestone", async function () {
    const { escrow, client, arbitrator } = await networkHelpers.loadFixture(activeFixture);
    const raisedAt = BigInt(await networkHelpers.time.latest()) + 10n;
    await networkHelpers.time.setNextBlockTimestamp(raisedAt);

    await expect(escrow.connect(client).raiseDispute(1n, REASON))
      .to.emit(escrow, "DisputeRaised")
      .withArgs(1n, client.address, arbitrator.address, TOTAL, raisedAt + ARBITRATION_PERIOD, REASON)
      .and.not.to.emit(escrow, "BalanceCredited");

    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Disputed);
    expect(p.raisedBy).to.equal(client.address);
    expect(p.raisedAt).to.equal(raisedAt);
    expect(p.frozenAmount).to.equal(TOTAL);
    expect(p.frozenPendingAmount).to.equal(TOTAL);
    expect(p.frozenSubmittedAmount).to.equal(0n);
    // Milestones keep their status while frozen.
    for (const m of await escrow.getMilestones(1n)) expect(m.status).to.equal(MilestoneStatus.Pending);
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("lets the freelancer raise one too", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(freelancer).raiseDispute(1n, REASON)).to.emit(escrow, "DisputeRaised");
    expect((await escrow.getProject(1n)).raisedBy).to.equal(freelancer.address);
  });

  it("rejects anyone but the client or freelancer, including the arbitrator and the admin", async function () {
    const { escrow, admin, arbitrator, other } = await networkHelpers.loadFixture(activeFixture);
    for (const caller of [arbitrator, admin, other]) {
      await expect(escrow.connect(caller).raiseDispute(1n, REASON))
        .to.be.revertedWithCustomError(escrow, "NotProjectParty")
        .withArgs(caller.address);
    }
  });

  it("needs a reason of 1 to 1000 bytes", async function () {
    const { escrow, client } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(client).raiseDispute(1n, "")).to.be.revertedWithCustomError(escrow, "InvalidReason");
    await expect(escrow.connect(client).raiseDispute(1n, "x".repeat(1001))).to.be.revertedWithCustomError(
      escrow,
      "InvalidReason",
    );
    await expect(escrow.connect(client).raiseDispute(1n, "x".repeat(1000))).to.emit(escrow, "DisputeRaised");
  });

  it("only works on an Active project", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(client).raiseDispute(99n, REASON))
      .to.be.revertedWithCustomError(escrow, "UnknownProject")
      .withArgs(99n);

    const open = await createProject(escrow, client, freelancer);
    await expect(escrow.connect(client).raiseDispute(open, REASON))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Open);

    await escrow.connect(client).cancelProject(open);
    await expect(escrow.connect(client).raiseDispute(open, REASON))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Cancelled);

    const completed = await createActiveProject(escrow, client, freelancer, [1n]);
    await escrow.connect(freelancer).forfeit(completed);
    await expect(escrow.connect(freelancer).raiseDispute(completed, REASON))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Completed);

    await escrow.connect(client).raiseDispute(1n, REASON);
    await expect(escrow.connect(freelancer).raiseDispute(1n, REASON))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Disputed);
  });

  it("freezes a submitted milestone at reviewDeadline - 1", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const reviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;

    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline - 1n);
    await expect(escrow.connect(client).raiseDispute(1n, REASON))
      .to.emit(escrow, "DisputeRaised")
      .and.not.to.emit(escrow, "MilestoneApproved");

    const p = await escrow.getProject(1n);
    expect(p.frozenAmount).to.equal(TOTAL);
    expect(p.frozenSubmittedAmount).to.equal(AMOUNTS[0]);
    expect(p.frozenPendingAmount).to.equal(TOTAL - AMOUNTS[0]);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Submitted);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(0n);
    await expectProjectBucketsBalanced(escrow);
  });

  it("credits a submitted milestone to the freelancer first at exactly reviewDeadline", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(activeFixture);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    const reviewDeadline = (await escrow.getMilestones(1n))[0].reviewDeadline;

    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    const tx = escrow.connect(client).raiseDispute(1n, REASON);
    await expect(tx)
      .to.emit(escrow, "MilestoneApproved")
      .withArgs(1n, 0n, freelancer.address, AMOUNTS[0], true)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, AMOUNTS[0], CreditReason.Approval)
      .and.to.emit(escrow, "DisputeRaised")
      .withArgs(1n, client.address, arbitrator.address, TOTAL - AMOUNTS[0], reviewDeadline + ARBITRATION_PERIOD, REASON);

    // The credit is logged before the freeze.
    const receipt = await (await tx).wait();
    const names = receipt!.logs.map((log) => escrow.interface.parseLog(log)?.name);
    expect(names).to.deep.equal(["MilestoneApproved", "BalanceCredited", "DisputeRaised"]);

    const p = await escrow.getProject(1n);
    expect(p.frozenAmount).to.equal(TOTAL - AMOUNTS[0]);
    expect(p.frozenSubmittedAmount).to.equal(0n);
    expect(p.approvedAmount).to.equal(AMOUNTS[0]);
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Approved);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0]);
    expect(await escrow.totalEscrow()).to.equal(TOTAL - AMOUNTS[0]);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("leaves approved milestones and existing balances alone, and credits only expired reviews", async function () {
    const { escrow, client, freelancer, arbitrator, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    // A refund on another project gives the client an existing balance too.
    const other = await createActiveProject(escrow, client, freelancer, [5n], [HOUR]);
    await networkHelpers.time.increaseTo(m1ReviewDeadline);
    await escrow.connect(client).refundOverdueMilestone(other, 0n);
    const [clientBefore, freelancerBefore, arbitratorBefore] = await balancesOf(escrow, [client, freelancer, arbitrator]);
    expect(clientBefore).to.equal(5n);
    expect(freelancerBefore).to.equal(AMOUNTS[0]);

    await escrow.connect(freelancer).raiseDispute(1n, REASON);

    const milestones = await escrow.getMilestones(1n);
    expect(milestones.map((m) => m.status)).to.deep.equal([
      MilestoneStatus.Approved,
      MilestoneStatus.Approved,
      MilestoneStatus.Submitted,
      MilestoneStatus.Pending,
    ]);
    const p = await escrow.getProject(1n);
    expect(p.frozenAmount).to.equal(AMOUNTS[2] + AMOUNTS[3]);
    expect(p.frozenSubmittedAmount).to.equal(AMOUNTS[2]);
    expect(p.frozenPendingAmount).to.equal(AMOUNTS[3]);
    expect(p.approvedAmount).to.equal(AMOUNTS[0] + AMOUNTS[1]);
    expect(await balancesOf(escrow, [client, freelancer, arbitrator])).to.deep.equal([
      clientBefore,
      freelancerBefore + AMOUNTS[1],
      arbitratorBefore,
    ]);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("reverts with NothingToDispute when every unsettled milestone is an expired review, changing nothing", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    const id = await createActiveProject(escrow, client, freelancer, [7n]);
    await escrow.connect(freelancer).submitMilestone(id, 0n, CID);
    const reviewDeadline = (await escrow.getMilestones(id))[0].reviewDeadline;
    await networkHelpers.time.setNextBlockTimestamp(reviewDeadline);
    await expect(escrow.connect(client).raiseDispute(id, REASON)).to.be.revertedWithCustomError(escrow, "NothingToDispute");

    expect((await escrow.getProject(id)).status).to.equal(ProjectStatus.Active);
    expect((await escrow.getMilestones(id))[0].status).to.equal(MilestoneStatus.Submitted);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(0n);
  });

  it("blocks every milestone action and forfeit while Disputed", async function () {
    const { escrow, client, freelancer, other } = await networkHelpers.loadFixture(mixedFixture);
    await escrow.connect(client).raiseDispute(1n, REASON);
    const disputed = [escrow, "ProjectNotActive"] as const;

    await expect(escrow.connect(freelancer).submitMilestone(1n, 3n, CID))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
    await expect(escrow.connect(client).approveMilestone(1n, 2n))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
    await expect(escrow.connect(client).requestRevision(1n, 2n, ""))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
    await networkHelpers.time.increase(60n * DAY);
    await expect(escrow.connect(other).finalizeAutoApproval(1n, 2n))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
    await expect(escrow.connect(client).refundOverdueMilestone(1n, 3n))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
    await expect(escrow.connect(freelancer).forfeit(1n))
      .to.be.revertedWithCustomError(...disputed)
      .withArgs(ProjectStatus.Disputed);
  });

  it("lets the freelancer withdraw earlier earnings while the dispute is open", async function () {
    const { escrow, client, freelancer, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    await escrow.connect(client).raiseDispute(1n, REASON);
    const earned = AMOUNTS[0] + AMOUNTS[1];

    await expect(escrow.connect(freelancer).withdraw()).to.changeEtherBalance(ethers, freelancer, earned);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(0n);
    // The frozen funds are still escrowed.
    expect(await escrow.totalEscrow()).to.equal(AMOUNTS[2] + AMOUNTS[3]);
    await expectFundsAccounted(escrow);
  });
});

describe("TrustLanceEscrow: resolve a dispute", function () {
  it("splits the frozen funds: fee to the arbitrator, the share to the freelancer, the rest to the client", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(disputedFixture);
    const fee = (TOTAL * FEE_BPS) / 10_000n;
    const share = ethers.parseEther("4");
    const clientAmount = TOTAL - fee - share;

    const tx = escrow.connect(arbitrator).resolveDispute(1n, share);
    await expect(tx)
      .to.emit(escrow, "BalanceCredited")
      .withArgs(arbitrator.address, 1n, fee, CreditReason.ArbitrationFee)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, share, CreditReason.DisputeSettlement)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(client.address, 1n, clientAmount, CreditReason.DisputeSettlement)
      .and.to.emit(escrow, "DisputeResolved")
      .withArgs(1n, arbitrator.address, share, clientAmount, fee);
    const receipt = await (await tx).wait();
    expect(receipt!.logs.map((log) => escrow.interface.parseLog(log)?.name).at(-1)).to.equal("DisputeResolved");

    expect(await balancesOf(escrow, [arbitrator, freelancer, client])).to.deep.equal([fee, share, clientAmount]);
    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Resolved);
    expect(p.pendingAmount).to.equal(0n);
    expect(p.submittedAmount).to.equal(0n);
    expect(p.frozenAmount).to.equal(TOTAL);
    for (const m of await escrow.getMilestones(1n)) expect(m.status).to.equal(MilestoneStatus.Resolved);
    expect(await escrow.totalEscrow()).to.equal(0n);
    expect(await escrow.totalWithdrawable()).to.equal(TOTAL);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("resolves only frozen milestones; approved ones stay approved", async function () {
    const { escrow, client, freelancer, arbitrator, m1ReviewDeadline } = await networkHelpers.loadFixture(mixedFixture);
    await networkHelpers.time.setNextBlockTimestamp(m1ReviewDeadline);
    await escrow.connect(client).raiseDispute(1n, REASON);
    const frozen = AMOUNTS[2] + AMOUNTS[3];
    const freelancerBefore = await escrow.withdrawable(freelancer.address);

    await escrow.connect(arbitrator).resolveDispute(1n, 0n);

    expect((await escrow.getMilestones(1n)).map((m) => m.status)).to.deep.equal([
      MilestoneStatus.Approved,
      MilestoneStatus.Approved,
      MilestoneStatus.Resolved,
      MilestoneStatus.Resolved,
    ]);
    const p = await escrow.getProject(1n);
    expect(p.approvedAmount).to.equal(AMOUNTS[0] + AMOUNTS[1]);
    // A zero share never lowers what the freelancer already earned.
    expect(await escrow.withdrawable(freelancer.address)).to.equal(freelancerBefore);
    expect(await escrow.withdrawable(client.address)).to.equal(frozen - (frozen * FEE_BPS) / 10_000n);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("only lets the project's snapshot arbitrator resolve", async function () {
    const { escrow, admin, client, freelancer, other, arbitrator2 } = await networkHelpers.loadFixture(disputedFixture);
    // A later change of the default arbitrator doesn't hand over existing disputes.
    await escrow.connect(admin).setDefaultArbitrator(arbitrator2.address);
    for (const caller of [client, freelancer, admin, other, arbitrator2]) {
      await expect(escrow.connect(caller).resolveDispute(1n, 0n))
        .to.be.revertedWithCustomError(escrow, "NotArbitrator")
        .withArgs(caller.address);
    }
  });

  it("works at arbitrationDeadline - 1 and reverts at exactly arbitrationDeadline", async function () {
    const { escrow, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    const snap = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline - 1n);
    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n)).to.emit(escrow, "DisputeResolved");

    await snap.restore();
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ArbitrationPeriodEnded")
      .withArgs(arbitrationDeadline);
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Disputed);
  });

  it("pays out only once", async function () {
    const { escrow, client, arbitrator } = await networkHelpers.loadFixture(disputedFixture);
    await escrow.connect(arbitrator).resolveDispute(1n, 0n);
    const totals = [await escrow.totalEscrow(), await escrow.totalWithdrawable()];

    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "NotDisputed")
      .withArgs(ProjectStatus.Resolved);
    // Resolved is terminal.
    await expect(escrow.connect(client).raiseDispute(1n, REASON))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Resolved);
    await expect(escrow.connect(client).approveMilestone(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotActive")
      .withArgs(ProjectStatus.Resolved);
    expect([await escrow.totalEscrow(), await escrow.totalWithdrawable()]).to.deep.equal(totals);
  });

  it("reverts with NotDisputed on projects that aren't Disputed", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "NotDisputed")
      .withArgs(ProjectStatus.Active);
    const open = await createProject(escrow, client, freelancer);
    await expect(escrow.connect(arbitrator).resolveDispute(open, 0n))
      .to.be.revertedWithCustomError(escrow, "NotDisputed")
      .withArgs(ProjectStatus.Open);
    await expect(escrow.connect(arbitrator).resolveDispute(99n, 0n))
      .to.be.revertedWithCustomError(escrow, "UnknownProject")
      .withArgs(99n);
  });

  it("rejects a freelancer share larger than frozen - fee, and accepts exactly that", async function () {
    const { escrow, arbitrator, client } = await networkHelpers.loadFixture(disputedFixture);
    const max = TOTAL - (TOTAL * FEE_BPS) / 10_000n;
    await expect(escrow.connect(arbitrator).resolveDispute(1n, max + 1n))
      .to.be.revertedWithCustomError(escrow, "ShareTooLarge")
      .withArgs(max + 1n, max);
    // The client's zero remainder isn't credited.
    expect(await eventCount(escrow, escrow.connect(arbitrator).resolveDispute(1n, max), "BalanceCredited")).to.equal(2);
    expect(await escrow.withdrawable(client.address)).to.equal(0n);
  });

  it("charges the fee snapshotted at creation, not the current one", async function () {
    const { escrow, admin, arbitrator } = await networkHelpers.loadFixture(disputedFixture);
    await escrow.connect(admin).setArbitrationFeeBps(1000);
    await escrow.connect(arbitrator).resolveDispute(1n, 0n);
    expect(await escrow.withdrawable(arbitrator.address)).to.equal((TOTAL * FEE_BPS) / 10_000n);
  });

  describe("accounting table", function () {
    // frozen = the milestone amounts (all Pending); share is the freelancer's part; "max" means frozen - fee.
    const cases: { name: string; amounts: bigint[]; feeBps: bigint; share: bigint | "max" }[] = [
      { name: "1% of 10 ETH, nothing to the freelancer", amounts: AMOUNTS, feeBps: 100n, share: 0n },
      { name: "1% of 10 ETH, everything after the fee to the freelancer", amounts: AMOUNTS, feeBps: 100n, share: "max" },
      { name: "fee rounds down: 1% of 9999 wei is 99", amounts: [9999n], feeBps: 100n, share: 4950n },
      { name: "fee rounds down to zero on 1 wei", amounts: [1n], feeBps: 1000n, share: 1n },
      { name: "10% (the cap) of an odd amount", amounts: [12_345n], feeBps: 1000n, share: 5555n },
      { name: "no fee, odd-wei split", amounts: [3n, 4n], feeBps: 0n, share: 3n },
      { name: "10% of 3 ETH + 1 wei over several milestones", amounts: [ethers.parseEther("1"), ethers.parseEther("2"), 1n], feeBps: 1000n, share: "max" },
    ];

    for (const c of cases) {
      it(c.name, async function () {
        const [admin, arbitrator, client, freelancer] = await ethers.getSigners();
        const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, c.feeBps]);
        const id = await createActiveProject(escrow, client, freelancer, c.amounts);
        await escrow.connect(client).raiseDispute(id, REASON);

        const frozen = c.amounts.reduce((a, b) => a + b, 0n);
        const fee = (frozen * c.feeBps) / 10_000n;
        const share = c.share === "max" ? frozen - fee : c.share;
        await escrow.connect(arbitrator).resolveDispute(id, share);

        const credited = await balancesOf(escrow, [arbitrator, freelancer, client]);
        expect(credited).to.deep.equal([fee, share, frozen - fee - share]);
        expect(credited.reduce((a, b) => a + b, 0n)).to.equal(frozen);
        expect(await escrow.totalEscrow()).to.equal(0n);
        await expectProjectBucketsBalanced(escrow, id);
        await expectFundsAccounted(escrow);
      });
    }
  });

  it("keeps disputes on projects with the same client, freelancer and arbitrator apart", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(activeFixture);
    const second = await createActiveProject(escrow, client, freelancer, [ethers.parseEther("5"), 3n]);
    const untouched = await createActiveProject(escrow, client, freelancer, [ethers.parseEther("0.5")]);
    await escrow.connect(freelancer).submitMilestone(second, 0n, CID);
    await escrow.connect(client).approveMilestone(second, 0n);

    // Raising one dispute doesn't touch the other projects.
    const secondBeforeRaise = await snapshot(escrow, second);
    const untouchedBefore = await snapshot(escrow, untouched);
    await escrow.connect(client).raiseDispute(1n, REASON);
    expect(await snapshot(escrow, second)).to.deep.equal(secondBeforeRaise);
    expect(await snapshot(escrow, untouched)).to.deep.equal(untouchedBefore);

    await escrow.connect(freelancer).raiseDispute(second, "Second dispute");
    const secondBefore = await snapshot(escrow, second);
    const balancesBefore = await balancesOf(escrow, [arbitrator, freelancer, client]);
    const escrowBefore = await escrow.totalEscrow();

    const fee = (TOTAL * FEE_BPS) / 10_000n;
    await escrow.connect(arbitrator).resolveDispute(1n, 100n);

    expect(await snapshot(escrow, second)).to.deep.equal(secondBefore);
    expect(await snapshot(escrow, untouched)).to.deep.equal(untouchedBefore);
    expect((await escrow.getProject(second)).frozenAmount).to.equal(3n);
    expect(await balancesOf(escrow, [arbitrator, freelancer, client])).to.deep.equal([
      balancesBefore[0] + fee,
      balancesBefore[1] + 100n,
      balancesBefore[2] + TOTAL - fee - 100n,
    ]);
    // Global totals move by exactly this project's frozen amount.
    expect(await escrow.totalEscrow()).to.equal(escrowBefore - TOTAL);

    // The second dispute still resolves on its own frozen amount (3 wei; a 1% fee rounds to 0).
    await escrow.connect(arbitrator).resolveDispute(second, 1n);
    expect(await escrow.withdrawable(client.address)).to.equal(balancesBefore[2] + TOTAL - fee - 100n + 2n);
    for (const id of [1n, second, untouched]) await expectProjectBucketsBalanced(escrow, id);
    await expectFundsAccounted(escrow);
  });

  it("settles several disputes open at once, each on its own frozen amount", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(deploy);
    // [milestone amounts, freelancer share]; the fee is 1% rounded down per project.
    const table: [bigint[], bigint][] = [
      [[9999n], 4950n],
      [[1n], 1n],
      [[ethers.parseEther("1"), 3n], 0n],
      [[12_345n, 1n], 6000n],
    ];
    const ids: bigint[] = [];
    for (const [amounts] of table) ids.push(await createActiveProject(escrow, client, freelancer, amounts));
    for (const id of ids) await escrow.connect(freelancer).raiseDispute(id, REASON);

    const expected = [0n, 0n, 0n]; // arbitrator, freelancer, client
    // Resolve out of creation order to show no project depends on another.
    for (const i of [2, 0, 3, 1]) {
      const [amounts, share] = table[i];
      const frozen = amounts.reduce((a, b) => a + b, 0n);
      const fee = (frozen * FEE_BPS) / 10_000n;
      await escrow.connect(arbitrator).resolveDispute(ids[i], share);
      expected[0] += fee;
      expected[1] += share;
      expected[2] += frozen - fee - share;
      expect(await balancesOf(escrow, [arbitrator, freelancer, client])).to.deep.equal(expected);
      await expectProjectBucketsBalanced(escrow, ids[i]);
    }
    expect(await escrow.totalEscrow()).to.equal(0n);
    await expectFundsAccounted(escrow);
  });

  it("disputes a project that already had an overdue refund, leaving the refund alone", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(activeFixture);
    const deliveryDeadline = (await escrow.getMilestones(1n))[0].deliveryDeadline;
    await networkHelpers.time.setNextBlockTimestamp(deliveryDeadline);
    await escrow.connect(client).refundOverdueMilestone(1n, 0n);

    await escrow.connect(freelancer).raiseDispute(1n, REASON);
    const p = await escrow.getProject(1n);
    expect(p.frozenAmount).to.equal(TOTAL - AMOUNTS[0]);
    expect(p.refundedAmount).to.equal(AMOUNTS[0]);

    await escrow.connect(arbitrator).resolveDispute(1n, 0n);
    const frozen = TOTAL - AMOUNTS[0];
    expect((await escrow.getMilestones(1n))[0].status).to.equal(MilestoneStatus.Refunded);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[0] + frozen - (frozen * FEE_BPS) / 10_000n);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("pays contract parties by credit only: a rejecting client keeps its balance, a re-entrant arbitrator can't drain", async function () {
    const { escrow, admin, freelancer } = await networkHelpers.loadFixture(deploy);
    const escrowAddress = await escrow.getAddress();
    const clientContract = await ethers.deployContract("EscrowPartyMock", [escrowAddress]);
    const arbitratorContract = await ethers.deployContract("EscrowPartyMock", [escrowAddress]);
    await escrow.connect(admin).setDefaultArbitrator(await arbitratorContract.getAddress());
    const now = BigInt(await networkHelpers.time.latest());
    await clientContract.createProject(
      {
        freelancer: freelancer.address,
        acceptanceDeadline: now + DAY,
        reviewWindow: REVIEW,
        title: "Contract client",
        description: "",
        milestones: [{ amount: TOTAL, deliveryPeriod: 10n * DAY, title: "All" }],
      },
      { value: TOTAL },
    );
    await escrow.connect(freelancer).acceptProject(1n);
    await clientContract.setMode(ReceiveMode.Revert);
    await arbitratorContract.setMode(ReceiveMode.Reenter);

    await clientContract.raiseDispute(1n, REASON);
    const fee = (TOTAL * FEE_BPS) / 10_000n;
    const share = ethers.parseEther("3");
    await arbitratorContract.resolveDispute(1n, share);

    // The client contract rejects ETH: its withdrawal fails and its credit stays for a retry.
    await expect(clientContract.withdraw()).to.be.revertedWithCustomError(escrow, "WithdrawalFailed");
    expect(await escrow.withdrawable(await clientContract.getAddress())).to.equal(TOTAL - fee - share);
    // The arbitrator contract re-enters withdraw from receive(); the guard stops it and it gets exactly its fee.
    await expect(arbitratorContract.withdraw()).to.changeEtherBalances(ethers, [arbitratorContract, escrow], [fee, -fee]);
    expect(await arbitratorContract.reentryError()).to.equal(escrow.interface.encodeErrorResult("ReentrancyGuardReentrantCall"));
    // Neither affects the freelancer.
    await expect(escrow.connect(freelancer).withdraw()).to.changeEtherBalance(ethers, freelancer, share);
    expect(await escrow.totalWithdrawable()).to.equal(TOTAL - fee - share);
    await expectFundsAccounted(escrow);
  });
});

describe("TrustLanceEscrow: admin", function () {
  it("sets the default arbitrator for future projects only", async function () {
    const { escrow, admin, arbitrator, arbitrator2, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(admin).setDefaultArbitrator(arbitrator2.address))
      .to.emit(escrow, "DefaultArbitratorChanged")
      .withArgs(arbitrator.address, arbitrator2.address);
    expect(await escrow.defaultArbitrator()).to.equal(arbitrator2.address);

    const id = await createProject(escrow, client, freelancer);
    expect((await escrow.getProject(1n)).arbitrator).to.equal(arbitrator.address);
    expect((await escrow.getProject(id)).arbitrator).to.equal(arbitrator2.address);
    expect(await escrow.projectIdsAsArbitrator(arbitrator2.address)).to.deep.equal([id]);

    await expect(escrow.connect(admin).setDefaultArbitrator(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(escrow, "InvalidArbitrator")
      .withArgs(ethers.ZeroAddress);
  });

  it("sets the arbitration fee for future projects only, capped at 10%", async function () {
    const { escrow, admin, client, freelancer } = await networkHelpers.loadFixture(activeFixture);
    await expect(escrow.connect(admin).setArbitrationFeeBps(1001))
      .to.be.revertedWithCustomError(escrow, "FeeTooHigh")
      .withArgs(1001);
    await expect(escrow.connect(admin).setArbitrationFeeBps(1000))
      .to.emit(escrow, "ArbitrationFeeChanged")
      .withArgs(FEE_BPS, 1000);

    const id = await createProject(escrow, client, freelancer);
    expect((await escrow.getProject(1n)).feeBps).to.equal(FEE_BPS);
    expect((await escrow.getProject(id)).feeBps).to.equal(1000n);
  });

  it("only lets the admin change settings or pause", async function () {
    const { escrow, arbitrator, client, other } = await networkHelpers.loadFixture(activeFixture);
    for (const caller of [arbitrator, client, other]) {
      for (const call of [
        () => escrow.connect(caller).setDefaultArbitrator(other.address),
        () => escrow.connect(caller).setArbitrationFeeBps(0),
        () => escrow.connect(caller).pause(),
        () => escrow.connect(caller).unpause(),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount").withArgs(caller.address);
      }
    }
  });

  it("pausing blocks only createProject", async function () {
    const { escrow, admin, arbitrator, client, freelancer } = await networkHelpers.loadFixture(mixedFixture);
    const open = await createProject(escrow, client, freelancer, [1n]);
    await expect(escrow.connect(admin).pause()).to.emit(escrow, "Paused").withArgs(admin.address);

    await expect(createProject(escrow, client, freelancer)).to.be.revertedWithCustomError(escrow, "EnforcedPause");

    // Every existing project keeps working, including disputes and withdrawals.
    await escrow.connect(client).cancelProject(open);
    await escrow.connect(freelancer).submitMilestone(1n, 3n, CID);
    await escrow.connect(client).raiseDispute(1n, REASON);
    await escrow.connect(arbitrator).resolveDispute(1n, 1n);
    await escrow.connect(freelancer).withdraw();
    await escrow.connect(client).withdraw();

    await expect(escrow.connect(admin).unpause()).to.emit(escrow, "Unpaused").withArgs(admin.address);
    await createProject(escrow, client, freelancer);
  });

  it("transfers admin in two steps", async function () {
    const { escrow, admin, other, client } = await networkHelpers.loadFixture(activeFixture);
    await escrow.connect(admin).transferOwnership(other.address);
    expect(await escrow.owner()).to.equal(admin.address);
    expect(await escrow.pendingOwner()).to.equal(other.address);

    await expect(escrow.connect(client).acceptOwnership())
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
      .withArgs(client.address);
    await escrow.connect(other).acceptOwnership();
    expect(await escrow.owner()).to.equal(other.address);
    await expect(escrow.connect(admin).pause())
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
      .withArgs(admin.address);
    await escrow.connect(other).pause();
  });
});
