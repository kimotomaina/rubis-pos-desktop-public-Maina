interface EmptyStateProps {
  icon?: string
  title: string
  subtitle?: string
}

/**
 * Reusable empty / placeholder state — used for the empty cart
 * and for the error / no-results product states.
 *
 * @param {EmptyStateProps} props
 * @returns {JSX.Element}
 */
export default function EmptyState({
  icon = '📦',
  title,
  subtitle = ''
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-slate-400">
      <span className="text-4xl">{icon}</span>
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
    </div>
  )
}
