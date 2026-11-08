import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const FEE_BPS = 100n;

// Mirrors the contract's ProjectStatus / MilestoneStatus enums.
const ProjectStatus = { Open: 0n } as const;
const MilestoneStatus = { Pending: 0n } as const;

async function deployEscrowFixture() {
  const [admin, arbitrator, client, freelancer, other] =
    await ethers.getSigners();
  const escrow = await ethers.deployContract("TrustLanceEscrow", [
    admin.address,
    arbitrator.address,
    FEE_BPS,
  ]);
  return { escrow, admin, arbitrator, client, freelancer, other };
}

async function validParams(freelancer: string) {
  const now = BigInt(await networkHelpers.time.latest());
  return {
    freelancer,
    acceptanceDeadline: now + 7n * DAY,
    reviewWindow: 7n * DAY,
    title: "Landing page redesign",
    description: "Design and build a new landing page.",
    milestones: [
      { amount: ethers.parseEther("1"), deliveryPeriod: 10n * DAY, title: "Wireframes" },
      { amount: ethers.parseEther("2.5"), deliveryPeriod: 20n * DAY, title: "Build" },
    ],
  };
}

describe("TrustLanceEscrow: deployment", function () {
  it("stores the platform configuration and its deployment block", async function () {
    const [admin, arbitrator] = await ethers.getSigners();
    const escrow = await ethers.deployContract("TrustLanceEscrow", [
      admin.address,
      arbitrator.address,
      FEE_BPS,
    ]);
    const receipt = await escrow.deploymentTransaction()!.wait();

    expect(await escrow.owner()).to.equal(admin.address);
    expect(await escrow.defaultArbitrator()).to.equal(arbitrator.address);
    expect(await escrow.arbitrationFeeBps()).to.equal(FEE_BPS);
    expect(await escrow.deploymentBlock()).to.equal(BigInt(receipt!.blockNumber));
  });

  it("rejects a zero arbitrator and a fee above 10%", async function () {
    const [admin, arbitrator] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("TrustLanceEscrow");

    await expect(ethers.deployContract("TrustLanceEscrow", [admin.address, ethers.ZeroAddress, FEE_BPS]))
      .to.be.revertedWithCustomError(factory, "InvalidArbitrator")
      .withArgs(ethers.ZeroAddress);
    await expect(ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, 1001n]))
      .to.be.revertedWithCustomError(factory, "FeeTooHigh")
      .withArgs(1001n);
    await ethers.deployContract("TrustLanceEscrow", [admin.address, arbitrator.address, 1000n]);
  });
});

describe("TrustLanceEscrow: project creation", function () {
  it("creates an Open project funded in full in one transaction", async function () {
    const { escrow, arbitrator, client, freelancer } =
      await networkHelpers.loadFixture(deployEscrowFixture);
    const params = await validParams(freelancer.address);

    await expect(
      escrow.connect(client).createProject(params, { value: ethers.parseEther("3.5") }),
    ).to.changeEtherBalances(
      ethers,
      [client, escrow],
      [-ethers.parseEther("3.5"), ethers.parseEther("3.5")],
    );

    const project = await escrow.getProject(1n);
    expect(project.client).to.equal(client.address);
    expect(project.freelancer).to.equal(freelancer.address);
    expect(project.arbitrator).to.equal(arbitrator.address);
    expect(project.feeBps).to.equal(FEE_BPS);
    expect(project.status).to.equal(ProjectStatus.Open);
    expect(project.acceptanceDeadline).to.equal(params.acceptanceDeadline);
    expect(project.reviewWindow).to.equal(7n * DAY);
    expect(project.milestoneCount).to.equal(2n);
    expect(project.totalAmount).to.equal(ethers.parseEther("3.5"));
    expect(project.pendingAmount).to.equal(ethers.parseEther("3.5"));

    const milestones = await escrow.getMilestones(1n);
    expect(milestones.length).to.equal(2);
    expect(milestones[0].amount).to.equal(ethers.parseEther("1"));
    expect(milestones[0].deliveryPeriod).to.equal(10n * DAY);
    expect(milestones[0].status).to.equal(MilestoneStatus.Pending);
    expect(milestones[1].amount).to.equal(ethers.parseEther("2.5"));

    expect(await escrow.totalEscrow()).to.equal(ethers.parseEther("3.5"));
  });

  it("emits ProjectCreated and one MilestoneDefined per milestone", async function () {
    const { escrow, arbitrator, client, freelancer } =
      await networkHelpers.loadFixture(deployEscrowFixture);
    const params = await validParams(freelancer.address);

    const tx = escrow.connect(client).createProject(params, { value: ethers.parseEther("3.5") });

    await expect(tx)
      .to.emit(escrow, "ProjectCreated")
      .withArgs(
        1n,
        client.address,
        freelancer.address,
        arbitrator.address,
        ethers.parseEther("3.5"),
        FEE_BPS,
        params.acceptanceDeadline,
        7n * DAY,
        "Landing page redesign",
        "Design and build a new landing page.",
      );
    await expect(tx)
      .to.emit(escrow, "MilestoneDefined")
      .withArgs(1n, 0n, ethers.parseEther("1"), 10n * DAY, "Wireframes");
    await expect(tx)
      .to.emit(escrow, "MilestoneDefined")
      .withArgs(1n, 1n, ethers.parseEther("2.5"), 20n * DAY, "Build");
  });

  describe("multiple projects", function () {
    it("gives each project a unique id and keeps their records and escrow independent", async function () {
      const { escrow, client, freelancer, other } =
        await networkHelpers.loadFixture(deployEscrowFixture);

      const a = await validParams(freelancer.address);
      await escrow.connect(client).createProject(a, { value: ethers.parseEther("3.5") });

      const b = await validParams(client.address);
      b.milestones = [{ amount: 7n, deliveryPeriod: DAY, title: "Audit" }];
      await escrow.connect(other).createProject(b, { value: 7n });

      const c = await validParams(other.address);
      await escrow.connect(client).createProject(c, { value: ethers.parseEther("3.5") });

      expect(await escrow.projectCount()).to.equal(3n);
      const [p1, p2, p3] = await Promise.all([1n, 2n, 3n].map((id) => escrow.getProject(id)));
      expect([p1.client, p1.freelancer]).to.deep.equal([client.address, freelancer.address]);
      expect([p2.client, p2.freelancer]).to.deep.equal([other.address, client.address]);
      expect([p3.client, p3.freelancer]).to.deep.equal([client.address, other.address]);
      expect([p1.totalAmount, p2.totalAmount, p3.totalAmount]).to.deep.equal([
        ethers.parseEther("3.5"),
        7n,
        ethers.parseEther("3.5"),
      ]);
      expect((await escrow.getMilestones(2n)).map((m) => m.amount)).to.deep.equal([7n]);

      const expectedEscrow = ethers.parseEther("7") + 7n;
      expect(await escrow.totalEscrow()).to.equal(expectedEscrow);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(expectedEscrow);
    });

    it("lists project ids per account and role", async function () {
      const { escrow, arbitrator, client, freelancer, other } =
        await networkHelpers.loadFixture(deployEscrowFixture);
      await escrow
        .connect(client)
        .createProject(await validParams(freelancer.address), { value: ethers.parseEther("3.5") });
      await escrow
        .connect(other)
        .createProject(await validParams(client.address), { value: ethers.parseEther("3.5") });

      expect(await escrow.projectIdsAsClient(client.address)).to.deep.equal([1n]);
      expect(await escrow.projectIdsAsFreelancer(client.address)).to.deep.equal([2n]);
      expect(await escrow.projectIdsAsFreelancer(freelancer.address)).to.deep.equal([1n]);
      expect(await escrow.projectIdsAsClient(other.address)).to.deep.equal([2n]);
      expect(await escrow.projectIdsAsArbitrator(arbitrator.address)).to.deep.equal([1n, 2n]);
      expect(await escrow.projectIdsAsClient(freelancer.address)).to.deep.equal([]);
    });

    it("reverts reads of a project that does not exist", async function () {
      const { escrow } = await networkHelpers.loadFixture(deployEscrowFixture);

      await expect(escrow.getProject(0n))
        .to.be.revertedWithCustomError(escrow, "UnknownProject")
        .withArgs(0n);
      await expect(escrow.getMilestones(1n))
        .to.be.revertedWithCustomError(escrow, "UnknownProject")
        .withArgs(1n);
    });
  });

  describe("rejects malformed parameters", function () {
    type Params = Awaited<ReturnType<typeof validParams>>;
    type Ctx = { params: Params; now: bigint; client: string; arbitrator: string };
    const milestone = (amount: bigint, deliveryPeriod = DAY, title = "Milestone") => ({
      amount,
      deliveryPeriod,
      title,
    });

    // Each case breaks one rule; `args` are the expected custom-error arguments.
    const cases: Array<{
      name: string;
      mutate: (c: Ctx) => void;
      error: string;
      args?: (c: Ctx) => unknown[];
    }> = [
      { name: "freelancer is the zero address", mutate: (c) => { c.params.freelancer = ethers.ZeroAddress; }, error: "InvalidFreelancer", args: () => [ethers.ZeroAddress] },
      { name: "freelancer is the client", mutate: (c) => { c.params.freelancer = c.client; }, error: "InvalidFreelancer", args: (c) => [c.client] },
      { name: "freelancer is the arbitrator", mutate: (c) => { c.params.freelancer = c.arbitrator; }, error: "InvalidFreelancer", args: (c) => [c.arbitrator] },
      { name: "there are no milestones", mutate: (c) => { c.params.milestones = []; }, error: "InvalidMilestoneCount", args: () => [0n] },
      { name: "there are 21 milestones", mutate: (c) => { c.params.milestones = Array.from({ length: 21 }, () => milestone(1n)); }, error: "InvalidMilestoneCount", args: () => [21n] },
      { name: "a milestone amount is zero", mutate: (c) => { c.params.milestones[1].amount = 0n; }, error: "ZeroMilestoneAmount", args: () => [1n] },
      { name: "a delivery period is under 1 hour", mutate: (c) => { c.params.milestones[0].deliveryPeriod = HOUR - 1n; }, error: "InvalidDeliveryPeriod", args: () => [0n, HOUR - 1n] },
      { name: "a delivery period is over 365 days", mutate: (c) => { c.params.milestones[1].deliveryPeriod = 365n * DAY + 1n; }, error: "InvalidDeliveryPeriod", args: () => [1n, 365n * DAY + 1n] },
      { name: "the review window is under 1 day", mutate: (c) => { c.params.reviewWindow = DAY - 1n; }, error: "InvalidReviewWindow", args: () => [DAY - 1n] },
      { name: "the review window is over 30 days", mutate: (c) => { c.params.reviewWindow = 30n * DAY + 1n; }, error: "InvalidReviewWindow", args: () => [30n * DAY + 1n] },
      { name: "the acceptance deadline is the creation time", mutate: (c) => { c.params.acceptanceDeadline = c.now; }, error: "InvalidAcceptanceDeadline", args: (c) => [c.now] },
      { name: "the acceptance deadline is over 90 days away", mutate: (c) => { c.params.acceptanceDeadline = c.now + 90n * DAY + 1n; }, error: "InvalidAcceptanceDeadline", args: (c) => [c.now + 90n * DAY + 1n] },
      { name: "the title is empty", mutate: (c) => { c.params.title = ""; }, error: "InvalidTitle" },
      { name: "the title is over 100 bytes", mutate: (c) => { c.params.title = "a".repeat(101); }, error: "InvalidTitle" },
      { name: "the description is over 1000 bytes", mutate: (c) => { c.params.description = "a".repeat(1001); }, error: "DescriptionTooLong" },
      { name: "a milestone title is empty", mutate: (c) => { c.params.milestones[1].title = ""; }, error: "InvalidMilestoneTitle", args: () => [1n] },
      { name: "a milestone title is over 100 bytes", mutate: (c) => { c.params.milestones[0].title = "é".repeat(51); }, error: "InvalidMilestoneTitle", args: () => [0n] },
    ];

    for (const { name, mutate, error, args } of cases) {
      it(`reverts when ${name}`, async function () {
        const { escrow, client, arbitrator, freelancer } =
          await networkHelpers.loadFixture(deployEscrowFixture);
        const now = BigInt(await networkHelpers.time.latest()) + 1n;
        const ctx: Ctx = {
          params: await validParams(freelancer.address),
          now,
          client: client.address,
          arbitrator: arbitrator.address,
        };
        mutate(ctx);
        const total = ctx.params.milestones.reduce((sum, m) => sum + m.amount, 0n);

        await networkHelpers.time.setNextBlockTimestamp(now);
        const assertion = expect(
          escrow.connect(client).createProject(ctx.params, { value: total }),
        ).to.be.revertedWithCustomError(escrow, error);
        if (args) await assertion.withArgs(...args(ctx));
        else await assertion;
      });
    }

    it("reverts when the client is the project's arbitrator", async function () {
      const { escrow, arbitrator, freelancer } =
        await networkHelpers.loadFixture(deployEscrowFixture);
      const params = await validParams(freelancer.address);

      await expect(
        escrow.connect(arbitrator).createProject(params, { value: ethers.parseEther("3.5") }),
      ).to.be.revertedWithCustomError(escrow, "ClientIsArbitrator");
    });

    it("accepts every parameter at its inclusive limit", async function () {
      const { escrow, client, freelancer } =
        await networkHelpers.loadFixture(deployEscrowFixture);
      const now = BigInt(await networkHelpers.time.latest()) + 1n;
      const milestones = Array.from({ length: 20 }, (_, i) =>
        milestone(1n, i % 2 === 0 ? HOUR : 365n * DAY, "é".repeat(50)),
      );
      const params = {
        freelancer: freelancer.address,
        acceptanceDeadline: now + 90n * DAY,
        reviewWindow: 30n * DAY,
        title: "a".repeat(100),
        description: "a".repeat(1000),
        milestones,
      };

      await networkHelpers.time.setNextBlockTimestamp(now);
      await escrow.connect(client).createProject(params, { value: 20n });

      expect((await escrow.getProject(1n)).milestoneCount).to.equal(20n);
      const lower = { ...params, acceptanceDeadline: now + 2n, reviewWindow: DAY };
      await networkHelpers.time.setNextBlockTimestamp(now + 1n);
      await escrow.connect(client).createProject(lower, { value: 20n });
      expect((await escrow.getProject(2n)).reviewWindow).to.equal(DAY);
    });
  });

  describe("deposit must equal the milestone total exactly", function () {
    for (const [label, sent] of [
      ["underpays by 1 wei", ethers.parseEther("3.5") - 1n],
      ["overpays by 1 wei", ethers.parseEther("3.5") + 1n],
      ["sends nothing", 0n],
    ] as const) {
      it(`reverts when the client ${label}`, async function () {
        const { escrow, client, freelancer } =
          await networkHelpers.loadFixture(deployEscrowFixture);
        const params = await validParams(freelancer.address);

        await expect(escrow.connect(client).createProject(params, { value: sent }))
          .to.be.revertedWithCustomError(escrow, "IncorrectDeposit")
          .withArgs(ethers.parseEther("3.5"), sent);
        expect(await escrow.projectCount()).to.equal(0n);
        expect(await escrow.totalEscrow()).to.equal(0n);
      });
    }

    it("reverts with MilestoneTotalOverflow when milestone amounts overflow instead of wrapping", async function () {
      const { escrow, client, freelancer } =
        await networkHelpers.loadFixture(deployEscrowFixture);
      const params = await validParams(freelancer.address);
      params.milestones[0].amount = ethers.MaxUint256;
      params.milestones[1].amount = 2n;

      await expect(escrow.connect(client).createProject(params, { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "MilestoneTotalOverflow")
        .withArgs(1n);
    });

    it("rejects plain ETH transfers to the contract", async function () {
      const { escrow, client } = await networkHelpers.loadFixture(deployEscrowFixture);

      await expect(
        client.sendTransaction({ to: await escrow.getAddress(), value: 1n }),
      ).to.revert(ethers);
    });
  });
});
