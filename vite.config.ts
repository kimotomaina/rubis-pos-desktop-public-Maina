/// <reference types="vitest/config" />

import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite config consumed by Vitest and any standalone renderer tooling.
 *
 * electron-vite uses its own `electron.vite.config.ts` for the main and
 * preload bundles; this file provides the renderer plugins and test
 * environment so that Vitest can parse TSX with React 19.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}']
  }
})