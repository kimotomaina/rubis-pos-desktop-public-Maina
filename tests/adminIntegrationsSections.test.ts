/**
 * Admin > Integrations, one section at a time (phase-142's overflow
 * finding; Phase E2(e)). Previously Shopify, Location, Fiscal device and
 * M-Pesa rendered stacked in two `<section>`s here, measuring
 * ~2200-2529px tall at scale 1 — too tall for the 1366x772 design box at
 * any zoom. Printer registration (moved here from Peripherals) makes it
 * five sections, shown one at a time via a small sub-nav.
 *
 * Source inspection, not a mount: `AdminScreen.tsx` has several relative
 * imports without a `.js` extension (`./EmptyState`, `../lib/currency`,
 * etc., unchanged by this phase) — fine for Vite's bundler resolution,
 * but `tests/**` compiles under `tsconfig.node.json`'s NodeNext
 * resolution, which requires the extension on every relative import it
 * reaches. Importing `AdminScreen` here would pull its whole fan-out
 * (EmptyState, ZReportModal, LocationPicker, the four page components,
 * etc.) into that stricter project and break `npm run typecheck` on
 * lines this phase did not touch. `adminIntegrationsSections` instead
 * verifies the JSX and effect wiring directly, the `stockTakeGuard.
 * test.ts` pattern for files too heavy to unit-import.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

describe('AdminScreen > Integrations: five sections, shown one at a time', () => {
  it('declares exactly the five named sections, in order, as a sub-nav', () => {
    expect(ADMIN_SCREEN).toMatch(
      /\[\s*\['shopify', 'Shopify'\],\s*\['location', 'Location'\],\s*\['fiscal', 'Fiscal Device'\],\s*\['mpesa', 'M-Pesa'\],\s*\['printer', 'Printer'\]\s*\]/
    )
  })

  it('renders each section only when integrationSection matches it — none unconditionally', () => {
    for (const key of ['shopify', 'location', 'fiscal', 'mpesa', 'printer']) {
      expect(INTEGRATIONS_BLOCK).toContain(`integrationSection === '${key}' && (`)
    }
    // Exactly five conditional sections, one per key — no extra always-on section left over.
    const matches = INTEGRATIONS_BLOCK.match(/integrationSection === '\w+' && \(/g) ?? []
    expect(matches).toHaveLength(5)
  })

  it('titles each section distinctly from the sub-nav label it lives under', () => {
    expect(INTEGRATIONS_BLOCK).toContain('Shopify Connection</h3>')
    expect(INTEGRATIONS_BLOCK).toContain('>Location</h3>')
    expect(INTEGRATIONS_BLOCK).toContain('>Fiscal Device</h3>')
    expect(INTEGRATIONS_BLOCK).toContain('M-Pesa (Daraja)</h3>')
    expect(INTEGRATIONS_BLOCK).toContain('>Printers</h3>')
  })

  it('loads printers only once the Printer section is the one showing, not just the Integrations tab', () => {
    expect(ADMIN_SCREEN).toContain(
      "if (activeTab === 'integrations' && integrationSection === 'printer') void loadPrinters()"
    )
    expect(ADMIN_SCREEN).toMatch(/}, \[activeTab, integrationSection\]\)/)
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
