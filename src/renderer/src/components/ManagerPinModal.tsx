import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore.js'
import VirtualNumpad from './VirtualNumpad.js'

interface ManagerPinModalProps {
  /** Shown as the modal's heading — describes what's being authorized. */
  title: string
  /**
   * Called once a valid admin PIN has been entered, with the
   * authorizing admin's id and PIN — forwarded on to any
   * privileged IPC call the caller makes next, so the main process can
   * independently re-verify it via `requireAdminPin` rather than
   * trusting this modal alone.
   */
  onAuthorized: (managerId: number, managerPin: string) => void
  /** Called when the cashier cancels the authorization. */
  onCancel: () => void
}

/**
 * PIN-entry gate for manager-only actions (manual price overrides,
 * discounts over the 10% threshold in `checkoutMath.ts`, and order
 * voids).
 *
 * Verifies the PIN via `window.api.login` directly rather than
 * `useAuthStore`'s `login` action, so authorizing a manager override
 * never swaps out the cashier currently signed in for the shift — this
 * is a one-off authorization check, not a session change.
 *
 * @param {ManagerPinModalProps} props
 * @returns {JSX.Element}
 */
export default function ManagerPinModal({ title, onAuthorized, onCancel }: ManagerPinModalProps) {
  const staffList = useAuthStore((state) => state.staffList)
  const fetchStaffList = useAuthStore((state) => state.fetchStaffList)

  const admins = staffList.filter((staff) => staff.role === 'admin')

  const [selectedAdminId, setSelectedAdminId] = useState<number | ''>(admins[0]?.id ?? '')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => {
    if (staffList.length === 0) void fetchStaffList()
  }, [staffList.length, fetchStaffList])

  useEffect(() => {
    if (selectedAdminId === '' && admins[0]) setSelectedAdminId(admins[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admins.length])

  const handleSubmit = async () => {
    if (!selectedAdminId || !pin.trim()) {
      setError('Select a manager and enter their PIN')
      return
    }
    setVerifying(true)
    setError(null)
    const trimmedPin = pin.trim()
    try {
      const result = await window.api.login(selectedAdminId, trimmedPin)
      if (result.success) {
        onAuthorized(selectedAdminId, trimmedPin)
        return
      }
      setError(result.error ?? 'Incorrect PIN')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PIN verification failed')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-2xl font-semibold text-slate-900">Manager PIN Required</h3>
        <p className="mb-4 text-lg text-slate-500">{title}</p>

        {admins.length === 0 ? (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-lg font-medium text-rose-700">
            No admin accounts available to authorize this action.
          </p>
        ) : (
          <>
            <label className="mb-1 block text-base font-medium text-slate-600">Manager</label>
            <select
              value={selectedAdminId}
              onChange={(e) => setSelectedAdminId(Number(e.target.value))}
              className="mb-3 h-12 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            >
              {admins.map((admin) => (
                <option key={admin.id} value={admin.id}>
                  {admin.name}
                </option>
              ))}
            </select>

            <label className="mb-1 block text-base font-medium text-slate-600">PIN</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit()
              }}
              className="mb-3 h-14 w-full rounded-lg border border-slate-300 px-3 text-2xl tracking-widest focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              autoFocus
            />

            <div className="mb-3">
              <VirtualNumpad value={pin} onChange={setPin} allowDecimal={false} />
            </div>

            {error && (
              <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-lg font-medium text-rose-700">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="h-14 flex-1 rounded-lg border border-slate-300 text-lg font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={verifying}
                onClick={() => void handleSubmit()}
                className="h-14 flex-1 rounded-lg bg-rose-600 text-lg font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {verifying ? 'Verifying…' : 'Authorize'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
