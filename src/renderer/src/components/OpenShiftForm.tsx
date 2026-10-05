import { useKeyboardStore } from '../stores/keyboardStore.js'
import { SHIFT_TYPES, shiftWindowLabel, type ShiftType } from '../lib/shiftWindows.js'

interface OpenShiftFormProps {
  shiftType: ShiftType
  onShiftTypeChange: (next: ShiftType) => void
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
 * The Open Shift inputs (docs/phase-227): the shift pick, starting cash, the optional M-Pesa balance, Confirm and
 * Cancel. One component for the Admin screen and the cart's "No shift open" dialog, so the two can never differ.
 * It holds no state and calls nothing: the owner of the form decides what Confirm does.
 *
 * @param {OpenShiftFormProps} props
 * @returns {JSX.Element}
 */
export default function OpenShiftForm({
  shiftType,
  onShiftTypeChange,
  startingCash,
  onStartingCashChange,
  mpesaOpening,
  onMpesaOpeningChange,
  onConfirm,
  onCancel
}: OpenShiftFormProps) {
  return (
    <>
      <div role="radiogroup" aria-label="Shift" className="mb-3 flex flex-wrap gap-2">
        {SHIFT_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={shiftType === type}
            onClick={() => onShiftTypeChange(type)}
            className={`rounded-lg border px-4 py-2 text-base font-medium ${
              shiftType === type
                ? 'border-rose-500 bg-rose-50 text-rose-700'
                : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {shiftWindowLabel(type)}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <div>
          <label className="mb-1 block text-lg font-medium text-slate-600">
            Starting Cash
          </label>
          <input
            type="text"
            readOnly
            value={startingCash}
            onClick={() => openDecimalField(startingCash, onStartingCashChange, 'Starting Cash')}
            onFocus={() => openDecimalField(startingCash, onStartingCashChange, 'Starting Cash')}
            className="w-32 h-12 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-lg font-medium text-slate-600">
            M-Pesa balance (optional)
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
          className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
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
    </>
  )
}
