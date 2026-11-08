// Deploys the escrow to the fresh end-to-end node with the same settings as contracts/ignition/parameters/local.json
// (admin account 0, arbitrator account 1, 1% fee). On a new node, account 0's first deployment lands on the address the web app was
// generated with, so the app and the proxy need no extra configuration and no tracked file changes.
import { readFile } from 'node:fs/promises'
import { ContractFactory } from 'ethers'
import { ROLE, address, escrowAddress, provider, signer } from './chain.ts'

const ARTIFACT = new URL('../../contracts/artifacts/contracts/TrustLanceEscrow.sol/TrustLanceEscrow.json', import.meta.url)
const FEE_BPS = 100

export default async function globalSetup(): Promise<void> {
  const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8').catch(() => {
    throw new Error('Contract artifact missing: run `npm run compile` first (`npm run test:e2e` from the repo root does).')
  })) as { abi: []; bytecode: string }

  if ((await provider.getCode(escrowAddress)) !== '0x') {
    throw new Error(`The end-to-end node already has a contract at ${escrowAddress}; it must start empty.`)
  }
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, await signer(ROLE.admin))
  const deployed = await factory.deploy(await address(ROLE.admin), await address(ROLE.arbitrator), FEE_BPS)
  await deployed.waitForDeployment()
  const deployedAt = await deployed.getAddress()
  if (deployedAt !== escrowAddress) {
    throw new Error(`Escrow deployed at ${deployedAt}, but the web app expects ${escrowAddress}. Run \`npm run deploy:local\` once to regenerate it.`)
  }
}
