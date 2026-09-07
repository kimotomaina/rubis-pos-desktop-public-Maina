export interface VirtualKeyboardProps {
  value: string
  onChange: (next: string) => void
  onDone: () => void
  /** A key press once `value.length` reaches this is a no-op, matching the field's own `maxLength`. */
  maxLength?: number
}

const KEY_CLASS =
  'flex h-14 items-center justify-center rounded-lg bg-slate-100 text-xl font-semibold text-slate-800 transition active:scale-95 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40'

const DIGIT_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

/**
 * Uppercase-only QWERTY rows (no shift/caps key — see the file doc for
 * why that's a deliberate simplification, not an oversight).
 */
const LETTER_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
]

/**
 * Touch alphanumeric keyboard (phase-86, Task 3) — the letters/digits
 * counterpart to `VirtualNumpad`, built the same way: fully controlled
 * (the caller owns `value` and receives the next string via `onChange`
 * on every key), no validation logic of its own, so it composes with
 * whatever a field already does (`.trim()`, `.toUpperCase()`, KRA PIN
 * format checks) without needing to know about any of it.
 *
 * Deliberately uppercase-only, no shift/caps key: the KRA PIN fields
 * already uppercase every keystroke themselves (`isValidKraPinFormat`
 * requires it), and an all-caps company name is a normal, unremarkable
 * convention on a printed receipt — so a second, always-on layer of
 * case state would add real complexity (tracking shift, rendering two
 * label sets) for a distinction that's a wash for the fields this
 * actually serves today. If a future field genuinely needs mixed case,
 * that's the point to revisit this, not before.
 *
 * @param {VirtualKeyboardProps} props
 * @returns {JSX.Element}
 */
export default function VirtualKeyboard({ value, onChange, onDone, maxLength }: VirtualKeyboardProps) {
  const atLimit = maxLength !== undefined && value.length >= maxLength

  const append = (char: string): void => {
    if (atLimit) return
    onChange(value + char)
  }

  const backspace = (): void => onChange(value.slice(0, -1))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-10 gap-1.5">
        {DIGIT_ROW.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => append(key)}
            disabled={atLimit}
            className={KEY_CLASS}
          >
            {key}
          </button>
        ))}
      </div>

      {LETTER_ROWS.map((row, index) => (
        <div key={index} className="flex gap-1.5">
          {row.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => append(key)}
              disabled={atLimit}
              className={`${KEY_CLASS} flex-1`}
            >
              {key}
            </button>
          ))}
        </div>
      ))}

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={backspace}
          disabled={value.length === 0}
          className={`${KEY_CLASS} w-20 shrink-0`}
          aria-label="Backspace"
        >
          ⌫
        </button>
        <button
          type="button"
          onClick={() => append(' ')}
          disabled={atLimit}
          className={`${KEY_CLASS} flex-1`}
        >
          Space
        </button>
        <button
          type="button"
          onClick={onDone}
          className="h-14 w-24 shrink-0 rounded-lg bg-rose-600 text-lg font-bold text-white transition active:scale-95 hover:bg-rose-700"
        >
          Done
        </button>
      </div>
    </div>
  )
}
