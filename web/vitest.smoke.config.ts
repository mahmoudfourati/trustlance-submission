import { defineConfig } from 'vitest/config'

// Only the manual smoke tests (*.smoke.ts); `npm test` never runs them because they need real services.
export default defineConfig({
  test: { include: ['server/**/*.smoke.ts'] },
})
