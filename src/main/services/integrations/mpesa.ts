/**
 * M-Pesa payment integration.
 *
 * Scopes the hybrid flow required for a low-network Kenyan retail
 * environment: an STK Push (Daraja API) when the till is online, and a
 * manual transaction-code entry fallback when it is not. Neither branch
 * makes a real HTTP call yet — {@link MockMpesaProvider} simulates
 * Safaricom's latency and response shape so the checkout flow, IPC
 * wiring, and UI can be built against a stable contract now. A real
 * `DarajaMpesaProvider` implementing the same {@link MpesaProvider}
 * interface is planned for the production integration.
 */

import type { ServiceResult } from '../shopify-types.js'

/** Simulated network/processing delay for the mock provider, in milliseconds. */
export const MOCK_MPESA_DELAY_MS = 2000

/** Request to initiate an STK Push prompt on the customer's phone. */
export interface StkPushRequest {
  /** MSISDN in `2547XXXXXXXX` format. */
  phoneNumber: string
  /** Amount in KES, matching the checkout total. */
  amount: number
  /** Shown to the customer as the payment reference (e.g. till/order id). */
  accountReference: string
  /** Shown to the customer describing the transaction. */
  transactionDesc: string
}

/** Daraja-shaped result of a successful STK Push initiation. */
export interface StkPushResult {
  merchantRequestId: string
  checkoutRequestId: string
  responseCode: string
  responseDescription: string
  customerMessage: string
}

/** Manual entry of an M-Pesa confirmation code read off the customer's phone. */
export interface ManualCodeVerification {
  /** The alphanumeric confirmation code, e.g. `QJI7XXXXXX`. */
  transactionCode: string
  /** Amount the cashier expects the code to cover. */
  amount: number
  /** Optional MSISDN for cross-checking, if the cashier captures it. */
  phoneNumber?: string
}

/** Outcome of a manual transaction-code verification attempt. */
export interface ManualCodeVerificationResult {
  verified: boolean
  transactionCode: string
  amount: number
  /** Set when `verified` is false — reason shown to the cashier. */
  reason?: string
}

/** Outcome of an STK Push status query. */
export interface StkPushStatusResult {
  /** `'pending'` when Daraja is still processing the request (neither completed nor cancelled). */
  status: 'success' | 'failed' | 'pending'
  /** M-Pesa confirmation code, present once `status` is `'success'`. */
  receiptNumber?: string
  /** Daraja's human-readable result description, when available. */
  resultDesc?: string
}

/**
 * Narrow surface every M-Pesa backend (mock or real Daraja) must
 * implement, so the checkout flow and IPC layer never depend on which
 * one is wired in.
 */
export interface MpesaProvider {
  /**
   * Initiates an STK Push prompt to the customer's phone. Only viable
   * when the till has connectivity to Safaricom's Daraja API.
   */
  initiateStkPush(request: StkPushRequest): Promise<ServiceResult<StkPushResult>>

  /**
   * Verifies a transaction code the cashier read off the customer's
   * phone (SMS confirmation) — the offline-capable fallback that needs
   * no network round trip to Safaricom at the point of sale.
   */
  verifyTransactionCode(
    input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>>

  /**
   * Queries the outcome of a previously initiated STK Push — the
   * manual-check fallback used while no public callback URL is
   * configured to receive Safaricom's asynchronous result.
   */
  queryStkPushStatus(checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>>
}

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

  async initiateStkPush(
    request: StkPushRequest
  ): Promise<ServiceResult<StkPushResult>> {
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
