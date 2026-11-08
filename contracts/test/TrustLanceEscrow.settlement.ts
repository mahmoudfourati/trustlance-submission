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
const REASON = "The arbitrator should look at the build.";

// Mirrors the contract's enums.
const ProjectStatus = { Open: 0n, Active: 1n, Completed: 2n, Cancelled: 3n, Disputed: 4n, Resolved: 5n } as const;
const MilestoneStatus = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n, Resolved: 4n } as const;
const CreditReason = { Refund: 0n, Approval: 1n, ArbitrationFee: 2n, DisputeSettlement: 3n } as const;
const ReceiveMode = { Accept: 0n, Revert: 1n, Reenter: 2n } as const;

async function deploy() {
  const [admin, arbitrator, client, freelancer, other] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, FEE_BPS]);
  return { escrow, admin, arbitrator, client, freelancer, other };
}

type Escrow = Awaited<ReturnType<typeof deploy>>["escrow"];
type Signer = Awaited<ReturnType<typeof deploy>>["client"];

async function createActiveProject(
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
  const id = await escrow.projectCount();
  await escrow.connect(freelancer).acceptProject(id);
  return id;
}

/** Raises a dispute on `id` as the client and returns its arbitration deadline. */
async function raise(escrow: Escrow, client: Signer, id: bigint) {
  await escrow.connect(client).raiseDispute(id, REASON);
  return (await escrow.getProject(id)).raisedAt + ARBITRATION_PERIOD;
}

/**
 * Project #1, Disputed by the client: M0 Approved before the dispute, M1 Submitted inside its review window
 * (frozen as submitted), M2 and M3 Pending (frozen as pending).
 */
async function disputedFixture() {
  const base = await deploy();
  const { escrow, client, freelancer } = base;
  await createActiveProject(escrow, client, freelancer);
  await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
  await escrow.connect(client).approveMilestone(1n, 0n);
  await escrow.connect(freelancer).submitMilestone(1n, 1n, CID);
  const arbitrationDeadline = await raise(escrow, client, 1n);
  return { ...base, arbitrationDeadline };
}

/** Accounting invariant 1: every wei the contract holds is either escrowed or withdrawable. */
async function expectFundsAccounted(escrow: Escrow) {
  const balance = await ethers.provider.getBalance(await escrow.getAddress());
  expect(balance).to.equal((await escrow.totalEscrow()) + (await escrow.totalWithdrawable()));
}

/** Accounting invariant 2, with the frozen amount counted once the dispute has paid out. */
async function expectProjectBucketsBalanced(escrow: Escrow, projectId = 1n) {
  const p = await escrow.getProject(projectId);
  const settled = p.status === ProjectStatus.Resolved ? p.frozenAmount : 0n;
  expect(p.pendingAmount + p.submittedAmount + p.approvedAmount + p.refundedAmount + settled).to.equal(p.totalAmount);
}

async function balancesOf(escrow: Escrow, accounts: Signer[]) {
  return Promise.all(accounts.map((a) => escrow.withdrawable(a.address)));
}

/** Plain-object snapshot of a project and its milestones, for "unchanged" comparisons. */
async function snapshot(escrow: Escrow, projectId: bigint) {
  return {
    project: ((await escrow.getProject(projectId)) as unknown as Result).toObject(true),
    milestones: (await escrow.getMilestones(projectId)).map((m) => (m as unknown as Result).toObject(true)),
  };
}

/**
 * Sends the calls, in this order, into one block at `timestamp` (automine off). Returns "ok" for each call that
 * succeeded and the custom error name for each that reverted, read from the transaction's trace, so a test can tell
 * a lost race from an unrelated failure such as running out of gas.
 */
async function sameBlock(escrow: Escrow, timestamp: bigint, ...sends: (() => Promise<{ hash: string }>)[]) {
  await ethers.provider.send("evm_setAutomine", [false]);
  try {
    const txs = [];
    for (const send of sends) txs.push(await send());
    await networkHelpers.time.setNextBlockTimestamp(timestamp);
    await networkHelpers.mine();
    const receipts = await Promise.all(txs.map((tx) => ethers.provider.getTransactionReceipt(tx.hash)));
    expect(new Set(receipts.map((r) => r!.blockNumber)).size).to.equal(1);
    // Mined in the order sent.
    expect(receipts.map((r) => r!.index)).to.deep.equal([...receipts.map((r) => r!.index)].sort((a, b) => a - b));
    return Promise.all(
      receipts.map(async (r) => {
        if (r!.status === 1) return "ok";
        const trace = await ethers.provider.send("debug_traceTransaction", [
          r!.hash,
          { disableStorage: true, disableMemory: true, disableStack: true },
        ]);
        return escrow.interface.parseError(trace.returnValue)?.name ?? "unknown revert";
      }),
    );
  } finally {
    await ethers.provider.send("evm_setAutomine", [true]);
  }
}

describe("TrustLanceEscrow: expired-dispute settlement", function () {
  it("from exactly arbitrationDeadline: pending to the client, submitted split in half, no fee", async function () {
    const { escrow, client, freelancer, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    const frozenPending = AMOUNTS[2] + AMOUNTS[3];
    const frozenSubmitted = AMOUNTS[1];
    const freelancerAmount = frozenSubmitted / 2n;
    const clientAmount = frozenPending + frozenSubmitted - freelancerAmount;
    const [freelancerBefore, clientBefore] = await balancesOf(escrow, [freelancer, client]);
    const escrowBefore = await escrow.totalEscrow();

    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    const tx = escrow.connect(client).settleExpiredDispute(1n);
    await expect(tx)
      .to.emit(escrow, "BalanceCredited")
      .withArgs(freelancer.address, 1n, freelancerAmount, CreditReason.DisputeSettlement)
      .and.to.emit(escrow, "BalanceCredited")
      .withArgs(client.address, 1n, clientAmount, CreditReason.DisputeSettlement)
      .and.to.emit(escrow, "ExpiredDisputeSettled")
      .withArgs(1n, client.address, freelancerAmount, clientAmount)
      .and.not.to.emit(escrow, "DisputeResolved");
    const receipt = await (await tx).wait();
    expect(receipt!.logs.map((log) => escrow.interface.parseLog(log)?.name)).to.deep.equal([
      "BalanceCredited",
      "BalanceCredited",
      "ExpiredDisputeSettled",
    ]);

    expect(await balancesOf(escrow, [freelancer, client, arbitrator])).to.deep.equal([
      freelancerBefore + freelancerAmount,
      clientBefore + clientAmount,
      0n,
    ]);
    const p = await escrow.getProject(1n);
    expect(p.status).to.equal(ProjectStatus.Resolved);
    expect(p.pendingAmount).to.equal(0n);
    expect(p.submittedAmount).to.equal(0n);
    expect(p.approvedAmount).to.equal(AMOUNTS[0]);
    expect((await escrow.getMilestones(1n)).map((m) => m.status)).to.deep.equal([
      MilestoneStatus.Approved,
      MilestoneStatus.Resolved,
      MilestoneStatus.Resolved,
      MilestoneStatus.Resolved,
    ]);
    expect(await escrow.totalEscrow()).to.equal(escrowBefore - p.frozenAmount);
    await expectProjectBucketsBalanced(escrow);
    await expectFundsAccounted(escrow);
  });

  it("lets the freelancer settle too, with the same payouts", async function () {
    const { escrow, client, freelancer, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await expect(escrow.connect(freelancer).settleExpiredDispute(1n))
      .to.emit(escrow, "ExpiredDisputeSettled")
      .withArgs(1n, freelancer.address, AMOUNTS[1] / 2n, AMOUNTS[1] / 2n + AMOUNTS[2] + AMOUNTS[3]);
    expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[1] / 2n + AMOUNTS[2] + AMOUNTS[3]);
  });

  it("at arbitrationDeadline - 1, settle reverts and resolve works; at arbitrationDeadline, the reverse", async function () {
    const { escrow, client, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    const snap = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline - 1n);
    await expect(escrow.connect(client).settleExpiredDispute(1n))
      .to.be.revertedWithCustomError(escrow, "ArbitrationPeriodOpen")
      .withArgs(arbitrationDeadline);
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline - 1n);
    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n)).to.emit(escrow, "DisputeResolved");

    await snap.restore();
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await expect(escrow.connect(arbitrator).resolveDispute(1n, 0n))
      .to.be.revertedWithCustomError(escrow, "ArbitrationPeriodEnded")
      .withArgs(arbitrationDeadline);
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await expect(escrow.connect(client).settleExpiredDispute(1n)).to.emit(escrow, "ExpiredDisputeSettled");
  });

  describe("resolve and settle in the same block", function () {
    const gasLimit = 1_000_000n;

    it("at arbitrationDeadline - 1 only the resolution succeeds, in either order", async function () {
      const { escrow, client, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
      const snap = await networkHelpers.takeSnapshot();
      const resolve = () => escrow.connect(arbitrator).resolveDispute(1n, 0n, { gasLimit });
      const settle = () => escrow.connect(client).settleExpiredDispute(1n, { gasLimit });

      expect(await sameBlock(escrow, arbitrationDeadline - 1n, resolve, settle)).to.deep.equal(["ok", "NotDisputed"]);
      expect(await escrow.withdrawable(arbitrator.address)).to.be.greaterThan(0n);

      await snap.restore();
      expect(await sameBlock(escrow, arbitrationDeadline - 1n, settle, resolve)).to.deep.equal(["ArbitrationPeriodOpen", "ok"]);
      await expectFundsAccounted(escrow);
    });

    it("at exactly arbitrationDeadline only the settlement succeeds, in either order", async function () {
      const { escrow, client, freelancer, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
      const snap = await networkHelpers.takeSnapshot();
      const resolve = () => escrow.connect(arbitrator).resolveDispute(1n, 0n, { gasLimit });
      const settle = () => escrow.connect(freelancer).settleExpiredDispute(1n, { gasLimit });

      expect(await sameBlock(escrow, arbitrationDeadline, resolve, settle)).to.deep.equal(["ArbitrationPeriodEnded", "ok"]);
      expect(await escrow.withdrawable(arbitrator.address)).to.equal(0n);

      await snap.restore();
      expect(await sameBlock(escrow, arbitrationDeadline, settle, resolve)).to.deep.equal(["ok", "NotDisputed"]);
      expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[1] / 2n + AMOUNTS[2] + AMOUNTS[3]);
      await expectFundsAccounted(escrow);
    });

    it("lets only one of two settlements in the same block pay out", async function () {
      const { escrow, client, freelancer, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
      const results = await sameBlock(
        escrow,
        arbitrationDeadline,
        () => escrow.connect(client).settleExpiredDispute(1n, { gasLimit }),
        () => escrow.connect(freelancer).settleExpiredDispute(1n, { gasLimit }),
      );
      expect(results).to.deep.equal(["ok", "NotDisputed"]);
      // The payouts don't depend on who settled (the freelancer also holds the approved M0).
      expect(await escrow.withdrawable(freelancer.address)).to.equal(AMOUNTS[0] + AMOUNTS[1] / 2n);
      expect(await escrow.withdrawable(client.address)).to.equal(AMOUNTS[1] / 2n + AMOUNTS[2] + AMOUNTS[3]);
      await expectFundsAccounted(escrow);
    });
  });

  it("reverts any second settlement of either kind with NotDisputed", async function () {
    const { escrow, client, freelancer, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    const snap = await networkHelpers.takeSnapshot();

    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await escrow.connect(client).settleExpiredDispute(1n);
    const totals = [await escrow.totalEscrow(), await escrow.totalWithdrawable()];
    for (const second of [
      () => escrow.connect(freelancer).settleExpiredDispute(1n),
      () => escrow.connect(client).settleExpiredDispute(1n),
      () => escrow.connect(arbitrator).resolveDispute(1n, 0n),
    ]) {
      await expect(second()).to.be.revertedWithCustomError(escrow, "NotDisputed").withArgs(ProjectStatus.Resolved);
    }
    expect([await escrow.totalEscrow(), await escrow.totalWithdrawable()]).to.deep.equal(totals);

    // A dispute resolved by the arbitrator can't be settled again after the deadline either.
    await snap.restore();
    await escrow.connect(arbitrator).resolveDispute(1n, 0n);
    await networkHelpers.time.increaseTo(arbitrationDeadline + DAY);
    await expect(escrow.connect(client).settleExpiredDispute(1n))
      .to.be.revertedWithCustomError(escrow, "NotDisputed")
      .withArgs(ProjectStatus.Resolved);
  });

  it("rejects outsiders, the arbitrator and the admin, even after the deadline", async function () {
    const { escrow, admin, arbitrator, other, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    await networkHelpers.time.increaseTo(arbitrationDeadline + 10n * DAY);
    for (const caller of [arbitrator, admin, other]) {
      await expect(escrow.connect(caller).settleExpiredDispute(1n))
        .to.be.revertedWithCustomError(escrow, "NotProjectParty")
        .withArgs(caller.address);
    }
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Disputed);
  });

  it("still works while project creation is paused", async function () {
    const { escrow, admin, client, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    await escrow.connect(admin).pause();
    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await expect(escrow.connect(client).settleExpiredDispute(1n)).to.emit(escrow, "ExpiredDisputeSettled");
    await expect(escrow.connect(client).withdraw()).to.changeEtherBalance(
      ethers,
      client,
      AMOUNTS[1] / 2n + AMOUNTS[2] + AMOUNTS[3],
    );
  });

  it("only settles Disputed projects", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(deploy);
    const id = await createActiveProject(escrow, client, freelancer);
    await networkHelpers.time.increase(ARBITRATION_PERIOD);
    await expect(escrow.connect(client).settleExpiredDispute(id))
      .to.be.revertedWithCustomError(escrow, "NotDisputed")
      .withArgs(ProjectStatus.Active);
    await expect(escrow.connect(client).settleExpiredDispute(99n))
      .to.be.revertedWithCustomError(escrow, "UnknownProject")
      .withArgs(99n);
  });

  describe("fallback table", function () {
    // Each row: milestone amounts, how many of them (from the start) are submitted before the dispute.
    const cases: { name: string; amounts: bigint[]; submitted: number; freelancer: bigint; client: bigint }[] = [
      { name: "only pending milestones: everything back to the client", amounts: [5n, 7n], submitted: 0, freelancer: 0n, client: 12n },
      { name: "one even submitted milestone: split in half", amounts: [10n], submitted: 1, freelancer: 5n, client: 5n },
      { name: "odd submitted total: the odd wei goes to the client", amounts: [7n], submitted: 1, freelancer: 3n, client: 4n },
      { name: "a single submitted wei: all of it to the client", amounts: [1n], submitted: 1, freelancer: 0n, client: 1n },
      { name: "two odd submissions add up before halving", amounts: [3n, 5n, 9n], submitted: 2, freelancer: 4n, client: 13n },
      { name: "several ETH-sized milestones, mixed", amounts: [ethers.parseEther("1.5"), 1n, ethers.parseEther("2")], submitted: 2, freelancer: ethers.parseEther("0.75"), client: ethers.parseEther("2.75") + 1n },
    ];

    for (const c of cases) {
      it(c.name, async function () {
        const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(deploy);
        const id = await createActiveProject(escrow, client, freelancer, c.amounts);
        for (let i = 0; i < c.submitted; i++) await escrow.connect(freelancer).submitMilestone(id, i, CID);
        const deadline = await raise(escrow, client, id);
        const frozen = c.amounts.reduce((a, b) => a + b, 0n);

        await networkHelpers.time.setNextBlockTimestamp(deadline);
        const tx = escrow.connect(client).settleExpiredDispute(id);
        await expect(tx).to.emit(escrow, "ExpiredDisputeSettled").withArgs(id, client.address, c.freelancer, c.client);
        // Zero amounts aren't credited.
        const receipt = await (await tx).wait();
        const credits = receipt!.logs.filter((log) => escrow.interface.parseLog(log)?.name === "BalanceCredited").length;
        expect(credits).to.equal([c.freelancer, c.client].filter((x) => x > 0n).length);

        expect(await balancesOf(escrow, [freelancer, client, arbitrator])).to.deep.equal([c.freelancer, c.client, 0n]);
        expect(c.freelancer + c.client).to.equal(frozen);
        expect(await escrow.totalEscrow()).to.equal(0n);
        await expectProjectBucketsBalanced(escrow, id);
        await expectFundsAccounted(escrow);
      });
    }
  });

  it("leaves approvals, earlier refunds and every existing balance alone", async function () {
    const { escrow, client, freelancer, arbitrator } = await networkHelpers.loadFixture(deploy);
    // Project 1: M0 approved, M1 refunded as overdue, M2 submitted, M3 pending.
    const id = await createActiveProject(escrow, client, freelancer, AMOUNTS, [10n * DAY, HOUR, 20n * DAY, 30n * DAY]);
    await escrow.connect(freelancer).submitMilestone(id, 0n, CID);
    await escrow.connect(client).approveMilestone(id, 0n);
    await networkHelpers.time.increase(2n * HOUR);
    await escrow.connect(client).refundOverdueMilestone(id, 1n);
    await escrow.connect(freelancer).submitMilestone(id, 2n, CID);
    // The arbitrator already earned a fee on another dispute.
    const other = await createActiveProject(escrow, client, freelancer, [ethers.parseEther("1")]);
    await escrow.connect(client).raiseDispute(other, REASON);
    await escrow.connect(arbitrator).resolveDispute(other, 0n);

    const before = await balancesOf(escrow, [freelancer, client, arbitrator]);
    const deadline = await raise(escrow, client, id);
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await escrow.connect(freelancer).settleExpiredDispute(id);

    expect(await balancesOf(escrow, [freelancer, client, arbitrator])).to.deep.equal([
      before[0] + AMOUNTS[2] / 2n,
      before[1] + AMOUNTS[2] / 2n + AMOUNTS[3],
      before[2],
    ]);
    expect((await escrow.getMilestones(id)).map((m) => m.status)).to.deep.equal([
      MilestoneStatus.Approved,
      MilestoneStatus.Refunded,
      MilestoneStatus.Resolved,
      MilestoneStatus.Resolved,
    ]);
    const p = await escrow.getProject(id);
    expect([p.approvedAmount, p.refundedAmount]).to.deep.equal([AMOUNTS[0], AMOUNTS[1]]);
    await expectProjectBucketsBalanced(escrow, id);
    await expectFundsAccounted(escrow);
  });

  it("keeps a second disputed project with the same parties unchanged", async function () {
    const { escrow, client, freelancer, arbitrator, arbitrationDeadline } = await networkHelpers.loadFixture(disputedFixture);
    const second = await createActiveProject(escrow, client, freelancer, [ethers.parseEther("0.5"), 3n]);
    await escrow.connect(freelancer).submitMilestone(second, 1n, CID);
    await escrow.connect(freelancer).raiseDispute(second, "Second dispute");
    const secondBefore = await snapshot(escrow, second);
    const escrowBefore = await escrow.totalEscrow();
    const frozen = (await escrow.getProject(1n)).frozenAmount;

    await networkHelpers.time.setNextBlockTimestamp(arbitrationDeadline);
    await escrow.connect(client).settleExpiredDispute(1n);

    expect(await snapshot(escrow, second)).to.deep.equal(secondBefore);
    expect(await escrow.totalEscrow()).to.equal(escrowBefore - frozen);
    // The second dispute is still open to its arbitrator, on its own deadline.
    const secondDeadline = (await escrow.getProject(second)).raisedAt + ARBITRATION_PERIOD;
    expect(secondDeadline).to.be.greaterThan(arbitrationDeadline);
    await expect(escrow.connect(client).settleExpiredDispute(second))
      .to.be.revertedWithCustomError(escrow, "ArbitrationPeriodOpen")
      .withArgs(secondDeadline);
    await escrow.connect(arbitrator).resolveDispute(second, 1n);
    for (const id of [1n, second]) await expectProjectBucketsBalanced(escrow, id);
    await expectFundsAccounted(escrow);
  });

  it("credits a contract client that rejects or re-enters, without blocking anyone else", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(deploy);
    const clientContract = await ethers.deployContract("EscrowPartyMock", [await escrow.getAddress()]);
    const now = BigInt(await networkHelpers.time.latest());
    await clientContract.createProject(
      {
        freelancer: freelancer.address,
        acceptanceDeadline: now + DAY,
        reviewWindow: REVIEW,
        title: "Contract client",
        description: "",
        milestones: [
          { amount: 9n, deliveryPeriod: 10n * DAY, title: "Done" },
          { amount: 4n, deliveryPeriod: 10n * DAY, title: "Open" },
        ],
      },
      { value: 13n },
    );
    await escrow.connect(freelancer).acceptProject(1n);
    await escrow.connect(freelancer).submitMilestone(1n, 0n, CID);
    await escrow.connect(freelancer).raiseDispute(1n, REASON);
    await clientContract.setMode(ReceiveMode.Revert);

    await networkHelpers.time.increaseTo((await escrow.getProject(1n)).raisedAt + ARBITRATION_PERIOD);
    // The contract client triggers settlement itself; the payouts go where the formula says.
    await clientContract.settleExpiredDispute(1n);
    const clientAddress = await clientContract.getAddress();
    expect(await escrow.withdrawable(clientAddress)).to.equal(4n + 5n);
    expect(await escrow.withdrawable(freelancer.address)).to.equal(4n);

    await expect(clientContract.withdraw()).to.be.revertedWithCustomError(escrow, "WithdrawalFailed");
    expect(await escrow.withdrawable(clientAddress)).to.equal(9n);
    await expect(escrow.connect(freelancer).withdraw()).to.changeEtherBalance(ethers, freelancer, 4n);

    await clientContract.setMode(ReceiveMode.Reenter);
    await expect(clientContract.withdraw()).to.changeEtherBalances(ethers, [clientContract, escrow], [9n, -9n]);
    expect(await clientContract.reentryError()).to.equal(escrow.interface.encodeErrorResult("ReentrancyGuardReentrantCall"));
    expect(await escrow.totalWithdrawable()).to.equal(0n);
    await expectFundsAccounted(escrow);
  });
});
