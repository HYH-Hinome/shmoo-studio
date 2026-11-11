/// <reference types="vite/client" />

import type { ShmooApi } from '@shared/types/api'

declare global {
  interface Window {
    /** preload 暴露的白名单 API，见 src/shared/types/api.ts */
    shmoo: ShmooApi
  }
}

export {}
