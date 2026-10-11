import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@engine': resolve(__dirname, 'src/engine'),
  '@features': resolve(__dirname, 'src/features'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@main': resolve(__dirname, 'src/main')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    optimizeDeps: { exclude: ['mupdf'] },
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 20000,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
