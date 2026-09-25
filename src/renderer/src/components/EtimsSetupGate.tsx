import { useState } from 'react'
import { WarningIcon } from './icons.js'
import {
  validateEtimsConnection,
  DEFAULT_ETIMS_BASE_URL,
  DEFAULT_ETIMS_DEVICE_PORT
} from '../lib/etimsConfig.js'
import { useKeyboardStore, type KeyboardMode } from '../stores/keyboardStore.js'

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

/**
 * The form's fields in on-screen order: two per row, so server address
 * and IP share the first row, port and password the second. `mode` is the
 * on-screen key set each one opens.
 */
const FIELDS: {
  key: keyof EtimsSetupForm
  label: string
  type: 'text' | 'password'
  mode: KeyboardMode
  placeholder: string
}[] = [
  { key: 'baseUrl', label: 'Fiscal server address', type: 'text', mode: 'text', placeholder: DEFAULT_ETIMS_BASE_URL },
  { key: 'deviceIp', label: 'Fiscal device IP address', type: 'text', mode: 'ip', placeholder: '192.168.1.50' },
  { key: 'devicePort', label: 'Fiscal device port', type: 'text', mode: 'numeric', placeholder: DEFAULT_ETIMS_DEVICE_PORT },
  { key: 'password', label: 'Fiscal device password', type: 'password', mode: 'text', placeholder: '••••••••' }
]

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
 * Fields are read-only and open the docked on-screen keyboard or numpad
 * on tap (see {@link FIELDS}). While it is open the gate top-aligns and
 * reserves the sheet's height, so Save & Continue stays visible above it.
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

  const keyboardOpen = useKeyboardStore((state) => state.request?.docked === true)

  const isFormComplete = Object.values(form).every((value) => value.trim().length > 0)

  const openKeyboard = (field: (typeof FIELDS)[number]) =>
    useKeyboardStore.getState().open({
      value: form[field.key],
      onChange: (next) => setForm((prev) => ({ ...prev, [field.key]: next })),
      label: field.label,
      mode: field.mode,
      docked: true,
      /**
       * The device password is the only credential here, so it is the only
       * field whose echo is masked; the address, IP and port echo plainly.
       */
      secret: field.type === 'password'
    })

  const handleSave = async () => {
    useKeyboardStore.getState().close()
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
    <div
      className={`app-theme fixed inset-0 z-[100] flex h-screen justify-center overflow-y-auto px-4 pt-8 ${
        keyboardOpen ? 'items-start pb-keyboard-sheet' : 'items-center pb-8'
      }`}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <WarningIcon className="h-7 w-7" />
          </span>
          <h1 className="text-2xl font-bold text-slate-900">Set up the fiscal device</h1>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label
                htmlFor={`etims-${field.key}`}
                className="mb-1 block text-base font-medium text-slate-600"
              >
                {field.label}
              </label>
              <input
                id={`etims-${field.key}`}
                type={field.type}
                value={form[field.key]}
                readOnly
                onFocus={() => openKeyboard(field)}
                onClick={() => openKeyboard(field)}
                placeholder={field.placeholder}
                className="h-14 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              />
              {fieldErrors[field.key] && (
                <p className="mt-1 text-sm font-medium text-rose-600">{fieldErrors[field.key]}</p>
              )}
            </div>
          ))}
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
