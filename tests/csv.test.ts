/**
 * Generic CSV encoding tests (docs/phase-158) — escaping, formula-
 * injection prevention, the BOM, and money formatting. No report-
 * specific logic lives in `csv.ts`; that is covered separately in
 * `tests/reportsExport.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { buildCsv, csvCell, csvMoney } from '../src/main/lib/csv.js'

describe('csvCell', () => {
  it('leaves a plain value untouched', () => {
    expect(csvCell('hello')).toBe('hello')
    expect(csvCell(42)).toBe('42')
  })

  it('wraps and doubles quotes when a value contains a comma', () => {
    expect(csvCell('Nairobi, Kenya')).toBe('"Nairobi, Kenya"')
  })

  it('wraps and doubles an embedded double quote', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""')
  })

  it('wraps a value containing a newline', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
    it(`prefixes a value starting with ${JSON.stringify(trigger)} to prevent formula injection`, () => {
      const cell = csvCell(`${trigger}cmd|'/bin/sh'!A1`)
      expect(cell.startsWith(`'${trigger}`) || cell.startsWith(`"'${trigger}`)).toBe(true)
    })
  }

  it('does not prefix a value that merely contains a trigger character mid-string', () => {
    expect(csvCell('a=b')).toBe('a=b')
  })

  it('applies both the formula prefix and quoting together when both are needed', () => {
    // Starts with '=' AND contains a comma - needs the prefix, then quoting.
    expect(csvCell('=1,2')).toBe('"\'=1,2"')
  })
})

describe('csvMoney', () => {
  it('always formats to exactly 2 decimal places', () => {
    expect(csvMoney(5)).toBe('5.00')
    expect(csvMoney(5.1)).toBe('5.10')
    expect(csvMoney(5.999)).toBe('6.00')
  })
})

describe('buildCsv', () => {
  it('starts with a UTF-8 BOM', () => {
    const csv = buildCsv(['a'], [['1']])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })

  it('joins the header and rows with CRLF line endings', () => {
    const csv = buildCsv(['a', 'b'], [['1', '2'], ['3', '4']])
    const withoutBom = csv.slice(1)
    expect(withoutBom).toBe('a,b\r\n1,2\r\n3,4\r\n')
  })

  it('escapes every cell independently', () => {
    const csv = buildCsv(['name'], [['Doe, Jane'], ['=EVIL()']])
    const withoutBom = csv.slice(1)
    expect(withoutBom).toBe('name\r\n"Doe, Jane"\r\n\'=EVIL()\r\n')
  })
})
