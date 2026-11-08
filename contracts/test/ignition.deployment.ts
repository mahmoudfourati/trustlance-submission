import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { Wallet } from "ethers";
import { network } from "hardhat";
import TrustLanceEscrowModule from "../ignition/modules/TrustLanceEscrow.js";

const LOCAL_PARAMETERS = fileURLToPath(new URL("../ignition/parameters/local.json", import.meta.url));

/** A fresh chain whose only signer is a throwaway key, like the Sepolia network in hardhat.config.ts. */
async function connectWithOneSigner() {
  const deployer = Wallet.createRandom();
  const connection = await network.create({
    override: { accounts: [{ privateKey: deployer.privateKey, balance: 10n ** 21n }] },
  });
  return { connection, deployer };
}

describe("Ignition module: TrustLanceEscrowModule", function () {
  describe("with one signing account (Sepolia)", function () {
    it("deploys with separate admin and arbitrator addresses, neither being the deployer", async function () {
      const { connection, deployer } = await connectWithOneSigner();
      const admin = Wallet.createRandom().address;
      const arbitrator = Wallet.createRandom().address;

      assert.deepEqual(
        (await connection.ethers.getSigners()).map((signer) => signer.address),
        [deployer.address],
      );
      const { escrow } = await connection.ignition.deploy(TrustLanceEscrowModule, {
        parameters: { TrustLanceEscrowModule: { admin, arbitrator, feeBps: 250 } },
      });

      expect(await escrow.owner()).to.equal(admin);
      expect(await escrow.defaultArbitrator()).to.equal(arbitrator);
      expect(await escrow.arbitrationFeeBps()).to.equal(250n);
    });

    for (const missing of ["admin", "arbitrator"] as const) {
      it(`refuses to deploy without an explicit ${missing}`, async function () {
        const { connection } = await connectWithOneSigner();
        const parameters: Record<string, string> = {
          admin: Wallet.createRandom().address,
          arbitrator: Wallet.createRandom().address,
        };
        delete parameters[missing];

        await assert.rejects(
          connection.ignition.deploy(TrustLanceEscrowModule, {
            parameters: { TrustLanceEscrowModule: parameters },
          }),
          new RegExp(missing),
        );
      });
    }
  });

  describe("with the local parameters file", function () {
    it("makes account 0 the admin and account 1 the arbitrator, with a 1% fee, deployed from account 0", async function () {
      const { ethers, ignition } = await network.create();
      const [account0, account1] = await ethers.getSigners();

      const { escrow } = await ignition.deploy(TrustLanceEscrowModule, { parameters: LOCAL_PARAMETERS });

      expect(await escrow.owner()).to.equal(account0.address);
      expect(await escrow.defaultArbitrator()).to.equal(account1.address);
      expect(await escrow.arbitrationFeeBps()).to.equal(100n);
      expect(await escrow.getAddress()).to.equal(ethers.getCreateAddress({ from: account0.address, nonce: 0 }));
    });
  });
});
