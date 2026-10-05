import { useEffect, useState } from 'react'
import { MPESA_BALANCE_INVALID, parseOptionalBalance } from '../lib/optionalBalance.js'
import { shiftTypeForTime, type ShiftType } from '../lib/shiftWindows.js'
import OpenShiftForm from './OpenShiftForm.js'

interface OpenShiftDialogProps {
  /** The signed-in staff member. An admin opens the shift as themselves; anyone else needs a manager's PIN. */
  staff: { id: number; role: string }
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
  onClose: () => void
  /** Called once the shift is open. */
  onOpened: () => void
  /** For an admin only: opens Shift History on the sales with no shift. */
  onRecordThem: () => void
}

/**
 * The cart's Open Shift dialog (docs/phase-227): the same inputs as the Admin screen's ({@link OpenShiftForm}), a
 * shift pick that starts from the time now, and a line about sales that have no shift. An admin opens the shift as
 * themselves. Anyone else is asked for a manager's PIN, checked again in the main process, and the shift is recorded
 * under that manager, because a shift is always opened by an admin.
 *
 * @param {OpenShiftDialogProps} props
 * @returns {JSX.Element}
 */
export default function OpenShiftDialog({ staff, requestManagerPin, onClose, onOpened, onRecordThem }: OpenShiftDialogProps) {
  const isAdmin = staff.role === 'admin'
  const [shiftType, setShiftType] = useState<ShiftType>(() => shiftTypeForTime(new Date().toISOString()))
  const [startingCash, setStartingCash] = useState('')
  const [mpesaOpening, setMpesaOpening] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [noShiftSales, setNoShiftSales] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.getUnattachedDays?.()
        if (!cancelled) {
          setNoShiftSales(result?.success && result.data ? result.data.reduce((sum, day) => sum + day.count, 0) : 0)
        }
      } catch {
        // The line is a courtesy: no count, no line.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleConfirm = (): void => {
    setError(null)
    const cash = parseFloat(startingCash)
    if (!Number.isFinite(cash) || cash < 0) {
      setError('Enter a valid starting cash amount')
      return
    }
    const mpesa = parseOptionalBalance(mpesaOpening)
    if (mpesa === 'invalid') {
      setError(MPESA_BALANCE_INVALID)
      return
    }
    const finish = (result: { success: boolean; error?: string }): void => {
      if (result.success) onOpened()
      else setError(result.error ?? 'Failed to open shift')
    }
    if (isAdmin) {
      void window.api
        .openShift(staff.id, cash, shiftType, ...(mpesa === null ? [] : [mpesa]))
        .then(finish)
        .catch(() => setError('Failed to open shift'))
      return
    }
    requestManagerPin('Open a shift', (managerId, managerPin) => {
      void window.api
        .openShiftAsManager(managerId, managerPin, cash, shiftType, mpesa === null ? undefined : mpesa)
        .then(finish)
        .catch(() => setError('Failed to open shift'))
    })
  }

  return (
    <div
      role="dialog"
      aria-label="Open shift"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">Open a shift</h3>

        {!isAdmin && (
          <p className="mb-3 text-base text-slate-600">A manager&apos;s PIN is asked for when you confirm.</p>
        )}

        {noShiftSales > 0 && (
          <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2" data-testid="dialog-no-shift-sales">
            <p className="text-base font-medium text-amber-900">
              {noShiftSales} {noShiftSales === 1 ? 'sale has' : 'sales have'} no shift.
            </p>
            {isAdmin ? (
              <button
                type="button"
                onClick={onRecordThem}
                className="mt-2 h-10 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700"
              >
                Record them
              </button>
            ) : (
              <p className="text-base text-amber-900">A manager can record these in Shift History.</p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {error}
          </p>
        )}

        <OpenShiftForm
          shiftType={shiftType}
          onShiftTypeChange={setShiftType}
          startingCash={startingCash}
          onStartingCashChange={setStartingCash}
          mpesaOpening={mpesaOpening}
          onMpesaOpeningChange={setMpesaOpening}
          onConfirm={handleConfirm}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}
