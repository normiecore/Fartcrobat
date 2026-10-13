import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@engine': resolve(__dirname, 'src/engine'),
  '@features': resolve(__dirname, 'src/features'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@main': resolve(__dirname, 'src/main')
}

export default defineConfig({
  // The installers ship no node_modules (electron-builder.yml), so the main and preload bundles
  // must contain every package they import: only Electron and Node's built-ins stay external.
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: false,
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
