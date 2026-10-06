import { useKeyboardStore } from '../stores/keyboardStore.js'
import { formatCurrency } from '../lib/currency.js'
import { previewOpenFloat } from '../lib/openShiftFloat.js'
import type { EarlierSalesShown } from '../../../main/services/database.js'

interface OpenShiftFormProps {
  /** The window of this moment, as text: `Night shift (17:31 to 08:59)`. It is shown, never chosen (docs/phase-232). */
  windowLabel: string
  /** Set when this window already has a shift: there is nothing to open, and this says why. */
  windowHasShift: string | null
  /** The sales already made in this window with no shift; they join the shift. */
  earlier: EarlierSalesShown
  /** Only an admin may start at 0 when the drawer holds less than the earlier cash sales. */
  isAdmin: boolean
  startAtZero: boolean
  onStartAtZeroChange: (next: boolean) => void
  startingCash: string
  onStartingCashChange: (next: string) => void
  mpesaOpening: string
  onMpesaOpeningChange: (next: string) => void
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Opens the docked on-screen keyboard on a decimal field.
 *
 * @param {string} value
 * @param {(next: string) => void} onChange
 * @param {string} label
 */
function openDecimalField(value: string, onChange: (next: string) => void, label: string): void {
  useKeyboardStore.getState().open({ value, onChange, label, mode: 'decimal' })
}

/**
 * The Open Shift inputs (docs/phase-227, changed in docs/phase-232): the window as text, the cash in the drawer, the
 * optional M-Pesa balance, Confirm and Cancel. One component for the Admin screen and the cart's "No shift open"
 * dialog, so the two can never differ. It holds no state and calls nothing: the owner of the form decides what
 * Confirm does.
 *
 * When earlier sales in this window have no shift it says so, asks for the cash in the drawer now, and shows the
 * starting cash that will be recorded (the drawer less their cash). A drawer below their cash needs a recount, or
 * an admin's tick to start at 0.
 *
 * @param {OpenShiftFormProps} props
 * @returns {JSX.Element}
 */
export default function OpenShiftForm({
  windowLabel,
  windowHasShift,
  earlier,
  isAdmin,
  startAtZero,
  onStartAtZeroChange,
  startingCash,
  onStartingCashChange,
  mpesaOpening,
  onMpesaOpeningChange,
  onConfirm,
  onCancel
}: OpenShiftFormProps) {
  const hasEarlier = earlier.count > 0
  const preview = previewOpenFloat(startingCash, mpesaOpening, earlier)
  const blocked = windowHasShift !== null || (preview.belowZero && !startAtZero) || preview.mpesaBelowZero
  const sales = earlier.count === 1 ? 'earlier sale' : 'earlier sales'

  return (
    <>
      <p className="mb-3 text-base font-medium text-slate-700" data-testid="open-shift-window">
        {windowLabel}
      </p>

      {windowHasShift && (
        <p role="alert" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900">
          {windowHasShift}
        </p>
      )}

      {hasEarlier && !windowHasShift && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="earlier-sales">
          {earlier.count} {sales} in this window (cash {formatCurrency(earlier.cash)}) will join this shift.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div>
          <label className="mb-1 block text-lg font-medium text-slate-600">
            {hasEarlier ? 'Cash in the drawer now' : 'Starting Cash'}
          </label>
          <input
            type="text"
            readOnly
            value={startingCash}
            onClick={() => openDecimalField(startingCash, onStartingCashChange, hasEarlier ? 'Cash in the drawer now' : 'Starting Cash')}
            onFocus={() => openDecimalField(startingCash, onStartingCashChange, hasEarlier ? 'Cash in the drawer now' : 'Starting Cash')}
            className="w-32 h-12 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-lg font-medium text-slate-600">
            {hasEarlier ? 'M-Pesa balance now (optional)' : 'M-Pesa balance (optional)'}
          </label>
          <input
            type="text"
            readOnly
            value={mpesaOpening}
            placeholder="Not recorded"
            onClick={() => openDecimalField(mpesaOpening, onMpesaOpeningChange, 'M-Pesa balance (optional)')}
            onFocus={() => openDecimalField(mpesaOpening, onMpesaOpeningChange, 'M-Pesa balance (optional)')}
            className="w-40 h-12 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
          />
        </div>
        <button
          type="button"
          onClick={onConfirm}
          disabled={blocked}
          className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-4 py-2 text-base text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>

      {hasEarlier && preview.float !== null && !preview.belowZero && (
        <p className="mt-2 text-base font-medium text-slate-700" data-testid="float-line">
          Starting cash will be recorded as {formatCurrency(preview.float)} (drawer {formatCurrency(preview.drawer ?? 0)}{' '}
          less earlier cash sales {formatCurrency(earlier.cash)}).
        </p>
      )}

      {preview.belowZero && (
        <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-base text-rose-700" data-testid="drawer-below">
          <p className="font-medium">
            The drawer ({formatCurrency(preview.drawer ?? 0)}) holds less than the cash sales already made in this window (
            {formatCurrency(earlier.cash)}). Count the drawer again.
          </p>
          {isAdmin && (
            <label className="mt-1 flex items-center gap-2">
              <input type="checkbox" checked={startAtZero} onChange={(event) => onStartAtZeroChange(event.target.checked)} />
              <span>
                Start at 0. The {formatCurrency(preview.shortfall)} missing will show as a shortage when the shift closes.
              </span>
            </label>
          )}
        </div>
      )}

      {hasEarlier && preview.mpesaOpening !== null && earlier.mpesa > 0 && (
        <p className="mt-2 text-base text-slate-700" data-testid="mpesa-line">
          M-Pesa opening balance will be recorded as {formatCurrency(preview.mpesaOpening)} (balance now less earlier
          M-Pesa sales {formatCurrency(earlier.mpesa)}).
        </p>
      )}

      {preview.mpesaBelowZero && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700" data-testid="mpesa-below">
          The M-Pesa balance is less than the M-Pesa sales already made in this window ({formatCurrency(earlier.mpesa)}).
          Read the balance again, or leave it blank.
        </p>
      )}
    </>
  )
}
