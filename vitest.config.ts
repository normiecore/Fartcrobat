import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine'),
      '@features': resolve(__dirname, 'src/features'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    include: ['tests/engine/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks'
  }
})
