/**
 * Development-only stand-in for the Daraja API.
 *
 * **This provider fabricates confirmations.** `verifyTransactionCode`
 * approves essentially any code, which is exactly what makes it useful
 * for building a checkout flow and exactly what makes it dangerous on a
 * real till: a cashier could type anything and complete a sale for a
 * payment that never happened. It is the payment-side twin of the
 * `KRA-MOCK-` receipt problem phase-89 closed for fiscalization, and it
 * is fenced off the same way.
 *
 * Split out of `mpesa.ts` (which keeps the contract every provider
 * implements) so `resolveMpesaProvider` can reach it only through a
 * dev-only dynamic import, and so `scripts/verify-no-mock-provider.cjs`
 * can fail the build if it ever reaches a packaged bundle. Mirrors
 * `mock-etims-provider.ts` exactly.
 */

import type { ServiceResult } from '../shopify-types.js'
import type {
  ManualCodeVerification,
  ManualCodeVerificationResult,
  MpesaProvider,
  StkPushRequest,
  StkPushResult,
  StkPushStatusResult
} from './mpesa.js'

/** Simulated network/processing delay for the mock provider, in milliseconds. */
export const MOCK_MPESA_DELAY_MS = 2000

/** Options accepted by {@link MockMpesaProvider}. */
export interface MockMpesaProviderOptions {
  /** Simulated latency in milliseconds. Defaults to {@link MOCK_MPESA_DELAY_MS}. */
  delayMs?: number
  /**
   * Probability (0–1) that a well-formed manual code verification
   * randomly fails, simulating a real Safaricom-side transient
   * rejection rather than cashier error. Defaults to 0.1 (10%). Set
   * to 0 for deterministic tests.
   */
  failureRate?: number
  /** Injectable random source for the failure roll — defaults to `Math.random`. */
  randomFn?: () => number
}

/**
 * Simulates the Daraja API without any network access: a fixed delay
 * (default {@link MOCK_MPESA_DELAY_MS}) then a deterministic
 * success/failure, so UI and integration tests can exercise both
 * outcomes without depending on external timing.
 *
 * Failure is driven by simple, obviously-fake sentinel values —
 * `phoneNumber` ending in `0000` fails STK Push, `transactionCode`
 * `'INVALID'` fails manual verification — plus a configurable random
 * failure rate on `verifyTransactionCode` (default 10%) standing in
 * for a real M-Pesa transient rejection, so the payment UI
 * has a realistic retry path to exercise even for a well-formed code.
 */
export class MockMpesaProvider implements MpesaProvider {
  private readonly delayMs: number
  private readonly failureRate: number
  private readonly randomFn: () => number

  constructor(delayMs: number = MOCK_MPESA_DELAY_MS, options: MockMpesaProviderOptions = {}) {
    this.delayMs = options.delayMs ?? delayMs
    this.failureRate = options.failureRate ?? 0.1
    this.randomFn = options.randomFn ?? Math.random
  }

  async initiateStkPush(request: StkPushRequest): Promise<ServiceResult<StkPushResult>> {
    await delay(this.delayMs)

    if (!request.phoneNumber || !/^254\d{9}$/.test(request.phoneNumber)) {
      return {
        success: false,
        error: 'Invalid phone number — expected format 2547XXXXXXXX'
      }
    }

    if (request.phoneNumber.endsWith('0000')) {
      return {
        success: false,
        error: 'STK Push request cancelled by user (mock simulation)'
      }
    }

    return {
      success: true,
      data: {
        merchantRequestId: `mock-merchant-${Date.now()}`,
        checkoutRequestId: `mock-checkout-${Date.now()}`,
        responseCode: '0',
        responseDescription: 'Success. Request accepted for processing',
        customerMessage: 'Success. Request accepted for processing'
      }
    }
  }

  async verifyTransactionCode(
    input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> {
    await delay(this.delayMs)

    if (!input.transactionCode?.trim()) {
      return { success: false, error: 'Transaction code is required' }
    }

    if (input.transactionCode.trim().toUpperCase() === 'INVALID') {
      return {
        success: true,
        data: {
          verified: false,
          transactionCode: input.transactionCode,
          amount: input.amount,
          reason: 'Transaction code not found (mock simulation)'
        }
      }
    }

    if (this.randomFn() < this.failureRate) {
      return {
        success: true,
        data: {
          verified: false,
          transactionCode: input.transactionCode,
          amount: input.amount,
          reason: 'M-Pesa could not verify this code right now — please retry or try another payment method'
        }
      }
    }

    return {
      success: true,
      data: {
        verified: true,
        transactionCode: input.transactionCode.trim(),
        amount: input.amount
      }
    }
  }

  /**
   * Simulates a status query by sentinel suffix on `checkoutRequestId`
   * — `'FAIL'` for a Daraja-cancelled transaction, `'PEND'` for one
   * still processing, anything else resolves `'success'` with a
   * synthetic receipt number.
   */
  async queryStkPushStatus(checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>> {
    await delay(this.delayMs)

    if (!checkoutRequestId?.trim()) {
      return { success: false, error: 'Checkout request id is required' }
    }

    if (checkoutRequestId.endsWith('FAIL')) {
      return {
        success: true,
        data: { status: 'failed', resultDesc: 'Request cancelled by user (mock simulation)' }
      }
    }

    if (checkoutRequestId.endsWith('PEND')) {
      return { success: true, data: { status: 'pending' } }
    }

    return {
      success: true,
      data: {
        status: 'success',
        receiptNumber: `MOCK${Date.now()}`,
        resultDesc: 'The service request is processed successfully.'
      }
    }
  }
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
