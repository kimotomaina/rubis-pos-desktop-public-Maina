/// <reference path="./window.d.ts" />

import type { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    /**
     * The full Electron API surface from @electron-toolkit/preload.
     * Populated only when `contextIsolation` is enabled.
     */
    electron: ElectronAPI
  }
}

export {}
