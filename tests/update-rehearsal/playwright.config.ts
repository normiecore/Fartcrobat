// Update rehearsals (README.md). Not part of `npx playwright test`: run them through linux.sh or the
// update-rehearsal workflow, which install a released Fartcrobat first.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  workers: 1,
  retries: 0,
  // Also the limit of each beforeAll hook (installing the old version), which a spec's
  // test.setTimeout does not extend.
  timeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: process.env.REHEARSAL_OUT ? `${process.env.REHEARSAL_OUT}/playwright` : 'test-results/rehearsal'
})
