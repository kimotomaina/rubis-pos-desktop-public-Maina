import { useState } from 'react'

export interface VirtualKeyboardProps {
  value: string
  onChange: (next: string) => void
  onDone: () => void
  /** A key press once `value.length` reaches this is a no-op, matching the field's own `maxLength`. */
  maxLength?: number
  /** `caps` (default) is the uppercase-only grid; `text` adds lower case, a Shift toggle and a symbol row. */
  layout?: 'caps' | 'text'
  /**
   * Text and accessible name of the closing key. Omitted, it reads
   * `Done` with no `aria-label`, exactly as it always has; the overlay
   * host passes `Submit` (phase-139) so its key sets name one action.
   */
  doneLabel?: string
}

const KEY_CLASS =
  'flex h-14 items-center justify-center rounded-lg bg-slate-100 text-xl font-semibold text-slate-800 transition active:scale-95 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40'

const DIGIT_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

const LETTER_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
]

/** The characters a URL (`http://host:4444/`), a Shopify token (`shpat_…`) or a device password needs. */
const SYMBOL_ROW = ['-', '_', '.', ':', '/', '@', '#', '$', '!', '?']

/**
 * Touch alphanumeric keyboard (phase-86, Task 3) — the letters/digits
 * counterpart to `VirtualNumpad`, built the same way: fully controlled
 * (the caller owns `value` and receives the next string via `onChange`
 * on every key), no validation logic of its own, so it composes with
 * whatever a field already does (`.trim()`, `.toUpperCase()`, KRA PIN
 * format checks) without needing to know about any of it.
 *
 * The default `caps` layout is uppercase-only with no Shift key: the KRA
 * PIN fields uppercase every keystroke themselves, and an all-caps
 * company name is normal on a printed receipt. The `text` layout
 * (phase-137) exists for the setup screens, whose server address, store
 * URL, API token and device password are case-sensitive and contain
 * symbols. Its Shift key is a toggle, not one-shot, and is the only state
 * this component holds; the value itself is still entirely the caller's.
 *
 * @param {VirtualKeyboardProps} props
 * @returns {JSX.Element}
 */
export default function VirtualKeyboard({
  value,
  onChange,
  onDone,
  maxLength,
  layout = 'caps',
  doneLabel
}: VirtualKeyboardProps) {
  const [shift, setShift] = useState(false)
  const atLimit = maxLength !== undefined && value.length >= maxLength
  const lowerCase = layout === 'text' && !shift

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

      {layout === 'text' && (
        <div className="grid grid-cols-10 gap-1.5">
          {SYMBOL_ROW.map((key) => (
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
      )}

      {LETTER_ROWS.map((row, index) => (
        <div key={index} className="flex gap-1.5">
          {row.map((key) => {
            const char = lowerCase ? key.toLowerCase() : key
            return (
              <button
                key={key}
                type="button"
                onClick={() => append(char)}
                disabled={atLimit}
                className={`${KEY_CLASS} flex-1`}
              >
                {char}
              </button>
            )
          })}
        </div>
      ))}

      <div className="flex gap-1.5">
        {layout === 'text' && (
          <button
            type="button"
            onClick={() => setShift((prev) => !prev)}
            aria-label="Shift"
            aria-pressed={shift}
            className={`${shift ? KEY_CLASS.replace('bg-slate-100', 'bg-slate-300') : KEY_CLASS} w-20 shrink-0`}
          >
            ⇧
          </button>
        )}
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
          aria-label={doneLabel}
          className="h-14 w-24 shrink-0 rounded-lg bg-rose-600 text-lg font-bold text-white transition active:scale-95 hover:bg-rose-700"
        >
          {doneLabel ?? 'Done'}
        </button>
      </div>
    </div>
  )
}
