// Ports of the end-to-end stack, chosen apart from `npm run chain` (8545) and `npm run dev` (5173) so a suite run
// never touches a development chain or server.
const chainPort = 8546
const storePort = 8547
const appPort = 5174

export const E2E = {
  chainPort,
  storePort,
  appPort,
  chainUrl: `http://127.0.0.1:${chainPort}`,
  storeUrl: `http://127.0.0.1:${storePort}`,
  appUrl: `http://localhost:${appPort}`,
}
