import type { ReactNode } from 'react'
import { PackageIcon } from './icons.js'

interface EmptyStateProps {
  icon?: ReactNode
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
  icon = <PackageIcon className="h-10 w-10" />,
  title,
  subtitle = ''
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-slate-400">
      <span className="text-slate-300">{icon}</span>
      <p className="text-base font-medium text-slate-600">{title}</p>
      {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
    </div>
  )
}
