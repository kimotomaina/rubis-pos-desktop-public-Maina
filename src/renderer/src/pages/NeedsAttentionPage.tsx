import { useEffect, useState } from 'react'
import type { NeedsAttentionRow } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import { isValidKraPinFormat, KRA_PIN_MAX_LENGTH } from '../lib/kraPin.js'
import { describeNeedsAttentionStatus, applyResendResult } from '../lib/needsAttention.js'
import { paginate } from '../lib/paginate.js'
import Pager from '../components/Pager.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { useUnfiledCountStore } from '../stores/unfiledCountStore.js'

/** Rows per page (docs/phase-166 Commit E4) — replaces this screen's reliance on the outer Admin wrapper scrolling. */
export const NEEDS_ATTENTION_PAGE_SIZE = 10

/** Tailwind classes for the status pill, keyed by row status. */
const STATUS_BADGE_CLASSES: Record<NeedsAttentionRow['fiscal_status'], string> = {
  waiting: 'bg-amber-100 text-amber-800',
  needs_fixing: 'bg-rose-100 text-rose-800'
}

/**
 * The fiscal back-office "needs attention" list (phase-94, closing the
 * go-live audit's Finding 1) — every `needs_fixing` sale plus every
 * sale stuck `waiting` past the threshold, in plain language, with a
 * Resend action per row. This is the UI half of Rule 3 ("never
 * silently lose an unfiled sale"): the data has always been correctly
 * tracked, but until this page existed nothing showed it to staff.
 *
 * A wrong-PIN row additionally offers "Correct PIN & Resend", reusing
 * the same `correctPinAndResend` path and on-screen keyboard
 * `FiscalNotice.tsx` uses for the identical fix at the point of sale.
 *
 * Paginated at {@link NEEDS_ATTENTION_PAGE_SIZE} (docs/phase-166 Commit
 * E4) — this screen used to rely on the outer Admin wrapper's scroll to
 * show more rows than fit; Phase E's no-scroll rule replaces that with
 * paging instead.
 *
 * @returns {JSX.Element}
 */
export default function NeedsAttentionPage() {
  const [rows, setRows] = useState<NeedsAttentionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<number | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const [correctingId, setCorrectingId] = useState<number | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [page, setPage] = useState(1)

  const fetchRows = async (): Promise<void> => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getSalesNeedingAttention()
      if (result.success && result.data) {
        setRows(result.data)
      } else {
        setError(result.error ?? 'Failed to load sales needing attention')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sales needing attention')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchRows()
  }, [])

  const handleResend = (localId: number): void => {
    setResendError(null)
    setResendingId(localId)
    void (async () => {
      try {
        const result = await window.api.resendFiscalization(localId)
        if (result.success && result.data) {
          setRows((current) => applyResendResult(current, result.data!))
          void useUnfiledCountStore.getState().refresh()
        } else {
          setResendError(result.error ?? `Failed to resend sale #${localId}`)
        }
      } catch (err) {
        setResendError(err instanceof Error ? err.message : `Failed to resend sale #${localId}`)
      } finally {
        setResendingId(null)
      }
    })()
  }

  const handleCorrectAndResend = (localId: number, pin: string): void => {
    setResendError(null)
    setResendingId(localId)
    void (async () => {
      try {
        const result = await window.api.correctPinAndResend(localId, pin)
        if (result.success && result.data) {
          setRows((current) => applyResendResult(current, result.data!))
          void useUnfiledCountStore.getState().refresh()
          setCorrectingId(null)
          setPinInput('')
        } else {
          setResendError(result.error ?? `Failed to resend sale #${localId}`)
        }
      } catch (err) {
        setResendError(err instanceof Error ? err.message : `Failed to resend sale #${localId}`)
      } finally {
        setResendingId(null)
      }
    })()
  }

  const openPinKeyboard = (): void => {
    useKeyboardStore.getState().open({
      value: pinInput,
      onChange: (next) => setPinInput(next.toUpperCase()),
      maxLength: KRA_PIN_MAX_LENGTH,
      label: 'Corrected Customer KRA PIN'
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-rose-600 border-t-transparent" />
      </div>
    )
  }

  const pageResult = paginate(rows, page, NEEDS_ATTENTION_PAGE_SIZE)

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-2xl font-bold text-slate-800">Sales Needing Attention</h3>
        <button
          type="button"
          onClick={() => void fetchRows()}
          className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {resendError && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{resendError}</p>
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-base text-slate-500">No sales need attention.</p>
      ) : (
        <div className="space-y-3">
          {pageResult.items.map((row) => {
            const isCorrecting = correctingId === row.local_id
            const trimmedPin = pinInput.trim().toUpperCase()
            const pinFormatValid = trimmedPin.length > 0 && isValidKraPinFormat(trimmedPin)
            const isBusy = resendingId === row.local_id

            return (
              <div
                key={row.local_id}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-semibold text-slate-800">Order #{row.local_id}</span>
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_BADGE_CLASSES[row.fiscal_status]}`}
                      >
                        {describeNeedsAttentionStatus(row.fiscal_status)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {new Date(row.created_at).toLocaleString()} · {row.staff_name ?? 'Unknown staff'} ·{' '}
                      {formatCurrency(row.total)}
                    </p>
                    <p className="mt-2 text-base text-slate-700">
                      {row.fiscal_error_reason ?? 'Waiting to be sent to the tax device.'}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleResend(row.local_id)}
                      className="h-11 rounded-md bg-rose-600 px-4 text-base font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBusy && !isCorrecting ? 'Resending…' : 'Resend'}
                    </button>
                    {row.fiscal_data_issue === 'wrong-pin' && !isCorrecting && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          setCorrectingId(row.local_id)
                          setPinInput('')
                        }}
                        className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Correct PIN & Resend
                      </button>
                    )}
                  </div>
                </div>

                {isCorrecting && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    <input
                      type="text"
                      value={pinInput}
                      readOnly
                      onClick={openPinKeyboard}
                      placeholder="P051234567Z"
                      aria-label="Corrected customer KRA PIN"
                      className="h-11 rounded-lg border border-slate-300 bg-white px-3 text-lg uppercase text-slate-900 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    <button
                      type="button"
                      disabled={!pinFormatValid || isBusy}
                      onClick={() => handleCorrectAndResend(row.local_id, trimmedPin)}
                      className="h-11 rounded-md bg-rose-600 px-4 text-base font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBusy ? 'Sending…' : 'Save & Resend'}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setCorrectingId(null)
                        setPinInput('')
                      }}
                      className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  )
}
