import { useEffect, useState } from 'react'
import type { HeldSaleSummary } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import { formatHeldAge, HELD_AGE_REFRESH_MS, heldAgeTone } from '../lib/heldSale.js'
import type { HeldAgeTone } from '../lib/heldSale.js'
import { HELD_SALE_NOTICE_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useAuthStore } from '../stores/authStore.js'
import { useCartStore } from '../stores/cartStore.js'
import { useHeldSalesStore } from '../stores/heldSalesStore.js'
import type { HeldActionResult } from '../stores/heldSalesStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { CloseIcon } from './icons.js'

interface HeldSalesStripProps {
  /** Opens the Manager PIN gate; calls `onAuthorized` once verified. */
  requestManagerPin: (title: string, onAuthorized: (managerId: number, managerPin: string) => void) => void
}

/** Minimum characters for a discard reason; mirrors `discardHeldSaleSchema`. */
const MIN_REASON_LENGTH = 3

const CARD_TONE: Record<HeldAgeTone, string> = {
  normal: 'border-slate-300 bg-white',
  amber: 'border-amber-400 bg-amber-50',
  red: 'border-rose-500 bg-rose-50'
}

const AGE_TONE: Record<HeldAgeTone, string> = {
  normal: 'text-slate-500',
  amber: 'font-semibold text-amber-800',
  red: 'font-semibold text-rose-700'
}

/** Shows why a held-sale action did not happen. */
function notify(message: string): void {
  useToastStore.getState().show({
    id: 'held-sale-notice',
    tone: 'warning',
    message,
    timeoutMs: HELD_SALE_NOTICE_TOAST_TIMEOUT_MS,
    onDismiss: () => useToastStore.getState().dismiss('held-sale-notice')
  })
}

/** @param {HeldActionResult} result */
function report(result: HeldActionResult): void {
  if (!result.ok) notify(result.error)
}

/**
 * The sales held on this till, always on the sale screen (docs/phase-217): one
 * card each, with its label, total, units and how long it has been held. It has
 * no close or collapse control, so a held sale is never forgotten. A card turns
 * amber after five minutes and red after fifteen.
 *
 * Tap a card to resume it. A held sale is not a sale; nothing here files,
 * queues or moves stock.
 *
 * @param {HeldSalesStripProps} props
 * @returns {JSX.Element | null}
 */
export default function HeldSalesStrip({ requestManagerPin }: HeldSalesStripProps) {
  const sales = useHeldSalesStore((state) => state.sales).filter((sale) => sale.status === 'held')
  const currentStaff = useAuthStore((state) => state.currentStaff)
  const cartCount = useCartStore((state) => state.items.length)
  const keyboardOpen = useKeyboardStore((state) => state.request !== null)

  const [now, setNow] = useState(() => Date.now())
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null)
  const [discarding, setDiscarding] = useState<{ sale: HeldSaleSummary; reason: string } | null>(null)
  const [holdFirst, setHoldFirst] = useState<HeldSaleSummary | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), HELD_AGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  /** A rename is saved when its keyboard closes. */
  useEffect(() => {
    if (keyboardOpen || !renaming) return
    const { id, value } = renaming
    setRenaming(null)
    if (value.trim()) void useHeldSalesStore.getState().rename(id, value).then(report)
  }, [keyboardOpen, renaming])

  const startRename = (sale: HeldSaleSummary): void => {
    setRenaming({ id: sale.id, value: sale.label })
    useKeyboardStore.getState().open({
      value: sale.label,
      onChange: (next) => setRenaming({ id: sale.id, value: next }),
      label: 'Name for this held sale',
      maxLength: 40,
      mode: 'text'
    })
  }

  const startResume = (sale: HeldSaleSummary): void => {
    if (cartCount > 0) {
      setHoldFirst(sale)
      return
    }
    void useHeldSalesStore.getState().resume(sale.id).then(report)
  }

  const holdThenResume = async (sale: HeldSaleSummary): Promise<void> => {
    setHoldFirst(null)
    if (!currentStaff) return
    const held = await useHeldSalesStore.getState().hold(currentStaff.id)
    if (!held.ok) {
      notify(held.error)
      return
    }
    report(await useHeldSalesStore.getState().resume(sale.id))
  }

  const openReasonKeyboard = (): void => {
    useKeyboardStore.getState().open({
      value: discarding?.reason ?? '',
      onChange: (next) => setDiscarding((prev) => (prev ? { ...prev, reason: next } : prev)),
      label: 'Reason for discarding this held sale',
      maxLength: 200,
      mode: 'text',
      docked: true
    })
  }

  const confirmDiscard = (): void => {
    if (!discarding || !currentStaff) return
    const { sale, reason } = discarding
    setDiscarding(null)
    requestManagerPin(`Discard held sale: ${sale.label}`, (managerId, managerPin) => {
      void useHeldSalesStore
        .getState()
        .discard({ id: sale.id, staffId: currentStaff.id, managerId, managerPin, reason: reason.trim() })
        .then(report)
    })
  }

  if (sales.length === 0 && !discarding && !holdFirst) return null

  return (
    <>
      {sales.length > 0 && (
        <div data-testid="held-sales-strip" className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-1">
          <ul className="grid grid-cols-3 gap-2">
            {sales.map((sale) => {
              const tone = heldAgeTone(sale.heldAt, now)
              const label = renaming?.id === sale.id ? renaming.value : sale.label
              return (
                <li
                  key={sale.id}
                  data-testid="held-sale-card"
                  data-tone={tone}
                  className={`flex h-14 min-w-0 overflow-hidden rounded-lg border-2 ${CARD_TONE[tone]}`}
                >
                  <button
                    type="button"
                    onClick={() => startResume(sale)}
                    aria-label={`Resume ${sale.label}`}
                    className="flex min-w-0 flex-1 flex-col justify-center px-2 text-left active:bg-slate-100"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-base font-bold text-slate-900">{label}</span>
                      <span className={`shrink-0 text-sm tabular-nums ${AGE_TONE[tone]}`}>
                        {formatHeldAge(sale.heldAt, now)}
                      </span>
                    </span>
                    <span className="truncate text-sm tabular-nums text-slate-600">
                      {formatCurrency(sale.total)} · {sale.unitCount} {sale.unitCount === 1 ? 'item' : 'items'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => startRename(sale)}
                    aria-label={`Rename ${sale.label}`}
                    className="flex w-10 shrink-0 items-center justify-center border-l border-slate-200 text-lg text-slate-500 hover:bg-slate-100"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscarding({ sale, reason: '' })}
                    aria-label={`Discard ${sale.label}`}
                    className="flex w-10 shrink-0 items-center justify-center border-l border-slate-200 text-rose-600 hover:bg-rose-50"
                  >
                    <CloseIcon className="h-5 w-5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {holdFirst && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-xl font-semibold text-slate-900">Hold the current cart first?</h3>
            <p className="mt-2 text-base text-slate-600">
              The cart on screen is not empty. It can be held, and {holdFirst.label} resumed in its place.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setHoldFirst(null)}
                className="h-12 flex-1 rounded-xl border border-slate-300 text-lg font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void holdThenResume(holdFirst)}
                className="h-12 flex-1 rounded-xl bg-rose-600 text-lg font-semibold text-white"
              >
                Hold it and resume
              </button>
            </div>
          </div>
        </div>
      )}

      {discarding && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-xl font-semibold text-slate-900">
              Discard {discarding.sale.label} ({formatCurrency(discarding.sale.total)})?
            </h3>
            <p className="mt-2 text-base text-amber-800">
              The customer may already have paid. A manager must approve, and the discard is recorded for the
              end-of-day review.
            </p>
            <label className="mb-1 mt-4 block text-base font-medium text-slate-600">Reason</label>
            <input
              readOnly
              value={discarding.reason}
              onClick={openReasonKeyboard}
              aria-label="Reason for discarding this held sale"
              placeholder="e.g. customer left without paying"
              className="h-12 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none"
            />
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setDiscarding(null)}
                className="h-12 flex-1 rounded-xl border border-slate-300 text-lg font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={discarding.reason.trim().length < MIN_REASON_LENGTH}
                onClick={confirmDiscard}
                className="h-12 flex-1 rounded-xl bg-rose-600 text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
