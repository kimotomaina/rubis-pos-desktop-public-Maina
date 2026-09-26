import { useEffect, useRef, useState } from 'react'
import { formatCurrency } from '../lib/currency.js'
import ManagerPinModal from './ManagerPinModal.js'
import {
  createMpesaPaymentPoller,
  MPESA_POLL_TIMEOUT_MS,
  type MpesaPaymentPoller
} from '../lib/mpesaPaymentPoller.js'

/** Which M-Pesa flow tab is active. Hidden once an STK Push is in flight or has failed. */
type PaymentTab = 'stk' | 'manual' | 'unverified'

/** The shape of a Safaricom confirmation code, mirrored from `checkout.ts`. */
export const MANUAL_CODE_PATTERN = /^[A-Z0-9]{10}$/

/**
 * STK Push sub-flow state — `'form'` is the phone-number entry screen,
 * `'waiting'` is the polling overlay shown after a push is accepted,
 * `'failed'` is the terminal failure/timeout screen with Retry/Cancel.
 */
type StkPhase =
  | { kind: 'form' }
  | { kind: 'waiting'; checkoutRequestId: string; msRemaining: number }
  | { kind: 'failed'; reason: string }

/**
 * A manually entered code plus the manager authorizing the sale on it.
 *
 * Passed straight through to `orders:checkout`, where the PIN is
 * re-verified in the main process. Nothing decided here is trusted.
 */
export interface ManualMpesaEntryInput {
  code: string
  managerId: number
  managerPin: string
  confirmUnverified: true
}

interface PaymentModalProps {
  /** Amount to charge, shown to the cashier and sent to the mock provider. */
  total: number
  /**
   * Called once a payment is confirmed, with the reference number to
   * record on the order.
   *
   * `manual` is present only on the unverified route, and its presence
   * is what tells the caller this sale was **not** confirmed by anyone.
   */
  onPaid: (referenceNumber: string, manual?: ManualMpesaEntryInput) => void
  /** Called when the cashier backs out to pick a different payment method. */
  onCancel: () => void
}

/** `2547XXXXXXXX` — Safaricom MSISDN format expected by the mock Daraja provider. */
const PHONE_PATTERN = /^254\d{9}$/

/** Kenyan country code, fixed in the UI so the cashier only ever types the subscriber number. */
const COUNTRY_CODE = '254'

/**
 * Strips non-digits and, since cashiers commonly read a number off a
 * customer's phone as `0712345678`, a single leading `0` — so typing
 * either `712345678` or `0712345678` after the fixed `254` prefix
 * yields the same subscriber number.
 */
function stripLeadingZero(rawInput: string): string {
  const digits = rawInput.replace(/\D/g, '')
  return digits.startsWith('0') ? digits.slice(1) : digits
}

/**
 * M-Pesa payment collection UI, wired to the mock Daraja IPC
 * placeholders (`initiateMpesaStkPush` / `verifyMpesaCode` /
 * `queryMpesaStatus`). Every STK Push attempt — accepted or rejected
 * — is also logged via `logMpesaTransaction` for the M-Pesa Logs
 * screen.
 *
 * Two tabs mirror the hybrid flow:
 *   - **STK Push**: phone number (entered after a fixed `254` prefix —
 *     a leading `0`, as in `0712345678`, is stripped automatically) →
 *     push prompt → a "Waiting for M-Pesa Confirmation" overlay that
 *     polls `queryMpesaStatus` every 5s
 *     (see `mpesaPaymentPoller.ts`) for up to 90s, only calling
 *     `onPaid` once Daraja actually confirms the payment — this
 *     component never checks out on push-*acceptance* alone.
 *   - **Manual Code**: the cashier reads the 6-character confirmation
 *     code off the customer's SMS and it's verified directly — the
 *     offline-capable path, unaffected by the STK polling above.
 *
 * The M-Pesa amount always equals the cart `total` passed in as a
 * prop — there is no editable amount field for the cashier to
 * mistype, so "amount must exactly match the cart total" holds by
 * construction. A blocking notice replaces the whole UI when `total`
 * is not positive, since there is nothing to charge for an empty cart.
 *
 * @param {PaymentModalProps} props
 * @returns {JSX.Element}
 */
export default function PaymentModal({ total, onPaid, onCancel }: PaymentModalProps) {
  const [tab, setTab] = useState<PaymentTab>('stk')

  /** Raw digits typed after the fixed `254` prefix — may still include a leading `0`. */
  const [localPhoneInput, setLocalPhoneInput] = useState('')
  const phoneNumber = `${COUNTRY_CODE}${stripLeadingZero(localPhoneInput)}`
  const [stkLoading, setStkLoading] = useState(false)
  const [stkError, setStkError] = useState<string | null>(null)
  const [stkPhase, setStkPhase] = useState<StkPhase>({ kind: 'form' })

  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  /**
   * Whether this till can actually confirm a typed transaction code.
   *
   * Starts `false` and is only switched on once the main process says
   * so. A Daraja till cannot check a code against Safaricom, so its
   * Manual Code tab could only ever dead-end on an error — and a route
   * that looks like a way to complete a sale but is not is exactly what
   * sends a cashier hunting for a way around the payment gate. Failing
   * closed also means a lost reply hides the tab rather than offering
   * one that does not work.
   */
  const [manualCodeSupported, setManualCodeSupported] = useState(false)

  /**
   * Whether an administrator has allowed this till to complete a sale on
   * a code nobody confirmed. Fails closed for the same reason as
   * {@link manualCodeSupported}: a lost reply hides the route.
   */
  const [manualEntryEnabled, setManualEntryEnabled] = useState(false)

  const [unverifiedCode, setUnverifiedCode] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [unverifiedError, setUnverifiedError] = useState<string | null>(null)
  const [collectingManagerPin, setCollectingManagerPin] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .getMpesaCapabilities()
      .then((result) => {
        if (!cancelled && result.success && result.data) {
          setManualCodeSupported(result.data.manualCodeSupported)
          setManualEntryEnabled(result.data.manualEntryEnabled)
        }
      })
      .catch(() => {
        // Fail closed: leave the tab hidden.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const pollerRef = useRef<MpesaPaymentPoller | null>(null)

  /** Stops and discards any in-flight poller. Idempotent. */
  const stopPolling = () => {
    pollerRef.current?.stop()
    pollerRef.current = null
  }

  useEffect(() => stopPolling, [])

  /**
   * Records a rejected/erroring STK Push attempt for the M-Pesa Logs
   * screen. Daraja never issues a `CheckoutRequestID` for a request it
   * didn't accept, so a client-generated placeholder id is used —
   * there is nothing to later "Check Status" on, only an audit trail
   * of the attempt. Best-effort: a logging failure must not block the
   * cashier from retrying the payment.
   */
  const logFailedStkPushAttempt = async () => {
    try {
      await window.api.logMpesaTransaction({
        checkoutRequestId: `failed-${Date.now()}`,
        merchantRequestId: '',
        phoneNumber,
        amount: total,
        status: 'failed'
      })
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  /**
   * Starts polling `checkoutRequestId` for a definitive outcome.
   * `onPaid` fires only from the poller's `onSuccess` callback — a
   * mere STK Push *acceptance* is never treated as a completed sale.
   */
  const startPolling = (checkoutRequestId: string) => {
    stopPolling()
    setStkPhase({ kind: 'waiting', checkoutRequestId, msRemaining: MPESA_POLL_TIMEOUT_MS })
    const poller = createMpesaPaymentPoller({
      checkoutRequestId,
      queryStatus: (id) => window.api.queryMpesaStatus(id),
      callbacks: {
        onPending: (msRemaining) => {
          setStkPhase((prev) => (prev.kind === 'waiting' ? { ...prev, msRemaining } : prev))
        },
        onSuccess: (receiptNumber) => {
          pollerRef.current = null
          onPaid(receiptNumber ?? checkoutRequestId)
        },
        onFailed: (reason) => {
          pollerRef.current = null
          setStkPhase({ kind: 'failed', reason })
        },
        onTimeout: () => {
          pollerRef.current = null
          setStkPhase({
            kind: 'failed',
            reason: 'Payment timed out — the customer did not respond in time.'
          })
        }
      }
    })
    pollerRef.current = poller
    poller.start()
  }

  const handleSendStkPush = async () => {
    setStkError(null)
    if (!PHONE_PATTERN.test(phoneNumber)) {
      setStkError('Enter a valid phone number, e.g. 712345678')
      return
    }
    setStkLoading(true)
    try {
      const result = await window.api.initiateMpesaStkPush({
        phoneNumber,
        amount: total,
        accountReference: `RUBIS-${Date.now()}`,
        transactionDesc: 'RUBIS POS sale'
      })
      if (result.success && result.data) {
        await window.api.logMpesaTransaction({
          checkoutRequestId: result.data.checkoutRequestId,
          merchantRequestId: result.data.merchantRequestId,
          phoneNumber,
          amount: total,
          status: 'pending'
        })
        startPolling(result.data.checkoutRequestId)
        return
      }
      setStkError(result.error ?? 'STK Push request failed')
      await logFailedStkPushAttempt()
    } catch (err) {
      setStkError(err instanceof Error ? err.message : 'STK Push request failed')
      await logFailedStkPushAttempt()
    } finally {
      setStkLoading(false)
    }
  }

  /**
   * Validates the typed code and the acknowledgement, then asks for a
   * manager's PIN.
   *
   * Both checks are repeated in the main process. These exist to tell
   * the cashier what is wrong before a manager is called over, not to
   * decide anything.
   */
  const handleUnverifiedContinue = () => {
    setUnverifiedError(null)
    if (!MANUAL_CODE_PATTERN.test(unverifiedCode)) {
      setUnverifiedError(
        'Enter the 10-character M-Pesa code from the customer’s message.'
      )
      return
    }
    if (!acknowledged) {
      setUnverifiedError('Tick the box to confirm this payment has not been verified.')
      return
    }
    setCollectingManagerPin(true)
  }

  /**
   * Hands the code and the manager's credentials up to the caller, which
   * sends them to `orders:checkout`. The PIN is re-verified there — this
   * modal's own check is a courtesy, never the gate.
   */
  const handleUnverifiedAuthorized = (managerId: number, managerPin: string) => {
    setCollectingManagerPin(false)
    onPaid(unverifiedCode, {
      code: unverifiedCode,
      managerId,
      managerPin,
      confirmUnverified: true
    })
  }

  /** Cashier cancels while waiting for confirmation — stops polling and returns to the cart. */
  const handleCancelWaiting = () => {
    stopPolling()
    onCancel()
  }

  /** Cashier retries after a failed/timed-out push — back to the phone-number form. */
  const handleRetry = () => {
    stopPolling()
    setStkError(null)
    setStkPhase({ kind: 'form' })
  }

  const handleVerifyCode = async () => {
    setVerifyError(null)
    if (!code.trim()) {
      setVerifyError('Enter the M-Pesa transaction code')
      return
    }
    setVerifying(true)
    try {
      const result = await window.api.verifyMpesaCode({
        transactionCode: code.trim(),
        amount: total
      })
      if (result.success && result.data?.verified) {
        onPaid(result.data.transactionCode)
        return
      }
      setVerifyError(
        result.success ? (result.data?.reason ?? 'Invalid M-Pesa Code') : (result.error ?? 'Invalid M-Pesa Code')
      )
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Invalid M-Pesa Code')
    } finally {
      setVerifying(false)
    }
  }

  if (total <= 0) {
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-base font-medium text-rose-700">
          Cart is empty. Please add items before paying.
        </p>
      </div>
    )
  }

  if (stkPhase.kind === 'waiting') {
    const secondsRemaining = Math.max(0, Math.ceil(stkPhase.msRemaining / 1000))
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-rose-600 border-t-transparent" />
        <h4 className="mb-1 text-xl font-semibold text-slate-900">
          Waiting for M-Pesa Confirmation
        </h4>
        <p className="mb-4 text-base text-slate-500">
          A prompt was sent to <span className="font-semibold text-slate-800">{phoneNumber}</span>{' '}
          for <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>. Ask the
          customer to enter their M-Pesa PIN to approve.
        </p>
        <p className="mb-6 text-3xl font-bold tabular-nums text-rose-600">{secondsRemaining}s</p>
        <button
          type="button"
          onClick={handleCancelWaiting}
          className="w-full rounded-xl border border-slate-300 py-3 text-lg font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel Payment
        </button>
      </div>
    )
  }

  if (stkPhase.kind === 'failed') {
    return (
      <div className="text-center">
        <h4 className="mb-2 text-xl font-semibold text-slate-900">Payment Not Completed</h4>
        <p className="mb-6 rounded-lg bg-rose-50 px-4 py-3 text-base font-medium text-rose-700">
          {stkPhase.reason}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-300 py-3 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRetry}
            className="flex-1 rounded-xl bg-rose-600 py-3 text-lg font-semibold text-white hover:bg-rose-700"
          >
            Retry Payment
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-3 text-base text-slate-500 hover:text-slate-700"
      >
        ← Change payment method
      </button>

      {(manualCodeSupported || manualEntryEnabled) && (
        <div className="mb-4 flex rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setTab('stk')}
            className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
              tab === 'stk' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            STK Push
          </button>
          {manualCodeSupported && (
            <button
              type="button"
              onClick={() => setTab('manual')}
              className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
                tab === 'manual' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              Manual Code
            </button>
          )}
          {/*
            Styled apart from the confirming routes on purpose. This tab
            completes a sale nobody has checked, and a cashier should never
            reach it by accident or mistake it for the verified one beside
            it. The amber carries through to the panel and the button.
          */}
          {manualEntryEnabled && (
            <button
              type="button"
              onClick={() => setTab('unverified')}
              className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
                tab === 'unverified' ? 'bg-amber-100 text-amber-900 shadow-sm' : 'text-amber-700'
              }`}
            >
              Unverified
            </button>
          )}
        </div>
      )}

      <p className="mb-4 text-base text-slate-500">
        Charging <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
      </p>

      {tab === 'stk' && (
        <div>
          <label className="mb-1 block text-base font-medium text-slate-600">Phone Number</label>
          <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-300 focus-within:border-rose-400 focus-within:outline-none focus-within:ring-4 focus-within:ring-rose-100">
            <span className="flex items-center bg-slate-100 px-3 text-xl font-medium text-slate-500">
              +{COUNTRY_CODE}
            </span>
            <input
              type="tel"
              value={localPhoneInput}
              onChange={(e) => setLocalPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="712345678 or 0712345678"
              disabled={stkLoading}
              className="w-full border-0 px-3 py-3 text-xl focus:outline-none disabled:bg-slate-50"
            />
          </div>

          <label className="mb-1 mt-3 block text-base font-medium text-slate-600">Amount</label>
          <input
            type="text"
            value={formatCurrency(total)}
            readOnly
            disabled
            aria-label="Amount (fixed to the cart total)"
            className="w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-50 px-3 py-3 text-xl text-slate-700"
          />

          {stkError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {stkError}
            </p>
          )}

          <button
            type="button"
            disabled={stkLoading}
            onClick={() => void handleSendStkPush()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-xl font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stkLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Sending request…
              </span>
            ) : (
              'Send Request'
            )}
          </button>
        </div>
      )}

      {tab === 'manual' && manualCodeSupported && (
        <div>
          <label className="mb-1 block text-base font-medium text-slate-600">
            M-Pesa Transaction Code
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. QDF73H"
            maxLength={12}
            disabled={verifying}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-xl uppercase tracking-wide focus:border-rose-400 focus:outline-none disabled:bg-slate-50"
          />

          {verifyError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {verifyError}
            </p>
          )}

          <button
            type="button"
            disabled={verifying}
            onClick={() => void handleVerifyCode()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-xl font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'Verify & Pay'}
          </button>
        </div>
      )}

      {tab === 'unverified' && manualEntryEnabled && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50/60 p-3">
          <p className="text-lg font-semibold text-amber-900">
            This records a payment nobody has confirmed.
          </p>
          <p className="mt-1 text-base text-amber-900/80">
            Use this only when the customer has paid but the confirmation has not reached this
            till. The sale will complete and be listed for a manager to check against the M-Pesa
            statement later.
          </p>

          <label className="mb-1 mt-3 block text-base font-medium text-slate-700">
            M-Pesa code from the customer&rsquo;s message
          </label>
          <input
            type="text"
            value={unverifiedCode}
            onChange={(e) =>
              setUnverifiedCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
            }
            placeholder="e.g. QDF73HK9LM"
            maxLength={10}
            className="w-full rounded-lg border border-amber-400 bg-white px-3 py-3 text-xl uppercase tracking-wide focus:border-amber-500 focus:outline-none"
          />

          <label className="mt-3 flex items-start gap-2 text-base text-amber-900">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1 h-5 w-5"
            />
            I confirm this payment has not been verified, and this sale will be recorded as
            unverified.
          </label>

          {unverifiedError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {unverifiedError}
            </p>
          )}

          <button
            type="button"
            onClick={handleUnverifiedContinue}
            className="mt-4 w-full rounded-xl border-2 border-amber-600 bg-white py-4 text-xl font-semibold text-amber-900 transition active:scale-95"
          >
            Continue &mdash; needs a manager&rsquo;s PIN
          </button>

          {collectingManagerPin && (
            <ManagerPinModal
              title={`Authorize an UNVERIFIED M-Pesa payment of ${formatCurrency(total)}`}
              onAuthorized={handleUnverifiedAuthorized}
              onCancel={() => setCollectingManagerPin(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
