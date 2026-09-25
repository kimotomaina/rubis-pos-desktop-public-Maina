interface VirtualNumpadProps {
  value: string
  onChange: (value: string) => void
  /** Renders a wide "Enter" key next to Clear when provided (e.g. submit on cash tendered). */
  onEnter?: () => void
  /** Disables the decimal-point key — used for integer-only fields (e.g. PIN entry). */
  allowDecimal?: boolean
  /** Lets the decimal-point key be pressed more than once, for dotted IP addresses. Validation stays with the field. */
  multipleDecimals?: boolean
  /**
   * Text and accessible name of the `onEnter` key. Omitted, it reads
   * `Enter` with no `aria-label`, exactly as it always has; the overlay
   * host passes `Submit` (phase-139) so its key sets name one action.
   */
  enterLabel?: string
}

const NUMPAD_KEY_CLASS =
  'h-16 w-full rounded-xl bg-slate-100 text-2xl font-semibold text-slate-800 transition active:scale-95 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40'

const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * Touch-first on-screen numpad for numeric entry (cash tendered, PIN,
 * price/discount overrides) — a 15" retail touchscreen cannot rely on
 * a physical keyboard, and Windows' own touch keyboard is unreliable
 * to trigger from an Electron (non-UWP) window.
 *
 * Fully controlled: the caller owns `value` and receives the next
 * string via `onChange` on every keypress, so it composes with
 * whatever validation/formatting the field already applies.
 *
 * @param {VirtualNumpadProps} props
 * @returns {JSX.Element}
 */
export default function VirtualNumpad({
  value,
  onChange,
  onEnter,
  allowDecimal = true,
  multipleDecimals = false,
  enterLabel
}: VirtualNumpadProps) {
  const appendKey = (key: string) => {
    if (key === '.' && (!allowDecimal || (!multipleDecimals && value.includes('.')))) return
    onChange(value + key)
  }

  const backspace = () => onChange(value.slice(0, -1))
  const clear = () => onChange('')

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        {DIGIT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => appendKey(key)}
            className={NUMPAD_KEY_CLASS}
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          onClick={() => appendKey('.')}
          disabled={!allowDecimal}
          className={NUMPAD_KEY_CLASS}
          aria-label="Decimal point"
        >
          .
        </button>
        <button type="button" onClick={() => appendKey('0')} className={NUMPAD_KEY_CLASS}>
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          className={NUMPAD_KEY_CLASS}
          aria-label="Backspace"
        >
          ⌫
        </button>
      </div>
      <div className={onEnter ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1 gap-2'}>
        <button
          type="button"
          onClick={clear}
          className="h-16 w-full rounded-xl bg-slate-200 text-2xl font-semibold text-slate-700 transition active:scale-95 hover:bg-slate-300"
        >
          Clear
        </button>
        {onEnter && (
          <button
            type="button"
            onClick={onEnter}
            aria-label={enterLabel}
            className="h-16 w-full rounded-xl bg-rose-600 text-2xl font-bold text-white transition active:scale-95 hover:bg-rose-700"
          >
            {enterLabel ?? 'Enter'}
          </button>
        )}
      </div>
    </div>
  )
}
