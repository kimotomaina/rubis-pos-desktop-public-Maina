import { ArrowLeftIcon } from './icons.js'

interface BackButtonProps {
  label: string
  onClick: () => void
}

/**
 * Shared "back to the grid above" control (phase-167, Admin's card
 * navigation) — top-left, a large touch target, the same shape at
 * every level (Admin, Integrations, Reports).
 *
 * @param {BackButtonProps} props
 * @returns {JSX.Element}
 */
export default function BackButton({ label, onClick }: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 flex h-14 items-center gap-2 rounded-lg px-4 text-lg font-semibold text-rose-600 transition hover:bg-rose-50 active:scale-95"
    >
      <ArrowLeftIcon className="h-6 w-6" />
      {label}
    </button>
  )
}
