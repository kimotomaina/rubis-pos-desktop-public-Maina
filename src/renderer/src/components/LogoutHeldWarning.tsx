import type { HeldSaleSummary } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'

interface LogoutHeldWarningProps {
  /** Every sale held or resumed on this till. */
  sales: HeldSaleSummary[]
  onLogout: () => void
  onStay: () => void
}

/**
 * Shown when a cashier logs out while sales are held (docs/phase-217). Logging out is
 * allowed, because a cashier must be able to hand over mid-wait; the warning lists
 * the held sales so they are not forgotten, and says they stay for the next cashier.
 *
 * @param {LogoutHeldWarningProps} props
 * @returns {JSX.Element}
 */
export default function LogoutHeldWarning({ sales, onLogout, onStay }: LogoutHeldWarningProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" role="dialog" aria-label="Held sales">
        <h3 className="text-xl font-semibold text-slate-900">
          {sales.length === 1 ? '1 sale is on hold' : `${sales.length} sales are on hold`}
        </h3>
        <ul className="mt-3 space-y-1 text-lg text-slate-800">
          {sales.map((sale) => (
            <li key={sale.id} className="flex justify-between gap-3">
              <span className="truncate font-medium">
                {sale.label}
                {sale.status === 'resumed' ? ' (on screen)' : ''}
              </span>
              <span className="tabular-nums">{formatCurrency(sale.total)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-base text-slate-600">These stay on the till for the next cashier.</p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onStay}
            className="h-12 flex-1 rounded-xl border border-slate-300 text-lg font-semibold text-slate-700"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="h-12 flex-1 rounded-xl bg-rose-600 text-lg font-semibold text-white"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  )
}
