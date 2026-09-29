import { useCallback, useEffect, useState } from 'react'
import VirtualKeyboard from './VirtualKeyboard.js'
import VirtualNumpad from './VirtualNumpad.js'
import { HoldToRevealButton, useHoldToReveal } from './HoldToReveal.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { pasteIntoValue } from '../lib/pasteText.js'

/** Ties the echo's accessible name to the label above it — one keyboard exists at a time, so a constant id is safe. */
const LABEL_ID = 'virtual-keyboard-label'

/**
 * The keyboard's on-screen presentation (phase-86, Task 3) — mounted
 * once at the React root in `main.tsx`, so every screen (the pre-login
 * setup screens included) reaches the same instance; reads
 * `keyboardStore`, renders nothing when no field has requested it.
 *
 * A request's `mode` picks the keys: `VirtualKeyboard` for `caps`/`text`,
 * `VirtualNumpad` for `numeric`/`ip`. One overlay hosts both, so there is
 * no third keyboard. Both are given the label `Submit` for their closing
 * key (phase-139), so every key set here names exactly one action; the
 * components' own defaults (`Done`, `Enter`) are what the inline numpads
 * still show.
 *
 * Submit only closes the overlay. It deliberately does not reach the
 * screen's own Save/Continue button: the relay in `keyboardStore.open()`
 * has already written every keystroke into the field, so there is nothing
 * left to commit, and firing a save from a keyboard key would take the
 * decision away from the visible button (the phase-84/86 coexistence
 * rule).
 *
 * Above the keys sits a read-only echo of `request.value` — the relay's
 * copy, updated on every key — so what has been typed is visible on a
 * till whose field may be behind the sheet or masked. It is a `div`, not
 * a `readOnly` input: an input can still take focus, and focus is what
 * opens this keyboard on the setup screens, which would loop. With
 * `request.secret` it shows one `•` per character, never the characters,
 * so the Shopify token and the fiscal device password stay off screen —
 * except while the eye beside it is held down (`HoldToReveal`), which
 * shows the characters for exactly as long as it is pressed.
 *
 * Beside the echo, a Paste key adds the clipboard's text to the field, and
 * so does Ctrl+V while the keyboard is open. The setup and admin fields
 * are read-only inputs that hand editing to this overlay, so a native
 * paste into them does nothing; the text goes through `pasteIntoValue`,
 * which cuts it to what typing it here could have produced.
 *
 * Modal (the default): `fixed inset-0 z-[60]` — deliberately above
 * `ToastStack`'s `z-50` (phase-84), so opening the keyboard from the
 * wrong-PIN correction field inside a fiscal-notice toast draws it
 * cleanly over the whole toast column. Closing it (Submit, or tapping the
 * backdrop) only clears `keyboardStore`'s `request` — it has no
 * reference to `toastStore` or to `FiscalNotice`'s own dismissal state
 * at all, so it cannot dismiss or otherwise disrupt the notice that
 * opened it: the notice's own React state never changes, it's just
 * visually covered while the keyboard is open.
 *
 * Docked (`request.docked`, phase-137): a bottom sheet with no backdrop,
 * `h-keyboard-sheet` tall, at `z-110` so it sits above the fiscal setup
 * gate's `z-[100]`. The setup screens reserve the same height below
 * their form, so the keys never cover the Save/Continue button.
 *
 * @returns {JSX.Element | null}
 */
export default function VirtualKeyboardModal() {
  const request = useKeyboardStore((state) => state.request)
  const close = useKeyboardStore((state) => state.close)
  const { revealed, hide, holdProps } = useHoldToReveal()
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  const isOpen = request !== null

  /** Adds `text` to whatever the field holds now, read fresh because the relay updates it on every key. */
  const applyPaste = useCallback((text: string): void => {
    const current = useKeyboardStore.getState().request
    if (!current) return
    const next = pasteIntoValue(current.value, text, current.mode, current.maxLength)
    if (next !== current.value) current.onChange(next)
  }, [])

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        setPasteNote('Nothing to paste')
        return
      }
      applyPaste(text)
      setPasteNote(null)
    } catch {
      setPasteNote('Could not read the clipboard')
    }
  }

  /** A hold cannot outlive the request: the icon is gone before its release arrives. */
  useEffect(() => {
    if (!isOpen) {
      hide()
      setPasteNote(null)
    }
  }, [isOpen, hide])

  useEffect(() => {
    if (!isOpen) return undefined
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text') ?? ''
      if (!text) return
      event.preventDefault()
      applyPaste(text)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [isOpen, applyPaste])

  if (!request) return null

  const mode = request.mode ?? 'caps'
  const numeric = mode === 'numeric' || mode === 'decimal' || mode === 'ip'

  const keys = numeric ? (
    <VirtualNumpad
      value={request.value}
      onChange={request.onChange}
      onEnter={close}
      enterLabel="Submit"
      allowDecimal={mode === 'decimal' || mode === 'ip'}
      multipleDecimals={mode === 'ip'}
    />
  ) : (
    <VirtualKeyboard
      value={request.value}
      onChange={request.onChange}
      onDone={close}
      doneLabel="Submit"
      maxLength={request.maxLength}
      layout={mode === 'text' ? 'text' : 'caps'}
    />
  )

  /**
   * Fixed height whether or not anything has been typed, so the keys
   * below never shift as the first character arrives.
   */
  const header = (
    <>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p id={LABEL_ID} className="text-base font-semibold text-slate-700">
          {request.label}
        </p>
        <p role="status" className="text-sm font-medium text-rose-600">
          {pasteNote}
        </p>
      </div>
      <div className="mb-2 flex h-12 items-center gap-2">
        <div
          role="textbox"
          aria-readonly="true"
          aria-labelledby={LABEL_ID}
          className="flex h-12 min-w-0 flex-1 items-center overflow-x-auto whitespace-pre rounded-lg border border-slate-300 bg-slate-50 px-3 text-xl text-slate-900"
        >
          {request.secret && !revealed ? '•'.repeat(request.value.length) : request.value}
        </div>
        <button
          type="button"
          onClick={() => void pasteFromClipboard()}
          className="h-12 shrink-0 rounded-lg border border-slate-300 bg-white px-4 text-base font-semibold text-slate-700 active:bg-slate-200"
        >
          Paste
        </button>
        {request.secret && <HoldToRevealButton revealed={revealed} className="h-12 w-12" {...holdProps} />}
      </div>
    </>
  )

  if (request.docked) {
    return (
      <div
        role="dialog"
        aria-label={request.label}
        className="fixed inset-x-0 bottom-0 z-110 flex h-keyboard-sheet justify-center border-t border-slate-200 bg-white p-4 shadow-2xl"
      >
        <div className={numeric ? 'w-full max-w-sm' : 'w-full max-w-3xl'}>
          {header}
          {keys}
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        {keys}
      </div>
    </div>
  )
}
