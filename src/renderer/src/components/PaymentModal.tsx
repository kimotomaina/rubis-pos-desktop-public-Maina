import { useState } from 'react'
import { formatCurrency } from '../lib/currency'

/** Which M-Pesa flow tab is active. */
type PaymentTab = 'stk' | 'manual'

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

/**
 * M-Pesa payment collection UI (Phase 10), wired to the Phase 9 IPC
 * placeholders (`initiateMpesaStkPush` / `verifyMpesaCode`).
 *
 * Two tabs mirror the hybrid flow from docs/phase-9.md §3.1:
 *   - **STK Push**: phone number → push prompt → simulated wait for the
 *     customer to approve on their phone.
 *   - **Manual Code**: the cashier reads the 6-character confirmation
 *     code off the customer's SMS and it's verified directly — the
 *     offline-capable path.
 *
 * A verification failure (including the mock's ~10% random failure —
 * see docs/phase-10.md Q3) shows a red inline error and leaves both
 * tabs available so the cashier can retry or back out to Cash.
 *
 * @param {PaymentModalProps} props
 * @returns {JSX.Element}
 */
export default function PaymentModal({ total, onPaid, onCancel }: PaymentModalProps) {
  const [tab, setTab] = useState<PaymentTab>('stk')

  const [phoneNumber, setPhoneNumber] = useState('')
  const [stkLoading, setStkLoading] = useState(false)
  const [stkError, setStkError] = useState<string | null>(null)

  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const handleSendStkPush = async () => {
    setStkError(null)
    if (!PHONE_PATTERN.test(phoneNumber)) {
      setStkError('Enter a valid phone number, e.g. 254712345678')
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
        onPaid(result.data.checkoutRequestId)
        return
      }
      setStkError(result.error ?? 'STK Push request failed')
    } catch (err) {
      setStkError(err instanceof Error ? err.message : 'STK Push request failed')
    } finally {
      setStkLoading(false)
    }
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

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-3 text-sm text-slate-500 hover:text-slate-700"
      >
        ← Change payment method
      </button>

      <div className="mb-4 flex rounded-lg bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => setTab('stk')}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
            tab === 'stk' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          STK Push
        </button>
        <button
          type="button"
          onClick={() => setTab('manual')}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
            tab === 'manual' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          Manual Code
        </button>
      </div>

      <p className="mb-4 text-sm text-slate-500">
        Charging <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
      </p>

      {tab === 'stk' && (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600">Phone Number</label>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="254712345678"
            disabled={stkLoading}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-lg focus:border-rose-400 focus:outline-none disabled:bg-slate-50"
          />

          {stkError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {stkError}
            </p>
          )}

          <button
            type="button"
            disabled={stkLoading}
            onClick={() => void handleSendStkPush()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stkLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Waiting for customer to approve…
              </span>
            ) : (
              'Send Request'
            )}
          </button>
        </div>
      )}

      {tab === 'manual' && (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-600">
            M-Pesa Transaction Code
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. QDF73H"
            maxLength={12}
            disabled={verifying}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-lg uppercase tracking-wide focus:border-rose-400 focus:outline-none disabled:bg-slate-50"
          />

          {verifyError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {verifyError}
            </p>
          )}

          <button
            type="button"
            disabled={verifying}
            onClick={() => void handleVerifyCode()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'Verify & Pay'}
          </button>
        </div>
      )}
    </div>
  )
}
