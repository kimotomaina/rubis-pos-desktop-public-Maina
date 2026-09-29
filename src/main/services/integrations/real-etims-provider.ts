/**
 * Real eTIMS fiscalization provider — drives the **local** ZFPLabServer
 * (`http://localhost:4444/`), which in turn holds the TCP session to the
 * physical fiscal device (Control Unit). The protocol below was
 * confirmed against the authoritative vendor SDK
 * (`ZFP_SDK_KE_2509041522_ControlUnit`'s `Libs/JS/fp.js`/`fp_core.js` —
 * the shipping JS client's own defs blob and request builder, not
 * inferred from decompiled bytecode) and by live HTTP calls against the
 * running server; see `tracker/SDK_RECON.md` in that package for the
 * full command-by-command citation trail. `tests/fixtures/tremol-contract.json`
 * is generated from the same defs blob (`scripts/extract-tremol-contract.mjs`).
 *
 * **Both shipped definition versions are supported**, selected by the
 * `<defVer>` the server echoes on `settings()`: `2509041522` (the newer
 * SDK, the path every command shape here was built and validated against)
 * and `2204120945` (the older "API Files" SDK). Every command this module
 * sends is identical under both except for two differences, each handled
 * where it arises — `Price` is 10 characters rather than 15
 * ({@link formatPrice}), and `ReadCUinvoiceNumber` does not exist
 * ({@link RealFiscalizationProvider.verifyAlreadyFiled}). The full
 * command-by-command diff is `docs/phase-110.md`.
 *
 * Per-sale flow:
 *
 *   1. `settings()` — once per session, not per sale. Opens the
 *      server→device TCP session (`http-client.ts`'s {@link getSettings}).
 *   2. `ReadStatus` — device reachability + fiscalization state.
 *   3. `OpenInvoiceWithFreeCustomerData`
 *   4. `SellPLUfromExtDB` (VAT class A) or `SellPLUfromExtDB_HS` (any
 *      other class — see {@link RealFiscalizationProvider.buildSellPluHsArgs})
 *      per line item.
 *   5. `ReadCurrentReceiptInfo` — the "read VAT" validation gate.
 *   6. `CloseReceipt` — returns `InvoiceNum` + `QRcode`.
 *   7. `ReadDateTime` — the device's own timestamp.
 *
 * The device ip/port/password ride **only** in step 1's GET. If any
 * command comes back `Code 53` ("client settings missing" — e.g. the
 * server restarted underneath us), `settings()` is re-sent once and the
 * command retried once.
 *
 * `ServerCloseDeviceConnection` (a `clientremove(who=me)` GET) is
 * deliberately *not* called per sale — see
 * {@link RealFiscalizationProvider.closeServerConnection}, wired to app
 * shutdown in `main/index.ts`.
 */

import type { AxiosInstance } from 'axios'
import type { ServiceResult } from '../shopify-types.js'
import type { Logger } from '../logger.js'
import type {
  CreditNoteDetails,
  FiscalFailureKind,
  FiscalInvoiceLine,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalSubmitOutcome,
  FiscalVatGroupAmounts,
  FiscalizationProvider
} from './etims.js'
import {
  closeDeviceConnection,
  createFiscalHttpClient,
  getSettings,
  postXml,
  normalizeBaseUrl,
  resolveDuplicateRecoverySupport,
  DEFAULT_ETIMS_BASE_URL,
  OLD_DEF_VERSION,
  type DefVersionStatus
} from './http-client.js'
import {
  connectionTestFailed,
  connectionTestPassed,
  describeDeviceNotAnswering,
  describeNotReady,
  NOT_CONFIGURED_MESSAGE,
  NOT_CONFIGURED_REASON,
  SERVER_UNREACHABLE_MESSAGE,
  STATUS_UNREADABLE_MESSAGE,
  type FiscalConnectionTestResult,
  type FiscalNotReadyReason,
  type FiscalServerFailure
} from './fiscal-connection-test.js'
import { extractInvoiceNumberFromXml, extractQrCodeFromXml } from './xml-utils.js'
import { sanitizeFiscalText } from './fiscal-sanitize.js'
import { validateFiscalInvoiceRequest } from './fiscal-validate.js'

/**
 * VAT class applied to a line item with no product-level tax class
 * configured (16% VAT in Kenya) — the class that carries no HS
 * classification, per the KRA manual.
 */
const DEFAULT_VAT_CLASS = 'A'

/** Unit of measure applied to a line item with none of its own. */
const DEFAULT_MEASURE_UNIT = 'pcs'

/** Total number of steps in the invoice workflow, for `Step N/7` progress logging. */
const TOTAL_WORKFLOW_STEPS = 7

/** Vendor-declared maximum length for `TraderSystemInvNum`. */
export const MAX_TRADER_SYSTEM_INV_NUM_LENGTH = 15

/** Vendor-declared maximum length for `CompanyName`. */
export const MAX_COMPANY_NAME_LENGTH = 30

/** Vendor-declared maximum length for `ClientPINnum`. */
export const MAX_CLIENT_PIN_LENGTH = 14

/** Vendor-declared maximum length for `HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum`. */
export const MAX_ADDRESS_FIELD_LENGTH = 30

/** Vendor-declared maximum length for `NamePLU`. */
export const MAX_NAME_PLU_LENGTH = 36

/** Vendor-declared maximum length for `HSName`. */
export const MAX_HS_NAME_LENGTH = 20

/** Vendor-declared maximum length for `HSCode` (format `XXXX.XX.XX`). */
export const MAX_HS_CODE_LENGTH = 10

/** Vendor-declared maximum length for `MeasureUnit`. */
export const MAX_MEASURE_UNIT_LENGTH = 3

/**
 * Vendor-declared maximum length for `Price` (`SellPLUfromExtDB`/
 * `SellPLUfromExtDB_HS`) under `defVer=2509041522` — "up to 15 symbols …
 * with up to 5 digits after the decimal point". Never applied as a
 * truncation (unlike the text fields above): silently chopping digits off
 * a monetary amount would corrupt the sale rather than merely mangle a
 * display string — see {@link formatPrice}. Cross-checked against
 * `tremol-contract.json` by `tests/tremolFixtures.test.ts`.
 */
export const MAX_PRICE_LENGTH = 15

/**
 * Vendor-declared maximum length for `Price` under
 * {@link OLD_DEF_VERSION} — "Up to 10 symbols for article's price". This
 * is the only *argument* width the older definitions narrow on any
 * command this app sends; see `docs/phase-110.md` §2.
 */
export const MAX_PRICE_LENGTH_OLD_DEFS = 10

/**
 * Most decimal places `Price` may carry — the newer definitions' own
 * stated maximum. The older definitions state no decimal limit at all, so
 * applying the newer, stricter one to both is safe in either direction.
 */
const MAX_PRICE_DECIMALS = 5

/**
 * Fewest decimal places {@link formatPrice} will reduce to when fitting a
 * price under a narrower ceiling — KES minor units, below which a price
 * would stop being a faithful amount.
 */
const MIN_PRICE_DECIMALS = 2

/** Vendor-declared maximum length for `RelatedInvoiceNum` (credit/debit notes). */
export const MAX_RELATED_INVOICE_NUM_LENGTH = 19

/** The five per-VAT-group subtotal fields `ReadCurrentReceiptInfo` returns. */
const SUBTOTAL_FIELDS = [
  'SubtotalAmountVATGA',
  'SubtotalAmountVATGB',
  'SubtotalAmountVATGC',
  'SubtotalAmountVATGD',
  'SubtotalAmountVATGE'
] as const

/** `<Res Code>` value indicating success. */
const RES_CODE_OK = '0'

/** `<Res Code>` value meaning the session has no stored settings — re-send `settings()` and retry once. */
const RES_CODE_SETTINGS_MISSING = '53'

/**
 * `<Res Code>` value meaning "command error" — the envelope every STE-coded
 * device business error arrives wrapped in. Confirmed from the vendor's own
 * client (`fp_core.js:71-75`): `STE1`/`STE2`/`FPLibErrorCode` are read off
 * `<Err …>` **only** when `resCode === 40`; every other non-zero code (30,
 * 31, 53, 63, 19, …) is a plain server/transport error with no STE bytes at
 * all. See {@link checkDeviceResponse}.
 */
const RES_CODE_COMMAND_ERROR = '40'

/**
 * Decimal value of `STE1` (the FD-errors column, protocol PDF §1.2.1) for
 * "Opened fiscal receipt" — hex `0x34` (`parseInt('34', 16) === 52`).
 */
const STE1_OPENED_FISCAL_RECEIPT = 52

/**
 * `DeviceResult.code` value `checkDeviceResponse` reports when `STE1`
 * (not `STE2`) equals {@link STE1_OPENED_FISCAL_RECEIPT}. Deliberately a
 * distinct sentinel string, not the decimal number `52` itself: `STE2`
 * decimal `52` (same hex byte, `0x34`, but the *command*-errors column)
 * means "Syntax error" — an unrelated, non-retryable business rejection.
 * Keying the open-receipt recovery on this sentinel (set only when
 * `STE1` — not `STE2` — is 52) means the two can never be confused. See
 * {@link checkDeviceResponse} and `submitInvoice`'s Step 3 retry.
 */
const CODE_OPENED_FISCAL_RECEIPT = 'openedFiscalReceipt'

/**
 * Decimal value of `STE1` (the FD-errors column, protocol PDF §1.2.1) for
 * "24 hours block, missing Z report" — hex `0x3b` (`parseInt('3b', 16) ===
 * 59`). Named explicitly (docs/phase-159 B1.5, docs/phase-162): before this,
 * `checkDeviceResponse` had no case for it, so it fell through to `STE2`'s
 * command-errors table, and `STE2`'s own decimal `59` happens to mean
 * "Wrong client PIN" (see {@link STE2_WRONG_CLIENT_PIN}) — a coincidental
 * overlap in a different byte column that gave a cashier a misleading
 * reason for an unrelated device-wide condition.
 */
const STE1_DAILY_CLOSURE_BLOCK = 59

/**
 * `DeviceResult.code` value `checkDeviceResponse` reports when `STE1`
 * equals {@link STE1_DAILY_CLOSURE_BLOCK} — fired on `STE1` alone, never
 * depending on or guessing at whatever `STE2` accompanies it (the real
 * pairing has never been captured on a live device; see
 * `docs/KNOWN_GAPS.md`'s `VERIFY-ON-DEVICE` note). A distinct sentinel,
 * mirroring {@link CODE_OPENED_FISCAL_RECEIPT}, so it can never be confused
 * with `STE2`'s own decimal `59` ("Wrong client PIN").
 */
const CODE_DAILY_CLOSURE_BLOCK = 'dailyClosureBlock'

/**
 * Cashier-facing reason for {@link CODE_DAILY_CLOSURE_BLOCK}, used verbatim
 * as the outcome's `reason` — plain language, no device codes, per the same
 * copy rule {@link UNVERIFIABLE_RETRY_REASON} follows. The sale itself is
 * already saved locally (Rule 3: never silently lose an unfiscalized sale)
 * and will be filed automatically once the closure is done; only VIL or an
 * authorized operator can run that closure (docs/KNOWN_GAPS.md's "Fiscal
 * device daily closure" entry), so a cashier is told to call support rather
 * than to retry anything themselves.
 */
export const DAILY_CLOSURE_BLOCK_REASON =
  'The fiscal device needs its daily closure before it can file sales. The sale is saved and will be ' +
  'filed once the closure is done. Call support.'

/**
 * `STE2` command-errors code for "Wrong client PIN"
 * ({@link mapFiscalDeviceError}'s `'59'` case) — the one `kind: 'data'`
 * rejection specific enough that a cashier can fix it on the spot
 * (correct or remove the buyer PIN and resend). Named here so
 * {@link classifyDeviceFailure} can tag the outcome's `dataIssue` from
 * the code it already has, rather than the till later trying to
 * recognize "wrong PIN" by matching `mapFiscalDeviceError`'s message text.
 */
const STE2_WRONG_CLIENT_PIN = '59'

/**
 * Cashier/back-office copy for a retry the connected definitions cannot
 * verify — shown verbatim on the Needs Attention list, so it follows that
 * screen's copy rules: plain language, no device codes, no jargon, and it
 * names the one action a person must take. The machine-readable detail
 * (the device's rejection, the `defVer`, why verification was impossible)
 * goes to the logger instead. See
 * {@link RealFiscalizationProvider.verifyAlreadyFiled}.
 */
export const UNVERIFIABLE_RETRY_REASON =
  'This sale was sent to the tax device again and the device refused it. The device cannot tell ' +
  'us whether this sale was already filed, so it was NOT sent a second time. Check on the device ' +
  'whether this sale is already filed before filing it again.'

/**
 * What a duplicate-recovery check concluded about a sale whose
 * `OpenInvoice` was rejected on a retry:
 *
 *   - `'already-filed'` — the device positively named the CU invoice
 *     number it holds. The sale is filed; report it, send nothing more.
 *   - `'genuine-failure'` — nothing was ever filed under this
 *     `TraderSystemInvNum`, so the original rejection is real and routes
 *     normally.
 *   - `'unverifiable'` — neither could be established. Flag for a person;
 *     never resend.
 */
type DuplicateRecoveryVerdict =
  | { outcome: 'already-filed'; cuInvoiceNumber: string }
  | { outcome: 'genuine-failure' }
  | { outcome: 'unverifiable'; reason: string }

/** Fiscal device endpoint paths, overridable per deployment. */
export interface FiscalEndpointPaths {
  readStatus: string
  openInvoice: string
  /** B2B invoice open endpoint, used instead of `openInvoice` when `request.buyerPin` is present. */
  openInvoiceWithPin: string
  sellPLU: string
  /** `SellPLUfromExtDB_HS` — the non-class-A / HS-code-derived sell path. See {@link RealFiscalizationProvider.buildSellPluHsArgs}. */
  sellPLUWithHsCode: string
  readCurrentReceiptInfo: string
  closeReceipt: string
  readDateTime: string
  cancelReceipt: string
  openCreditNote: string
  /**
   * Recovery command for a duplicate `TraderSystemInvNum` rejection.
   * Declared only by `defVer=2509041522` — see
   * {@link RealFiscalizationProvider.verifyAlreadyFiled}.
   */
  readCUinvoiceNumber: string
  /** Reads the CU's serial/PIN numbers — static per device, read once per session. See {@link RealFiscalizationProvider.ensureCUNumbers}. */
  readCUnumbers: string
}

/**
 * Default paths: every command maps to `''` (the base URL itself). The
 * ZFPLabServer is a single endpoint — it routes on the XML body's
 * `<Command Name="...">`, not the URL path. These remain per-command and
 * overridable via `endpoints` for a differently routed deployment.
 */
export const DEFAULT_FISCAL_ENDPOINTS: FiscalEndpointPaths = {
  readStatus: '',
  openInvoice: '',
  openInvoiceWithPin: '',
  sellPLU: '',
  sellPLUWithHsCode: '',
  readCurrentReceiptInfo: '',
  closeReceipt: '',
  readDateTime: '',
  cancelReceipt: '',
  openCreditNote: '',
  readCUinvoiceNumber: '',
  readCUnumbers: ''
}

/** Friendly translation of a fiscal error, from either the server or the device. */
export interface FiscalDeviceErrorInfo {
  /** Human-readable message suitable for a cashier-facing toast. */
  message: string
  /**
   * `true` for a transient/technical condition worth an automatic retry
   * (queued as `fiscalization_pending` and drained by `fiscal-engine.ts`,
   * or — for the one-shot open-receipt case — retried immediately within
   * the same `submitInvoice` call). `false` for a business rejection: the
   * request itself is wrong (bad PIN, unknown item, invalid HS code, …)
   * and resubmitting the same data will fail again the same way, so it
   * must surface to the cashier rather than loop silently in the queue.
   */
  retryable: boolean
}

/**
 * Translates a **server-level** `<Res Code>` — a transport/session
 * failure raised by the ZFPLabServer itself (`<Err Source="Server">`),
 * not a device business error — into an actionable message. These are
 * the codes observed live against the running server, plus Code 19
 * (`ServUndefined` — "FP refuses new socket connection", confirmed by
 * `tests/fixtures/wire/readstatus-live-captured-code19.xml`, a real
 * capture), which previously had no case here and fell through to the
 * device-error branch misclassified as a non-retryable business error.
 * All four codes here are transient/technical, not data problems — they
 * heal on their own (19, 30 — device/socket busy or unreachable) or once
 * config is corrected (31 — TCP password) or automatically (53 — session
 * re-established) — so the caller should queue-and-retry, never surface
 * them as "fix your data and resubmit."
 *
 * **Code 31 covers two stages, not one.** The server returns it both when
 * the password was refused (`<Message>Missing password authentication
 * answer</Message>`) and when the device never answered the initial ping,
 * before any password is presented (`<Message>Missing first ping
 * answer</Message>` — the only variant ever observed live, see
 * `docs/phase-97.md` §5). The code alone cannot tell them apart, so the
 * message here names both possibilities rather than asserting the
 * password one. Where the raw `<Message>` is available — the connection
 * test — {@link describeDeviceNotAnswering} does separate them.
 *
 * @param {string} code
 * @returns {FiscalDeviceErrorInfo | undefined} `undefined` when `code` is not a known server code
 */
export function mapFiscalServerError(code: string): FiscalDeviceErrorInfo | undefined {
  switch (code) {
    case '19':
      return {
        message: 'Fiscal device has an open socket from another connection — will retry automatically',
        retryable: true
      }
    case '30':
      return {
        message:
          'ZFPLabServer cannot reach the fiscal device — check the device IP/port and that the device is powered on',
        retryable: true
      }
    case '31':
      return {
        message:
          'Fiscal device session could not be opened — either the device did not answer, or it rejected the TCP password. Check the device is powered on and reachable, and the device password in Admin → Integrations',
        retryable: true
      }
    case RES_CODE_SETTINGS_MISSING:
      return {
        message: 'Fiscal session not initialized — reconnecting to the fiscal device',
        retryable: true
      }
    case '63':
      return { message: 'ZFPLabServer rejected the request format', retryable: false }
    default:
      return undefined
  }
}

/**
 * Translates a device-level **command/business** error — the `STE2` byte
 * (protocol PDF §1.2.1's "Command errors" column), decimal-converted from
 * the hex the wire sends — into a friendly message. Almost every one of
 * these is a rejection that resending the identical request would meet
 * again (wrong PIN, unknown item, invalid HS code, an amount that doesn't
 * fit the original invoice, …), so they are `retryable: false` —
 * cashier-visible, not queued. The one exception is `'50'` (hex `0x32`,
 * "Illegal command"), which the PDF defines as refused "depending on the
 * current status of the CU": state, not data, so it is queued and retried
 * (docs/phase-184 §2). Only ever called with a Code 40 `STE2` —
 * {@link checkDeviceResponse} never runs a server `<Res Code>` through
 * this table, since the SDK reuses 50–53, 62 and 63 as client/server
 * codes (`Tremol.ServerErrorType`). `STE1 = 52` ("Opened
 * fiscal receipt", the *other* column, same hex byte `0x34`) is handled
 * separately by `checkDeviceResponse` as {@link CODE_OPENED_FISCAL_RECEIPT},
 * not through this table — see that constant's doc for why the two must
 * never be conflated. An unrecognized code falls back to the device's own
 * raw `message` so nothing is silently swallowed.
 *
 * @param {string} code
 * @param {string} message
 * @returns {FiscalDeviceErrorInfo}
 */
export function mapFiscalDeviceError(code: string, message: string): FiscalDeviceErrorInfo {
  switch (code) {
    case '49':
      return { message: 'Invalid command', retryable: false }
    case '50':
      return { message: 'Illegal command', retryable: true }
    case '51':
      return { message: 'Z daily report is not zero', retryable: false }
    case '52':
      return { message: 'Syntax error', retryable: false }
    case '53':
      return { message: 'Input registers overflow', retryable: false }
    case '54':
      return { message: 'Zero input registers', retryable: false }
    case '55':
      return { message: 'Unavailable transaction for correction', retryable: false }
    case '56':
      return { message: 'Insufficient amount on hand', retryable: false }
    case '57':
      return { message: 'Conflict in tax group', retryable: false }
    case '58':
      return { message: 'Invoice number not found', retryable: false }
    case '59':
      return { message: 'Wrong client PIN', retryable: false }
    case '60':
      return { message: 'Missing defined item', retryable: false }
    case '61':
      return { message: 'Item quantity too large', retryable: false }
    case '62':
      return { message: 'Item amount too large', retryable: false }
    case '63':
      return { message: 'Amount exceeds original invoice', retryable: false }
    case '64':
      return { message: 'HS code is not valid', retryable: false }
    default:
      return { message: message || `Unknown fiscal device error (Code ${code})`, retryable: false }
  }
}

/**
 * A checked response: a failure carries the raw error `code` alongside
 * the friendly `error`, plus `retryable` — the explicit transient-vs-
 * business classification from {@link mapFiscalServerError}/
 * {@link mapFiscalDeviceError}/the open-receipt case, so a caller can act
 * on it without re-deriving it from `code` or `error` text.
 */
type DeviceResult = ServiceResult<Record<string, string>> & {
  code?: string
  retryable?: boolean
  /**
   * Set when the failure came from the fiscal **server** itself
   * (`<Err Source="Server">`): the raw code and the server's own
   * `<Message>`. Read only by the connection test's reporting path —
   * filing and routing continue to act on `code`/`retryable` alone.
   *
   * The raw message has to travel with the code because `error` above is
   * already a rewritten sentence, and the rewrite loses the one detail
   * that separates Code 31's two stages.
   */
  serverFailure?: FiscalServerFailure
  /**
   * Set when `ReadStatus` succeeded and a status bit says the device
   * cannot file. A typed marker rather than a phrase to match on, so the
   * genuine not-ready case can never be confused with a device that
   * never answered.
   */
  notReady?: FiscalNotReadyReason
}

/**
 * Interprets a parsed response envelope. `<Res Code="0">` is success; any
 * other code is an error, resolved in this order:
 *
 *   1. the server table (`Source="Server"` transport/session failures —
 *      19/30/31/53/63);
 *   2. `Code 40` ("command error") — the envelope every STE-coded device
 *      business error arrives wrapped in (confirmed `fp_core.js:71-75`:
 *      `STE1`/`STE2`/`FPLibErrorCode` are only ever read when
 *      `resCode === 40`). Both STE bytes are logged in full here — not
 *      just the one this codebase acts on — so the first live Code 40
 *      settles any remaining doubt about which byte the real device
 *      populates. `STE1 = 52` (hex `0x34`, "Opened fiscal receipt") is
 *      the one-shot cancel-and-retry case and reports
 *      {@link CODE_OPENED_FISCAL_RECEIPT} as `code` so the caller's retry
 *      check can never be confused with `STE2 = 52` ("Syntax error", a
 *      plain non-retryable business rejection with the *same* hex byte
 *      in the other column). `STE1 = 59` (hex `0x3b`, "24 hours block,
 *      missing Z report", docs/phase-162) is checked next, on `STE1`
 *      alone and ahead of `STE2`'s table, reporting
 *      {@link CODE_DAILY_CLOSURE_BLOCK} — again never to be confused with
 *      `STE2`'s own decimal `59` ("Wrong client PIN"). Otherwise `STE2`
 *      is looked up in {@link mapFiscalDeviceError}'s command-errors table;
 *   3. a defensive fallback for any other non-zero code (no known server
 *      case and not `40`) — reported with the server's own `<Message>`,
 *      non-retryable, and never looked up in the `STE2` table: the SDK
 *      reuses 50–53, 62 and 63 as client/server codes
 *      (`Tremol.ServerErrorType`, `fp_core.js:547-552`), so reading them as
 *      `STE2` would turn our own malformed request into a retryable
 *      "Illegal command" (docs/phase-184 §2.3a).
 *
 * @param {ServiceResult<Record<string, string>>} result
 * @returns {DeviceResult}
 */
function checkDeviceResponse(result: ServiceResult<Record<string, string>>): DeviceResult {
  if (!result.success) return result

  const data = result.data ?? {}
  const code = data.code
  if (!code || code === RES_CODE_OK) return result

  const rawMessage = data.Message ?? 'Unknown fiscal error'
  const serverFailure =
    data.errSource === 'Server' ? { code, message: rawMessage } : undefined
  const serverError = mapFiscalServerError(code)
  if (serverError && (data.errSource === 'Server' || data.errSource === undefined)) {
    return {
      success: false,
      error: `Fiscal server error (Code ${code}): ${serverError.message}`,
      code,
      retryable: serverError.retryable,
      serverFailure: serverFailure ?? { code, message: rawMessage }
    }
  }

  if (code === RES_CODE_COMMAND_ERROR) {
    const ste1Hex = data.STE1
    const ste2Hex = data.STE2
    const ste1 = ste1Hex !== undefined ? parseInt(ste1Hex, 16) : undefined
    const ste2 = ste2Hex !== undefined ? parseInt(ste2Hex, 16) : undefined
    console.warn(
      `[rubis-pos] Fiscal device Code 40 (command error) — STE1=${ste1Hex ?? '?'} (decimal ${ste1 ?? '?'}), ` +
        `STE2=${ste2Hex ?? '?'} (decimal ${ste2 ?? '?'}), FPLibErrorCode=${data.FPLibErrorCode ?? '?'}. ` +
        'Logged in full (not just the byte this build acts on) so the first live Code 40 settles which ' +
        'byte the real device actually populates — see real-etims-provider.ts#checkDeviceResponse.'
    )

    if (ste1 === STE1_OPENED_FISCAL_RECEIPT) {
      return {
        success: false,
        error: 'Fiscal device error (Code 40, STE1=52): Opened fiscal receipt — cancelling and retrying',
        code: CODE_OPENED_FISCAL_RECEIPT,
        retryable: true
      }
    }
    if (ste1 === STE1_DAILY_CLOSURE_BLOCK) {
      // Fires on STE1 alone, checked before STE2's table and regardless of
      // whatever STE2 carries (docs/phase-159 B1.5, docs/phase-162) — the
      // real STE1/STE2 pairing for this condition has never been captured
      // on a live device, so this must not guess at STE2's value.
      return {
        success: false,
        error: DAILY_CLOSURE_BLOCK_REASON,
        code: CODE_DAILY_CLOSURE_BLOCK,
        retryable: true
      }
    }
    if (ste2 !== undefined) {
      const mapped = mapFiscalDeviceError(String(ste2), rawMessage)
      return {
        success: false,
        error: `Fiscal device error (Code 40, STE2=${ste2}): ${mapped.message}`,
        code: String(ste2),
        retryable: mapped.retryable
      }
    }
    return { success: false, error: `Fiscal device error (Code 40): ${rawMessage}`, code, retryable: false }
  }

  return {
    success: false,
    error: `Fiscal device error (Code ${code}): ${rawMessage}`,
    code,
    retryable: false,
    // Server codes with no entry in `mapFiscalServerError` (32, 34) land
    // here; tagging them keeps the connection test reporting them as the
    // device not answering, which is what they mean.
    serverFailure
  }
}

/**
 * Maps a failed {@link DeviceResult} into the `(reason, kind, retryable)`
 * triple {@link FiscalSubmitOutcome} needs — the bridge between
 * `checkDeviceResponse`'s wire-level classification and the
 * fiscalization-specific outcome `submitInvoice` returns:
 *
 *   - `retryable` (already correctly computed by `checkDeviceResponse` —
 *     the transient server/technical codes 19/30/31/53, a still-
 *     unresolved `STE1=52` "opened receipt" case, `STE1=59` "missing
 *     daily closure", docs/phase-162, and `STE2=0x32` "Illegal command",
 *     docs/phase-184) → `'technical'`. This branch runs
 *     before the `dataIssue`/wrong-PIN tag below, so none of these can
 *     ever be mistagged as a data problem;
 *   - otherwise `code === '63'` (`ZFPLabServer rejected the request
 *     format` — a malformed request is this build's own bug, not the
 *     sale's data) → `'system'`;
 *   - otherwise (every other STE2 command-errors code) → `'data'`.
 *
 * `fallbackKind` overrides the final branch for call sites whose failure
 * was never routed through `checkDeviceResponse`'s STE tables at all
 * (`readStatus`'s hand-built "not fiscalized"/"not paired" checks) — see
 * that call site's own comment for why `'system'` is correct there.
 *
 * Also tags `dataIssue: 'wrong-pin'` (phase-77) when `result.code` is
 * {@link STE2_WRONG_CLIENT_PIN} — the one rejection specific enough for
 * the till to offer a same-visit fix. Never set from `reason`'s message
 * text; always from the code already computed upstream.
 *
 * @param {Pick<DeviceResult, 'error' | 'retryable' | 'code'>} result
 * @param {string} fallbackReason used when `result.error` is unset
 * @param {FiscalFailureKind} [fallbackKind='data']
 * @returns {Extract<FiscalSubmitOutcome, { ok: false }>}
 */
function classifyDeviceFailure(
  result: Pick<DeviceResult, 'error' | 'retryable' | 'code'>,
  fallbackReason: string,
  fallbackKind: FiscalFailureKind = 'data'
): Extract<FiscalSubmitOutcome, { ok: false }> {
  const reason = result.error ?? fallbackReason
  if (result.retryable) {
    return { ok: false, reason, kind: 'technical', retryable: true }
  }
  if (result.code === '63') {
    return { ok: false, reason, kind: 'system', retryable: false }
  }
  const dataIssue = result.code === STE2_WRONG_CLIENT_PIN ? 'wrong-pin' : undefined
  return { ok: false, reason, kind: fallbackKind, retryable: false, dataIssue }
}

/** Looks up a previously fiscalized invoice by number in local storage (the POS's `orders` table). */
export type FiscalInvoiceLookupFn = (invoiceNumber: string) => FiscalInvoiceResult | undefined

/** Options accepted by {@link RealFiscalizationProvider}. */
export interface RealFiscalizationProviderOptions {
  /** Base URL of the local ZFPLabServer. Defaults to `http://localhost:4444/`. */
  baseUrl?: string
  /** Injectable HTTP client, primarily for tests. Defaults to a client built from `baseUrl`. */
  httpClient?: AxiosInstance
  /** Overrides for one or more endpoint paths. Unset paths fall back to {@link DEFAULT_FISCAL_ENDPOINTS}. */
  endpoints?: Partial<FiscalEndpointPaths>
  /** VAT class applied to a line item with no `vatClass` of its own. Defaults to `'A'`. */
  defaultVatClass?: string
  /** Device TCP password, sent once in the `settings()` handshake. */
  password?: string
  /** IP of the fiscal device the local server opens its TCP session to, sent once in `settings()`. */
  deviceIp?: string
  /** TCP port of the fiscal device, sent once in `settings()`. */
  devicePort?: string
  /**
   * Reads back a previously fiscalized invoice from local storage.
   * `getInvoiceDetails` reports "not found" when omitted, since
   * querying the device's Electronic Journal is slow and unreliable
   * compared to the POS's own order history.
   */
  lookupInvoice?: FiscalInvoiceLookupFn
  /** Defaults to `console` (phase-80). Notable per-sale/session events log through this. */
  logger?: Logger
  /**
   * Off by default (phase-80): the per-step progress log and the raw
   * request/response wire trace (`http-client.ts`'s `[DEBUG-HTTP]`
   * lines) are pure noise once the workflow is known to work — every
   * outcome they'd help diagnose is already reported through `logger`.
   * Flip on via `FISCAL_DEBUG_LOGGING=true` to get the full trace back
   * when there's an actual device issue to chase.
   */
  debugLogging?: boolean
}

/**
 * The device details {@link RealFiscalizationProvider.reconfigure}
 * replaces — everything the Admin screen's fiscal device form owns.
 * `endpoints`, `lookupInvoice` and the logging options are deliberately
 * absent: they are set once at startup and no screen can change them.
 */
export type ReconfigureFiscalDeviceOptions = Pick<
  RealFiscalizationProviderOptions,
  'baseUrl' | 'deviceIp' | 'devicePort' | 'password' | 'defaultVatClass'
>

/**
 * Drives the local ZFPLabServer's stateful invoice workflow over HTTP.
 * If any step from `OpenInvoice` onward fails, a best-effort
 * `CancelReceipt` voids the open receipt on the device so it doesn't
 * block future sales; a device left stuck after a crash still requires
 * operator intervention.
 *
 * `request.clientOrderUuid`/`request.localId` feed `TraderSystemInvNum`
 * (see {@link RealFiscalizationProvider.buildTraderSystemInvNum}) so a
 * store-and-forward retry of the same request (see `fiscal-engine.ts`)
 * is recognizable by the device as a duplicate rather than fiscalizing
 * the same sale twice. When `request.isRetry` is set and `OpenInvoice`
 * is rejected, {@link RealFiscalizationProvider.verifyAlreadyFiled} runs
 * before concluding failure — if the device already has this sale's
 * invoice number on file (a reply lost on an earlier attempt), that's
 * reported as success with no second `OpenInvoice`/`CloseReceipt` sent;
 * where the connected definitions cannot answer at all, the sale is
 * flagged for a person and never resent (Rule 1 — never file twice; see
 * `docs/phase-75.md` and `docs/phase-110.md`).
 *
 * Every free-text field is passed through {@link sanitizeFiscalText}
 * before its documented max length is applied — the G03 manual warns
 * that symbols outside a conservative allow-list can silently block a
 * request from reaching TIMS.
 */
export class RealFiscalizationProvider implements FiscalizationProvider {
  private readonly http: AxiosInstance
  private readonly endpoints: FiscalEndpointPaths
  private readonly lookupInvoice?: FiscalInvoiceLookupFn
  private readonly logger: Logger
  /**
   * The four values the Admin screen owns. Mutable, and replaced
   * together by {@link reconfigure}, so saving new device details
   * applies to the next sale without relaunching the app.
   */
  private defaultVatClass: string
  private deviceIp: string
  private devicePort: string
  private password: string
  private readonly debugLogging: boolean
  /** In-flight or completed `settings()` handshake; cleared on Code 53 so the next call re-runs it. */
  private settingsPromise: Promise<DeviceResult> | null = null
  /**
   * In-flight or completed `ReadCUnumbers` read — the CU's serial/PIN
   * numbers are static per device, so this is fetched at most once per
   * session (like `settingsPromise`), never per sale. Cleared on failure
   * so a later sale can retry; a failure here never blocks a sale (the
   * serial number is a receipt-printing nicety, not required to
   * fiscalize) — see {@link ensureCUNumbers}.
   */
  private cuNumbersPromise: Promise<ServiceResult<{ serialNumber: string }>> | null = null
  /** Tail of the chain every device-facing public method waits on — see {@link exclusive}. */
  private deviceQueue: Promise<void> = Promise.resolve()

  constructor(options: RealFiscalizationProviderOptions = {}) {
    this.deviceIp = options.deviceIp?.trim() ?? ''
    this.devicePort = options.devicePort?.trim() ?? ''
    this.password = options.password?.trim() ?? ''
    this.http = options.httpClient ?? createFiscalHttpClient({ baseUrl: options.baseUrl })
    this.endpoints = { ...DEFAULT_FISCAL_ENDPOINTS, ...options.endpoints }
    this.defaultVatClass = options.defaultVatClass ?? DEFAULT_VAT_CLASS
    this.lookupInvoice = options.lookupInvoice
    this.logger = options.logger ?? console
    this.debugLogging = options.debugLogging ?? false
  }

  /**
   * Runs `task` after every device call already queued on this provider
   * has settled, so checkout, the fiscal queue, resend, the badge and
   * Test connection never interleave on the device (docs/phase-184). A
   * failed task still releases the chain. Public entry points only: the
   * chain is not re-entrant, so a private helper that took it would wait
   * on itself.
   *
   * Serialises this till's own calls only. The CU may be shared with other
   * tills; cross-client safety depends on the vendor (VIL question 6).
   *
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.deviceQueue.then(task)
    this.deviceQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Reports whether this till has the device details it needs to talk to
   * the Control Unit at all.
   *
   * There is deliberately no default for any of the three. A wrong
   * password is indistinguishable from a broken device once it is on the
   * wire, so guessing one turns "nobody has set this up" into "the
   * device is rejecting us" — see `docs/phase-89.md` §5.
   *
   * @returns {boolean}
   */
  isConfigured(): boolean {
    return Boolean(this.deviceIp && this.devicePort && this.password)
  }

  /**
   * Replaces the device details this provider uses, taking effect on the
   * next sale rather than the next launch.
   *
   * Clears both per-session caches: the `settings()` handshake is bound
   * to the old ip/port/password, and the CU serial number belongs to the
   * old device. `baseUrl` is applied to the existing axios instance
   * rather than rebuilding it, so an injected test client survives.
   *
   * @param {ReconfigureFiscalDeviceOptions} options
   * @returns {void}
   */
  reconfigure(options: ReconfigureFiscalDeviceOptions): void {
    this.deviceIp = options.deviceIp?.trim() ?? ''
    this.devicePort = options.devicePort?.trim() ?? ''
    this.password = options.password?.trim() ?? ''
    this.defaultVatClass = options.defaultVatClass?.trim() || DEFAULT_VAT_CLASS
    this.http.defaults.baseURL = normalizeBaseUrl(options.baseUrl?.trim() || DEFAULT_ETIMS_BASE_URL)
    this.settingsPromise = null
    this.cuNumbersPromise = null
  }

  /**
   * Runs the three hops between this till and a filed invoice, stopping
   * at the first failure, and reports which one broke in plain words.
   *
   * Clears the cached handshake first: a "test" that reported a session
   * opened minutes ago under different settings would not be a test. The
   * clearing happens inside {@link exclusive}, so it never lands mid-sale.
   *
   * @returns {Promise<FiscalConnectionTestResult>}
   */
  async testConnection(): Promise<FiscalConnectionTestResult> {
    if (!this.isConfigured()) {
      return connectionTestFailed('device', NOT_CONFIGURED_MESSAGE)
    }

    return this.exclusive(() => {
      this.settingsPromise = null
      return this.runConnectionHops()
    })
  }

  /**
   * Same three-hop classification as {@link testConnection}, but reuses
   * an already-open session instead of forcing a fresh handshake first.
   *
   * For the periodic background badge (polled every 30s), which must not
   * tear down a session a live sale might depend on — see the
   * `settingsPromise` doc comment and the before-quit handler in
   * `index.ts` that both exist to avoid exactly that churn.
   *
   * Runs under {@link exclusive} even though `ReadStatus` is a read: it
   * can also send `settings()`, and the vendor's own client never has two
   * requests in flight (docs/phase-184 §1).
   *
   * @returns {Promise<FiscalConnectionTestResult>}
   */
  async checkConnectivity(): Promise<FiscalConnectionTestResult> {
    if (!this.isConfigured()) {
      return connectionTestFailed('device', NOT_CONFIGURED_MESSAGE)
    }

    return this.exclusive(() => this.runConnectionHops())
  }

  /**
   * The shared body of {@link testConnection} and {@link checkConnectivity}:
   * `settings()` then `ReadStatus`, stopping at the first failure.
   *
   * A `ReadStatus` failure is attributed to the hop it actually belongs
   * to, which is the point of the four explicit branches below. Until
   * phase-98 every one of them was reported as hop 3 with "the fiscal
   * device answered but is not ready to file sales" — a sentence that is
   * false whenever nothing answered, and one that sent a live
   * investigation after KRA provisioning while the real fault was that
   * the session never opened (`docs/phase-97.md`).
   */
  private async runConnectionHops(): Promise<FiscalConnectionTestResult> {
    const settings = await this.ensureSettings()
    if (!settings.success) {
      // No `code` means no `<Res>` came back at all — the fiscal server
      // itself was unreachable, rather than the device behind it.
      return settings.code === undefined
        ? connectionTestFailed('server', SERVER_UNREACHABLE_MESSAGE)
        : connectionTestFailed(
            'device',
            describeDeviceNotAnswering(
              settings.serverFailure ?? { code: settings.code, message: '' }
            )
          )
    }

    const status = await this.readStatus()
    if (status.success) {
      return connectionTestPassed()
    }
    if (status.notReady) {
      // The device answered and reported its own status. The only case
      // where "contact the device supplier" is the right advice.
      return connectionTestFailed('ready', describeNotReady(status.notReady))
    }
    if (status.serverFailure) {
      // The session never opened, so the device answered nothing —
      // hop 2, and hop 3 stays unattempted rather than showing a pass it
      // did not earn.
      return connectionTestFailed('device', describeDeviceNotAnswering(status.serverFailure))
    }
    if (status.code === undefined) {
      // No `<Res>` at all: same rule as the handshake above.
      return connectionTestFailed('server', SERVER_UNREACHABLE_MESSAGE)
    }
    // A device-level command error: it answered, it just refused to
    // report its status, so readiness is unknown rather than bad.
    return connectionTestFailed('ready', STATUS_UNREADABLE_MESSAGE)
  }

  /**
   * Files one sale, holding the device for the whole sequence so no other
   * caller's command can land inside this sale's receipt (docs/phase-184).
   *
   * @param {FiscalInvoiceRequest} request
   * @returns {Promise<FiscalSubmitOutcome>}
   */
  submitInvoice(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome> {
    return this.exclusive(() => this.submitInvoiceExclusive(request))
  }

  /** The body of {@link submitInvoice}; only ever run under {@link exclusive}. */
  private async submitInvoiceExclusive(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome> {
    if (!request.clientOrderUuid) {
      return {
        ok: false,
        reason: 'clientOrderUuid is required to fiscalize an invoice',
        kind: 'system',
        retryable: false
      }
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      return {
        ok: false,
        reason: 'Invoice has no line items to fiscalize',
        kind: 'system',
        retryable: false
      }
    }
    const validationError = validateFiscalInvoiceRequest(request)
    if (validationError) {
      // The sale's own data (buyer PIN format, a non-A line missing its
      // HS classification, …) failed pre-send checks — never even reaches
      // the device, but it's the sale's data at fault, not this build.
      return { ok: false, reason: validationError, kind: 'data', retryable: false }
    }
    if (!this.isConfigured()) {
      // No device details on this till. Report it before any HTTP call
      // rather than sending a guessed password and getting back a Code 31
      // that reads like a device fault. `'technical'` is the existing kind
      // for a condition that heals "once configuration is corrected", so
      // the sale completes, queues, and drains once the details are saved.
      return {
        ok: false,
        reason: NOT_CONFIGURED_REASON,
        kind: 'technical',
        retryable: true
      }
    }

    const t0 = Date.now()
    // Off by default (phase-80) — pure step-by-step progress, no
    // diagnostic value once the workflow is known to work. Every
    // outcome it would help trace is already reported through
    // `this.logger` at the point it's decided.
    const logStep = (step: number, label: string): void => {
      if (this.debugLogging) {
        console.log(`[ETIMS] Step ${step}/${TOTAL_WORKFLOW_STEPS}: ${label} +${Date.now() - t0}ms`)
      }
    }

    // Step 1/7: settings() — opens the server→device session (once per session).
    logStep(1, `settings(ip=${this.deviceIp},port=${this.devicePort})`)
    const settingsResult = await this.ensureSettings()
    if (!settingsResult.success) {
      return classifyDeviceFailure(settingsResult, 'Unable to initialize the fiscal device session')
    }
    const defVerStatus = (settingsResult.data?.defVerStatus as DefVersionStatus | undefined) ?? 'unknown'
    const defVer = settingsResult.data?.defVer
    const priceMaxLength = resolvePriceMaxLength(defVer)

    // Ancillary, best-effort: ReadCUnumbers (the CU serial number), cached
    // for the session — not one of the 7 canonical steps (it's session-
    // level info, like settings(), not part of the per-sale sequence) and
    // never allowed to block a sale. A failure just means the receipt
    // prints without a CU serial this time; the next sale retries it.
    const cuNumbersResult = await this.ensureCUNumbers()
    if (!cuNumbersResult.success) {
      this.logger.warn(
        `[rubis-pos] ReadCUnumbers failed — the receipt will print without a CU serial number: ${cuNumbersResult.error}`
      )
    }
    const cuSerialNumber = cuNumbersResult.success ? cuNumbersResult.data?.serialNumber : undefined

    // Step 2/7: ReadStatus — device reachability and fiscalization state.
    // fallbackKind='system' here: `readStatus`'s two hand-built "not
    // fiscalized"/"not paired" checks never carry a `code`/`retryable`
    // from the STE tables (they're not STE-coded at all), and a device
    // that reports itself unfiscalized/unpaired is a configuration
    // problem for IT, not the sale's data.
    logStep(2, 'ReadStatus')
    const statusResult = await this.readStatus()
    if (!statusResult.success) {
      return classifyDeviceFailure(statusResult, 'Fiscal device status check failed', 'system')
    }

    // Step 3/7: OpenInvoiceWithFreeCustomerData, retrying once when the
    // device reports an already-opened fiscal receipt (STE1=52, hex 0x34 —
    // NOT STE2=52, which is an unrelated "Syntax error"; see
    // CODE_OPENED_FISCAL_RECEIPT).
    logStep(3, 'OpenInvoiceWithFreeCustomerData')
    let openResult = await this.sendCommand(
      this.resolveOpenInvoiceEndpoint(request),
      'OpenInvoiceWithFreeCustomerData',
      this.buildOpenInvoiceArgs(request)
    )
    if (!openResult.success && openResult.code === CODE_OPENED_FISCAL_RECEIPT) {
      this.logger.log(
        `[rubis-pos] Sale ${request.localId}: device reports an already-opened receipt — cancelling and retrying once`
      )
      await this.rollback()
      openResult = await this.sendCommand(
        this.resolveOpenInvoiceEndpoint(request),
        'OpenInvoiceWithFreeCustomerData',
        this.buildOpenInvoiceArgs(request)
      )
    }
    if (!openResult.success && request.isRetry) {
      const verdict = await this.verifyAlreadyFiled(defVer, openResult, request.localId)
      if (verdict.outcome === 'already-filed') {
        this.logger.log(
          `[rubis-pos] Sale ${request.localId}: ReadCUinvoiceNumber recovered an already-filed invoice ` +
            `(${verdict.cuInvoiceNumber}) — filed on an earlier, unacknowledged attempt; NOT resubmitting`
        )
        return {
          ok: true,
          data: {
            invoiceNumber: verdict.cuInvoiceNumber,
            // QR is only ever returned by CloseReceipt at filing time —
            // a recovered sale never went through CloseReceipt on THIS
            // attempt, so there is no QR to store. Left empty, never a
            // fake/guessed value (Rule 2 groundwork — receipt handling
            // for an empty QR is a later step).
            qrCode: '',
            fiscalizedAt: new Date().toISOString(),
            fiscalizedAtSource: 'local-fallback',
            cuSerialNumber,
            defVerStatus
          }
        }
      }
      if (verdict.outcome === 'unverifiable') {
        this.logger.warn(
          `[rubis-pos] Sale ${request.localId}: the fiscal device refused to reopen this invoice on a ` +
            `retry and the connected server's definitions (defVer=${defVer || 'not reported'}) cannot ` +
            'confirm whether it was already filed — FLAGGED for a person, NOT resent. ' +
            `Device rejection: ${openResult.error}. Reason it could not be verified: ${verdict.reason}`
        )
        return {
          ok: false,
          reason: UNVERIFIABLE_RETRY_REASON,
          kind: 'system',
          retryable: false
        }
      }
    }
    if (!openResult.success) {
      return classifyDeviceFailure(openResult, 'Failed to open the fiscal invoice')
    }

    // Step 4/7: SellPLUfromExtDB (class A) or SellPLUfromExtDB_HS (any other class) per line item.
    for (const [index, item] of request.items.entries()) {
      const { path, commandName, args } = this.resolveSellCommand(item, priceMaxLength)
      logStep(4, `${commandName} ${index + 1}/${request.items.length}`)
      const sellResult = await this.sendCommand(path, commandName, args)
      if (!sellResult.success) {
        await this.rollback()
        return classifyDeviceFailure(sellResult, 'Failed to record a sold item on the fiscal device')
      }
    }

    // Step 5/7: ReadCurrentReceiptInfo — the "read VAT" validation gate.
    logStep(5, 'ReadCurrentReceiptInfo')
    const receiptInfoResult = await this.sendCommand(
      this.endpoints.readCurrentReceiptInfo,
      'ReadCurrentReceiptInfo',
      {}
    )
    if (!receiptInfoResult.success) {
      await this.rollback()
      return classifyDeviceFailure(receiptInfoResult, 'Failed to read the fiscal receipt')
    }
    const receiptInfo = receiptInfoResult.data ?? {}
    const isReceiptOpened = receiptInfo.OptionIsReceiptOpened === '1'
    const subtotal = sumVatGroupSubtotals(receiptInfo)
    if (!isReceiptOpened || subtotal <= 0) {
      await this.rollback()
      // Not an STE-coded rejection — the receipt-info read itself
      // succeeded, but its content doesn't make sense. An anomaly in how
      // this build sequenced the sale, not the sale's data nor a
      // transient connectivity blip.
      return {
        ok: false,
        reason: `Fiscal receipt validation failed — receipt open: ${isReceiptOpened}, VAT-group subtotal: ${subtotal}`,
        kind: 'system',
        retryable: false
      }
    }

    // Step 6/7: CloseReceipt — returns InvoiceNum + QRcode.
    logStep(6, 'CloseReceipt')
    const closeResult = await this.sendCommand(this.endpoints.closeReceipt, 'CloseReceipt', {})
    if (!closeResult.success) {
      await this.rollback()
      return classifyDeviceFailure(closeResult, 'Failed to close the fiscal receipt')
    }

    const invoiceNumber = extractInvoiceNumberFromXml(closeResult.data ?? {})
    if (!invoiceNumber) {
      // The `system`-kind failure below is what gets logged once, at the
      // caller's decision point — this raw response dump is extra
      // diagnostic detail, debug-only rather than a second log of the
      // same event.
      if (this.debugLogging) {
        console.warn(
          `[ETIMS] Sale ${request.localId}: CloseReceipt response carried no InvoiceNum. Raw response:`,
          JSON.stringify(closeResult.data, null, 2)
        )
      }
      await this.rollback()
      return {
        ok: false,
        reason: 'Fiscal device closed the receipt without returning an invoice number',
        kind: 'system',
        retryable: false
      }
    }

    // Step 7/7: ReadDateTime — best-effort; a failure here doesn't undo an already-closed receipt.
    logStep(7, 'ReadDateTime')
    const dateTimeResult = await this.sendCommand(this.endpoints.readDateTime, 'ReadDateTime', {})
    const deviceDateTime = dateTimeResult.success
      ? (dateTimeResult.data?.DateTime ?? dateTimeResult.data?.dateTime)
      : undefined
    if (!deviceDateTime && this.debugLogging) {
      console.log(
        `[ETIMS] Sale ${request.localId}: ReadDateTime returned no device timestamp — recording the local ` +
          'clock time and flagging it as not device-sourced (fiscalizedAtSource="local-fallback")'
      )
    }

    return {
      ok: true,
      data: {
        invoiceNumber,
        qrCode: extractQrCodeFromXml(closeResult.data ?? {}) ?? '',
        fiscalizedAt: deviceDateTime ?? new Date().toISOString(),
        fiscalizedAtSource: deviceDateTime ? 'device' : 'local-fallback',
        cuSerialNumber,
        defVerStatus,
        // Step 5 (ReadCurrentReceiptInfo) already read these — carried
        // through verbatim for the fiscal reconciliation report
        // (docs/phase-163), not re-fetched with any extra command.
        vatGroups: extractVatGroupAmounts(receiptInfo)
      }
    }
  }

  async getInvoiceDetails(invoiceNumber: string): Promise<ServiceResult<FiscalInvoiceResult>> {
    if (!this.lookupInvoice) {
      return {
        success: false,
        error: 'No local invoice lookup configured for the real eTIMS provider'
      }
    }

    const invoice = this.lookupInvoice(invoiceNumber)
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceNumber} not found in local order history` }
    }
    return { success: true, data: invoice }
  }

  /**
   * Issues a device credit note for a previously fiscalized invoice.
   *
   * `OpenCreditNoteWithFreeCustomerData` re-opens a *full* invoice
   * receipt — it re-states the entire original customer block
   * (`CompanyName`/`ClientPINnum`/`HeadQuarters`/`Address`/
   * `PostalCodeAndCity`/`ExemptionNum`), not just a reference to the
   * original invoice number, plus a fresh `TraderSystemInvNum` for the
   * note itself. Without that block, there is no contract-valid command
   * to send — a bare "cancel by invoice number" command doesn't exist
   * (an earlier revision guessed one, `OpenCreditNote`; the conformance
   * guard in `tests/tremolConformance.test.ts` caught it, tracked in
   * `docs/KNOWN_GAPS.md`). So `details` is required to actually reach
   * the device; without it this reports the same manual-credit-note
   * fallback immediately, with no device call at all, rather than
   * guessing at a payload.
   */
  async cancelInvoice(
    invoiceNumber: string,
    details?: CreditNoteDetails
  ): Promise<ServiceResult<void>> {
    if (!details) {
      return {
        success: false,
        error:
          `Automatic credit note requires the original invoice's full customer details, which weren't ` +
          `supplied — issue a manual credit note on the fiscal device for invoice ${invoiceNumber}`
      }
    }

    const result = await this.exclusive(() =>
      this.sendCommand(
        this.endpoints.openCreditNote,
        'OpenCreditNoteWithFreeCustomerData',
        buildOpenCreditNoteArgs(details)
      )
    )
    if (!result.success) {
      return {
        success: false,
        error:
          `Automatic credit note failed — issue a manual credit note on the fiscal device for ` +
          `invoice ${invoiceNumber}: ${result.error}`
      }
    }
    return { success: true }
  }

  /**
   * `ReadCUinvoiceNumber` — the documented recovery path when
   * `OpenInvoiceWithFreeCustomerData` is rejected for a duplicate
   * `TraderSystemInvNum`: it returns the CU invoice number the device
   * already assigned on the earlier, unacknowledged attempt.
   *
   * Declared only by `defVer=2509041522`. Callers that must stay correct
   * on either definitions version go through
   * {@link verifyAlreadyFiled} rather than calling this directly.
   *
   * The command takes no caller-supplied arguments (`Option='I'` is
   * `OptionHardcoded` — server-filled, per the same convention as
   * `OpenInvoice`'s `reserved`/`InvoiceType`).
   *
   * @returns {Promise<ServiceResult<{ cuInvoiceNumber: string }>>}
   */
  async readCUInvoiceNumber(): Promise<ServiceResult<{ cuInvoiceNumber: string }>> {
    const result = await this.exclusive(() => this.sendReadCUinvoiceNumber())
    if (!result.success) {
      return { success: false, error: result.error }
    }
    const cuInvoiceNumber = result.data?.CU_InvoiceNumber
    if (!cuInvoiceNumber) {
      return {
        success: false,
        error: 'ReadCUinvoiceNumber returned no CU_InvoiceNumber'
      }
    }
    return { success: true, data: { cuInvoiceNumber } }
  }

  /**
   * Answers "was this sale already filed?" after an `OpenInvoice`
   * rejection on a retry/resend — the guard behind Rule 1, never file an
   * invoice twice (phase-75; both definition versions, phase-110).
   *
   * Only ever reached on a retry (`request.isRetry`). A first attempt
   * cannot collide with itself, so it falls straight through to normal
   * failure routing and no branch here can mark a never-filed sale as
   * filed. Duplicates are never recognized by error code — the device is
   * asked what it actually holds.
   *
   * **Why the older definitions must flag rather than resend.**
   * `defVer=2204120945` declares no `ReadCUinvoiceNumber`, and no other
   * read-back keyed by `TraderSystemInvNum` either — `ReadLastAndTotal`
   * `ReceiptNum` names only the *last* receipt filed, whichever sale that
   * was, so it can report a sale filed that never was, or unfiled when it
   * was. Nor do those definitions document any device-side duplicate
   * refusal (the newer ones state it explicitly, in
   * `ReadCUinvoiceNumber`'s own operation text), so a resend cannot be
   * assumed safe. With no way to establish either answer, the only sound
   * outcome is `'unverifiable'`: a person checks the device. Flagging a
   * sale that was in fact fine costs seconds; filing one twice is a KRA
   * compliance problem — the risk is asymmetric, so uncertainty always
   * resolves to the flag.
   *
   * A **transport** failure is deliberately not treated as uncertainty. A
   * server-level `serverFailure` (Codes 19/30/31/53) means no session
   * opened and the device never saw this attempt at all, so nothing was
   * filed by it and what we know about the sale is exactly what we knew
   * before — a non-event, not an unverified filing. Those keep normal
   * retry routing, without which every network blip on a queued sale
   * would become a support ticket.
   *
   * VERIFY-ON-DEVICE: no live duplicate-`TraderSystemInvNum` rejection
   * has ever been captured, on either definitions version — this is built
   * from the protocol definitions alone.
   * VERIFY-AGAINST-REAL-OLD-DEVICE: the `'absent'` path has never run
   * against a real `2204120945` device (see `docs/phase-109.md`).
   *
   * **One narrow carve-out ahead of the `support`/`deviceNeverSawIt`
   * fail-safe** (docs/phase-162-2): when BOTH the original `OpenInvoice`
   * rejection and this function's own `ReadCUinvoiceNumber` read were
   * refused by the same named `STE1=59` "missing daily closure" condition
   * (docs/phase-162), the outcome is `'genuine-failure'` regardless of
   * `defVer`. See the comment at that check for why this is safe and
   * does not widen the fail-safe for any other kind of failure.
   *
   * @param {string | undefined} defVer the connected server's echoed `<defVer>`
   * @param {DeviceResult} openResult the rejected `OpenInvoice` result
   * @param {number | undefined} localId sale id, for the debug trace only
   * @returns {Promise<DuplicateRecoveryVerdict>}
   */
  private async verifyAlreadyFiled(
    defVer: string | undefined,
    openResult: DeviceResult,
    localId: number | undefined
  ): Promise<DuplicateRecoveryVerdict> {
    const support = resolveDuplicateRecoverySupport(defVer)
    const deviceNeverSawIt = Boolean(openResult.serverFailure)

    if (support === 'absent') {
      return deviceNeverSawIt
        ? { outcome: 'genuine-failure' }
        : {
            outcome: 'unverifiable',
            reason: `defVer=${OLD_DEF_VERSION} declares no ReadCUinvoiceNumber — not sent`
          }
    }

    if (this.debugLogging) {
      console.log(
        `[ETIMS] Sale ${localId}: OpenInvoice rejected on a retry/resend — checking ` +
          `ReadCUinvoiceNumber before concluding this sale was never filed: ${openResult.error}`
      )
    }
    const recovery = await this.sendReadCUinvoiceNumber()
    const cuInvoiceNumber = recovery.success ? recovery.data?.CU_InvoiceNumber : undefined
    if (cuInvoiceNumber) {
      return { outcome: 'already-filed', cuInvoiceNumber }
    }

    // The device answered and named no invoice: it holds no record of
    // this TraderSystemInvNum, so the original rejection is genuine.
    if (recovery.success) {
      if (this.debugLogging) {
        console.log(
          `[ETIMS] Sale ${localId}: ReadCUinvoiceNumber found no record of this sale — the ` +
            'OpenInvoice rejection is genuine: no cuInvoiceNumber in response'
        )
      }
      return { outcome: 'genuine-failure' }
    }

    // Both the original OpenInvoice rejection and this recovery read were
    // refused by the SAME named condition (STE1=59, "missing daily
    // closure" — docs/phase-162), regardless of `defVer`/`support`. This
    // files nothing; it only lets the sale keep waiting. The duplicate
    // check still runs on the next attempt, at OpenInvoice, once the
    // device answers again — nothing here resends SellPLU/CloseReceipt,
    // and a device refusing every command outright cannot have filed
    // anything in the same breath (docs/phase-162-1's Step 0b). Checked
    // ahead of the `support`/`deviceNeverSawIt` fail-safe below so an
    // unrecognized `defVer` no longer turns this specific, unambiguous
    // condition into a false `'unverifiable'` flag (docs/phase-162-1,
    // Test A, Case B) — every other combination (a different original
    // error, a different recovery failure, or only one side blocked)
    // falls through to that fail-safe exactly as before.
    if (openResult.code === CODE_DAILY_CLOSURE_BLOCK && recovery.code === CODE_DAILY_CLOSURE_BLOCK) {
      return { outcome: 'genuine-failure' }
    }

    // The command itself failed. On `'available'` that is a known-new
    // server having a bad moment, routed exactly as it has always been.
    // On `'unknown'` it may equally be an old-defs server rejecting a
    // command it does not declare — indistinguishable from here, so it
    // fails safe.
    if (support === 'available' || deviceNeverSawIt) {
      if (this.debugLogging) {
        console.log(
          `[ETIMS] Sale ${localId}: ReadCUinvoiceNumber failed — routing the original ` +
            `OpenInvoice rejection normally: ${recovery.error}`
        )
      }
      return { outcome: 'genuine-failure' }
    }
    return { outcome: 'unverifiable', reason: recovery.error ?? 'ReadCUinvoiceNumber failed' }
  }

  /** Sends the argument-free `ReadCUinvoiceNumber` command. */
  private sendReadCUinvoiceNumber(): Promise<DeviceResult> {
    return this.sendCommand(this.endpoints.readCUinvoiceNumber, 'ReadCUinvoiceNumber', {})
  }

  /**
   * Releases this client's device session on the ZFPLabServer. Call
   * once on app shutdown — never per sale, which would force a fresh
   * `settings()` handshake on every transaction. Runs under
   * {@link exclusive}, so it waits for a sale in flight rather than
   * dropping that sale's session mid-receipt.
   *
   * @returns {Promise<ServiceResult<Record<string, string>>>}
   */
  async closeServerConnection(): Promise<ServiceResult<Record<string, string>>> {
    return this.exclusive(() => {
      this.settingsPromise = null
      this.cuNumbersPromise = null
      return closeDeviceConnection(this.http, this.debugLogging)
    })
  }

  /**
   * Runs the `settings()` handshake at most once per session. The
   * resolved promise is cached, so concurrent sales share one
   * handshake; {@link sendCommand} clears it on a Code 53 so the next
   * attempt re-runs it.
   */
  private async ensureSettings(): Promise<DeviceResult> {
    if (!this.settingsPromise) {
      this.settingsPromise = getSettings(
        this.http,
        this.deviceIp,
        this.devicePort,
        this.password,
        this.debugLogging
      ).then(checkDeviceResponse)
    }
    const result = await this.settingsPromise
    if (!result.success) {
      // A failed handshake must not be cached — the next sale should retry it.
      this.settingsPromise = null
    }
    return result
  }

  /**
   * Reads `ReadCUnumbers` (PDF §2.4.1 — arg-free, returns
   * `SerialNumber[20]`/`PINnumber[11]`) at most once per session — the
   * serial number is static per physical device, so re-reading it on
   * every sale would be pure waste. Per the VIL manual's own high-level
   * framework table ("Control Unit Serial Number" is one of the fixed
   * details returned for printing on the invoice), the serial is
   * best-effort and surfaced on {@link FiscalInvoiceResult}, not gated —
   * a failure here must never block a sale, the same philosophy already
   * applied to `ReadDateTime` (`submitInvoice`'s step 7).
   */
  private async ensureCUNumbers(): Promise<ServiceResult<{ serialNumber: string }>> {
    if (!this.cuNumbersPromise) {
      this.cuNumbersPromise = this.sendCommand(
        this.endpoints.readCUnumbers,
        'ReadCUnumbers',
        {}
      ).then((result): ServiceResult<{ serialNumber: string }> => {
        if (!result.success) return { success: false, error: result.error }
        const serialNumber = result.data?.SerialNumber
        if (!serialNumber) {
          return { success: false, error: 'ReadCUnumbers returned no SerialNumber' }
        }
        return { success: true, data: { serialNumber } }
      })
    }
    const result = await this.cuNumbersPromise
    if (!result.success) {
      // Don't cache a failure — the next sale should retry, same as settings().
      this.cuNumbersPromise = null
    }
    return result
  }

  /**
   * Sends one `<Command Name="…">` and interprets its response. A
   * `Code 53` ("client settings missing" — typically the server was
   * restarted, dropping our session) re-runs `settings()` once and
   * retries the command a single time. Only a server-sourced 53 counts:
   * `STE2 = 0x35` ("Input registers overflow") is also decimal 53, and
   * repeating a command the device refused must not happen
   * (docs/phase-184 §2.3b).
   */
  private async sendCommand(
    path: string,
    commandName: string,
    args: object
  ): Promise<DeviceResult> {
    const first = checkDeviceResponse(await postXml(this.http, path, commandName, args, this.debugLogging))
    if (first.success || first.code !== RES_CODE_SETTINGS_MISSING || !first.serverFailure) {
      return first
    }

    // Session-level recovery, not tied to one sale — rare (only fires
    // when the server session was dropped, e.g. a ZFPLabServer restart).
    this.logger.log(`[rubis-pos] ${commandName}: Code 53 — re-sending settings() and retrying once`)
    this.settingsPromise = null
    const settingsResult = await this.ensureSettings()
    if (!settingsResult.success) {
      return { success: false, error: settingsResult.error, code: RES_CODE_SETTINGS_MISSING }
    }
    return checkDeviceResponse(await postXml(this.http, path, commandName, args, this.debugLogging))
  }

  /**
   * Sends `ReadStatus` and interprets the device's status bits. A
   * `<Res Code="0">` response means the server reached the device — the
   * first point in the flow where that is actually proven, since
   * `settings()` only stores parameters. When the response carries the
   * `CU_fiscalized`/`Paired_with_TIMS` bits, both must be `'1'`;
   * when it doesn't (an unrecognized shape), that is logged as a
   * warning and treated as reachable rather than blocking the sale.
   */
  private async readStatus(): Promise<DeviceResult> {
    const result = await this.sendCommand(this.endpoints.readStatus, 'ReadStatus', {})
    if (!result.success) {
      // Preserve `code`/`retryable` from `sendCommand` — an earlier
      // revision rebuilt a bare `{success:false, error}` here, silently
      // dropping the classification `classifyDeviceFailure` needs.
      return result
    }

    const data = result.data ?? {}
    const fiscalized = data.CU_fiscalized
    const paired = data.Paired_with_TIMS
    if (fiscalized === undefined && paired === undefined) {
      this.logger.warn(
        '[rubis-pos] ReadStatus returned no CU_fiscalized/Paired_with_TIMS bits — treating the device ' +
          `as reachable on the strength of Res Code 0. Raw response: ${JSON.stringify(data)}`
      )
      return { success: true, data }
    }
    if (fiscalized !== undefined && fiscalized !== '1') {
      return {
        success: false,
        error: 'Fiscal device reports it is not fiscalized (CU_fiscalized=0)',
        notReady: 'not-fiscalized'
      }
    }
    if (paired !== undefined && paired !== '1') {
      return {
        success: false,
        error: 'Fiscal device reports it is not paired with TIMS (Paired_with_TIMS=0)',
        notReady: 'not-paired'
      }
    }
    return { success: true, data }
  }

  /**
   * Picks the B2B (`openInvoiceWithPin`) endpoint when `request.buyerPin`
   * is a non-blank KRA PIN, otherwise the B2C (`openInvoice`) endpoint.
   * Both default to `''` (the single endpoint) — the distinction only
   * matters for a deployment whose `endpoints` override routes them
   * apart.
   */
  private resolveOpenInvoiceEndpoint(request: FiscalInvoiceRequest): string {
    return request.buyerPin?.trim() ? this.endpoints.openInvoiceWithPin : this.endpoints.openInvoice
  }

  /**
   * Builds `OpenInvoiceWithFreeCustomerData`'s seven arguments, in the
   * vendor's declared order. The `reserved`/`InvoiceType` arguments the
   * command definition also lists are `OptionHardcoded` — the server
   * fills them from its own definitions and the vendor client never
   * sends them, so neither do we.
   *
   * Uncaptured fields keep their `<Arg>` element with an empty value
   * rather than being omitted, matching the vendor client, which always
   * passes all seven.
   */
  private buildOpenInvoiceArgs(request: FiscalInvoiceRequest): Record<string, string> {
    return {
      CompanyName: sanitizeFiscalText(request.companyName, MAX_COMPANY_NAME_LENGTH),
      ClientPINnum: sanitizeFiscalText(request.buyerPin?.trim(), MAX_CLIENT_PIN_LENGTH),
      HeadQuarters: sanitizeFiscalText(request.headQuarters, MAX_ADDRESS_FIELD_LENGTH),
      Address: sanitizeFiscalText(request.address, MAX_ADDRESS_FIELD_LENGTH),
      PostalCodeAndCity: sanitizeFiscalText(request.postalCodeAndCity, MAX_ADDRESS_FIELD_LENGTH),
      ExemptionNum: sanitizeFiscalText(request.exemptionNum, MAX_ADDRESS_FIELD_LENGTH),
      TraderSystemInvNum: sanitizeFiscalText(
        this.buildTraderSystemInvNum(request),
        MAX_TRADER_SYSTEM_INV_NUM_LENGTH
      )
    }
  }

  /**
   * Builds a `TraderSystemInvNum` no longer than
   * {@link MAX_TRADER_SYSTEM_INV_NUM_LENGTH} characters. Prefers a
   * zero-padded `INV-<localId>` (short, sequential, and stable across a
   * store-and-forward retry) and falls back to a truncated
   * `clientOrderUuid` when no local order id is available yet.
   */
  private buildTraderSystemInvNum(request: FiscalInvoiceRequest): string {
    const raw =
      typeof request.localId === 'number'
        ? `INV-${String(request.localId).padStart(9, '0')}`
        : request.clientOrderUuid.replace(/-/g, '')
    return raw.slice(0, MAX_TRADER_SYSTEM_INV_NUM_LENGTH)
  }

  /**
   * Picks which sell command a line item goes through and builds its
   * arguments. Under `defVer=2509041522`, `SellPLUfromExtDB`'s
   * `OptionVATClass` has exactly one legal enum value, `"A"` — there is
   * no way to express class B/C/D/E through it at all — while
   * `SellPLUfromExtDB_HS` takes neither `OptionVATClass` nor `VATGrRate`
   * and instead carries only `HSCode`, from which the device looks up
   * the item's programmed rate/exempt flag (`ProgHScode`).
   *
   * VERIFY-ON-DEVICE: nothing in the vendor's prose documentation
   * states this routing rule outright — it's inferred from the argument
   * lists (`_HS` structurally cannot carry a VAT class or rate; the HS
   * table is the only place non-16%/exempt treatment could come from)
   * and from `SellPLUfromExtDB`'s single-value enum. Confirm against a
   * live device before treating a class-A-looking sale that lands on
   * `_HS` (or vice versa) as correct rather than a device rejection.
   *
   * This routing is valid under **both** supported definition versions,
   * confirmed command-by-command in `docs/phase-110.md` §1a. The older
   * `defVer=2204120945` widens `SellPLUfromExtDB`'s `OptionVATClass` to
   * accept `A`–`E` where the newer one accepts only `A`; since this
   * routing sends `A` on that command and nothing else, it is stricter
   * than the older contract requires and legal under either.
   *
   * @param {FiscalInvoiceLine} item
   * @param {number} priceMaxLength ceiling for `Price` under the connected server's definitions
   */
  private resolveSellCommand(
    item: FiscalInvoiceLine,
    priceMaxLength: number
  ): {
    path: string
    commandName: string
    args: Record<string, string | undefined>
  } {
    const vatClass = item.vatClass ?? this.defaultVatClass
    if (vatClass === DEFAULT_VAT_CLASS) {
      return {
        path: this.endpoints.sellPLU,
        commandName: 'SellPLUfromExtDB',
        args: this.buildSellPluArgs(item, priceMaxLength)
      }
    }
    return {
      path: this.endpoints.sellPLUWithHsCode,
      commandName: 'SellPLUfromExtDB_HS',
      args: this.buildSellPluHsArgs(item, priceMaxLength)
    }
  }

  /**
   * Maps a class-A line item to `SellPLUfromExtDB`'s arguments, in the
   * vendor's declared order. `HSCode`/`HSName` are structurally
   * required (the vendor defs carry no `Compulsory="false"` on either,
   * unlike `Quantity`/`DiscAddP`) and are always sent, populated with
   * whatever HS classification the item actually carries — blank when
   * it has none, never omitted. `VATGrRate` is a percentage string
   * (`0.16` → `"16.00"`), confirmed against the vendor's sibling
   * VAT-rate fields (`ProgVATrates`, `ReadVATrates`, `ProgHScode.VAT_Rate`
   * — all documented `##.##`) — see `tracker/SDK_RECON.md` §4(a) in the
   * `ZFP_SDK_KE_2509041522_ControlUnit` package.
   *
   * `DiscAddP` is optional in the vendor definition and is omitted
   * entirely when the line carries no discount/addition.
   *
   * @param {FiscalInvoiceLine} item
   * @param {number} priceMaxLength ceiling for `Price` under the connected server's definitions
   * @returns {Record<string, string | undefined>}
   */
  private buildSellPluArgs(
    item: FiscalInvoiceLine,
    priceMaxLength: number
  ): Record<string, string | undefined> {
    return {
      NamePLU: sanitizeFiscalText(item.description, MAX_NAME_PLU_LENGTH),
      OptionVATClass: DEFAULT_VAT_CLASS,
      Price: formatPrice(item.unitPrice, priceMaxLength),
      MeasureUnit: sanitizeFiscalText(item.measureUnit || DEFAULT_MEASURE_UNIT, MAX_MEASURE_UNIT_LENGTH),
      HSCode: sanitizeFiscalText(item.hsCode, MAX_HS_CODE_LENGTH),
      HSName: sanitizeFiscalText(item.hsName, MAX_HS_NAME_LENGTH),
      VATGrRate: (item.taxRate * 100).toFixed(2),
      Quantity: String(item.quantity),
      DiscAddP: formatOptionalDiscAddP(item)
    }
  }

  /**
   * Maps a non-class-A line item to `SellPLUfromExtDB_HS`'s arguments.
   * No `OptionVATClass`, `MeasureUnit`, `HSName`, or `VATGrRate` — the
   * command doesn't declare those args at all; the device derives VAT
   * treatment from `HSCode` alone via its programmed HS table.
   *
   * @param {FiscalInvoiceLine} item
   * @param {number} priceMaxLength ceiling for `Price` under the connected server's definitions
   * @returns {Record<string, string | undefined>}
   */
  private buildSellPluHsArgs(
    item: FiscalInvoiceLine,
    priceMaxLength: number
  ): Record<string, string | undefined> {
    return {
      NamePLU: sanitizeFiscalText(item.description, MAX_NAME_PLU_LENGTH),
      Price: formatPrice(item.unitPrice, priceMaxLength),
      HSCode: sanitizeFiscalText(item.hsCode, MAX_HS_CODE_LENGTH),
      Quantity: String(item.quantity),
      DiscAddP: formatOptionalDiscAddP(item)
    }
  }

  /**
   * Best-effort void of an open receipt during recovery or after a
   * failed step. The failure that triggered this rollback is already
   * logged once at the caller's decision point, so the raw command
   * result is debug-only detail, not a second log of the same event.
   */
  private async rollback(): Promise<void> {
    const result = await this.sendCommand(this.endpoints.cancelReceipt, 'CancelReceipt', {})
    if (this.debugLogging) {
      console.log('[ETIMS] CancelReceipt result:', result)
    }
  }
}

/**
 * Sums `ReadCurrentReceiptInfo`'s five per-VAT-group subtotals. The
 * response has no single "SubTotal" field — the amounts arrive split
 * across `SubtotalAmountVATGA`…`VATGE`, any of which may be absent.
 *
 * @param {Record<string, string>} receiptInfo
 * @returns {number}
 */
export function sumVatGroupSubtotals(receiptInfo: Record<string, string>): number {
  return SUBTOTAL_FIELDS.reduce((total, field) => {
    const parsed = Number(receiptInfo[field])
    return total + (Number.isFinite(parsed) ? parsed : 0)
  }, 0)
}

/**
 * `SUBTOTAL_FIELDS`, in order, paired with the VAT class letter each one
 * carries — the same letters `FiscalInvoiceLine.vatClass` already uses.
 */
const VAT_GROUP_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const

/**
 * Reads `ReadCurrentReceiptInfo`'s five per-VAT-group subtotals as raw
 * strings, exactly as the device returned them (docs/phase-163) — no
 * parsing, no summing (that is {@link sumVatGroupSubtotals}'s job, for
 * the read-VAT validation gate, a different purpose). A group with no
 * field at all in the response (rather than an explicit `'0.00'`) is left
 * out of the result entirely, never defaulted.
 *
 * @param {Record<string, string>} receiptInfo
 * @returns {FiscalVatGroupAmounts}
 */
export function extractVatGroupAmounts(receiptInfo: Record<string, string>): FiscalVatGroupAmounts {
  const amounts: FiscalVatGroupAmounts = {}
  SUBTOTAL_FIELDS.forEach((field, index) => {
    const raw = receiptInfo[field]
    if (raw !== undefined) {
      amounts[VAT_GROUP_LETTERS[index]] = raw
    }
  })
  return amounts
}

/**
 * Formats a line item's unit price for `Price`, fitted to `maxLength` —
 * {@link MAX_PRICE_LENGTH} on the newer definitions,
 * {@link MAX_PRICE_LENGTH_OLD_DEFS} on the older ones, resolved per
 * session by {@link resolvePriceMaxLength}.
 *
 * Two steps, in order:
 *
 *   1. **Normalize**, identically on both paths. `String(unitPrice)`
 *      alone leaks binary-float artifacts — `String(0.1 + 0.2)` is
 *      `"0.30000000000000004"`, 19 characters, over the ceiling of
 *      *both* versions. Rounding to {@link MAX_PRICE_DECIMALS} and
 *      dropping trailing zeros removes those while leaving every
 *      already-valid price byte-identical, so this costs the newer path
 *      nothing.
 *   2. **Fit**, only when still over `maxLength`: step the decimals down
 *      toward {@link MIN_PRICE_DECIMALS}. Digits are never truncated —
 *      chopping them off a monetary amount would corrupt the sale rather
 *      than merely mangle a display string — so a price whose whole-unit
 *      part alone cannot fit is returned as-is with a warning, for the
 *      device to reject rather than silently mis-record.
 *
 * @param {number} unitPrice
 * @param {number} maxLength
 * @returns {string}
 */
function formatPrice(unitPrice: number, maxLength: number): string {
  const normalized = formatDecimal(unitPrice, MAX_PRICE_DECIMALS)
  if (normalized.length <= maxLength) {
    return normalized
  }

  for (let decimals = MAX_PRICE_DECIMALS - 1; decimals >= MIN_PRICE_DECIMALS; decimals -= 1) {
    const candidate = formatDecimal(unitPrice, decimals)
    if (candidate.length <= maxLength) {
      return candidate
    }
  }

  console.warn(
    `[rubis-pos] Price "${normalized}" exceeds the connected device's ${maxLength}-character limit and ` +
      'cannot be fitted without dropping whole units — sending as-is'
  )
  return normalized
}

/**
 * Rounds `value` to at most `decimals` places and renders it with no
 * trailing zeros, so a whole amount stays `"60"` rather than
 * `"60.00000"`.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
function formatDecimal(value: number, decimals: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  const fixed = value.toFixed(decimals)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/**
 * The `Price` ceiling the connected server's definitions impose. Falls
 * back to {@link MAX_PRICE_LENGTH} for a blank or unrecognized `defVer`,
 * which keeps the newer path's behaviour unchanged wherever the server
 * does not positively identify itself as the older one — over-length
 * prices are already warned about rather than sent blindly, and the
 * narrower ceiling is only correct where it is known to apply.
 *
 * @param {string | undefined} defVer
 * @returns {number}
 */
function resolvePriceMaxLength(defVer: string | undefined): number {
  return defVer === OLD_DEF_VERSION ? MAX_PRICE_LENGTH_OLD_DEFS : MAX_PRICE_LENGTH
}

/**
 * Formats a line item's `DiscAddP` — optional per the vendor definition
 * — returning `undefined` (which {@link serializeToXml} omits entirely)
 * when the line carries no real discount/addition.
 *
 * @param {FiscalInvoiceLine} item
 * @returns {string | undefined}
 */
function formatOptionalDiscAddP(item: FiscalInvoiceLine): string | undefined {
  const discAddP = item.discAddP?.trim()
  return discAddP && discAddP !== '0' ? discAddP : undefined
}

/**
 * Builds `OpenCreditNoteWithFreeCustomerData`'s eight caller-supplied
 * arguments, in the vendor's declared order. Byte-identical shape to
 * `OpenDebitNoteWithFreeCustomerData` (see {@link buildOpenDebitNoteArgs})
 * — the two commands share every field except the server-filled,
 * hardcoded `InvoiceDebitNoteType` discriminator (`'A'` credit vs `'@'`
 * debit), which — like `OpenInvoice`'s `reserved`/`InvoiceType` — is
 * never sent by the caller.
 *
 * @param {CreditNoteDetails} details
 * @returns {Record<string, string>}
 */
export function buildOpenCreditNoteArgs(details: CreditNoteDetails): Record<string, string> {
  return buildOpenNoteArgs(details)
}

/**
 * Builds `OpenDebitNoteWithFreeCustomerData`'s eight caller-supplied
 * arguments — see {@link buildOpenCreditNoteArgs}. Not currently wired
 * into any caller; available and contract-tested ahead of a future
 * phase that needs it.
 *
 * @param {CreditNoteDetails} details
 * @returns {Record<string, string>}
 */
export function buildOpenDebitNoteArgs(details: CreditNoteDetails): Record<string, string> {
  return buildOpenNoteArgs(details)
}

/** Shared arg-building logic behind {@link buildOpenCreditNoteArgs} and {@link buildOpenDebitNoteArgs}. */
function buildOpenNoteArgs(details: CreditNoteDetails): Record<string, string> {
  return {
    CompanyName: sanitizeFiscalText(details.companyName, MAX_COMPANY_NAME_LENGTH),
    ClientPINnum: sanitizeFiscalText(details.buyerPin?.trim(), MAX_CLIENT_PIN_LENGTH),
    HeadQuarters: sanitizeFiscalText(details.headQuarters, MAX_ADDRESS_FIELD_LENGTH),
    Address: sanitizeFiscalText(details.address, MAX_ADDRESS_FIELD_LENGTH),
    PostalCodeAndCity: sanitizeFiscalText(details.postalCodeAndCity, MAX_ADDRESS_FIELD_LENGTH),
    ExemptionNum: sanitizeFiscalText(details.exemptionNum, MAX_ADDRESS_FIELD_LENGTH),
    RelatedInvoiceNum: sanitizeFiscalText(details.relatedInvoiceNum, MAX_RELATED_INVOICE_NUM_LENGTH),
    TraderSystemInvNum: sanitizeFiscalText(details.traderSystemInvNum, MAX_TRADER_SYSTEM_INV_NUM_LENGTH)
  }
}
