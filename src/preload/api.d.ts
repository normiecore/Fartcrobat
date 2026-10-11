import type { PreloadApi } from '@shared/ipc'

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
