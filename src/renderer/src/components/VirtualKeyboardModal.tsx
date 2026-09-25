import VirtualKeyboard from './VirtualKeyboard.js'
import VirtualNumpad from './VirtualNumpad.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'

/**
 * The keyboard's on-screen presentation (phase-86, Task 3) — mounted
 * once at the React root in `main.tsx`, so every screen (the pre-login
 * setup screens included) reaches the same instance; reads
 * `keyboardStore`, renders nothing when no field has requested it.
 *
 * A request's `mode` picks the keys: `VirtualKeyboard` for `caps`/`text`,
 * `VirtualNumpad` for `numeric`/`ip`, whose Enter key closes it the way
 * Done does. One overlay hosts both, so there is no third keyboard.
 *
 * Modal (the default): `fixed inset-0 z-[60]` — deliberately above
 * `ToastStack`'s `z-50` (phase-84), so opening the keyboard from the
 * wrong-PIN correction field inside a fiscal-notice toast draws it
 * cleanly over the whole toast column. Closing it (Done, or tapping the
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
  const keys =
    mode === 'numeric' || mode === 'ip' ? (
      <VirtualNumpad
        value={request.value}
        onChange={request.onChange}
        onEnter={close}
        allowDecimal={mode === 'ip'}
        multipleDecimals={mode === 'ip'}
      />
    ) : (
      <VirtualKeyboard
        value={request.value}
        onChange={request.onChange}
        onDone={close}
        maxLength={request.maxLength}
        layout={mode === 'text' ? 'text' : 'caps'}
      />
    )

  if (request.docked) {
    return (
      <div
        role="dialog"
        aria-label={request.label}
        className="fixed inset-x-0 bottom-0 z-110 flex h-keyboard-sheet justify-center border-t border-slate-200 bg-white p-4 shadow-2xl"
      >
        <div className={mode === 'numeric' || mode === 'ip' ? 'w-full max-w-sm' : 'w-full max-w-3xl'}>
          <p className="mb-2 text-base font-semibold text-slate-700">{request.label}</p>
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
        <p className="mb-2 text-base font-semibold text-slate-700">{request.label}</p>
        {keys}
      </div>
    </div>
  )
}
