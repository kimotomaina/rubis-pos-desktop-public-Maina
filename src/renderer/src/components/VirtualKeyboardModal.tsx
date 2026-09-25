import VirtualKeyboard from './VirtualKeyboard.js'
import VirtualNumpad from './VirtualNumpad.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'

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
 * so the Shopify token and the fiscal device password stay off screen.
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

  if (!request) return null

  const mode = request.mode ?? 'caps'
  const numeric = mode === 'numeric' || mode === 'ip'

  const keys = numeric ? (
    <VirtualNumpad
      value={request.value}
      onChange={request.onChange}
      onEnter={close}
      enterLabel="Submit"
      allowDecimal={mode === 'ip'}
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
      <p id={LABEL_ID} className="mb-2 text-base font-semibold text-slate-700">
        {request.label}
      </p>
      <div
        role="textbox"
        aria-readonly="true"
        aria-labelledby={LABEL_ID}
        className="mb-2 flex h-12 items-center overflow-x-auto whitespace-pre rounded-lg border border-slate-300 bg-slate-50 px-3 text-xl text-slate-900"
      >
        {request.secret ? '•'.repeat(request.value.length) : request.value}
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
