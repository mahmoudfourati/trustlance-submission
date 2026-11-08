import { gatewayList } from './deliverable'

/** Dev-only: the end-to-end suite's local pinning store, used instead of real gateways under `--mode testwallet`. */
const e2eGateway = import.meta.env.DEV && import.meta.env.MODE === 'testwallet' ? import.meta.env.VITE_E2E_IPFS_GATEWAY : undefined

/** IPFS gateways for reading deliverables: VITE_PINATA_GATEWAY (a bare host such as example.mypinata.cloud) first. */
export const ipfsGateways: string[] = e2eGateway ? [e2eGateway] : gatewayList(import.meta.env.VITE_PINATA_GATEWAY)
