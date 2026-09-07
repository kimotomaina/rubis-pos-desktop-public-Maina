/**
 * Real Daraja M-Pesa provider tests.
 *
 * Injects a mock `AxiosInstance` (matching the pattern used in
 * `realEtimsProvider.test.ts`) so OAuth2 token acquisition/caching
 * and the STK Push request/response shape can be asserted without a
 * real Daraja Sandbox call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios, { type AxiosInstance } from 'axios'
import { DarajaMpesaProvider } from '../src/main/services/integrations/daraja-mpesa-provider.js'
import type { StkPushRequest } from '../src/main/services/integrations/mpesa.js'

function makeMockClient(
  getImpl: ReturnType<typeof vi.fn>,
  postImpl: ReturnType<typeof vi.fn>
): AxiosInstance {
  return { get: getImpl, post: postImpl } as unknown as AxiosInstance
}

const CREDENTIALS = {
  consumerKey: 'test-consumer-key',
  consumerSecret: 'test-consumer-secret',
  shortcode: '174379',
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919'
}

const SAMPLE_REQUEST: StkPushRequest = {
  phoneNumber: '0712345678',
  amount: 100,
  accountReference: 'ORDER-1',
  transactionDesc: 'POS sale'
}

const TOKEN_RESPONSE = { access_token: 'mock-access-token', expires_in: '3599' }

const STK_SUCCESS_RESPONSE = {
  MerchantRequestID: '29115-34620561-1',
  CheckoutRequestID: 'ws_CO_191220191020363925',
  ResponseCode: '0',
  ResponseDescription: 'Success. Request accepted for processing',
  CustomerMessage: 'Success. Request accepted for processing'
}

describe('DarajaMpesaProvider constructor', () => {
  it('throws when required credentials are missing', () => {
    expect(() => new DarajaMpesaProvider({ ...CREDENTIALS, consumerKey: '' })).toThrow(
      /requires consumerKey/i
    )
  })
})

describe('DarajaMpesaProvider.initiateStkPush', () => {
  let get: ReturnType<typeof vi.fn>
  let post: ReturnType<typeof vi.fn>

  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ data: TOKEN_RESPONSE })
    post = vi.fn().mockResolvedValue({ data: STK_SUCCESS_RESPONSE })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches an OAuth token from the generate endpoint using HTTP Basic Auth', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(get).toHaveBeenCalledTimes(1)
    const [path, config] = get.mock.calls[0]
    expect(path).toBe('/oauth/v1/generate?grant_type=client_credentials')
    const expectedAuth = `Basic ${Buffer.from(
      `${CREDENTIALS.consumerKey}:${CREDENTIALS.consumerSecret}`
    ).toString('base64')}`
    expect(config.headers.Authorization).toBe(expectedAuth)
  })

  it('caches the access token across multiple STK Push calls instead of refetching', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush(SAMPLE_REQUEST)
    await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(get).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('refetches the token once it has expired', async () => {
    get = vi.fn().mockResolvedValue({ data: { access_token: 'short-lived', expires_in: '61' } })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    vi.useFakeTimers().setSystemTime(new Date('2026-01-15T10:30:45'))
    await provider.initiateStkPush(SAMPLE_REQUEST)
    vi.setSystemTime(new Date('2026-01-15T10:30:50'))
    await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(get).toHaveBeenCalledTimes(2)
  })

  it('posts to the STK Push endpoint with a correctly generated password and timestamp', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-15T10:30:45'))

    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush(SAMPLE_REQUEST)

    const [path, body] = post.mock.calls[0]
    expect(path).toBe('/mpesa/stkpush/v1/processrequest')
    expect(body.Timestamp).toBe('20260115103045')
    const expectedPassword = Buffer.from(
      `${CREDENTIALS.shortcode}${CREDENTIALS.passkey}20260115103045`
    ).toString('base64')
    expect(body.Password).toBe(expectedPassword)
  })

  it('builds the STK Push payload with the expected fields', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush(SAMPLE_REQUEST)

    const [, body, config] = post.mock.calls[0]
    expect(body.BusinessShortCode).toBe(CREDENTIALS.shortcode)
    expect(body.TransactionType).toBe('CustomerPayBillOnline')
    expect(body.Amount).toBe(100)
    expect(body.PartyA).toBe('254712345678')
    expect(body.PartyB).toBe(CREDENTIALS.shortcode)
    expect(body.PhoneNumber).toBe('254712345678')
    expect(body.AccountReference).toBe('ORDER-1')
    expect(body.TransactionDesc).toBe('POS sale')
    expect(body.CallBackURL).toBe('https://example.com/callback')
    expect(config.headers.Authorization).toBe('Bearer mock-access-token')
  })

  it('normalizes a leading-zero phone number to the 2547XXXXXXXX format', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush({ ...SAMPLE_REQUEST, phoneNumber: '0712345678' })

    expect(post.mock.calls[0][1].PhoneNumber).toBe('254712345678')
  })

  it('normalizes a +254-prefixed phone number', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    await provider.initiateStkPush({ ...SAMPLE_REQUEST, phoneNumber: '+254712345678' })

    expect(post.mock.calls[0][1].PhoneNumber).toBe('254712345678')
  })

  it('returns the MerchantRequestID/CheckoutRequestID on success', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(result.success).toBe(true)
    expect(result.data?.merchantRequestId).toBe('29115-34620561-1')
    expect(result.data?.checkoutRequestId).toBe('ws_CO_191220191020363925')
    expect(result.data?.responseCode).toBe('0')
  })

  it('rejects an invalid phone number without calling Daraja', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.initiateStkPush({ ...SAMPLE_REQUEST, phoneNumber: '12345' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid phone number/i)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('returns a failed ServiceResult when the OAuth call fails', async () => {
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    get = vi.fn().mockRejectedValue({
      response: { status: 400, data: { error_description: 'Invalid Credentials' } }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid credentials/i)
    expect(post).not.toHaveBeenCalled()
  })

  it('returns a failed ServiceResult when Daraja rejects the STK Push request', async () => {
    post = vi.fn().mockResolvedValue({
      data: { ResponseCode: '1', ResponseDescription: 'Unable to lock subscriber' }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unable to lock subscriber/i)
  })

  it('returns a failed ServiceResult when the STK Push HTTP call throws', async () => {
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    post = vi.fn().mockRejectedValue(Object.assign(new Error('Network Error'), { request: {} }))
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.initiateStkPush(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unreachable/i)
  })
})

describe('DarajaMpesaProvider.testCredentials', () => {
  it('reports success when the OAuth token exchange succeeds, without hitting the STK Push endpoint', async () => {
    const get = vi.fn().mockResolvedValue({ data: TOKEN_RESPONSE })
    const post = vi.fn()
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.testCredentials()

    expect(result.success).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })

  it('reports failure when the OAuth token exchange is rejected', async () => {
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    const get = vi.fn().mockRejectedValue({
      response: { status: 400, data: { error_description: 'Invalid Credentials' } }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, vi.fn())
    })

    const result = await provider.testCredentials()

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid credentials/i)
    vi.restoreAllMocks()
  })
})

describe('DarajaMpesaProvider.verifyTransactionCode', () => {
  it('reports manual code verification as unsupported', async () => {
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(vi.fn(), vi.fn())
    })

    const result = await provider.verifyTransactionCode({
      transactionCode: 'QJI7XXXXXX',
      amount: 100
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not supported/i)
  })
})

describe('DarajaMpesaProvider.queryStkPushStatus', () => {
  let get: ReturnType<typeof vi.fn>
  let post: ReturnType<typeof vi.fn>

  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ data: TOKEN_RESPONSE })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts to the STK Push Query endpoint and extracts the receipt number on success', async () => {
    post = vi.fn().mockResolvedValue({
      data: {
        ResponseCode: '0',
        ResponseDescription: 'The service request has been accepted successfully',
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_191220191020363925',
        ResultCode: '0',
        ResultDesc: 'The service request is processed successfully.',
        MpesaReceiptNumber: 'NLJ7RT61SV'
      }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_191220191020363925')

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('success')
    expect(result.data?.receiptNumber).toBe('NLJ7RT61SV')
    const [path, body] = post.mock.calls[0]
    expect(path).toBe('/mpesa/stkpushquery/v1/query')
    expect(body.CheckoutRequestID).toBe('ws_CO_191220191020363925')
    expect(body.BusinessShortCode).toBe(CREDENTIALS.shortcode)
  })

  it('reports failed for a "cancelled by user" ResultCode', async () => {
    post = vi.fn().mockResolvedValue({
      data: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_1')

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('failed')
    expect(result.data?.resultDesc).toMatch(/cancelled by user/i)
  })

  it('reports failed for an "insufficient funds" ResultCode', async () => {
    post = vi.fn().mockResolvedValue({
      data: { ResultCode: '1', ResultDesc: 'The balance is insufficient for the transaction' }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_1')

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('failed')
  })

  it('reports pending when the transaction is still being processed (HTTP error)', async () => {
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    post = vi.fn().mockRejectedValue({
      response: {
        status: 500,
        data: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }
      }
    })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_1')

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('pending')
  })

  it('reports pending for an unrecognized ResultCode', async () => {
    post = vi.fn().mockResolvedValue({ data: { ResultCode: '9999', ResultDesc: 'Unknown' } })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_1')

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('pending')
  })

  it('returns a failed ServiceResult on a network error', async () => {
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    post = vi.fn().mockRejectedValue(Object.assign(new Error('Network Error'), { request: {} }))
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const result = await provider.queryStkPushStatus('ws_CO_1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unreachable/i)
  })

  it('handles rapid successive calls for the same checkout request id consistently', async () => {
    post = vi.fn().mockResolvedValue({ data: { ResultCode: '0', MpesaReceiptNumber: 'NLJ7RT61SV' } })
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const [first, second, third] = await Promise.all([
      provider.queryStkPushStatus('ws_CO_1'),
      provider.queryStkPushStatus('ws_CO_1'),
      provider.queryStkPushStatus('ws_CO_1')
    ])

    for (const result of [first, second, third]) {
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('success')
      expect(result.data?.receiptNumber).toBe('NLJ7RT61SV')
    }
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('resolves each concurrent query for a different checkout request id independently', async () => {
    post = vi.fn().mockImplementation((_path: string, body: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          ResultCode: '0',
          MpesaReceiptNumber: `RCPT-${body.CheckoutRequestID as string}`
        }
      })
    )
    const provider = new DarajaMpesaProvider({
      ...CREDENTIALS,
      httpClient: makeMockClient(get, post)
    })

    const [first, second] = await Promise.all([
      provider.queryStkPushStatus('ws_CO_1'),
      provider.queryStkPushStatus('ws_CO_2')
    ])

    expect(first.data?.receiptNumber).toBe('RCPT-ws_CO_1')
    expect(second.data?.receiptNumber).toBe('RCPT-ws_CO_2')
    expect(post).toHaveBeenCalledTimes(2)

    // Once a token is cached, a later call reuses it instead of re-fetching.
    get.mockClear()
    await provider.queryStkPushStatus('ws_CO_3')
    expect(get).not.toHaveBeenCalled()
  })
})
