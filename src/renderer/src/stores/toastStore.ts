/**
 * Shared toast stack (phase-84). Every toast in the app — connectivity
 * changes, auto-update status, the fiscal outcome notice, the
 * sale-complete confirmation, barcode/search feedback — is an entry in
 * this one store, rendered by the single `ToastStack` component. Each
 * producer (`ConnectivityToast`, `UpdateToast`, `FiscalNotice`,
 * `SaleCompleteToast`, `App.tsx`'s scan/search feedback) keeps its own
 * trigger and decides its own content; only the presentation (position,
 * stacking, timeout, close button) is unified here.
 */

import { create } from 'zustand'
import type { ReactNode } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

/** What a producer supplies to show one toast. */
export interface ToastInput {
  /** Stable id for this toast's "slot" — showing again with the same id replaces it in place rather than stacking a duplicate. */
  id: string
  message: string
  tone: ToastTone
  /** Milliseconds until this toast auto-dismisses, or `null` to never auto-dismiss (used only by the fiscal notice — see its own doc comment for why). */
  timeoutMs: number | null
  /** Called on either the close (x) click or the timeout firing — the producer decides what dismissal means for it. */
  onDismiss: () => void
  /** Extra interactive content rendered below the message (e.g. FiscalNotice's fix-and-resend buttons, UpdateToast's install button). */
  actions?: ReactNode
  /**
   * Exempts this toast from `ToastStack`'s visible-count cap (docs/
   * phase-166 Commit E4) — set only by `FiscalNotice`, the one place a
   * flagged sale surfaces to a person at all, so it can never be pushed
   * out by routine toasts arriving afterwards. Mirrors `timeoutMs: null`
   * (also FiscalNotice-only): both exist because that one toast plays by
   * different rules than everything else in the stack.
   */
  pinned?: boolean
}

/** A toast as held in the store — `input` plus a freshness stamp. */
export interface ToastEntry extends ToastInput {
  /**
   * Set fresh by `show()` on every call, including a replace of an
   * existing id. Lets `ToastShell` reset its countdown on new activity
   * even when `timeoutMs`'s value is unchanged (e.g. `UpdateToast`
   * calling `show()` again on every download-progress tick with the
   * same 5-minute timeout should still push the deadline out, not let
   * the original countdown keep running underneath).
   */
  updatedAt: number
}

interface ToastStoreState {
  toasts: ToastEntry[]
  /** Upserts by `id`: replaces an existing entry in place (same position), or appends a new one at the end. */
  show: (input: ToastInput) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastStoreState>()((set) => ({
  toasts: [],

  show: (input) => {
    set((state) => {
      const entry: ToastEntry = { ...input, updatedAt: Date.now() }
      const index = state.toasts.findIndex((t) => t.id === input.id)
      if (index === -1) {
        return { toasts: [...state.toasts, entry] }
      }
      const toasts = [...state.toasts]
      toasts[index] = entry
      return { toasts }
    })
  },

  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  }
}))
