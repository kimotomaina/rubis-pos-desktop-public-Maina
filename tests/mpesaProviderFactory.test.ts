/**
 * Which M-Pesa provider a till runs, and what checkout may rely on it
 * for.
 *
 * The rule this file holds: **a packaged build never gets the mock.**
 * The mock's `verifyTransactionCode` approves almost any transaction
 * code, so a shipped one lets a till complete sales for payments that
 * never happened — the payment-side twin of printing a fiscal receipt
 * for a sale that was never filed. Until phase-102 the mock was not only
 * shippable but the default when no `.env` was present.
 *
 * `verifyReferenceNumbers` is asserted alongside, because it is what
 * `runCheckout` keys its payment gate on.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolveMpesaProvider, MPESA_NOT_CONFIGURED_MESSAGE } from '../src/main/services/mpesa-provider-factory.js'
import { DarajaMpesaProvider } from '../src/main/services/integrations/daraja-mpesa-provider.js'
import { SmsMpesaProvider } from '../src/main/services/integrations/sms-mpesa-provider.js'

/** Complete Daraja credentials, so the real provider can be constructed. */
const DARAJA = {
  consumerKey: 'key',
  consumerSecret: 'secret',
  shortcode: '174379',
  passkey: 'passkey'
} as const

function silentLogger(): { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(), warn: vi.fn() }
}

describe('resolveMpesaProvider', () => {
  it('returns the real provider in a packaged build even when the mock was requested', async () => {
    const logger = silentLogger()

    const { provider, verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: true,
      darajaOptions: { ...DARAJA },
      logger
    })

    expect(provider).toBeInstanceOf(DarajaMpesaProvider)
    expect(verifyReferenceNumbers).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('packaged build'))
  })

  it('returns the real provider when the mock was not requested', async () => {
    const { provider, verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: false,
      mockRequested: false,
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(DarajaMpesaProvider)
    expect(verifyReferenceNumbers).toBe(false)
  })

  it('reports that Daraja cannot verify a reference number', async () => {
    // Not because it is "real" — the SMS provider is real and verifies
    // for real. Daraja specifically has no receipt-lookup endpoint, so
    // checkout must prove payment from its own STK records instead.
    const { verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: false,
      mockRequested: false,
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(verifyReferenceNumbers).toBe(false)
  })

  it('refuses everything, rather than throwing, when no credentials are saved', async () => {
    // A till that cannot take M-Pesa must still open and still take
    // cash. DarajaMpesaProvider throws on missing credentials, so the
    // factory substitutes a provider that refuses instead of letting
    // start-up fail.
    const logger = silentLogger()

    const { provider } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      darajaOptions: { ...DARAJA, passkey: '' },
      logger
    })

    expect(provider).not.toBeInstanceOf(DarajaMpesaProvider)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'))

    await expect(provider.verifyTransactionCode({ transactionCode: 'X', amount: 100 })).resolves.toEqual({
      success: false,
      error: MPESA_NOT_CONFIGURED_MESSAGE
    })
    await expect(
      provider.initiateStkPush({
        phoneNumber: '254712345678',
        amount: 100,
        accountReference: 'r',
        transactionDesc: 'd'
      })
    ).resolves.toEqual({ success: false, error: MPESA_NOT_CONFIGURED_MESSAGE })
    await expect(provider.queryStkPushStatus('ws_CO_1')).resolves.toEqual({
      success: false,
      error: MPESA_NOT_CONFIGURED_MESSAGE
    })
  })

  it('an unconfigured till can confirm nothing, so no M-Pesa sale can complete on it', async () => {
    const { provider, verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      darajaOptions: { ...DARAJA, consumerSecret: '' },
      logger: silentLogger()
    })

    // The gate asks this provider, and it says no — so the cashier reads
    // "M-Pesa is not set up" rather than a vaguer "not confirmed".
    expect(verifyReferenceNumbers).toBe(true)
    const verification = await provider.verifyTransactionCode({ transactionCode: 'X', amount: 100 })
    expect(verification.success).toBe(false)
  })

  it('treats any missing credential as unconfigured', async () => {
    for (const missing of ['consumerKey', 'consumerSecret', 'shortcode', 'passkey'] as const) {
      const { provider } = await resolveMpesaProvider({
        isPackaged: true,
        mockRequested: false,
        darajaOptions: { ...DARAJA, [missing]: '' },
        logger: silentLogger()
      })

      expect(provider).not.toBeInstanceOf(DarajaMpesaProvider)
    }
  })
})

describe('the message-based method', () => {
  /** A stand-in for the two read methods the SMS provider needs. */
  const smsDb = {
    getMpesaSmsMessageByCode: () => undefined,
    listUnmatchedMpesaSmsMessages: () => []
  }

  it('is selected when the till is configured for it', async () => {
    const { provider, verifyReferenceNumbers, claimsStoredPayments } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      confirmationMethod: 'sms',
      smsDb,
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(SmsMpesaProvider)
    // It confirms for real, from a message Safaricom sent to this till.
    expect(verifyReferenceNumbers).toBe(true)
    // And a sale using one spends it, so the next sale cannot.
    expect(claimsStoredPayments).toBe(true)
  })

  it('is selected without needing Daraja credentials', async () => {
    // A message-based till never talks to Daraja, so credentials it will
    // never use must not gate it.
    const { provider } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      confirmationMethod: 'sms',
      smsDb,
      darajaOptions: { consumerKey: '', consumerSecret: '', shortcode: '', passkey: '' },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(SmsMpesaProvider)
  })

  it('refuses everything when there is no message store to read', async () => {
    const logger = silentLogger()

    const { provider, claimsStoredPayments } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      confirmationMethod: 'sms',
      darajaOptions: { ...DARAJA },
      logger
    })

    expect(provider).not.toBeInstanceOf(SmsMpesaProvider)
    expect(claimsStoredPayments).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no message store'))
  })

  it('is still refused in favour of the real provider when the mock is requested in a packaged build', async () => {
    // The mock fence outranks the method: a packaged build never
    // fabricates a confirmation, whatever else is configured.
    const { provider } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: true,
      confirmationMethod: 'sms',
      smsDb,
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(SmsMpesaProvider)
  })
})

describe('choosing the message method does not disturb Daraja', () => {
  it('still selects Daraja when the method is daraja', async () => {
    const { provider, verifyReferenceNumbers, claimsStoredPayments } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      confirmationMethod: 'daraja',
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(DarajaMpesaProvider)
    expect(verifyReferenceNumbers).toBe(false)
    expect(claimsStoredPayments).toBe(false)
  })

  it('still selects Daraja when no method is configured at all', async () => {
    // A till that has never been told otherwise keeps what it had.
    const { provider, verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: true,
      mockRequested: false,
      darajaOptions: { ...DARAJA },
      logger: silentLogger()
    })

    expect(provider).toBeInstanceOf(DarajaMpesaProvider)
    expect(verifyReferenceNumbers).toBe(false)
  })
})

describe('the mock M-Pesa provider is fenced off', () => {
  it('is never selected in a packaged build, whatever the config says', async () => {
    for (const mockRequested of [true, false]) {
      const { provider } = await resolveMpesaProvider({
        isPackaged: true,
        mockRequested,
        darajaOptions: { ...DARAJA },
        logger: silentLogger()
      })

      expect(provider).toBeInstanceOf(DarajaMpesaProvider)
    }
  })

  it('warns loudly about what the mock does when it is selected in development', async () => {
    const logger = silentLogger()

    const { provider, verifyReferenceNumbers } = await resolveMpesaProvider({
      isPackaged: false,
      mockRequested: true,
      darajaOptions: { ...DARAJA },
      logger
    })

    expect(provider).not.toBeInstanceOf(DarajaMpesaProvider)
    expect(verifyReferenceNumbers).toBe(true)
    // The warning has to say what is actually unsafe about it, not just
    // that a mock is in use.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no real payment is confirmed'))
  })
})
