/**
 * Admin screen fiscal-device form validation.
 *
 * Kept framework-free so it's testable without mounting `AdminScreen`
 * (whose renderer-only import graph isn't `NodeNext`-extension-safe, the
 * module resolution `tests/**` is type-checked under).
 *
 * The messages are asserted as whole sentences, not matched loosely: a
 * branch manager reads them off a touch till, and "no codes, no jargon"
 * is a requirement of this screen rather than a style preference.
 */

import { describe, it, expect } from 'vitest'
import {
  isIpv4Address,
  validateEtimsConnection,
  DEFAULT_ETIMS_BASE_URL,
  DEFAULT_ETIMS_DEVICE_PORT,
  DEFAULT_ETIMS_VAT_CLASS
} from '../src/renderer/src/lib/etimsConfig.js'

/** A complete, valid set of connection fields. */
const VALID = {
  baseUrl: 'http://localhost:4444/',
  deviceIp: '192.168.1.50',
  devicePort: '8000'
}

describe('isIpv4Address', () => {
  it('accepts a dotted quad', () => {
    expect(isIpv4Address('192.168.1.50')).toBe(true)
    expect(isIpv4Address('10.0.0.1')).toBe(true)
    expect(isIpv4Address('255.255.255.255')).toBe(true)
    expect(isIpv4Address('0.0.0.0')).toBe(true)
  })

  it('ignores surrounding whitespace', () => {
    expect(isIpv4Address('  192.168.1.50  ')).toBe(true)
  })

  it('rejects an octet above 255', () => {
    expect(isIpv4Address('192.168.1.256')).toBe(false)
    expect(isIpv4Address('999.1.1.1')).toBe(false)
  })

  it('rejects the wrong number of octets', () => {
    expect(isIpv4Address('192.168.1')).toBe(false)
    expect(isIpv4Address('192.168.1.50.7')).toBe(false)
  })

  it('rejects a hostname or a URL', () => {
    expect(isIpv4Address('localhost')).toBe(false)
    expect(isIpv4Address('http://192.168.1.50')).toBe(false)
    expect(isIpv4Address('device.local')).toBe(false)
  })

  it('rejects empty and non-numeric octets', () => {
    expect(isIpv4Address('')).toBe(false)
    expect(isIpv4Address('192.168..1')).toBe(false)
    expect(isIpv4Address('192.168.1.x')).toBe(false)
  })
})

describe('validateEtimsConnection', () => {
  it('accepts a complete, well-formed set of fields', () => {
    expect(validateEtimsConnection(VALID)).toEqual([])
  })

  it('rejects a blank server address by name, not by field key', () => {
    const errors = validateEtimsConnection({ ...VALID, baseUrl: '   ' })
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('baseUrl')
    expect(errors[0].message).toBe(
      'Enter the fiscal server address, for example http://localhost:4444/'
    )
  })

  it('rejects a blank device IP', () => {
    const errors = validateEtimsConnection({ ...VALID, deviceIp: '' })
    expect(errors).toEqual([
      { field: 'deviceIp', message: 'Enter the fiscal device IP address.' }
    ])
  })

  it('rejects a malformed device IP with an example of a good one', () => {
    const errors = validateEtimsConnection({ ...VALID, deviceIp: 'not-an-ip' })
    expect(errors).toEqual([
      {
        field: 'deviceIp',
        message: 'That does not look like an IP address. It should look like 192.168.1.50.'
      }
    ])
  })

  it('rejects a blank port', () => {
    const errors = validateEtimsConnection({ ...VALID, devicePort: '' })
    expect(errors).toEqual([
      { field: 'devicePort', message: 'Enter the fiscal device port. It is usually 8000.' }
    ])
  })

  it('rejects a non-numeric port', () => {
    const errors = validateEtimsConnection({ ...VALID, devicePort: '80oo' })
    expect(errors).toEqual([
      { field: 'devicePort', message: 'The port must be a whole number between 1 and 65535.' }
    ])
  })

  it('rejects a port outside the valid range, at both ends', () => {
    expect(validateEtimsConnection({ ...VALID, devicePort: '0' })[0].field).toBe('devicePort')
    expect(validateEtimsConnection({ ...VALID, devicePort: '65536' })[0].field).toBe('devicePort')
    expect(validateEtimsConnection({ ...VALID, devicePort: '65535' })).toEqual([])
    expect(validateEtimsConnection({ ...VALID, devicePort: '1' })).toEqual([])
  })

  it('reports every bad field at once rather than one at a time', () => {
    const errors = validateEtimsConnection({ baseUrl: '', deviceIp: 'nope', devicePort: 'x' })
    expect(errors.map((error) => error.field)).toEqual(['baseUrl', 'deviceIp', 'devicePort'])
  })

  it('never mentions a code, a field key, or a command name', () => {
    const errors = validateEtimsConnection({ baseUrl: '', deviceIp: 'nope', devicePort: 'x' })
    for (const { message } of errors) {
      expect(message).not.toMatch(/baseUrl|deviceIp|devicePort|Res Code|settings\(/)
    }
  })
})

describe('fiscal device defaults', () => {
  it('points at the local ZFPLabServer, keeping the trailing slash settings() concatenates onto', () => {
    expect(DEFAULT_ETIMS_BASE_URL).toBe('http://localhost:4444/')
    expect(DEFAULT_ETIMS_BASE_URL.endsWith('/')).toBe(true)
  })

  it('suggests the usual device port and VAT class', () => {
    expect(DEFAULT_ETIMS_DEVICE_PORT).toBe('8000')
    expect(DEFAULT_ETIMS_VAT_CLASS).toBe('A')
  })
})
