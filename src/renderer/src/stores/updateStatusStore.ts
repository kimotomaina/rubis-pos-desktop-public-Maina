/**
 * The latest auto-update status, kept for the whole signed-in session (docs/phase-219).
 *
 * `UpdatePrompt` feeds it, so the App & Updates panel, which only listens while it is open,
 * can still show that an update is available after the prompt was answered "Later". While
 * the prompt is open it drives the download itself, so the toast stays quiet.
 */

import { create } from 'zustand'
import type { UpdateStatus } from '../../../main/services/updater.js'

interface UpdateStatusState {
  status: UpdateStatus | null
  promptOpen: boolean
  setStatus: (status: UpdateStatus) => void
  setPromptOpen: (open: boolean) => void
}

export const useUpdateStatusStore = create<UpdateStatusState>()((set) => ({
  status: null,
  promptOpen: false,
  setStatus: (status) => set({ status }),
  setPromptOpen: (promptOpen) => set({ promptOpen })
}))
