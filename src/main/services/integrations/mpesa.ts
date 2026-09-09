/**
 * The M-Pesa payment contract, and nothing else.
 *
 * Holds the request/result shapes and the {@link MpesaProvider}
 * interface every backend implements. The implementations live beside
 * it: `daraja-mpesa-provider.ts` for the real Safaricom API, and
 * `mock-mpesa-provider.ts` for development.
 *
 * The mock used to live here. It was split out for the same reason
 * `MockFiscalizationProvider` was split out of `etims.ts` in phase-90:
 * a module every caller imports cannot also contain a class that must
 * never reach a packaged build. See `mpesa-provider-factory.ts`.
 */

import type { ServiceResult } from '../shopify-types.js'

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
