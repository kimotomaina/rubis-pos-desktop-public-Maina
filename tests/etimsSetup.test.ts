/**
 * `checkEtimsCompletion` tests — the pure decision logic behind the
 * `setup:check-etims-completion` IPC handler that gates the mandatory
 * eTIMS setup screen.
 */

import { describe, it, expect } from 'vitest'
import { checkEtimsCompletion } from '../src/main/services/etimsSetup.js'

describe('checkEtimsCompletion', () => {
  it('is always complete in mock mode, regardless of stored config', () => {
    expect(checkEtimsCompletion(true, {})).toEqual({ isComplete: true, missingFields: [] })
  })

  it('is incomplete when every field is missing in real mode', () => {
    const result = checkEtimsCompletion(false, {})
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toEqual(['baseUrl', 'deviceIp', 'devicePort', 'password'])
  })

  it('reports only the fields that are missing', () => {
    const result = checkEtimsCompletion(false, {
      baseUrl: 'http://localhost:4444/',
      deviceIp: '154.79.253.236'
    })
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toEqual(['devicePort', 'password'])
  })

  it('treats a blank/whitespace-only value as missing', () => {
    const result = checkEtimsCompletion(false, {
      baseUrl: '  ',
      deviceIp: '154.79.253.236',
      devicePort: '8000',
      password: 'secret'
    })
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toEqual(['baseUrl'])
  })

  it('is complete once all four fields are present in real mode', () => {
    const result = checkEtimsCompletion(false, {
      baseUrl: 'http://localhost:4444/',
      deviceIp: '154.79.253.236',
      devicePort: '8000',
      password: 'secret'
    })
    expect(result).toEqual({ isComplete: true, missingFields: [] })
  })
})
