import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Electron-Vite orchestration config.
 *
 * Splits the build into three bundles:
 *   • main     — Electron main process (CJS via externalizeDepsPlugin)
 *   • preload  — Context-bridge preload script (CJS)
 *   • renderer — Vite-bundled React SPA (ESM)
 *
 * The renderer receives the React JSX transform and the Tailwind v4 Vite
 * plugin so utility classes are purged at build time.
 */
/**
 * `sourcemap: false` on every bundle (Phase 12, Task 3 — the task
 * brief's `devtool: false` is webpack terminology; Vite's equivalent
 * build option is `build.sourcemap`). Vite already defaults to no
 * sourcemaps, but this is set explicitly on all three bundles so it
 * can't silently regress if a future change (or a copy-pasted example
 * from Vite's docs) turns one on — a sourcemap would let anyone
 * extract close-to-original TypeScript from the packaged app's
 * minified JS.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false
    }
  },
  preload: {
    // No externalizeDepsPlugin here: a sandboxed preload script's `require`
    // is restricted to Electron built-ins and cannot resolve node_modules
    // packages at runtime, so every dependency (e.g. @electron-toolkit/preload)
    // must be bundled directly into out/preload/index.js. `ssr.noExternal`
    // overrides Vite's default SSR behaviour of externalizing every
    // node_modules import.
    ssr: {
      noExternal: true
    },
    build: {
      sourcemap: false,
      // electron-vite auto-applies externalizeDepsPlugin unless disabled
      // here — that's what was silently re-externalizing our dependencies.
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: false
    }
  }
})