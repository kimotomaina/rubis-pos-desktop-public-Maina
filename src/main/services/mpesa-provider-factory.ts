/**
 * Chooses which {@link MpesaProvider} a till runs, and reports whether
 * that provider can actually confirm a payment.
 *
 * Split out of `main/index.ts`'s bootstrap for the same reason
 * `fiscal-provider-factory.ts` was: the one decision that can let a till
 * accept a payment that never happened should be a single testable
 * function, not an inline ternary.
 *
 * **A packaged build always gets the real provider.** The mock approves
 * essentially any transaction code, so a packaged till running it would
 * complete sales for imaginary payments — the payment-side twin of
 * printing a fiscal receipt for an unfiled sale. The mock is reached
 * only through a dev-only dynamic import, which also keeps
 * `mock-mpesa-provider.ts` out of the production bundle;
 * `scripts/verify-no-mock-provider.cjs` asserts that at build time
 * rather than trusting tree-shaking.
 */

import type { ServiceResult } from './shopify-types.js'
import type {
  ManualCodeVerification,
  ManualCodeVerificationResult,
  MpesaProvider,
  StkPushRequest,
  StkPushResult,
  StkPushStatusResult
} from './integrations/mpesa.js'
import {
  DarajaMpesaProvider,
  type DarajaMpesaProviderOptions
} from './integrations/daraja-mpesa-provider.js'
import {
  SmsMpesaProvider,
  type SmsMpesaProviderDb
} from './integrations/sms-mpesa-provider.js'

/** How a till confirms that an M-Pesa payment really happened. */
export type MpesaConfirmationMethod = 'daraja' | 'sms'

/** Shown to the cashier when this till has no M-Pesa credentials saved. */
export const MPESA_NOT_CONFIGURED_MESSAGE =
  'M-Pesa has not been set up on this till yet. Take payment another way, or ask an administrator to finish the setup.'

/**
 * Stands in when no M-Pesa credentials are configured.
 *
 * `DarajaMpesaProvider` throws on missing credentials, and a till that
 * cannot take M-Pesa must still open and still take cash — so an
 * unconfigured till gets a provider that refuses every call with a
 * plain reason instead of a crash at start-up. It confirms nothing,
 * which means no M-Pesa sale can complete against it: the correct
 * answer for a till that cannot check whether a payment happened.
 *
 * The same shape as phase-92's not-configured fiscal backstop, for the
 * same reason.
 */
class UnconfiguredMpesaProvider implements MpesaProvider {
  async initiateStkPush(_request: StkPushRequest): Promise<ServiceResult<StkPushResult>> {
    return { success: false, error: MPESA_NOT_CONFIGURED_MESSAGE }
  }

  async verifyTransactionCode(
    _input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> {
    return { success: false, error: MPESA_NOT_CONFIGURED_MESSAGE }
  }

  async queryStkPushStatus(_checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>> {
    return { success: false, error: MPESA_NOT_CONFIGURED_MESSAGE }
  }
}

/** Whether Daraja has everything it needs, checked before construction so a gap is not a crash. */
function isDarajaConfigured(options: DarajaMpesaProviderOptions): boolean {
  return Boolean(
    options.consumerKey && options.consumerSecret && options.shortcode && options.passkey
  )
}

/** Minimal logging surface, matching `fiscal-provider-factory.ts`. */
export interface MpesaProviderLogger {
  log(message: string): void
  warn(message: string): void
}

/** Options accepted by {@link resolveMpesaProvider}. */
export interface ResolveMpesaProviderOptions {
  /**
   * `app.isPackaged`. Passed in rather than imported so this module has
   * no Electron dependency and can be unit tested. `true` forces the
   * real provider regardless of {@link mockRequested}.
   */
  isPackaged: boolean
  /** Whether the till's config asked for the mock provider. */
  mockRequested: boolean
  /**
   * How this till confirms an M-Pesa payment. `'daraja'` prompts the
   * customer and reads Safaricom's answer; `'sms'` reads the
   * confirmation message the till's own notification SIM received.
   * Defaults to `'daraja'`.
   */
  confirmationMethod?: MpesaConfirmationMethod
  /** Constructor options forwarded to {@link DarajaMpesaProvider}. */
  darajaOptions: DarajaMpesaProviderOptions
  /**
   * Whether this till may also complete a sale on a manually entered,
   * unconfirmed code.
   *
   * Orthogonal to {@link confirmationMethod}, deliberately: it is a
   * fallback permitted *alongside* a confirming method, not a way of
   * confirming. Defaults to off — the exception has to be switched on by
   * an administrator who read what it does.
   */
  manualEntryEnabled?: boolean
  /** Database surface the SMS provider reads. Required when the method is `'sms'`. */
  smsDb?: SmsMpesaProviderDb
  /** Defaults to `console`. */
  logger?: MpesaProviderLogger
}

/** The chosen provider, plus what checkout may rely on it for. */
export interface ResolvedMpesaProvider {
  provider: MpesaProvider
  /**
   * Whether `verifyTransactionCode` can settle whether a payment
   * really happened.
   *
   * `false` for Daraja, which has no receipt-lookup endpoint in the STK
   * Push scope and refuses that call outright. A Daraja till proves its
   * payments a different way: `checkout.ts` matches the reference
   * against this till's own record of Daraja's STK status responses.
   * Never inferred from "is this the mock" — the SMS provider is real
   * and verifies for real.
   */
  verifyReferenceNumbers: boolean
  /**
   * Whether a confirmation is a stored record that must be **spent** when
   * a sale uses it.
   *
   * `true` only for the message-based till, where the same received
   * payment sits in a list a cashier picks from and would otherwise be
   * pickable again for the next sale. Distinct from
   * {@link verifyReferenceNumbers}: that answers "did this payment
   * happen", this answers "does using it consume it". Daraja's STK
   * records and the mock's fabrications are not claimed.
   */
  claimsStoredPayments: boolean
  /**
   * Whether the till may complete a sale on a manually entered code that
   * nobody confirmed.
   *
   * Passed straight through from config rather than inferred from the
   * provider: no provider *supports* manual entry, because manual entry
   * asks nothing of a provider. It is a policy the store opted into, and
   * every other control around it — the manager PIN, the format check,
   * the acknowledgement, the unverified record — lives in `checkout.ts`.
   *
   * Reported separately from {@link verifyReferenceNumbers}, which stays
   * exactly what it always was: *can the provider settle whether this
   * payment happened*. Manual never makes that true.
   */
  manualEntryEnabled: boolean
}

/**
 * Resolves the M-Pesa provider for this run.
 *
 * @param {ResolveMpesaProviderOptions} options
 * @returns {Promise<ResolvedMpesaProvider>}
 */
export async function resolveMpesaProvider(
  options: ResolveMpesaProviderOptions
): Promise<ResolvedMpesaProvider> {
  const logger = options.logger ?? console
  const manualEntryEnabled = options.manualEntryEnabled === true

  if (options.mockRequested && options.isPackaged) {
    logger.warn(
      '[rubis-pos] Mock M-Pesa was requested but this is a packaged build — ' +
        'using the real M-Pesa integration. The mock approves almost any transaction ' +
        'code and is not shipped.'
    )
  }

  if (options.mockRequested && !options.isPackaged && import.meta.env.DEV) {
    const { MockMpesaProvider } = await import('./integrations/mock-mpesa-provider.js')
    logger.warn(
      '[rubis-pos] Using MockMpesaProvider — transaction codes are approved without ' +
        'contacting Safaricom and no real payment is confirmed. Development only.'
    )
    return {
      provider: new MockMpesaProvider(),
      verifyReferenceNumbers: true,
      claimsStoredPayments: false,
      manualEntryEnabled
    }
  }

  if (options.confirmationMethod === 'sms') {
    if (!options.smsDb) {
      // Nothing to read confirmations from, so nothing can be confirmed.
      // Refusing is the only safe answer; a till in this state takes cash.
      logger.warn(
        '[rubis-pos] M-Pesa by message was selected but no message store was supplied — ' +
          'no payment can be confirmed on this till.'
      )
      return {
        provider: new UnconfiguredMpesaProvider(),
        verifyReferenceNumbers: true,
        claimsStoredPayments: false,
        manualEntryEnabled
      }
    }
    // Real confirmations, from messages Safaricom sent to this till's own
    // SIM — and each one is spent by the sale that uses it.
    return {
      provider: new SmsMpesaProvider({ db: options.smsDb }),
      verifyReferenceNumbers: true,
      claimsStoredPayments: true,
      manualEntryEnabled
    }
  }

  if (!isDarajaConfigured(options.darajaOptions)) {
    logger.warn(
      '[rubis-pos] M-Pesa is not configured on this till — no M-Pesa payment can be confirmed, ' +
        'and no M-Pesa sale can complete, until credentials are saved in Admin.'
    )
    // `true` so the refusal above is what the cashier reads, rather than
    // the more general "this payment has not been confirmed".
    return {
      provider: new UnconfiguredMpesaProvider(),
      verifyReferenceNumbers: true,
      claimsStoredPayments: false,
      manualEntryEnabled
    }
  }

  return {
    provider: new DarajaMpesaProvider(options.darajaOptions),
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    manualEntryEnabled
  }
}
