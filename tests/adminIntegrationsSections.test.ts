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

  it('keeps Save Integration Settings reachable from both M-Pesa and Fiscal Device, same handler, no new one', () => {
    const saveCalls = [
      ...INTEGRATIONS_BLOCK.matchAll(/onClick=\{\(\) => void handleSaveIntegrationsConfig\(\)\}/g)
    ]
    expect(saveCalls).toHaveLength(2)
    // No section invented a second save handler for the same combined settings.
    expect(INTEGRATIONS_BLOCK).not.toMatch(/handleSave(Mpesa|Fiscal)(Only)?Config/)
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
