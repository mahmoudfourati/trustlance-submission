import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const FEE_BPS = 100n;
const TOTAL = ethers.parseEther("3.5");

// Mirrors the contract's enums.
const ProjectStatus = { Open: 0n, Active: 1n, Cancelled: 3n } as const;
const MilestoneStatus = { Pending: 0n, Refunded: 3n } as const;
const CreditReason = { Refund: 0n } as const;
const ReceiveMode = { Accept: 0n, Revert: 1n, Reenter: 2n } as const;

async function projectParams(freelancer: string) {
  const now = BigInt(await networkHelpers.time.latest());
  return {
    freelancer,
    acceptanceDeadline: now + 7n * DAY,
    reviewWindow: 7n * DAY,
    title: "Landing page redesign",
    description: "",
    milestones: [
      { amount: ethers.parseEther("1"), deliveryPeriod: 10n * DAY, title: "Wireframes" },
      { amount: ethers.parseEther("2.5"), deliveryPeriod: 20n * DAY, title: "Build" },
    ],
  };
}

/** Deploys the escrow and creates project #1 (Open, 3.5 ETH) from `client` to `freelancer`. */
async function openProjectFixture() {
  const [admin, arbitrator, client, freelancer, other] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, FEE_BPS]);
  const params = await projectParams(freelancer.address);
  await escrow.connect(client).createProject(params, { value: TOTAL });
  return { escrow, admin, arbitrator, client, freelancer, other, deadline: params.acceptanceDeadline };
}

type Escrow = Awaited<ReturnType<typeof openProjectFixture>>["escrow"];

/** Accounting invariant 1: every wei the contract holds is either escrowed or withdrawable. */
async function expectFundsAccounted(escrow: Escrow) {
  const balance = await ethers.provider.getBalance(await escrow.getAddress());
  expect(balance).to.equal((await escrow.totalEscrow()) + (await escrow.totalWithdrawable()));
}

describe("TrustLanceEscrow: acceptance", function () {
  it("lets the freelancer accept at acceptanceDeadline - 1 and starts every delivery period", async function () {
    const { escrow, freelancer, deadline } = await networkHelpers.loadFixture(openProjectFixture);
    expect((await escrow.getMilestones(1n))[0].deliveryDeadline).to.equal(0n);

    const acceptedAt = deadline - 1n;
    await networkHelpers.time.setNextBlockTimestamp(acceptedAt);
    await expect(escrow.connect(freelancer).acceptProject(1n))
      .to.emit(escrow, "ProjectAccepted")
      .withArgs(1n, freelancer.address, acceptedAt);

    const project = await escrow.getProject(1n);
    expect(project.status).to.equal(ProjectStatus.Active);
    expect(project.acceptedAt).to.equal(acceptedAt);
    expect(project.pendingAmount).to.equal(TOTAL);

    const milestones = await escrow.getMilestones(1n);
    expect(milestones[0].deliveryDeadline).to.equal(acceptedAt + 10n * DAY);
    expect(milestones[1].deliveryDeadline).to.equal(acceptedAt + 20n * DAY);
    expect(milestones[0].status).to.equal(MilestoneStatus.Pending);
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
    expect(await escrow.totalWithdrawable()).to.equal(0n);
  });

  it("reverts acceptance at exactly the acceptance deadline", async function () {
    const { escrow, freelancer, deadline } = await networkHelpers.loadFixture(openProjectFixture);
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await expect(escrow.connect(freelancer).acceptProject(1n))
      .to.be.revertedWithCustomError(escrow, "AcceptanceDeadlinePassed")
      .withArgs(deadline);
    expect((await escrow.getProject(1n)).status).to.equal(ProjectStatus.Open);
  });

  it("only lets the project's freelancer accept", async function () {
    const { escrow, admin, arbitrator, client, other } = await networkHelpers.loadFixture(openProjectFixture);
    for (const caller of [client, arbitrator, admin, other]) {
      await expect(escrow.connect(caller).acceptProject(1n))
        .to.be.revertedWithCustomError(escrow, "NotFreelancer")
        .withArgs(caller.address);
    }
  });

  it("reverts acceptance of a project that is not Open", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await escrow.connect(freelancer).acceptProject(1n);
    await expect(escrow.connect(freelancer).acceptProject(1n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotOpen")
      .withArgs(ProjectStatus.Active);

    const params = await projectParams(freelancer.address);
    await escrow.connect(client).createProject(params, { value: TOTAL });
    await escrow.connect(client).cancelProject(2n);
    await expect(escrow.connect(freelancer).acceptProject(2n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotOpen")
      .withArgs(ProjectStatus.Cancelled);
  });

  it("reverts every lifecycle action on a project that does not exist", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await expect(escrow.connect(freelancer).acceptProject(2n)).to.be.revertedWithCustomError(escrow, "UnknownProject").withArgs(2n);
    await expect(escrow.connect(freelancer).declineProject(0n)).to.be.revertedWithCustomError(escrow, "UnknownProject").withArgs(0n);
    await expect(escrow.connect(client).cancelProject(2n)).to.be.revertedWithCustomError(escrow, "UnknownProject").withArgs(2n);
  });
});

describe("TrustLanceEscrow: pre-acceptance exits", function () {
  for (const exit of ["decline", "cancel"] as const) {
    describe(exit === "decline" ? "freelancer declines" : "client cancels", function () {
      async function runExit(fixture: Awaited<ReturnType<typeof openProjectFixture>>, projectId = 1n) {
        return exit === "decline"
          ? fixture.escrow.connect(fixture.freelancer).declineProject(projectId)
          : fixture.escrow.connect(fixture.client).cancelProject(projectId);
      }

      it("cancels the project and credits the full escrow to the client without sending ETH", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        const { escrow, client, freelancer } = fixture;

        const tx = runExit(fixture);
        await expect(tx).to.changeEtherBalances(ethers, [client, freelancer, escrow], [0n, 0n, 0n]);
        await expect(tx)
          .to.emit(escrow, exit === "decline" ? "ProjectDeclined" : "ProjectCancelled")
          .withArgs(1n, exit === "decline" ? freelancer.address : client.address);
        await expect(tx).to.emit(escrow, "BalanceCredited").withArgs(client.address, 1n, TOTAL, CreditReason.Refund);
        await expect(tx).to.emit(escrow, "MilestoneRefunded").withArgs(1n, 0n, ethers.parseEther("1"));
        await expect(tx).to.emit(escrow, "MilestoneRefunded").withArgs(1n, 1n, ethers.parseEther("2.5"));

        const project = await escrow.getProject(1n);
        expect(project.status).to.equal(ProjectStatus.Cancelled);
        expect(project.pendingAmount).to.equal(0n);
        expect(project.refundedAmount).to.equal(TOTAL);
        for (const milestone of await escrow.getMilestones(1n)) {
          expect(milestone.status).to.equal(MilestoneStatus.Refunded);
        }
        expect(await escrow.withdrawable(client.address)).to.equal(TOTAL);
        expect(await escrow.withdrawable(freelancer.address)).to.equal(0n);
        expect(await escrow.totalEscrow()).to.equal(0n);
        expect(await escrow.totalWithdrawable()).to.equal(TOTAL);
        await expectFundsAccounted(escrow);
      });

      it("still works after the acceptance deadline, so an unanswered offer is never locked", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        await networkHelpers.time.increaseTo(fixture.deadline + 30n * DAY);
        await runExit(fixture);
        expect((await fixture.escrow.getProject(1n)).status).to.equal(ProjectStatus.Cancelled);
        expect(await fixture.escrow.withdrawable(fixture.client.address)).to.equal(TOTAL);
      });

      it("works at acceptanceDeadline - 1", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        await networkHelpers.time.setNextBlockTimestamp(fixture.deadline - 1n);
        await runExit(fixture);
        expect((await fixture.escrow.getProject(1n)).status).to.equal(ProjectStatus.Cancelled);
      });

      it("works at exactly the acceptance deadline", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        await networkHelpers.time.setNextBlockTimestamp(fixture.deadline);
        await runExit(fixture);
        expect((await fixture.escrow.getProject(1n)).status).to.equal(ProjectStatus.Cancelled);
      });

      it("can't run twice, so the refund is credited once", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        await runExit(fixture);
        await expect(runExit(fixture))
          .to.be.revertedWithCustomError(fixture.escrow, "ProjectNotOpen")
          .withArgs(ProjectStatus.Cancelled);
        expect(await fixture.escrow.withdrawable(fixture.client.address)).to.equal(TOTAL);
        expect(await fixture.escrow.totalWithdrawable()).to.equal(TOTAL);
      });

      it("reverts once the project is accepted", async function () {
        const fixture = await networkHelpers.loadFixture(openProjectFixture);
        await fixture.escrow.connect(fixture.freelancer).acceptProject(1n);
        await expect(runExit(fixture))
          .to.be.revertedWithCustomError(fixture.escrow, "ProjectNotOpen")
          .withArgs(ProjectStatus.Active);
        expect(await fixture.escrow.totalEscrow()).to.equal(TOTAL);
        expect(await fixture.escrow.withdrawable(fixture.client.address)).to.equal(0n);
      });
    });
  }

  it("only lets the project's freelancer decline", async function () {
    const { escrow, admin, arbitrator, client, other } = await networkHelpers.loadFixture(openProjectFixture);
    for (const caller of [client, arbitrator, admin, other]) {
      await expect(escrow.connect(caller).declineProject(1n))
        .to.be.revertedWithCustomError(escrow, "NotFreelancer")
        .withArgs(caller.address);
    }
  });

  it("only lets the project's client cancel", async function () {
    const { escrow, admin, arbitrator, freelancer, other } = await networkHelpers.loadFixture(openProjectFixture);
    for (const caller of [freelancer, arbitrator, admin, other]) {
      await expect(escrow.connect(caller).cancelProject(1n))
        .to.be.revertedWithCustomError(escrow, "NotClient")
        .withArgs(caller.address);
    }
  });

  it("a declined project can't be cancelled, and a cancelled one can't be declined", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await escrow.connect(freelancer).declineProject(1n);
    await expect(escrow.connect(client).cancelProject(1n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotOpen")
      .withArgs(ProjectStatus.Cancelled);

    await escrow.connect(client).createProject(await projectParams(freelancer.address), { value: TOTAL });
    await escrow.connect(client).cancelProject(2n);
    await expect(escrow.connect(freelancer).declineProject(2n))
      .to.be.revertedWithCustomError(escrow, "ProjectNotOpen")
      .withArgs(ProjectStatus.Cancelled);
    expect(await escrow.withdrawable(client.address)).to.equal(2n * TOTAL);
  });

  it("refunding one project leaves another project of the same parties untouched", async function () {
    const { escrow, client, freelancer, other } = await networkHelpers.loadFixture(openProjectFixture);
    const second = { ...(await projectParams(freelancer.address)), milestones: [{ amount: 7n, deliveryPeriod: HOUR, title: "Odd" }] };
    await escrow.connect(client).createProject(second, { value: 7n });
    await escrow.connect(other).createProject(await projectParams(freelancer.address), { value: TOTAL });

    await escrow.connect(client).cancelProject(1n);

    const untouched = await escrow.getProject(2n);
    expect(untouched.status).to.equal(ProjectStatus.Open);
    expect(untouched.pendingAmount).to.equal(7n);
    expect(untouched.refundedAmount).to.equal(0n);
    expect((await escrow.getMilestones(2n))[0].status).to.equal(MilestoneStatus.Pending);
    expect((await escrow.getProject(3n)).status).to.equal(ProjectStatus.Open);
    expect(await escrow.totalEscrow()).to.equal(7n + TOTAL);
    expect(await escrow.withdrawable(client.address)).to.equal(TOTAL);
    expect(await escrow.withdrawable(other.address)).to.equal(0n);
    await expectFundsAccounted(escrow);

    await escrow.connect(freelancer).declineProject(2n);
    expect(await escrow.withdrawable(client.address)).to.equal(TOTAL + 7n);
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
    await expectFundsAccounted(escrow);
  });
});

describe("TrustLanceEscrow: withdraw", function () {
  it("pays the whole withdrawable balance once and zeroes it", async function () {
    const { escrow, client, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    await escrow.connect(client).createProject(await projectParams(freelancer.address), { value: TOTAL });
    await escrow.connect(client).cancelProject(1n);
    await escrow.connect(freelancer).declineProject(2n);

    const tx = escrow.connect(client).withdraw();
    await expect(tx).to.changeEtherBalances(ethers, [client, escrow], [2n * TOTAL, -2n * TOTAL]);
    await expect(tx).to.emit(escrow, "Withdrawn").withArgs(client.address, 2n * TOTAL);

    expect(await escrow.withdrawable(client.address)).to.equal(0n);
    expect(await escrow.totalWithdrawable()).to.equal(0n);
    await expectFundsAccounted(escrow);

    await expect(escrow.connect(client).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
  });

  it("reverts for an account with no balance and leaves escrow alone", async function () {
    const { escrow, freelancer, other } = await networkHelpers.loadFixture(openProjectFixture);
    for (const caller of [freelancer, other]) {
      await expect(escrow.connect(caller).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    }
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
  });

  it("pays a re-entrant attacker exactly once", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    const attacker = await ethers.deployContract("EscrowPartyMock", [await escrow.getAddress()]);
    await attacker.createProject(await projectParams(freelancer.address), { value: TOTAL });
    await attacker.cancelProject(2n);
    await attacker.setMode(ReceiveMode.Reenter);

    await expect(attacker.withdraw()).to.changeEtherBalances(ethers, [attacker, escrow], [TOTAL, -TOTAL]);

    expect(await attacker.receiveCount()).to.equal(1n);
    expect(await attacker.reentryError()).to.equal(escrow.interface.encodeErrorResult("ReentrancyGuardReentrantCall"));
    expect(await escrow.withdrawable(await attacker.getAddress())).to.equal(0n);
    expect(await escrow.totalEscrow()).to.equal(TOTAL);
    await expectFundsAccounted(escrow);
  });

  it("keeps the balance of a receiver that rejects ETH so it can retry", async function () {
    const { escrow, freelancer } = await networkHelpers.loadFixture(openProjectFixture);
    const receiver = await ethers.deployContract("EscrowPartyMock", [await escrow.getAddress()]);
    const receiverAddress = await receiver.getAddress();
    await receiver.createProject(await projectParams(freelancer.address), { value: TOTAL });
    await receiver.cancelProject(2n);
    await receiver.setMode(ReceiveMode.Revert);

    await expect(receiver.withdraw()).to.be.revertedWithCustomError(escrow, "WithdrawalFailed");
    expect(await escrow.withdrawable(receiverAddress)).to.equal(TOTAL);
    expect(await escrow.totalWithdrawable()).to.equal(TOTAL);
    await expectFundsAccounted(escrow);

    await receiver.setMode(ReceiveMode.Accept);
    await expect(receiver.withdraw()).to.changeEtherBalances(ethers, [receiver, escrow], [TOTAL, -TOTAL]);
    expect(await escrow.withdrawable(receiverAddress)).to.equal(0n);
    await expectFundsAccounted(escrow);
  });
});
