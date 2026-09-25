import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import rubisLogo from '../assets/logo-rubis.png'

/** Digit keys rendered on the PIN pad, in phone-keypad order. */
const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

/** Maximum PIN length accepted by the pad. */
const MAX_PIN_LENGTH = 6

/**
 * Full-screen authentication gate.
 *
 * Shows a tile for every active staff member; tapping one reveals a
 * numeric PIN pad. A successful `authStore.login` call sets
 * `currentStaff`, which `App.tsx` uses to swap this screen out for
 * the POS shell.
 *
 * @returns {JSX.Element}
 */
export default function LoginScreen() {
  const staffList = useAuthStore((state) => state.staffList)
  const fetchStaffList = useAuthStore((state) => state.fetchStaffList)
  const login = useAuthStore((state) => state.login)
  const loginError = useAuthStore((state) => state.loginError)
  const loggingIn = useAuthStore((state) => state.loggingIn)

  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null)
  const [pin, setPin] = useState('')

  useEffect(() => {
    void fetchStaffList()
  }, [fetchStaffList])

  const selectedStaff = staffList.find((s) => s.id === selectedStaffId) ?? null

  const handleKeyPress = (key: string) => {
    if (key === '') return
    if (key === '⌫') {
      setPin((prev) => prev.slice(0, -1))
      return
    }
    setPin((prev) => (prev.length < MAX_PIN_LENGTH ? prev + key : prev))
  }

  const handleSubmit = async () => {
    if (!selectedStaffId || pin.length === 0) return
    const success = await login(selectedStaffId, pin)
    if (!success) {
      setPin('')
    }
  }

  const handleBack = () => {
    setSelectedStaffId(null)
    setPin('')
  }

  useEffect(() => {
    if (!selectedStaff) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleBack()
        return
      }
      if (event.key === 'Enter') {
        void handleSubmit()
        return
      }
      if (event.key === 'Backspace') {
        handleKeyPress('⌫')
        return
      }
      if (/^[0-9]$/.test(event.key)) {
        handleKeyPress(event.key)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedStaff, pin, loggingIn])

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-slate-900 text-white">
      <img src={rubisLogo} alt="Enjoy" className="mb-8 h-16 w-auto" />

      {!selectedStaff ? (
        <div className="w-full max-w-md">
          <h2 className="mb-4 text-center text-xl font-medium text-slate-300">
            Who&apos;s working?
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {staffList.map((staff) => (
              <button
                key={staff.id}
                type="button"
                onClick={() => setSelectedStaffId(staff.id)}
                className="rounded-xl bg-slate-800 px-4 py-6 text-center text-xl font-semibold text-white transition active:scale-95 hover:bg-slate-700"
              >
                {staff.name}
              </button>
            ))}
          </div>
          {staffList.length === 0 && (
            <p className="text-center text-base text-slate-500">
              Loading staff…
            </p>
          )}
        </div>
      ) : (
        <div className="w-full max-w-xs">
          <button
            type="button"
            onClick={handleBack}
            className="mb-4 text-base text-slate-400 hover:text-slate-200"
          >
            ← Back
          </button>
          <h2 className="mb-4 text-center text-xl font-medium text-slate-300">
            {selectedStaff.name}
          </h2>

          <div className="mb-4 flex justify-center gap-2" aria-label="PIN entry">
            {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
              <span
                key={i}
                className={`h-3 w-3 rounded-full ${
                  i < pin.length ? 'bg-rose-500' : 'bg-slate-700'
                }`}
              />
            ))}
          </div>

          {loginError && (
            <p className="mb-4 text-center text-lg font-medium text-rose-400">
              {loginError}
            </p>
          )}

          <div className="grid grid-cols-3 justify-items-center gap-3">
            {PIN_KEYS.map((key, i) => (
              <button
                key={`${key}-${i}`}
                type="button"
                disabled={key === ''}
                onClick={() => handleKeyPress(key)}
                className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl font-semibold transition active:scale-95 ${
                  key === ''
                    ? 'invisible'
                    : 'bg-slate-800 text-white hover:bg-slate-700'
                }`}
              >
                {key}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={pin.length === 0 || loggingIn}
            onClick={() => void handleSubmit()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-xl font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loggingIn ? 'Verifying…' : 'Enter'}
          </button>
        </div>
      )}
    </div>
  )
}
