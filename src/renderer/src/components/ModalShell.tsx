import type { ReactNode } from 'react'
import { CloseIcon } from './icons.js'

interface ShellPanelProps {
  title: ReactNode
  /** Shows a close button in the header when given and `showCloseButton` is not `false`. */
  onClose?: () => void
  showCloseButton?: boolean
  /** Anything else for the header's right-hand side, such as a Cancel button. */
  headerAction?: ReactNode
  /** Stays in view under the scrolling body: the buttons of the window. */
  footer?: ReactNode
  children: ReactNode
}

/**
 * The three parts of a window that has to stay usable at any length (docs/phase-246, R1): a header and a footer that
 * stay where they are, and a body between them that scrolls. The body is the one place in these windows that scrolls,
 * with the always-visible scroll bar of docs/phase-220. Used on its own for a panel inside a page (Move a sale), and
 * by {@link ModalShell} for the windows on top of one. It fills the height it is given, so its parent must be a column
 * with a bounded height.
 *
 * @param {ShellPanelProps} props
 * @returns {JSX.Element}
 */
export function ShellPanel({ title, onClose, showCloseButton = true, headerAction, footer, children }: ShellPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 p-4">
        <h3 className="text-xl font-semibold text-slate-900">{title}</h3>
        <div className="flex items-center gap-2">
          {headerAction}
          {onClose && showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
      <div data-testid="shell-body" className="touch-scrollbar min-h-0 flex-1 overflow-y-auto p-4 text-base">
        {children}
      </div>
      {footer && (
        <div data-testid="shell-footer" className="shrink-0 border-t border-slate-200 p-4">
          {footer}
        </div>
      )}
    </div>
  )
}

interface ModalShellProps extends ShellPanelProps {
  /** Names the dialog for assistive technology and tests. */
  ariaLabel?: string
  /** Tailwind max-width class of the box. */
  maxWidthClass?: string
  zClass?: string
  backdropClass?: string
  /** A click on the backdrop calls `onClose`; `false` for a window that only its own buttons close. */
  closeOnBackdrop?: boolean
}

/**
 * A window on top of the page (docs/phase-246, R1): the backdrop, a box that is never taller than the screen, and the
 * {@link ShellPanel} inside it. A long report scrolls in its body; the header and the buttons stay visible.
 *
 * @param {ModalShellProps} props
 * @returns {JSX.Element}
 */
export default function ModalShell({
  ariaLabel,
  maxWidthClass = 'max-w-3xl',
  zClass = 'z-50',
  backdropClass = 'bg-black/50',
  closeOnBackdrop = true,
  onClose,
  ...panel
}: ModalShellProps) {
  return (
    <div
      role="dialog"
      aria-label={ariaLabel}
      className={`fixed inset-0 ${zClass} flex items-center justify-center ${backdropClass} p-4`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={`flex max-h-full w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl bg-white shadow-xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <ShellPanel onClose={onClose} {...panel} />
      </div>
    </div>
  )
}
