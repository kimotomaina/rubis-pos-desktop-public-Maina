/**
 * Admin > Integrations, one section at a time (phase-142's overflow
 * finding; Phase E2(e)). Previously Shopify, Location, Fiscal device and
 * M-Pesa rendered stacked in two `<section>`s here, measuring
 * ~2200-2529px tall at scale 1 — too tall for the 1366x772 design box at
 * any zoom. Printer registration (moved here from Peripherals) makes it
 * five sections, shown one at a time via a small sub-nav.
 *
 * DELIBERATE TEST CHANGE (docs/phase-155): `AdminScreen.tsx` could not be
 * mounted here before this phase — several of its relative imports (and
 * a few of its transitive ones — `EmptyState`, `ZReportModal`,
 * `RestartCountdownModal`, `MpesaLogsPage`) were missing the `.js`
 * extension `tests/**`'s NodeNext resolution requires, so this file did
 * source inspection instead (`readFileSync` + regex/slice), the
 * `stockTakeGuard.test.ts` pattern for files too heavy to unit-import.
 * Phase-155 fixed those extensions (the same fix phase-146 applied to
 * `PosCheckoutPanel`) so it could convert every plain `<input>` to the
 * on-screen-keyboard pattern and test the result with a real mount
 * (`tests/adminScreen.test.ts`) — and mounting is now possible here too.
 *   Old assertions: four tests below (`declares exactly the five named
 *     sections`, `renders each section only when integrationSection
 *     matches`, `titles each section distinctly`, `loads printers only
 *     once the Printer section is showing`) each read `AdminScreen.tsx`
 *     as a string and matched regex/substrings against its JSX.
 *   New assertions: the same four behaviours, proved instead by
 *     mounting `AdminScreen` and driving its sub-nav for real — a mount
 *     confirms the section actually renders, not just that the source
 *     text contains the right conditional.
 *   Decision that required it: docs/phase-155's own instruction to
 *     replace phase-148's source-reading checks with real mount
 *     assertions "where they cover the same behaviour."
 *
 * The remaining tests in this file (save-handler isolation: no shared
 * handler, M-Pesa validation independent of the fiscal fields, an
 * honest restart prompt, the fiscal save never touching M-Pesa state,
 * etc.) stay source-reading on purpose: they are negative-space
 * assertions ("this function body does not reference that variable"),
 * which reading the function's own text proves more directly than
 * driving the UI and inferring absence from a spy's call arguments —
 * and none of their underlying code changed in phase-155.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'

const ADMIN_SCREEN = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'components', 'AdminScreen.tsx'),
  'utf8'
)

/** The `activeTab === 'integrations'` branch only, so matches elsewhere in the file can't false-pass. */
const INTEGRATIONS_BLOCK = ADMIN_SCREEN.slice(
  ADMIN_SCREEN.indexOf("{activeTab === 'integrations' && ("),
  ADMIN_SCREEN.indexOf("{activeTab === 'overview' && (")
)

/** The `activeTab === 'peripherals'` branch only. */
const PERIPHERALS_BLOCK = ADMIN_SCREEN.slice(
  ADMIN_SCREEN.indexOf("{activeTab === 'peripherals' && ("),
  ADMIN_SCREEN.indexOf("{activeTab === 'integrations' && (")
)

let container: HTMLDivElement
let root: Root

function ok<T>(data?: T): { success: true; data: T | undefined } {
  return { success: true, data }
}

/** Stubs only what mounting AdminScreen and visiting Integrations/Peripherals needs. */
function stubApi(): void {
  window.api = {
    getDailySummary: vi
      .fn()
      .mockResolvedValue(ok({ orderCount: 0, totalRevenue: 0, totalTax: 0, totalsByMethod: { cash: 0, mpesa: 0, card: 0 } })),
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getStaffList: vi.fn().mockResolvedValue(ok([])),
    getIntegrationConfig: vi.fn((provider: string) =>
      Promise.resolve(
        ok(
          provider === 'mpesa'
            ? {
                consumerKey: '',
                shortcode: '',
                environment: 'sandbox',
                callbackUrl: '',
                confirmationMethod: 'manual',
                smsInboxPath: '',
                manualEntryEnabled: false
              }
            : { baseUrl: '', deviceIp: '', devicePort: '', defaultVatClass: '' }
        )
      )
    ),
    getMpesaCredentialStatus: vi
      .fn()
      .mockResolvedValue(ok({ consumerSecretConfigured: false, passkeyConfigured: false })),
    getEtimsSecretStatus: vi.fn().mockResolvedValue(ok({ passwordConfigured: false })),
    getStoreIdentity: vi.fn().mockResolvedValue(ok({ storeName: '', storeKraPin: '' })),
    getShopifyTokenStatus: vi.fn().mockResolvedValue(ok({ configured: false })),
    getShopifyStoreUrl: vi.fn().mockResolvedValue(ok({ storeUrl: '' })),
    getConfigStatus: vi.fn().mockResolvedValue(ok({ config: null })),
    getPrinters: vi.fn().mockResolvedValue(ok([]))
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}

describe('AdminScreen > Integrations: five sections, shown one at a time', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('declares exactly the five named sections, in order, as cards', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    const cards = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(cards).toEqual(
      expect.arrayContaining(['Shopify', 'Location', 'Fiscal Device', 'M-Pesa', 'Printer'])
    )
    // In this exact order, in the card grid shown as soon as Integrations opens (phase-167 Part A).
    const order = cards.filter((label) =>
      ['Shopify', 'Location', 'Fiscal Device', 'M-Pesa', 'Printer'].includes(label ?? '')
    )
    expect(order).toEqual(['Shopify', 'Location', 'Fiscal Device', 'M-Pesa', 'Printer'])
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-167 Part A): Integrations opened
   * straight to the Shopify section by default; it now opens to a card
   * grid (same pattern as Admin's own top level), and no section renders
   * until its card is tapped. Switching to a different section goes via
   * "Back to Integrations" first, not directly from one section to
   * another — the same one-at-a-time navigation the card grid uses
   * everywhere else.
   *   Old assertion: clicking "Integrations" alone already shows
   *     "Shopify Connection</h3>"; clicking a different sub-nav button
   *     switches directly between sections.
   *   New assertion: clicking "Integrations" shows neither; each
   *     section's own card must be tapped to see it, and only after
   *     returning to the grid can a different card be tapped.
   */
  it('renders each section only when its own card is the one clicked — none unconditionally', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    // The grid is showing — no section content is rendered until a card is tapped.
    expect(container.innerHTML).not.toContain('Shopify Connection</h3>')
    expect(container.innerHTML).not.toContain('>Fiscal Device</h3>')

    for (const [card, heading] of [
      ['Shopify', 'Shopify Connection</h3>'],
      ['Location', 'Location</h3>'],
      ['Fiscal Device', 'Fiscal Device</h3>'],
      ['M-Pesa', '>M-Pesa</h3>'],
      ['Printer', 'Printers</h3>']
    ] as const) {
      await click(card)
      expect(container.innerHTML).toContain(heading)
      await click('Back to Integrations')
    }
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-148.md step 2): the M-Pesa
   * section heading dropped "(Daraja)" — M-Pesa is no longer
   * Daraja-exclusive (manual/daraja/sms), so a heading naming only one
   * of its three modes would be actively wrong once manual is the default.
   *   Old assertion: `'M-Pesa (Daraja)</h3>'`.
   *   New assertion: `'>M-Pesa</h3>'`.
   *
   * ALSO CHANGED (docs/phase-167 Part A, same reasoning as the test
   * above): each section is now reached from the grid via its own card,
   * with "Back to Integrations" between them, rather than switching
   * directly from one sub-nav button to the next.
   */
  it('titles each section distinctly from the card it lives under', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    await click('Shopify')
    expect(container.innerHTML).toContain('Shopify Connection</h3>')
    await click('Back to Integrations')

    await click('Location')
    expect(container.textContent).toContain('Location')
    await click('Back to Integrations')

    await click('Fiscal Device')
    expect(container.innerHTML).toContain('>Fiscal Device</h3>')
    await click('Back to Integrations')

    await click('M-Pesa')
    expect(container.innerHTML).toContain('>M-Pesa</h3>')
    await click('Back to Integrations')

    await click('Printer')
    expect(container.innerHTML).toContain('>Printers</h3>')
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-167 Part A): Printer is reached
   * via "Back to Integrations" then its own card, not by clicking
   * directly from the M-Pesa section.
   *   Old assertion: `click('M-Pesa')` then `click('Printer')` directly.
   *   New assertion: `click('M-Pesa')`, `click('Back to Integrations')`,
   *     then `click('Printer')`.
   */
  it('loads printers only once the Printer section is the one showing, not just the Integrations tab', async () => {
    stubApi()
    await mount()
    await click('Integrations')
    expect(window.api.getPrinters).not.toHaveBeenCalled()

    await click('M-Pesa')
    expect(window.api.getPrinters).not.toHaveBeenCalled()
    await click('Back to Integrations')

    await click('Printer')
    expect(window.api.getPrinters).toHaveBeenCalledTimes(1)
  })

  /**
   * Phase 148 step 1 deliberately reverses this test's old assertion.
   * It used to require exactly ONE shared `handleSaveIntegrationsConfig`
   * reachable from both the M-Pesa and Fiscal Device sections — that
   * shared handler is why a till could not save M-Pesa settings at all
   * until its fiscal device IP/port were already valid (phase-147 Part 6
   * #5). The client's decoupling decision (phase-148) requires the
   * opposite: three independent handlers, each validating and saving
   * only its own section, with no cross-validation between them.
   *   Old assertion: `handleSaveIntegrationsConfig` called from exactly
   *     2 places; no `handleSave(Mpesa|Fiscal)Config` exists.
   *   New assertion: `handleSaveIntegrationsConfig` no longer exists at
   *     all; `handleSaveMpesaConfig`, `handleSaveFiscalConfig` and
   *     `handleSaveStoreIdentity` each exist and are called exactly once.
   */
  it('saves M-Pesa, Fiscal Device and Store Details independently — no shared handler', () => {
    expect(ADMIN_SCREEN).not.toContain('handleSaveIntegrationsConfig')
    for (const handler of ['handleSaveMpesaConfig', 'handleSaveFiscalConfig', 'handleSaveStoreIdentity']) {
      const calls = [
        ...INTEGRATIONS_BLOCK.matchAll(new RegExp(`onClick=\\{\\(\\) => void ${handler}\\(\\)\\}`, 'g'))
      ]
      expect(calls).toHaveLength(1)
    }
  })

  it("does not let the M-Pesa save's validation depend on the Fiscal Device fields", () => {
    const mpesaHandlerBody = ADMIN_SCREEN.slice(
      ADMIN_SCREEN.indexOf('const handleSaveMpesaConfig = () => {'),
      ADMIN_SCREEN.indexOf('const handleSaveFiscalConfig = () => {')
    )
    expect(mpesaHandlerBody).not.toContain('validateEtimsConnection')
    expect(mpesaHandlerBody).not.toContain('etimsBaseUrl')
    expect(mpesaHandlerBody).not.toContain('etimsDeviceIp')
    expect(mpesaHandlerBody).not.toContain('etimsDevicePort')
  })

  it('gives the M-Pesa save an honest restart prompt instead of a hot-apply claim', () => {
    const mpesaHandlerBody = ADMIN_SCREEN.slice(
      ADMIN_SCREEN.indexOf('const handleSaveMpesaConfig = () => {'),
      ADMIN_SCREEN.indexOf('const handleSaveFiscalConfig = () => {')
    )
    expect(mpesaHandlerBody).toContain('setShowRestartModal(true)')
    expect(INTEGRATIONS_BLOCK).toContain('Save & Restart')
  })

  it('never sends an M-Pesa field from the Fiscal Device save', () => {
    const fiscalHandlerBody = ADMIN_SCREEN.slice(
      ADMIN_SCREEN.indexOf('const handleSaveFiscalConfig = () => {'),
      ADMIN_SCREEN.indexOf('const handleSaveStoreIdentity = () => {')
    )
    expect(fiscalHandlerBody).not.toContain("setIntegrationConfig(\n              'mpesa'")
    expect(fiscalHandlerBody).not.toContain('mpesaConsumerKey')
    expect(fiscalHandlerBody).not.toContain('mpesaShortcode')
    expect(fiscalHandlerBody).not.toContain('setMpesaCredentials')
  })

  it('keeps a failing Store Details save from touching M-Pesa or Fiscal Device state', () => {
    const storeIdentityHandlerBody = ADMIN_SCREEN.slice(
      ADMIN_SCREEN.indexOf('const handleSaveStoreIdentity = () => {'),
      ADMIN_SCREEN.indexOf('/**\n   * Runs the three-hop fiscal device check')
    )
    expect(storeIdentityHandlerBody).not.toContain('setMpesaMessage')
    expect(storeIdentityHandlerBody).not.toContain('setFiscalMessage')
    expect(storeIdentityHandlerBody).not.toContain('loadMpesaConfig')
    expect(storeIdentityHandlerBody).not.toContain('loadFiscalConfig')
    expect(storeIdentityHandlerBody).toContain('setStoreIdentityMessage')
  })

  it('shows each Integrations section its own save message, not a shared one', () => {
    const mpesaStart = INTEGRATIONS_BLOCK.indexOf("integrationSection === 'mpesa'")
    const fiscalStart = INTEGRATIONS_BLOCK.indexOf("integrationSection === 'fiscal'")
    const printerStart = INTEGRATIONS_BLOCK.indexOf("integrationSection === 'printer'")
    const mpesaSection = INTEGRATIONS_BLOCK.slice(mpesaStart, fiscalStart)
    const fiscalSection = INTEGRATIONS_BLOCK.slice(fiscalStart, printerStart)
    expect(mpesaSection).toContain('{mpesaMessage &&')
    expect(mpesaSection).not.toContain('{fiscalMessage &&')
    expect(mpesaSection).not.toContain('{storeIdentityMessage &&')
    expect(fiscalSection).toContain('{fiscalMessage &&')
    expect(fiscalSection).toContain('{storeIdentityMessage &&')
    expect(fiscalSection).not.toContain('{mpesaMessage &&')
  })

  it('folds Store Details into Fiscal Device rather than inventing an unlisted sixth section', () => {
    const fiscalStart = INTEGRATIONS_BLOCK.indexOf("integrationSection === 'fiscal'")
    const mpesaOrPrinterAfterFiscal = INTEGRATIONS_BLOCK.indexOf(
      "integrationSection === 'printer'",
      fiscalStart
    )
    const fiscalSection = INTEGRATIONS_BLOCK.slice(fiscalStart, mpesaOrPrinterAfterFiscal)
    expect(fiscalSection).toContain('Store Details</h4>')
    expect(fiscalSection).toContain('storeKraPin')
  })

  it('leaves every existing settings handler and its call signature untouched', () => {
    const untouchedHandlers = [
      'handleSaveShopifyStoreUrl()',
      'handleSaveShopifyToken()',
      'handleOpenChangeLocation',
      'handleConfirmChangeLocation',
      'handleTestMpesaConnection()',
      'handleTestEtimsConnection()',
      'handleAddPrinter()',
      'handleDeletePrinter(printer.id)',
      'handleTestPrinter(printer.id, printer.interfaceName)'
    ]
    for (const handler of untouchedHandlers) {
      expect(INTEGRATIONS_BLOCK).toContain(handler)
    }
  })
})

describe('AdminScreen > Peripherals: Printer moved out, Barcode Scanner Stations stays', () => {
  it('no longer registers printers from the Peripherals tab', () => {
    expect(PERIPHERALS_BLOCK).not.toContain('Printers</h3>')
    expect(PERIPHERALS_BLOCK).not.toContain('handleAddPrinter')
  })

  it('still has the Barcode Scanner Stations instructions', () => {
    expect(PERIPHERALS_BLOCK).toContain('Barcode Scanner Stations</h3>')
  })
})
