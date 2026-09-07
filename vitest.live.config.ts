/// <reference types="vitest/config" />

import { defineConfig } from 'vite'

/**
 * Vitest config for the LIVE ZFPLabServer smoke test — deliberately
 * separate from `vite.config.ts`, which excludes `tests/live/**` so a
 * plain `npm test` never dials real HTTP.
 *
 * Selecting this config (`npm run test:live`) IS the opt-in: it sets
 * `LIVE_ZFP=1` via Vitest's `test.env` (the documented, cross-platform
 * way to inject env vars into the test run — no shell-specific
 * `set`/`export` syntax needed in `package.json`, so this works
 * identically on Windows and POSIX). The test file's own
 * `describe.skipIf(process.env.LIVE_ZFP !== '1')` guard is a second,
 * independent gate — belt-and-suspenders in case this file is ever
 * pointed at directly by some other means.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/live/**/*.live.test.ts'],
    env: { LIVE_ZFP: '1' },
    // Live HTTP against real hardware is inherently slower than the
    // mocked suite's milliseconds. The ReadStatus test alone can make
    // two requests (a settings() re-handshake plus the ReadStatus call
    // itself), each capped at production's real 5s per-request timeout
    // (`ETIMS_REQUEST_TIMEOUT_MS`), so this needs headroom above ~10s.
    testTimeout: 15_000
  }
})
