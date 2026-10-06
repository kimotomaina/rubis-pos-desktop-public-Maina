import { useState } from 'react'
import { MPESA_BALANCE_INVALID, parseOptionalBalance } from '../lib/optionalBalance.js'
import { useShiftWindowStatus } from '../lib/useShiftWindowStatus.js'
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
}

/**
 * The cart's Open Shift dialog (docs/phase-227, changed in docs/phase-232): the same inputs as the Admin screen's
 * ({@link OpenShiftForm}). The shift's type is the window's, shown and never chosen. Sales already made in this
 * window with no shift join the shift when it opens, and the form says so. An admin opens the shift as themselves.
 * Anyone else is asked for a manager's PIN, checked again in the main process, and the shift is recorded under that
 * manager, because a shift is always opened by an admin.
 *
 * @param {OpenShiftDialogProps} props
 * @returns {JSX.Element}
 */
export default function OpenShiftDialog({ staff, requestManagerPin, onClose, onOpened }: OpenShiftDialogProps) {
  const isAdmin = staff.role === 'admin'
  const { status } = useShiftWindowStatus()
  const [startingCash, setStartingCash] = useState('')
  const [mpesaOpening, setMpesaOpening] = useState('')
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
    if (isAdmin) {
      void window.api
        .openShift(staff.id, cash, mpesa === null ? undefined : mpesa, options)
        .then(finish)
        .catch(() => setError('Failed to open shift'))
      return
    }
    requestManagerPin('Open a shift', (managerId, managerPin) => {
      void window.api
        .openShiftAsManager(managerId, managerPin, cash, mpesa === null ? undefined : mpesa, options)
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
