// Update rehearsals (README.md). Not part of `npx playwright test`: run them through linux.sh or the
// update-rehearsal workflow, which install a released Fartcrobat first.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.REHEARSAL_OUT ? `${process.env.REHEARSAL_OUT}/playwright` : 'test-results/rehearsal'
})
