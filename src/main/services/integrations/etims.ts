/**
 * eTIMS (KRA) fiscalization integration.
 *
 * KRA's eTIMS requires every invoice to be fiscalized (assigned a KRA
 * invoice number and QR code) — but a store-floor till cannot block a
 * sale on a government API being reachable. The intended production
 * shape is a local middleware that queues invoices for submission
 * (store-and-forward, mirroring the existing Shopify `sync_queue`
 * pattern in `database.ts`) and generates a provisional local invoice
 * immediately.
 *
 * This module holds only the contract — {@link FiscalizationProvider} and
 * its request/result types. The implementations live beside it:
 * `real-etims-provider.ts` (the only one a packaged build may use) and
 * `mock-etims-provider.ts` (development and tests only).
 */

import type { ServiceResult } from '../shopify-types.js'
import type { DefVersionStatus } from './http-client.js'

/** One taxable line item on the invoice submitted for fiscalization. */
export interface FiscalInvoiceLine {
  description: string
  quantity: number
  unitPrice: number
  /** Fractional tax rate applied to this line (0.16 = 16% VAT). */
  taxRate: number
  /** Stable product identifier the fiscal device can key its PLU registry on — a variant id or generated hash. */
  pluCode?: string
  /** Device VAT class code (e.g. `'A'` for 16%). Providers default this when omitted. */
  vatClass?: string
  /** Unit of measure for `quantity` (e.g. `'pcs'`, `'kg'`). Providers default this when omitted. */
  measureUnit?: string
  /** Harmonized System code for the item, when tracked. */
  hsCode?: string
  /** Harmonized System name/description for the item, when tracked. */
  hsName?: string
  /** Per-line discount/addition percentage. Omitted from the fiscal payload entirely when unset. */
  discAddP?: string
}

/** Request to fiscalize one completed sale. */
export interface FiscalInvoiceRequest {
  /** Local order UUID — ties the KRA invoice back to the POS sale. */
  clientOrderUuid: string
  /** Local order id, used to build a short, sequential `TraderSystemInvNum`. */
  localId?: number
  items: FiscalInvoiceLine[]
  /** Grand total including tax, in KES. */
  total: number
  /**
   * Calculated by the till, added on top. Not sent to the device. Do
   * not use for reports; prices include VAT (docs/phase-159 B1.3).
   */
  taxAmount: number
  /** Buyer's KRA PIN, when captured (optional for walk-in retail sales). */
  buyerPin?: string
  /** Buyer's display name, when captured. */
  customerName?: string
  /** Buyer's company/trading name, when captured. */
  companyName?: string
  /** Buyer's head office name/branch, when captured. */
  headQuarters?: string
  /** Buyer's address, when captured. */
  address?: string
  /** Buyer's postal code and city, when captured. */
  postalCodeAndCity?: string
  /** Buyer's tax exemption number, when applicable. */
  exemptionNum?: string
  /** ISO 4217 currency code. Providers default this (e.g. to `'KES'`) when omitted. */
  currency?: string
  /** Till payment method (e.g. `'cash'`, `'mpesa'`, `'card'`). */
  paymentMethod?: string
  /** Amount tendered by the customer. */
  amountTendered?: number
  /**
   * Set by a retry or manual resend (never by the first checkout
   * attempt) — lets a provider tell the two apart without any DB access
   * of its own. `RealFiscalizationProvider` uses it to gate the
   * `ReadCUinvoiceNumber` duplicate-recovery check (phase-75): only a
   * retry/resend can be resubmitting a sale that might already be
   * filed, so only a retry/resend is allowed to ask "did the device
   * already file this?" before concluding an `OpenInvoice` rejection is
   * a genuine failure. Omitted/`false` on a first attempt.
   */
  isRetry?: boolean
}

/**
 * The full customer block plus the original CU invoice number a credit
 * or debit note must carry — per the vendor protocol,
 * `OpenCreditNoteWithFreeCustomerData`/`OpenDebitNoteWithFreeCustomerData`
 * re-open a full invoice receipt and re-state the entire customer block
 * rather than just referencing the original invoice number, so storing
 * only an invoice number is not enough to issue one later. See
 * `real-etims-provider.ts`'s `cancelInvoice` doc for how a caller
 * without this full block is handled.
 */
export interface CreditNoteDetails {
  /** Buyer's company/trading name, as captured on the original invoice. */
  companyName?: string
  /** Buyer's KRA PIN, as captured on the original invoice. */
  buyerPin?: string
  /** Buyer's head office name/branch, as captured on the original invoice. */
  headQuarters?: string
  /** Buyer's address, as captured on the original invoice. */
  address?: string
  /** Buyer's postal code and city, as captured on the original invoice. */
  postalCodeAndCity?: string
  /** Buyer's tax exemption number, as captured on the original invoice. */
  exemptionNum?: string
  /**
   * The original invoice's `InvoiceNum`, as returned by its
   * `CloseReceipt` call — becomes `RelatedInvoiceNum` (19 chars) on the
   * note.
   */
  relatedInvoiceNum: string
  /**
   * A fresh trader-system invoice number for *this* note — not the
   * original's. Same role and length limit (15 chars) as
   * `FiscalInvoiceRequest`'s own `TraderSystemInvNum` generation.
   */
  traderSystemInvNum: string
}

/**
 * One order's per-VAT-group subtotal amounts from `ReadCurrentReceiptInfo`
 * (Step 5), exactly as the device returned them — raw strings, never
 * parsed or summed here (docs/phase-159 B1.1/B1.2, docs/phase-163). Keyed
 * by VAT class letter, the same vocabulary `FiscalInvoiceLine.vatClass`
 * already uses. A group absent from the device's response (no
 * `SubtotalAmountVATG<letter>` field at all) is simply absent here too —
 * never defaulted to `'0.00'`, which would misrepresent "the device
 * didn't say" as "the device said zero".
 */
export interface FiscalVatGroupAmounts {
  A?: string
  B?: string
  C?: string
  D?: string
  E?: string
}

/** Result of a successful (or previously successful) fiscalization. */
export interface FiscalInvoiceResult {
  /** KRA-assigned invoice number, or a local placeholder while queued. */
  invoiceNumber: string
  /**
   * Base64-encoded placeholder for the KRA-mandated QR code. Real QR
   * generation (the `qrcode` package, encoding the KRA verification
   * URL) is planned for the production integration.
   */
  qrCode: string
  fiscalizedAt: string
  /**
   * Where `fiscalizedAt` came from: `'device'` when `ReadDateTime`
   * returned the device's own clock, `'local-fallback'` when it didn't
   * and the till's clock stood in. Recorded rather than silently
   * substituted so a receipt's timestamp can never be mistaken for a
   * device-attested one. Absent on providers that don't distinguish
   * (e.g. the mock).
   */
  fiscalizedAtSource?: 'device' | 'local-fallback'
  /**
   * The Control Unit's own serial number, from `ReadCUnumbers` (PDF
   * §2.4.1) — read once per session, not per sale, so identical across
   * every invoice from the same till in the same run. Per the VIL G03
   * manual's high-level framework table, this is one of the fixed set of
   * details meant to be printed on the invoice. Absent when the read
   * failed (best-effort — never blocks a sale) or on providers that don't
   * surface it (e.g. the mock).
   */
  cuSerialNumber?: string
  /**
   * Three-state comparison of the server's echoed `settings()` `<defVer>`
   * against the version this build's `tremol-contract.json` was
   * extracted from (`EXPECTED_DEF_VERSION` in `http-client.ts`) — see
   * `checkDefVersion`. The VAT-class sell routing in
   * `real-etims-provider.ts#resolveSellCommand` (`SellPLUfromExtDB` for
   * class A vs `SellPLUfromExtDB_HS` otherwise) is confirmed valid only
   * when this is `'match'`. `'unknown'` (blank `<defVer>`) is a common,
   * non-error server build, not a mismatch. A `'mismatch'` is logged
   * loudly but never blocks the sale — go-live warn-vs-block policy on a
   * real mismatch is tracked in `docs/KNOWN_GAPS.md`. Absent on providers
   * that don't surface it (e.g. the mock).
   */
  defVerStatus?: DefVersionStatus
  /**
   * The five raw per-VAT-group subtotal strings read at Step 5
   * (`ReadCurrentReceiptInfo`), for the fiscal reconciliation report
   * (docs/phase-163). Set only on a fresh `submitInvoice` success that
   * actually performed Step 5 — `undefined` on the mock provider, and on
   * the `verifyAlreadyFiled` "already-filed" recovery path, which never
   * re-reads the receipt (no extra device command is sent to fetch it
   * after the fact).
   */
  vatGroups?: FiscalVatGroupAmounts
}

/**
 * Plain-language classification of *why* a fiscalization attempt failed —
 * feeds the order's `fiscal_status`/`fiscal_error_kind` routing
 * (`main/index.ts`'s checkout handler), not the retry queue directly:
 *
 *   - `'data'`      — the device rejected the sale's own data (wrong PIN,
 *     unknown item, invalid HS code, an amount that doesn't fit, …).
 *     Resubmitting the identical data will fail again the same way.
 *   - `'system'`    — this build's own bug, an anomalous device response
 *     shape (a malformed request the server rejected outright, a receipt
 *     that closed without an invoice number, a device that reports itself
 *     unfiscalized/unpaired), or a resend the connected device's protocol
 *     definitions cannot confirm is safe (see
 *     `real-etims-provider.ts#verifyAlreadyFiled`). Not the cashier's
 *     fault and not the customer's data, but also not something an
 *     automatic retry fixes — a person has to look at it.
 *   - `'technical'` — a transient/technical condition (device
 *     unreachable, wrong TCP password, busy socket, dropped session, an
 *     already-open receipt) that heals on its own or once configuration
 *     is corrected. Worth retrying in the background.
 */
export type FiscalFailureKind = 'data' | 'system' | 'technical'

/**
 * Discriminated outcome of {@link FiscalizationProvider.submitInvoice} —
 * deliberately its own type, not the shared `ServiceResult<T>` (used by
 * roughly a dozen unrelated services), so the fiscalization-specific
 * `kind`/`retryable` classification a caller needs to route a failed sale
 * into `waiting` vs `needs_fixing` doesn't leak into every other service
 * that shape is used for. A discriminated union rather than optional
 * fields on one object: a failure literally cannot be constructed without
 * stating its `kind`/`retryable` — no code path can silently fall back to
 * an unclassified failure.
 */
export type FiscalSubmitOutcome =
  | { ok: true; data: FiscalInvoiceResult }
  | {
      ok: false
      reason: string
      kind: FiscalFailureKind
      retryable: boolean
      /**
       * A small, stable, machine-readable tag for a `kind: 'data'`
       * rejection the till can offer an on-the-spot fix for (phase-77+)
       * — set only when a provider *recognizes* the specific rejection
       * from its own structured classification (e.g. the STE2 business
       * code), never by matching `reason`'s free text. Currently the
       * only recognized value is `'wrong-pin'`; `undefined` for every
       * other rejection, including other `'data'` ones.
       */
      dataIssue?: 'wrong-pin'
    }

/**
 * Narrow surface every fiscalization backend (mock or real eTIMS
 * middleware) must implement.
 */
export interface FiscalizationProvider {
  /** Submits a completed sale for fiscalization. */
  submitInvoice(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome>

  /**
   * Cancels a previously submitted invoice (e.g. on a full refund).
   * `details` — the original invoice's full customer block, per
   * {@link CreditNoteDetails} — is required by the real provider to
   * issue an actual device credit note; omitted, it reports that a
   * manual credit note is needed instead of guessing at the payload.
   */
  cancelInvoice(invoiceNumber: string, details?: CreditNoteDetails): Promise<ServiceResult<void>>

  /** Reads back the current status of a previously submitted invoice. */
  getInvoiceDetails(invoiceNumber: string): Promise<ServiceResult<FiscalInvoiceResult>>
}
