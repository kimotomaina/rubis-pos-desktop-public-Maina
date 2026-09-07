import VirtualKeyboard from './VirtualKeyboard.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'

/**
 * The keyboard's on-screen presentation (phase-86, Task 3) — mounted
 * once at the `App.tsx` root, reads `keyboardStore`, renders nothing
 * when no field has requested it.
 *
 * `fixed inset-0 z-[60]` — deliberately above `ToastStack`'s `z-50`
 * (phase-84), so opening the keyboard from the wrong-PIN correction
 * field inside a fiscal-notice toast draws the keyboard cleanly over
 * the whole toast column rather than behind or beside it. Closing it
 * (Done, or tapping the backdrop) only clears `keyboardStore`'s
 * `request` — it has no reference to `toastStore` or to
 * `FiscalNotice`'s own dismissal state at all, so it cannot dismiss or
 * otherwise disrupt the notice that opened it: the notice's own React
 * state never changes, it's just visually covered while the keyboard
 * is open and plainly visible again, exactly as it was, the moment it
 * closes.
 *
 * @returns {JSX.Element | null}
 */
export default function VirtualKeyboardModal() {
  const request = useKeyboardStore((state) => state.request)
  const close = useKeyboardStore((state) => state.close)

  if (!request) return null

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
        <VirtualKeyboard
          value={request.value}
          onChange={request.onChange}
          onDone={close}
          maxLength={request.maxLength}
        />
      </div>
    </div>
  )
}
