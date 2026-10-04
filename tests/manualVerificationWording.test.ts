/**
 * "Unverified" is not shown to a person (docs/phase-218): an M-Pesa payment keyed in by
 * the cashier reads "Manual verification" on screen, on paper and in messages.
 *
 * The stored value `manual_unverified`, the `unverified` tab id, and identifiers such as
 * `confirmUnverified` are data and code, and stay. So the rule is: any text a person can
 * read (JSX text, a string or template literal that is prose) must not contain
 * "unverified"; the only strings with that word that may remain are the two data values.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'

const ROOT = resolve(__dirname, '..')
const SRC = join(ROOT, 'src')

/** The stored value, wherever it appears (a type, a CHECK constraint, a query): data, never shown. */
const STORED_VALUE = 'manual_unverified'

/** The only other string containing the word that may remain: the Daraja tab's internal id, never shown. */
const DATA_VALUES = new Set(['unverified'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

interface Hit {
  file: string
  line: number
  text: string
}

/** Every piece of text in `file` that is code-level prose: JSX text, string and template literals (never comments). */
function textsIn(file: string): Hit[] {
  const source = readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: Hit[] = []
  const add = (node: ts.Node, text: string): void => {
    if (/unverified/i.test(text.split(STORED_VALUE).join(''))) {
      hits.push({ file: relative(ROOT, file), line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: text.trim() })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) add(node, node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return hits
}

describe('no source text a person can read says "unverified"', () => {
  const hits = sourceFiles(SRC).flatMap(textsIn)

  it('finds no prose or label containing it, in the renderer, the main process or the preload', () => {
    const shown = hits.filter((hit) => !DATA_VALUES.has(hit.text))

    expect(shown).toEqual([])
  })

  it('leaves the stored value and the internal tab id as they were', () => {
    const data = new Set(hits.map((hit) => hit.text))
    const all = sourceFiles(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(all).toContain("verificationStatus: 'manual_unverified'")
    expect(all).toContain("CHECK (verification_status IN ('confirmed', 'matched', 'manual_unverified'))")
    expect(data.has('unverified')).toBe(true)
  })

  it('shows the new wording where the old was: the tab, the setting, the help text and the two messages', () => {
    const all = sourceFiles(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(all).toContain('Manual verification')
    expect(all).toContain('Allow recording manually verified M-Pesa payments')
    expect(all).toContain('Checked by the')
    expect(all).toContain('A manually verified M-Pesa payment must be explicitly confirmed')
    expect(all).toContain('Recording a manually verified M-Pesa payment is not switched on')
  })
})

describe('the printed output says no such thing', () => {
  const order: ReceiptLayoutOrder = {
    localId: 7,
    createdAt: '2026-10-04T09:00:00.000Z',
    cashierName: 'mary',
    paymentMethod: 'mpesa',
    tenderedAmount: 0,
    changeDue: 0,
    referenceNumber: 'QDF73HK9LM',
    fiscalInvoiceNumber: '0110605040001000811',
    traderInvNum: 'LZZYNW4NOE68CQ',
    fiscalizedAt: '04-10-2026 12:00:00',
    fiscalizedAtSource: 'device',
    cuSerial: 'KRAMW011202207060504',
    total: 100,
    vatGroups: { A: '100.00' },
    items: [{ title: 'Water', variantTitle: '', quantity: 1, unitPrice: 100, vatClass: 'A' }]
  }
  const texts = (entries: ReceiptLayoutEntry[]): string[] =>
    entries.map((entry) => (isReceiptLayoutQr(entry) ? entry.qr : entry.text))

  it.each([48, 42, 32] as const)('the fiscal slip, a sale record and the Enjoy slip of a manual M-Pesa sale at %d columns', (width) => {
    const settings = { taxRate: 0.16, tradingName: 'ENJOY' }
    const quiet = { warn: (): void => {} }
    const lines = [
      ...texts(buildReceiptLayout(order, settings, { width, logger: quiet })),
      ...texts(buildReceiptLayout({ ...order, fiscalInvoiceNumber: undefined, fiscalPending: true }, settings, { width, logger: quiet })),
      ...texts(buildEnjoySlip(order, {}, { width, kraNote: 'printed' }))
    ]

    expect(lines.length).toBeGreaterThan(20)
    expect(lines.filter((line) => /unverified/i.test(line))).toEqual([])
  })
})

describe('the built renderer', () => {
  const assets = join(ROOT, 'out', 'renderer', 'assets')
  const bundles = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith('.js')) : []
  const newestSource = Math.max(...sourceFiles(join(SRC, 'renderer')).map((file) => statSync(file).mtimeMs))
  const newestBundle = Math.max(0, ...bundles.map((name) => statSync(join(assets, name)).mtimeMs))
  const fresh = bundles.length > 0 && newestBundle >= newestSource

  it.skipIf(!fresh)('contains no capitalised word "Unverified" (the property name confirmUnverified is data) and no "unverified" followed by a word (rebuild if this fails)', () => {
    const text = bundles.map((name) => readFileSync(join(assets, name), 'utf8')).join('\n')

    expect(text).not.toMatch(/\bUnverified\b/)
    expect(text).not.toMatch(/unverified [A-Za-z]/i)
    expect(text).toContain('Manual verification')
  })
})
