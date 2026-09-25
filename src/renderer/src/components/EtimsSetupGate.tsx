import { useState } from 'react'
import { WarningIcon } from './icons.js'
import {
  validateEtimsConnection,
  DEFAULT_ETIMS_BASE_URL,
  DEFAULT_ETIMS_DEVICE_PORT
} from '../lib/etimsConfig.js'

/** Fields collected by the eTIMS setup gate's form. */
interface EtimsSetupForm {
  baseUrl: string
  deviceIp: string
  devicePort: string
  password: string
}

/**
 * Starting values for the gate's form.
 *
 * `baseUrl` is pre-filled with {@link DEFAULT_ETIMS_BASE_URL} —
 * unlike the device fields, `localhost` is genuinely correct for the
 * overwhelming majority of installs (the fiscal server runs on the till
 * itself), so showing it ready-to-go is a real default, not a guess.
 * `deviceIp`/`devicePort`/`password` stay blank: those vary per
 * physical device, and pre-filling one would be exactly the
 * silent-wrong-default trap removed elsewhere in go-live prep (see
 * `docs/phase-92.md` — no guessed device password ships).
 */
const EMPTY_FORM: EtimsSetupForm = {
  baseUrl: DEFAULT_ETIMS_BASE_URL,
  deviceIp: '',
  devicePort: '',
  password: ''
}

/** Props accepted by {@link EtimsSetupGate}. */
interface EtimsSetupGateProps {
  /** Called once the connection fields are saved (or mock mode was chosen), lifting the gate. */
  onComplete: () => void
}

/**
 * Full-screen, un-dismissible overlay shown when Real eTIMS is enabled
 * but its connection fields have not yet been configured — blocks the
 * main POS UI so checkout never reaches an unconfigured fiscal device
 * and crashes with an HTTP 500.
 *
 * @param {EtimsSetupGateProps} props
 * @returns {JSX.Element}
 */
export default function EtimsSetupGate({ onComplete }: EtimsSetupGateProps) {
  const [form, setForm] = useState<EtimsSetupForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Per-field validation messages, keyed by field. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const isFormComplete = Object.values(form).every((value) => value.trim().length > 0)

  const updateField = (field: keyof EtimsSetupForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }))

  const handleSave = async () => {
    if (!isFormComplete) return
    /**
     * Same checks the Admin screen applies: this is the screen a branch
     * meets first at go-live, so it cannot be the lenient one.
     */
    const errors = validateEtimsConnection(form)
    if (errors.length > 0) {
      setFieldErrors(Object.fromEntries(errors.map((e) => [e.field, e.message])))
      return
    }
    setFieldErrors({})
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.saveEtimsConfig(form)
      if (!result.success) {
        setError(result.error ?? 'Could not save the fiscal device details')
        return
      }
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the fiscal device details')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-theme fixed inset-0 z-[100] flex h-screen items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <WarningIcon className="h-7 w-7" />
          </span>
          <h1 className="text-2xl font-bold text-slate-900">Set up the fiscal device</h1>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-base font-medium text-slate-600">
              Fiscal server address
            </label>
            <input
              type="text"
              value={form.baseUrl}
              onChange={updateField('baseUrl')}
              placeholder={DEFAULT_ETIMS_BASE_URL}
              className="h-14 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              autoFocus
            />
            <p className="mt-1 text-sm text-slate-500">
              Already set for this till. Only change it if the fiscal server is on another
              machine.
            </p>
            {fieldErrors.baseUrl && (
              <p className="mt-1 text-sm font-medium text-rose-600">{fieldErrors.baseUrl}</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-base font-medium text-slate-600">
              Fiscal device IP address
            </label>
            <input
              type="text"
              value={form.deviceIp}
              onChange={updateField('deviceIp')}
              placeholder="192.168.1.50"
              className="h-14 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <p className="mt-1 text-sm text-slate-500">
              The address of the control unit on the shop network.
            </p>
            {fieldErrors.deviceIp && (
              <p className="mt-1 text-sm font-medium text-rose-600">{fieldErrors.deviceIp}</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-base font-medium text-slate-600">
              Fiscal device port
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={form.devicePort}
              onChange={updateField('devicePort')}
              placeholder={DEFAULT_ETIMS_DEVICE_PORT}
              className="h-14 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <p className="mt-1 text-sm text-slate-500">Usually 8000.</p>
            {fieldErrors.devicePort && (
              <p className="mt-1 text-sm font-medium text-rose-600">{fieldErrors.devicePort}</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-base font-medium text-slate-600">
              Fiscal device password
            </label>
            <input
              type="password"
              value={form.password}
              onChange={updateField('password')}
              placeholder="••••••••"
              className="h-14 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <p className="mt-1 text-sm text-slate-500">
              The password set on the control unit. It is stored securely on this till.
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!isFormComplete || saving}
          onClick={() => void handleSave()}
          className="mt-6 h-14 w-full rounded-lg bg-rose-600 text-lg font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
      </div>
    </div>
  )
}
