/**
 * Phase 254: nothing a cashier can reach on screen calls a channel the role gate refuses a cashier, so the gate never
 * breaks a cashier's selling screen. Every `window.api` call in every renderer file is mapped through the preload to its
 * channel; a file counts as a cashier's unless it is one of the admin-only screens listed here, so a new screen is
 * checked by default.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CASHIER_CHANNELS } from '../src/main/lib/roleGate.js'

const RENDERER = join(process.cwd(), 'src', 'renderer', 'src')

/** Screens only an admin reaches (the Admin tab and what it opens), or, for onboarding, nobody signed in. */
const ADMIN_ONLY = new Set(
  [
    'components/AdminScreen.tsx',
    'components/LocationConfirmScreen.tsx',
    'components/MergeShiftsForm.tsx',
    'components/MoveSaleForm.tsx',
    'components/ShiftCorrectionForm.tsx',
    'components/ShiftEndOfDay.tsx',
    'components/ShiftApprovalList.tsx',
    'components/ScopePicker.tsx',
    'components/WindowReportModal.tsx',
    'components/OnboardingScreen.tsx',
    'components/EtimsSetupGate.tsx',
    'pages/MpesaLogsPage.tsx',
    'pages/MpesaReconciliationPage.tsx',
    'pages/NeedsAttentionPage.tsx',
    'pages/ReportsPage.tsx',
    'pages/StockTakePage.tsx'
  ].map((path) => path.replace(/\//g, '\\'))
)

/** Each preload method and the channels it invokes. */
function preloadChannels(): Map<string, string[]> {
  const source = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
  const methods = new Map<string, string[]>()
  const starts = [...source.matchAll(/^ {2}(\w+): /gm)]
  starts.forEach((match, index) => {
    const chunk = source.slice(match.index, starts[index + 1]?.index ?? source.length)
    methods.set(match[1], [...chunk.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]))
  })
  return methods
}

function rendererFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rendererFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('what a cashier can reach on screen', () => {
  const channels = preloadChannels()
  const cashierFiles = rendererFiles(RENDERER).filter((path) => !ADMIN_ONLY.has(relative(RENDERER, path).replace(/\//g, '\\')))

  it('finds the screens it checks', () => {
    for (const name of ['App.tsx', 'MyShiftsPage.tsx', 'OrderHistory.tsx', 'PaymentModal.tsx', 'ZReportBlock.tsx', 'cartStore.ts']) {
      expect(cashierFiles.some((path) => path.endsWith(name)), name).toBe(true)
    }
  })

  it.each(rendererFiles(RENDERER).filter((path) => !ADMIN_ONLY.has(relative(RENDERER, path).replace(/\//g, '\\'))).map((path) => [relative(RENDERER, path), path]))(
    '%s calls only channels a cashier may call',
    (_name, path) => {
      const source = readFileSync(path, 'utf8')
      const called = [...source.matchAll(/window\.api\??\s*\.\s*(\w+)/g)].map((m) => m[1])
      for (const method of called) {
        if (/^on[A-Z]/.test(method) || method === 'platform') continue
        const invoked = channels.get(method)
        expect(invoked, `${method} is not in the preload`).toBeDefined()
        for (const channel of invoked ?? []) expect(CASHIER_CHANNELS.has(channel), `${method} -> ${channel}`).toBe(true)
      }
    }
  )
})
