/**
 * Thin `axios` wrapper for talking to the **local** ZFPLabServer — the
 * vendor-supplied Windows service that bridges HTTP on
 * `http://localhost:4444/` to the fiscal device over TCP. Centralizes
 * the base URL, timeout, and error translation so provider code only
 * ever handles {@link ServiceResult}.
 *
 * The server speaks two distinct request shapes. Both were first
 * confirmed by decompiling the (older) vendor `FPcore.jar`; the
 * `Content-Type` was then corrected against the authoritative source —
 * the shipping vendor JS client (`ZFP_SDK_KE_2509041522_ControlUnit`'s
 * `Libs/JS/fp_core.js`), whose single `sendReq(verb, prefix, data)`
 * function builds every request, GET or POST, identically:
 *
 *   1. **Session/admin commands** — an HTTP **GET** whose path is a
 *      literal function-call string concatenated onto the base URL, e.g.
 *      `GET http://localhost:4444/settings(ip=…,port=…,password=…,tcp=1)`.
 *      See {@link getSettings} and {@link closeDeviceConnection}. These
 *      are *not* XML and *not* query-parameter encoded.
 *   2. **Fiscal commands** — an HTTP **POST** to the bare base URL
 *      (a single endpoint; routing happens on the XML body's
 *      `<Command Name="…">`), with `Content-Type: text/plain` — the
 *      literal header the vendor client sets (`fp_core.js:32`), despite
 *      the body being XML. See {@link postXml}.
 *
 * The device's ip/port/password travel **only** in the one-time
 * `settings()` GET — never as per-request query parameters or headers.
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios'
import type { ServiceResult } from '../shopify-types.js'
import { parseXmlResponse, serializeToXml } from './xml-utils.js'

/**
 * Default local ZFPLabServer URL. The trailing slash is significant —
 * `settings()` concatenates onto it.
 *
 * This is the only device-related value with a default. The server is a
 * fixed-port service installed on the till itself, so `localhost:4444`
 * is a real answer rather than a guess. The device's own ip/port/password
 * deliberately have none: guessing a password turns "nobody has set this
 * up" into a Code 31 that reads like a device fault. See
 * `RealFiscalizationProvider.isConfigured`.
 */
export const DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444/'

/** Request timeout — fiscal devices can be slow to respond. */
export const ETIMS_REQUEST_TIMEOUT_MS = 5000

/**
 * `Content-Type` the ZFPLabServer expects — the literal value the
 * authoritative vendor JS client sets (`fp_core.js:32`,
 * `req.setRequestHeader("Content-Type", "text/plain")`) on every
 * request, GET or POST, despite every body being XML. An earlier
 * revision used `application/xml; charset='UTF-8'`, inferred from
 * decompiling an older compiled `FPcore.jar` — wrong, corrected here
 * against the shipping source.
 */
export const FISCAL_CONTENT_TYPE = 'text/plain'

/**
 * The protocol definitions version (`<GenerationTimeStamp>`) this
 * codebase's `tremol-contract.json` was extracted from — see
 * `tracker/SDK_RECON.md` §1.3 in the `ZFP_SDK_KE_2509041522_ControlUnit`
 * package. The server echoes its own `<defVer>` on every `settings()`
 * response; the vendor client's real compatibility check
 * (`fp_core.js:411-414`) compares the two, not any "vX.Y.Z" server
 * version string.
 */
export const EXPECTED_DEF_VERSION = '2509041522'

/**
 * Three-state comparison of a `settings()` response's `<defVer>` against
 * {@link EXPECTED_DEF_VERSION}. `'unknown'` (blank/absent `<defVer>`) is
 * deliberately distinct from `'mismatch'` — the real captured
 * `settings-ok.xml` fixture itself has an empty `<defVer></defVer>`, so a
 * blank value is a normal, common server build, not evidence of a
 * version problem.
 */
export type DefVersionStatus = 'match' | 'mismatch' | 'unknown'

/**
 * Pure three-state comparison behind {@link getSettings}'s `<defVer>`
 * check. Split out so the match/mismatch/unknown logic is unit-testable
 * without mocking an HTTP call.
 *
 * @param {string | undefined} defVer
 * @returns {DefVersionStatus}
 */
export function checkDefVersion(defVer: string | undefined): DefVersionStatus {
  if (!defVer) return 'unknown'
  return defVer === EXPECTED_DEF_VERSION ? 'match' : 'mismatch'
}

/** Options accepted by {@link createFiscalHttpClient}. */
export interface FiscalHttpClientOptions {
  /** Base URL of the local ZFPLabServer. Defaults to {@link DEFAULT_ETIMS_BASE_URL}. */
  baseUrl?: string
  /** Request timeout in milliseconds. Defaults to {@link ETIMS_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Normalizes `baseUrl` to end in exactly one slash. The trailing slash
 * is load-bearing: {@link getSettings} builds its URL by literal
 * concatenation (`baseUrl + 'settings(…)'`), so stripping the slash
 * would produce `http://localhost:4444settings(…)`. A POST to the
 * slash-terminated URL hits the same single endpoint, so keeping it
 * costs the command path nothing.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`
}

/**
 * Builds an `axios` instance configured for the local ZFPLabServer:
 * the normalized base URL, the request timeout, and the **one** header
 * the vendor client sets.
 *
 * `sendReq` in the vendor's `Libs/JS/fp_core.js:29-37` makes exactly one
 * `setRequestHeader` call, for `Content-Type` — its only other header
 * line, an `Accept-Charset`, is commented out in the shipped source. An
 * earlier revision of this file also sent `Accept: application/xml` on
 * the strength of a comment claiming the vendor did; it does not, so it
 * was removed (see `tracker/SDK_RECON.md` §2.1).
 *
 * Nothing else rides on a request — in particular no
 * `ip`/`port`/`password` query parameters and no `X-Device-*` headers,
 * which were never part of this server's contract.
 *
 * @param {FiscalHttpClientOptions} options
 * @returns {AxiosInstance}
 */
export function createFiscalHttpClient(options: FiscalHttpClientOptions = {}): AxiosInstance {
  const trimmedBaseUrl = options.baseUrl?.trim()

  return axios.create({
    baseURL: normalizeBaseUrl(trimmedBaseUrl || DEFAULT_ETIMS_BASE_URL),
    timeout: options.timeoutMs ?? ETIMS_REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': FISCAL_CONTENT_TYPE
    }
  })
}

/**
 * Builds the literal `settings(…)` request string the ZFPLabServer
 * parses. Deliberately **not** URL-encoded: the server reads the raw
 * parentheses, commas and equals signs, and percent-encoding them makes
 * it reject the request.
 *
 * The `password=` segment is omitted entirely for an empty password,
 * matching the vendor client's
 * `(password ? (",password=" + password) : "")`
 * (`Libs/JS/fp_core.js:409`, `tracker/SDK_RECON.md` §2.4) rather than
 * sending a bare `password=`. In practice the provider refuses to call
 * at all without a password (`isConfigured`), so this only matters for a
 * caller reaching `getSettings` directly.
 *
 * @param {string} deviceIp
 * @param {string} devicePort
 * @param {string} password
 * @returns {string}
 */
export function buildSettingsCommand(
  deviceIp: string,
  devicePort: string,
  password: string
): string {
  const passwordSegment = password ? `,password=${password}` : ''
  return `settings(ip=${deviceIp},port=${devicePort}${passwordSegment},tcp=1)`
}

/**
 * Opens the server→device TCP session by GETting
 * `${baseUrl}settings(ip=…,port=…,password=…,tcp=1)`.
 *
 * The server does not auto-connect to the device; until this call lands,
 * every fiscal command fails with `Code 53` ("client settings missing").
 * A `Code 0` response only confirms the parameters were *stored* and the
 * client registered — it does not prove the device answered, so device
 * reachability is established by the `ReadStatus` that follows.
 *
 * Also runs the response's `<defVer>` through {@link checkDefVersion} and
 * stashes the result as `data.defVerStatus` (never a hard failure — this
 * is a POC) so callers get a structured `'match'`/`'mismatch'`/`'unknown'`
 * state instead of having to re-parse `<defVer>` themselves. A `'mismatch'`
 * also gets one prominent, structured `console.warn` here — see
 * {@link RealFiscalizationProvider.resolveSellCommand} in
 * `real-etims-provider.ts`, whose VAT-class routing depends on this
 * defVer and is surfaced onward via `FiscalInvoiceResult.defVerStatus`.
 *
 * @param {AxiosInstance} client
 * @param {string} deviceIp
 * @param {string} devicePort
 * @param {string} password
 * @returns {Promise<ServiceResult<Record<string, string>>>}
 */
export async function getSettings(
  client: AxiosInstance,
  deviceIp: string,
  devicePort: string,
  password: string,
  debug = false
): Promise<ServiceResult<Record<string, string>>> {
  const url = `${normalizeBaseUrl(client.defaults.baseURL ?? DEFAULT_ETIMS_BASE_URL)}${buildSettingsCommand(deviceIp, devicePort, password)}`
  const result = await sendGet(client, url, 'settings()', debug)
  if (!result.success || !result.data) {
    return result
  }

  const defVer = result.data.defVer
  const defVerStatus = checkDefVersion(defVer)
  result.data.defVerStatus = defVerStatus

  if (defVerStatus === 'mismatch') {
    console.warn(
      '[rubis-pos] ZFPLabServer protocol definitions version MISMATCH — this build\'s VAT-class sell ' +
        'routing (SellPLUfromExtDB vs SellPLUfromExtDB_HS) and other command shapes are only confirmed ' +
        `valid for defVer=${EXPECTED_DEF_VERSION}. Commands this build sends may be rejected or ` +
        'misrouted by the device. See tests/fixtures/tremol-contract.json and ' +
        'real-etims-provider.ts#resolveSellCommand.',
      { defVer, expectedDefVer: EXPECTED_DEF_VERSION, defVerStatus }
    )
  }

  return result
}

/**
 * Releases this client's device session (`clientremove(who=me)` — the
 * literal GET the vendor's `ServerCloseDeviceConnection()` issues).
 * Intended for app shutdown only: the vendor demo calls it when its
 * form closes, not per sale, and calling it between sales would force a
 * fresh `settings()` handshake on every transaction.
 *
 * @param {AxiosInstance} client
 * @returns {Promise<ServiceResult<Record<string, string>>>}
 */
export async function closeDeviceConnection(
  client: AxiosInstance,
  debug = false
): Promise<ServiceResult<Record<string, string>>> {
  const url = `${normalizeBaseUrl(client.defaults.baseURL ?? DEFAULT_ETIMS_BASE_URL)}clientremove(who=me)`
  return sendGet(client, url, 'clientremove(who=me)', debug)
}

/**
 * Serializes `args` into a `<Command Name="commandName">` envelope (see
 * {@link serializeToXml}) and POSTs it to the fiscal server, parsing the
 * XML response body back into a flat field lookup via
 * {@link parseXmlResponse}. Normalizes both network failures and non-2xx
 * responses into a {@link ServiceResult} so callers never need to catch
 * — a 2xx response carrying a `<Res Code="N">` error is still returned
 * as `success: true` here, since only the caller knows how to interpret
 * the code (see `real-etims-provider.ts`'s `checkDeviceResponse`).
 *
 * `path` is `''` for every real command: the ZFPLabServer is a single
 * endpoint that routes on the body's `Command/@Name`. It remains a
 * parameter so a differently-routed deployment can supply a per-command
 * path via `endpoints` overrides.
 *
 * @param {AxiosInstance} client
 * @param {string} path
 * @param {string} commandName
 * @param {object} args
 * @returns {Promise<ServiceResult<Record<string, string>>>}
 */
export async function postXml(
  client: AxiosInstance,
  path: string,
  commandName: string,
  args: object,
  debug = false
): Promise<ServiceResult<Record<string, string>>> {
  const body = serializeToXml(args, commandName)
  try {
    if (debug) {
      console.log(`[DEBUG-HTTP] POST ${client.defaults?.baseURL ?? ''}${path} ${commandName}: ${body}`)
    }

    const response = await client.post<string>(path, body, {
      headers: { 'Content-Type': FISCAL_CONTENT_TYPE },
      timeout: resolveTimeout(client)
    })

    if (debug) {
      console.log(`[DEBUG-HTTP] ${commandName} → HTTP ${response.status}: ${response.data}`)
    }
    return { success: true, data: parseXmlResponse(response.data) }
  } catch (error) {
    // Logs the translated message, not the raw axios error — the raw
    // error's `config` can carry the request URL (see `sendGet`, whose
    // settings() URL embeds the device password), and this description
    // already has everything needed to diagnose the failure.
    const description = describeFiscalHttpError(error, commandName)
    console.error(`[DEBUG-HTTP] ${commandName} failed: ${description}`)
    return { success: false, error: description }
  }
}

/**
 * Shared GET/parse/error-translation logic behind {@link getSettings}
 * and {@link closeDeviceConnection}. `url` is absolute so `axios` sends
 * it verbatim rather than re-joining it with `baseURL` (which would
 * re-encode nothing but makes the outgoing string harder to assert).
 *
 * @param {AxiosInstance} client
 * @param {string} url
 * @param {string} label
 * @returns {Promise<ServiceResult<Record<string, string>>>}
 */
async function sendGet(
  client: AxiosInstance,
  url: string,
  label: string,
  debug = false
): Promise<ServiceResult<Record<string, string>>> {
  try {
    if (debug) {
      console.log(`[DEBUG-HTTP] GET ${redactPassword(url)}`)
    }
    const response = await client.get<string>(url, { timeout: resolveTimeout(client) })
    if (debug) {
      console.log(`[DEBUG-HTTP] ${label} → HTTP ${response.status}: ${response.data}`)
    }
    return { success: true, data: parseXmlResponse(response.data) }
  } catch (error) {
    const description = describeFiscalHttpError(error, label)
    console.error(`[DEBUG-HTTP] ${label} failed: ${description}`)
    return { success: false, error: description }
  }
}

/**
 * Redacts the device password out of a `settings(...)` URL before it's
 * ever logged — `buildSettingsCommand` puts the real TCP password in
 * plain text in this exact string (phase-80: this was previously logged
 * verbatim on every session start).
 */
function redactPassword(url: string): string {
  return url.replace(/password=[^,)]*/, 'password=***')
}

/**
 * The per-request timeout {@link postXml}/{@link sendGet} actually use.
 * Before this, both hardcoded `timeout: ETIMS_REQUEST_TIMEOUT_MS` on every
 * request config — since axios's per-request `timeout` always wins over
 * `client.defaults.timeout`, that made {@link FiscalHttpClientOptions.timeoutMs}
 * (which only ever set the instance default via {@link createFiscalHttpClient})
 * silently dead: no code path could ever make a request actually use a
 * non-default timeout. This makes the instance default the single source
 * of truth, falling back to {@link ETIMS_REQUEST_TIMEOUT_MS} only when the
 * client was built with no override (the common case, including every
 * client `createFiscalHttpClient` builds without an explicit `timeoutMs`).
 */
function resolveTimeout(client: AxiosInstance): number {
  return client.defaults.timeout ?? ETIMS_REQUEST_TIMEOUT_MS
}

/** Translates an axios failure into a cashier/operator-readable message. */
function describeFiscalHttpError(error: unknown, label: string): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError
    if (axiosError.code === 'ECONNABORTED') {
      return `Fiscal device timed out on ${label}`
    }
    if (axiosError.response) {
      const raw = axiosError.response.data
      if (typeof raw === 'string' && raw.includes('<Res')) {
        const parsed = parseXmlResponse(raw)
        if (parsed.code) {
          return `Fiscal server rejected ${label} (Code ${parsed.code}): ${parsed.Message ?? 'Unknown error'}`
        }
      }
      return `Fiscal server rejected ${label} (HTTP ${axiosError.response.status}): ${JSON.stringify(raw)}`
    }
    if (axiosError.request) {
      return `ZFPLabServer unreachable on ${label} — is the service running at the configured URL?`
    }
    return `Fiscal request ${label} failed: ${axiosError.message}`
  }
  return `Fiscal request ${label} failed: ${error instanceof Error ? error.message : String(error)}`
}
