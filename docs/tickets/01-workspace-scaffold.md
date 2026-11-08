# 01: Workspace scaffold and toolchain

**What to build:** An npm-workspaces repo with a Hardhat 3 contracts workspace and a React/Vite/TS/Tailwind web workspace that both build and test from the root, with secrets kept out of git. The current docs for Hardhat 3, Ignition, the keystore plugin, Vite and Tailwind 4 are read before installing.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] Root scripts for compile, contract tests, web dev, web build and lint all run successfully
- [x] A placeholder contract compiles and a placeholder contract test passes under Hardhat 3
- [x] The web app renders a Tailwind-styled shell page
- [x] `.gitignore` covers node_modules, build output, Hardhat cache/artifacts, `.env*` (except `*.example`) and keystores
- [x] Pinned library versions are recorded, with any deviation from the spec's version list explained
- [x] CLAUDE.md commands section updated to the real commands

## Comments

**2026-10-25, done.** `npm run check` passes: compile, typecheck, oxlint, 5 contract tests (3 Solidity including a 256-run fuzz test, 2 mocha), and the web build. Coverage runs. The shell page was checked in the browser.

The placeholder `Counter` contract and tests come from Hardhat's `mocha-ethers` template. Ticket 02 replaces them. I removed the template's OP-chain network and script because L2 is out of scope.

TypeScript is on 6.0 instead of 7.0 because both templates pin it. The zod audit finding is accepted for now; both are recorded in CLAUDE.md.
