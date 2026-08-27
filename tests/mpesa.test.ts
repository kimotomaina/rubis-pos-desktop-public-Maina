/**
 * M-Pesa integration placeholder tests.
 *
 * Exercises {@link MockMpesaProvider} directly — no real Daraja API
 * call exists yet, so there is nothing external to mock; these tests
 * pin down the contract {@link MpesaProvider} implementations must
 * satisfy, and the deterministic success/failure sentinels used to
 * drive the mock.
 */

import { describe, it, expect } from 'vitest'
import { MockMpesaProvider } from '../src/main/services/integrations/mpesa.js'

describe('MockMpesaProvider.initiateStkPush', () => {
  it('resolves successfully for a valid phone number after the simulated delay', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.initiateStkPush({
      phoneNumber: '254712345678',
      amount: 500,
      accountReference: 'ORDER-1',
      transactionDesc: 'RUBIS POS sale'
    })

    expect(result.success).toBe(true)
    expect(result.data?.responseCode).toBe('0')
    expect(result.data?.checkoutRequestId).toMatch(/^mock-checkout-/)
  })

  it('rejects an invalid phone number format', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.initiateStkPush({
      phoneNumber: '0712345678',
      amount: 500,
      accountReference: 'ORDER-1',
      transactionDesc: 'RUBIS POS sale'
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid phone number/i)
  })

  it('simulates a user-cancelled prompt for the 0000 sentinel', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.initiateStkPush({
      phoneNumber: '254700000000',
      amount: 500,
      accountReference: 'ORDER-1',
      transactionDesc: 'RUBIS POS sale'
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/i)
  })
})

describe('MockMpesaProvider.verifyTransactionCode', () => {
  it('verifies a well-formed transaction code', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.verifyTransactionCode({
      transactionCode: 'QJI7ABCDEF',
      amount: 250
    })

    expect(result.success).toBe(true)
    expect(result.data?.verified).toBe(true)
    expect(result.data?.transactionCode).toBe('QJI7ABCDEF')
  })

  it('rejects an empty transaction code', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.verifyTransactionCode({
      transactionCode: '',
      amount: 250
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/required/i)
  })

  it('reports unverified for the INVALID sentinel without failing the call', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0 })
    const result = await provider.verifyTransactionCode({
      transactionCode: 'invalid',
      amount: 250
    })

    expect(result.success).toBe(true)
    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toBeDefined()
  })
})

describe('MockMpesaProvider random failure rate', () => {
  it('fails a well-formed code when the random roll lands under the failure rate', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0.1, randomFn: () => 0 })
    const result = await provider.verifyTransactionCode({
      transactionCode: 'QDF73H',
      amount: 250
    })

    expect(result.success).toBe(true)
    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toMatch(/could not verify/i)
  })

  it('succeeds a well-formed code when the random roll lands above the failure rate', async () => {
    const provider = new MockMpesaProvider(5, { failureRate: 0.1, randomFn: () => 0.99 })
    const result = await provider.verifyTransactionCode({
      transactionCode: 'QDF73H',
      amount: 250
    })

    expect(result.success).toBe(true)
    expect(result.data?.verified).toBe(true)
  })

  it('defaults to a 10% failure rate and Math.random when unconfigured', async () => {
    const provider = new MockMpesaProvider(5)
    const result = await provider.verifyTransactionCode({
      transactionCode: 'QDF73H',
      amount: 250
    })

    expect(result.success).toBe(true)
    expect(typeof result.data?.verified).toBe('boolean')
  })
})
