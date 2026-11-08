// Manual smoke test against real Pinata: `npm run smoke:upload -w @trustlance/web`.
// Needs: the local chain (`npm run chain`) with the escrow deployed (`npm run deploy:local`), and the dev server
// (`npm run dev`) started with PINATA_JWT in web/.env.local. See docs/upload-proxy.md.
import { Contract, JsonRpcProvider, parseEther } from 'ethers'
import { expect, it } from 'vitest'
import { escrowAbi } from '../src/contracts/generated/escrowAbi'
import { escrowAddresses } from '../src/contracts/generated/deployments'
import { fetchDeliverable, gatewayList, uploadDeliverable } from '../src/lib/deliverable'
import { requestUploadTargets } from '../src/lib/uploadProxyClient'

const CHAIN_ID = 31337
const RPC_URL = process.env.SMOKE_RPC_URL ?? 'http://127.0.0.1:8545'
const PROXY_URL = process.env.SMOKE_PROXY_URL ?? 'http://localhost:5173'
const GATEWAYS = gatewayList(process.env.SMOKE_GATEWAY)

it('uploads an encrypted deliverable through the proxy to Pinata and reads it back', { timeout: 180_000 }, async () => {
  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true })
  // Hardhat's unlocked dev accounts 2 (client) and 3 (freelancer); no keys are needed or stored.
  const client = await provider.getSigner(2)
  const freelancer = await provider.getSigner(3)
  const escrowAddress = escrowAddresses[CHAIN_ID]
  const escrow = new Contract(escrowAddress, escrowAbi, client)

  const now = (await provider.getBlock('latest'))!.timestamp
  await (
    await escrow.createProject(
      {
        freelancer: await freelancer.getAddress(),
        acceptanceDeadline: now + 86_400,
        reviewWindow: 7 * 86_400,
        title: 'Upload smoke test',
        description: '',
        milestones: [{ amount: parseEther('0.01'), deliveryPeriod: 86_400, title: 'Smoke deliverable' }],
      },
      { value: parseEther('0.01') },
    )
  ).wait()
  const projectId = (await escrow.projectCount()) as bigint
  await ((await (escrow.connect(freelancer) as Contract).acceptProject(projectId)) as { wait(): Promise<unknown> }).wait()

  const targets = await requestUploadTargets({
    signer: freelancer,
    chainId: CHAIN_ID,
    escrow: escrowAddress,
    projectId,
    milestoneIndex: 0,
    endpoint: `${PROXY_URL}/api/upload-url`,
  })
  const content = new TextEncoder().encode(`TrustLance smoke deliverable ${new Date().toISOString()}`)
  const { manifestCid, manifest } = await uploadDeliverable({
    file: { name: 'smoke.txt', type: 'text/plain', bytes: content },
    passphrase: 'smoke-test-passphrase',
    targets,
  })
  console.log(`project #${projectId}: manifest ${manifestCid}, file ${manifest.fileCid}`)

  // Freshly pinned content can take a moment to reach gateways; retry for up to ~2 minutes.
  let lastError: unknown
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = await fetchDeliverable(manifestCid, { passphrase: 'smoke-test-passphrase', gateways: GATEWAYS, timeoutMs: 10_000 })
      expect(result.bytes).toEqual(content)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  throw lastError
})
