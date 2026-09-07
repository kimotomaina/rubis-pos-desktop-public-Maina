/**
 * Real M-Pesa provider — talks to Safaricom's Daraja API (OAuth2 +
 * Lipa Na M-Pesa Online / STK Push) so a checkout can prompt the
 * customer's phone directly instead of relying on a manually-entered
 * confirmation code.
 *
 * The Daraja API has no endpoint for verifying an arbitrary
 * transaction code after the fact — reconciling one would require a
 * C2B account statement / callback pipeline outside this phase's
 * scope — so {@link DarajaMpesaProvider.verifyTransactionCode} reports
 * that path unsupported rather than approximating it.
 */

import axios, { type AxiosInstance } from 'axios'
import type { ServiceResult } from '../shopify-types.js'
import type {
  ManualCodeVerification,
  ManualCodeVerificationResult,
  MpesaProvider,
  StkPushRequest,
  StkPushResult,
  StkPushStatusResult
} from './mpesa.js'

/** Daraja sandbox base URL. */
export const DARAJA_SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke'

/** Daraja production base URL. */
export const DARAJA_PRODUCTION_BASE_URL = 'https://api.safaricom.co.ke'

/** OAuth2 client-credentials token endpoint, relative to the base URL. */
const OAUTH_PATH = '/oauth/v1/generate?grant_type=client_credentials'

/** STK Push (Lipa Na M-Pesa Online) endpoint, relative to the base URL. */
const STK_PUSH_PATH = '/mpesa/stkpush/v1/processrequest'

/** STK Push Query endpoint, relative to the base URL. */
const STK_PUSH_QUERY_PATH = '/mpesa/stkpushquery/v1/query'

/**
 * Result codes Daraja returns from a completed STK Push, per the
 * Lipa Na M-Pesa Online API reference: `'0'` is success, everything
 * else listed here is a definitive failure. Any other code — or no
 * code at all (the request is still awaiting the customer) — is
 * treated as `'pending'`.
 */
const STK_QUERY_FAILURE_CODES = new Set(['1032', '1'])

/**
 * Daraja's `errorCode` for "the transaction is still being
 * processed" — returned as an HTTP error (not a `ResultCode`) when a
 * query is sent before the customer has responded to the prompt.
 */
const STK_QUERY_PROCESSING_ERROR_CODE = '500.001.1001'

/** Request timeout for Daraja API calls, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10000

/** Fallback token lifetime (seconds) if Daraja's response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 3599

/** Safety margin (seconds) subtracted from a token's lifetime before it's treated as expired. */
const TOKEN_EXPIRY_BUFFER_SECONDS = 60

/**
 * Placeholder callback URL used when none is configured. Safaricom
 * requires a publicly reachable HTTPS URL to accept an STK Push
 * request at all, which a till on localhost cannot offer — a real
 * webhook receiver (or polling via the STK Push query endpoint) is a
 * later addition; for now this only needs to be well-formed enough
 * for the Sandbox to accept the request.
 */
const DEFAULT_CALLBACK_URL = 'https://example.com/callback'

/** Options accepted by {@link DarajaMpesaProvider}. */
export interface DarajaMpesaProviderOptions {
  /** Daraja app consumer key. */
  consumerKey: string
  /** Daraja app consumer secret. */
  consumerSecret: string
  /** Till/paybill shortcode, e.g. `174379` for the Sandbox. */
  shortcode: string
  /** Lipa Na M-Pesa passkey associated with `shortcode`. */
  passkey: string
  /** Defaults to `'sandbox'`. */
  environment?: 'sandbox' | 'production'
  /** Public callback URL Safaricom posts the STK Push result to. Defaults to {@link DEFAULT_CALLBACK_URL}. */
  callbackUrl?: string
  /** Injectable HTTP client, primarily for tests. Defaults to a client built from `environment`. */
  httpClient?: AxiosInstance
}

/**
 * Strips a leading `+` or `0` and normalizes to the `2547XXXXXXXX` /
 * `2541XXXXXXXX` MSISDN format Daraja expects. Not exhaustively
 * validated here — {@link DarajaMpesaProvider.initiateStkPush} checks
 * the result against `^254\d{9}$` before using it.
 */
function formatPhoneNumber(input: string): string {
  const trimmed = input.trim().replace(/^\+/, '')
  if (trimmed.startsWith('254')) return trimmed
  if (trimmed.startsWith('0')) return `254${trimmed.slice(1)}`
  return `254${trimmed}`
}

/** Formats `date` as Daraja's `YYYYMMDDHHmmss` timestamp, in local time. */
function generateTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Translates an axios failure calling the Daraja API into a cashier/operator-readable message. */
function describeDarajaError(error: unknown, path: string): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const data = error.response.data as
        | { errorMessage?: string; error_description?: string }
        | undefined
      const message = data?.errorMessage ?? data?.error_description ?? JSON.stringify(error.response.data)
      return `Daraja request to ${path} failed (HTTP ${error.response.status}): ${message}`
    }
    if (error.code === 'ECONNABORTED') {
      return `Daraja request to ${path} timed out`
    }
    if (error.request) {
      return `Daraja API unreachable at ${path} — check network connectivity`
    }
    return `Daraja request to ${path} failed: ${error.message}`
  }
  return `Daraja request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Real M-Pesa provider backed by Safaricom's Daraja API. Obtains and
 * caches an OAuth2 access token (client-credentials grant) and issues
 * STK Push (Lipa Na M-Pesa Online) prompts.
 */
export class DarajaMpesaProvider implements MpesaProvider {
  private readonly http: AxiosInstance
  private readonly consumerKey: string
  private readonly consumerSecret: string
  private readonly shortcode: string
  private readonly passkey: string
  private readonly callbackUrl: string
  private cachedToken?: { value: string; expiresAt: number }

  constructor(options: DarajaMpesaProviderOptions) {
    if (!options.consumerKey || !options.consumerSecret || !options.shortcode || !options.passkey) {
      throw new Error(
        'DarajaMpesaProvider requires consumerKey, consumerSecret, shortcode, and passkey'
      )
    }
    this.consumerKey = options.consumerKey
    this.consumerSecret = options.consumerSecret
    this.shortcode = options.shortcode
    this.passkey = options.passkey
    this.callbackUrl = options.callbackUrl?.trim() || DEFAULT_CALLBACK_URL
    this.http =
      options.httpClient ??
      axios.create({
        baseURL:
          options.environment === 'production' ? DARAJA_PRODUCTION_BASE_URL : DARAJA_SANDBOX_BASE_URL,
        timeout: REQUEST_TIMEOUT_MS
      })
  }

  async initiateStkPush(request: StkPushRequest): Promise<ServiceResult<StkPushResult>> {
    const phoneNumber = formatPhoneNumber(request.phoneNumber)
    if (!/^254\d{9}$/.test(phoneNumber)) {
      return { success: false, error: 'Invalid phone number — expected format 2547XXXXXXXX' }
    }

    const tokenResult = await this.getAccessToken()
    if (!tokenResult.success || !tokenResult.data) {
      return { success: false, error: tokenResult.error ?? 'Failed to obtain Daraja access token' }
    }

    const timestamp = generateTimestamp()
    const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64')

    try {
      const response = await this.http.post(
        STK_PUSH_PATH,
        {
          BusinessShortCode: this.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: Math.round(request.amount),
          PartyA: phoneNumber,
          PartyB: this.shortcode,
          PhoneNumber: phoneNumber,
          CallBackURL: this.callbackUrl,
          AccountReference: request.accountReference,
          TransactionDesc: request.transactionDesc
        },
        { headers: { Authorization: `Bearer ${tokenResult.data}` } }
      )

      const data = response.data as Record<string, unknown>
      if (String(data.ResponseCode) !== '0') {
        return {
          success: false,
          error:
            (data.ResponseDescription as string | undefined) ??
            (data.errorMessage as string | undefined) ??
            'STK Push request was not accepted'
        }
      }

      return {
        success: true,
        data: {
          merchantRequestId: String(data.MerchantRequestID ?? ''),
          checkoutRequestId: String(data.CheckoutRequestID ?? ''),
          responseCode: String(data.ResponseCode ?? ''),
          responseDescription: String(data.ResponseDescription ?? ''),
          customerMessage: String(data.CustomerMessage ?? '')
        }
      }
    } catch (error) {
      return { success: false, error: describeDarajaError(error, STK_PUSH_PATH) }
    }
  }

  /**
   * Verifies `consumerKey`/`consumerSecret` are accepted by Daraja
   * without sending any STK Push or other charge-bearing request —
   * just the OAuth2 client-credentials exchange every other call
   * already depends on. Used by the Admin screen's "Test Connection"
   * action.
   */
  async testCredentials(): Promise<ServiceResult<void>> {
    const tokenResult = await this.getAccessToken()
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error ?? 'Failed to authenticate with Daraja' }
    }
    return { success: true }
  }

  async verifyTransactionCode(
    _input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> {
    return {
      success: false,
      error:
        'Manual M-Pesa code verification is not supported by the Daraja integration — use STK Push instead'
    }
  }

  /**
   * Queries the outcome of a previously initiated STK Push — the
   * fallback used while no public callback URL is configured to
   * receive Safaricom's asynchronous result (see checkout's manual
   * "Check Status" action). A query sent before the customer has
   * responded to the prompt comes back as an HTTP error carrying
   * {@link STK_QUERY_PROCESSING_ERROR_CODE}, which is reported as
   * `'pending'` rather than a failed {@link ServiceResult}.
   */
  async queryStkPushStatus(checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>> {
    const tokenResult = await this.getAccessToken()
    if (!tokenResult.success || !tokenResult.data) {
      return { success: false, error: tokenResult.error ?? 'Failed to obtain Daraja access token' }
    }

    const timestamp = generateTimestamp()
    const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64')

    try {
      const response = await this.http.post(
        STK_PUSH_QUERY_PATH,
        {
          BusinessShortCode: this.shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId
        },
        { headers: { Authorization: `Bearer ${tokenResult.data}` } }
      )

      const data = response.data as Record<string, unknown>
      const resultCode = String(data.ResultCode ?? '')
      const resultDesc = data.ResultDesc as string | undefined

      if (resultCode === '0') {
        const receiptNumber = data.MpesaReceiptNumber as string | undefined
        return { success: true, data: { status: 'success', receiptNumber, resultDesc } }
      }
      if (STK_QUERY_FAILURE_CODES.has(resultCode)) {
        return { success: true, data: { status: 'failed', resultDesc } }
      }
      return { success: true, data: { status: 'pending', resultDesc } }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const data = error.response.data as { errorCode?: string; errorMessage?: string } | undefined
        if (data?.errorCode === STK_QUERY_PROCESSING_ERROR_CODE) {
          return { success: true, data: { status: 'pending', resultDesc: data.errorMessage } }
        }
      }
      return { success: false, error: describeDarajaError(error, STK_PUSH_QUERY_PATH) }
    }
  }

  /**
   * Returns a cached OAuth2 access token if still valid, otherwise
   * fetches a fresh one via the client-credentials grant and caches
   * it for `expires_in` seconds (minus a safety buffer).
   */
  private async getAccessToken(): Promise<ServiceResult<string>> {
    const now = Date.now()
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return { success: true, data: this.cachedToken.value }
    }

    try {
      const credentials = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString(
        'base64'
      )
      const response = await this.http.get(OAUTH_PATH, {
        headers: { Authorization: `Basic ${credentials}` }
      })

      const data = response.data as { access_token?: string; expires_in?: string | number }
      if (!data.access_token) {
        return { success: false, error: 'Daraja OAuth response did not include an access token' }
      }

      const expiresInSeconds = Number(data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS)
      this.cachedToken = {
        value: data.access_token,
        expiresAt: now + (expiresInSeconds - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000
      }

      return { success: true, data: data.access_token }
    } catch (error) {
      return { success: false, error: describeDarajaError(error, OAUTH_PATH) }
    }
  }
}
