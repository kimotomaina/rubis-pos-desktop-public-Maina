import { useState } from 'react'
import { MPESA_BALANCE_INVALID, parseOptionalBalance } from '../lib/optionalBalance.js'
import { useShiftWindowStatus } from '../lib/useShiftWindowStatus.js'
import { OPEN_SHIFT_FIGURE_DEFAULT, OPEN_SHIFT_MPESA_DEFAULT } from '../lib/openShiftFloat.js'
import OpenShiftForm from './OpenShiftForm.js'

interface OpenShiftDialogProps {
  /** The signed-in staff member, who opens the shift as themselves (docs/phase-254). */
  staff: { id: number; role: string }
  onClose: () => void
  /** Called once the shift is open. */
  onOpened: () => void
}

/**
 * The cart's Open Shift dialog (docs/phase-227, changed in docs/phase-232 and docs/phase-254): the same inputs as the
 * Admin screen's ({@link OpenShiftForm}). The shift's type is the window's, shown and never chosen. Sales already made
 * in this window with no shift join the shift when it opens, and the form says so. Whoever is signed in, cashier or
 * admin, opens the shift as themselves with no PIN; the main process records it under its own session's staff member.
 * Only an admin is offered starting at 0.
 *
 * @param {OpenShiftDialogProps} props
 * @returns {JSX.Element}
 */
export default function OpenShiftDialog({ staff, onClose, onOpened }: OpenShiftDialogProps) {
  const isAdmin = staff.role === 'admin'
  const { status } = useShiftWindowStatus()
  const [startingCash, setStartingCash] = useState(OPEN_SHIFT_FIGURE_DEFAULT)
  const [mpesaOpening, setMpesaOpening] = useState(OPEN_SHIFT_MPESA_DEFAULT)
  const [startAtZero, setStartAtZero] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const earlier = status?.earlier ?? { count: 0, cash: 0, mpesa: 0 }

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
    const options = { earlierShown: earlier, startAtZero: startAtZero || undefined }
    const finish = (result: { success: boolean; error?: string }): void => {
      if (result.success) onOpened()
      else setError(result.error ?? 'Failed to open shift')
    }
    void window.api
      .openShift(staff.id, cash, mpesa === null ? undefined : mpesa, options)
      .then(finish)
      .catch(() => setError('Failed to open shift'))
  }

  return (
    <div
      role="dialog"
      aria-label="Open shift"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">Open a shift</h3>

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {error}
          </p>
        )}

        <OpenShiftForm
          windowLabel={status?.window.label ?? ''}
          windowHasShift={status?.windowShift ? status.windowShiftMessage : null}
          earlier={earlier}
          isAdmin={isAdmin}
          startAtZero={startAtZero}
          onStartAtZeroChange={setStartAtZero}
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
