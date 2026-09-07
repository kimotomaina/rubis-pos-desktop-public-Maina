/**
 * The single on-screen keyboard's open/closed state (phase-86, Task 3).
 *
 * `PosCheckoutPanel.tsx`'s company-name/customer-PIN fields and
 * `FiscalNotice.tsx`'s wrong-PIN correction field live in different
 * parts of the component tree (the checkout panel and the top-center
 * toast stack are siblings, not parent/child), so — same problem
 * `toastStore.ts` solved for toasts — a shared Zustand store is how one
 * keyboard instance, mounted once, serves all three without prop
 * drilling. A field "opens" the keyboard by calling `open()` with its
 * own `value`/`onChange`; the keyboard never knows which field it's
 * editing or applies any validation of its own — it only ever relays
 * keystrokes through the `onChange` it was given, exactly like
 * `VirtualNumpad`'s "fully controlled, caller owns validation" contract.
 */

import { create } from 'zustand'

/** What a field hands the keyboard when it opens. */
export interface KeyboardRequest {
  value: string
  onChange: (next: string) => void
  /** Shown above the key grid so the cashier knows what they're editing. */
  label: string
  /** Enforced the same way the underlying `<input maxLength>` already is — a key press past this length is a no-op. */
  maxLength?: number
}

interface KeyboardStoreState {
  request: KeyboardRequest | null
  open: (request: KeyboardRequest) => void
  close: () => void
}

export const useKeyboardStore = create<KeyboardStoreState>()((set) => ({
  request: null,

  open: (request) => {
    /**
     * Wraps the field's own `onChange` so every keystroke also updates
     * this store's copy of `value`, not just the field's own state.
     * Without this, `request.value` would be a one-time snapshot taken
     * at `open()` — `VirtualKeyboard` would keep computing
     * `staleValue + nextChar` forever instead of building on what was
     * actually typed, since nothing else feeds the field's real value
     * back in. `VirtualNumpad` never needs this because it's rendered
     * inline by its own parent, closing that loop for free; going
     * through this store to reach three separate call sites breaks
     * that unless it's closed here instead.
     */
    const relay = (next: string): void => {
      request.onChange(next)
      set((state) => (state.request ? { request: { ...state.request, value: next } } : state))
    }
    set({ request: { ...request, onChange: relay } })
  },

  close: () => set({ request: null })
}))
