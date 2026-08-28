/**
 * Thin `axios` wrapper for talking to a local fiscal device server
 * (ZFPLabServer). Centralizes the base URL, timeout, and error
 * translation so provider code only ever handles {@link ServiceResult}.
 *
 * The device's SDK expects XML request/response bodies
 * (`Content-Type: text/xml`), not JSON — see {@link postXml}.
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios'
import type { ServiceResult } from '../shopify-types.js'
import { parseXmlResponse, serializeToXml } from './xml-utils.js'

/** Default local address ZFPLabServer listens on. */
export const DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444'

/** Request timeout — fiscal devices can be slow to respond. */
export const ETIMS_REQUEST_TIMEOUT_MS = 5000

/** Options accepted by {@link createFiscalHttpClient}. */
export interface FiscalHttpClientOptions {
  /** Base URL of the fiscal device server. Defaults to {@link DEFAULT_ETIMS_BASE_URL}. */
  baseUrl?: string
  /** Request timeout in milliseconds. Defaults to {@link ETIMS_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number
  /** TCP/device password required by some ZFP server configurations, sent as `X-ZFP-Password`. */
  password?: string
}

/**
 * Builds an `axios` instance configured for the local fiscal device
 * server.
 */
export function createFiscalHttpClient(options: FiscalHttpClientOptions = {}): AxiosInstance {
  return axios.create({
    baseURL: options.baseUrl?.trim() || DEFAULT_ETIMS_BASE_URL,
    timeout: options.timeoutMs ?? ETIMS_REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'text/xml',
      ...(options.password ? { 'X-ZFP-Password': options.password } : {})
    }
  })
}

/**
 * Serializes `payload` to XML — wrapped in a `<Request name="commandName">`
 * envelope, per {@link serializeToXml} — and posts it to the fiscal
 * device with `Content-Type: text/xml`, parsing the XML response body
 * back into a flat field lookup via {@link parseXmlResponse}.
 * Normalizes both network failures and non-2xx responses into a
 * {@link ServiceResult} so callers never need to catch — a 2xx
 * response with a device-level error encoded in the XML body (e.g.
 * `<Res Code="63">`) is still returned as `success: true` here, since
 * only the caller knows which fields mean the call failed.
 */
export async function postXml(
  client: AxiosInstance,
  path: string,
  commandName: string,
  payload: object
): Promise<ServiceResult<Record<string, string>>> {
  try {
    const body = serializeToXml(payload, commandName)
    const response = await client.post<string>(path, body, {
      headers: { 'Content-Type': 'text/xml' }
    })
    return { success: true, data: parseXmlResponse(response.data) }
  } catch (error) {
    return { success: false, error: describeFiscalHttpError(error, path) }
  }
}

/** Translates an axios failure into a cashier/operator-readable message. */
function describeFiscalHttpError(error: unknown, path: string): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError
    if (axiosError.code === 'ECONNABORTED') {
      return `Fiscal device timed out calling ${path}`
    }
    if (axiosError.response) {
      const raw = axiosError.response.data
      if (typeof raw === 'string' && raw.includes('<Res')) {
        const parsed = parseXmlResponse(raw)
        if (parsed.code) {
          return `Fiscal device rejected ${path} (Code ${parsed.code}): ${parsed.Message ?? 'Unknown error'}`
        }
      }
      return `Fiscal device rejected ${path} (HTTP ${axiosError.response.status}): ${JSON.stringify(raw)}`
    }
    if (axiosError.request) {
      return `Fiscal device unreachable at ${path} — is the ZFPLabServer running on the configured URL?`
    }
    return `Fiscal device request to ${path} failed: ${axiosError.message}`
  }
  return `Fiscal device request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`
}
