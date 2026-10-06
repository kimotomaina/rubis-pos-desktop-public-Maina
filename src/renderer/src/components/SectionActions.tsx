import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The fixed bar of the open section on the Reports tab (docs/phase-246-1). `undefined` means "no bar around": the
 * component that asks for one then draws its actions where it is, so each can still be mounted and tested alone.
 * `null` means the bar exists and has not been attached to the page yet.
 */
export const ActionSlotContext = createContext<HTMLElement | null | undefined>(undefined)

/**
 * Puts a section's actions (Print, Approve, Move a sale) in the fixed bar under its scroll area, wherever the component
 * that owns them sits in the section. The owner keeps its state and its handlers; only where the buttons are drawn
 * changes, so a long list can never push them out of view.
 *
 * @param {{ children: ReactNode }} props
 * @returns {JSX.Element | null}
 */
export function SectionActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionSlotContext)
  if (slot === undefined) return <>{children}</>
  return slot ? createPortal(children, slot) : null
}
