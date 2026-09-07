import { useEffect, useRef, useState } from 'react'
import { formatCurrency } from '../lib/currency'
import {
  createMpesaPaymentPoller,
  MPESA_POLL_TIMEOUT_MS,
  type MpesaPaymentPoller
} from '../lib/mpesaPaymentPoller'

/** Which M-Pesa flow tab is active. Hidden once an STK Push is in flight or has failed. */
type PaymentTab = 'stk' | 'manual'

/**
 * STK Push sub-flow state — `'form'` is the phone-number entry screen,
 * `'waiting'` is the polling overlay shown after a push is accepted,
 * `'failed'` is the terminal failure/timeout screen with Retry/Cancel.
 */
type StkPhase =
  | { kind: 'form' }
  | { kind: 'waiting'; checkoutRequestId: string; msRemaining: number }
  | { kind: 'failed'; reason: string }

interface PaymentModalProps {
  /** Amount to charge, shown to the cashier and sent to the mock provider. */
  total: number
  /** Called once a payment is confirmed, with the reference number to record on the order. */
  onPaid: (referenceNumber: string) => void
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
        <button
          type="button"
          onClick={() => setTab('manual')}
          className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
            tab === 'manual' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          Manual Code
        </button>
      </div>

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

      {tab === 'manual' && (
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
    </div>
  )
}
