import { useEffect, useState } from 'react'
import type { ShiftRow } from '../../../main/services/database.js'
import { DEFAULT_SCOPE, PRESET_CHOICES, scopeTitle, shiftScopeLabel, type ScopeChoice } from '../lib/reportScopeChoice.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import Pager from './Pager.js'

interface ScopePickerProps {
  scope: ScopeChoice
  onChange: (scope: ScopeChoice) => void
}

const FIELD_CLASS =
  'h-11 w-52 rounded-lg border border-slate-300 px-3 text-base focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'
const CUSTOM_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
const PAGE_SIZE = 10

/**
 * The one range picker of the Reports tab (docs/phase-246, R2): its list shows the shifts first, newest first with the
 * open one on top, then the six fixed periods, then a typed range of two date-times. Picking a shift scopes every
 * report to that shift; the main process turns it into the range of the shift's sales. A shift is listed as the Shift
 * History pages it: ten at a time, from the main process, never all of them.
 *
 * The list drops over the cards under the picker (docs/phase-246-1), so the picker stays the same height and fixed at the
 * top of the page; a list taller than the screen scrolls inside its own box.
 *
 * @param {ScopePickerProps} props
 * @returns {JSX.Element}
 */
export default function ScopePicker({ scope, onChange }: ScopePickerProps) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [shifts, setShifts] = useState<ShiftRow[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.getShiftsList(page).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setShifts(result.data.shifts)
        setTotal(result.data.total)
      } else {
        setError(result.error ?? 'Failed to load the shifts')
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, page])

  const choose = (next: ScopeChoice): void => {
    setError(null)
    setOpen(false)
    onChange(next)
  }

  const applyCustom = (): void => {
    if (!CUSTOM_PATTERN.test(from.trim()) || !CUSTOM_PATTERN.test(to.trim())) {
      setError('Enter both date-times as YYYY-MM-DD HH:MM, Nairobi time')
      return
    }
    choose({ kind: 'custom', from: from.trim(), to: to.trim() })
  }

  const openField = (value: string, onChangeValue: (next: string) => void, label: string): void => {
    useKeyboardStore.getState().open({ value, onChange: onChangeValue, label, mode: 'text', maxLength: 16 })
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-3">
        <p data-testid="scope-title" className="text-xl font-semibold text-slate-900">
          {scopeTitle(scope)}
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setPage(1)
            setOpen((value) => !value)
          }}
          className="h-11 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
        >
          {open ? 'Close the list' : 'Change scope'}
        </button>
        {scope.kind !== 'preset' || scope.preset !== DEFAULT_SCOPE.preset ? (
          <button
            type="button"
            onClick={() => choose(DEFAULT_SCOPE)}
            className="h-11 rounded-lg px-3 text-base font-medium text-slate-500 hover:bg-slate-100"
          >
            Back to Today
          </button>
        ) : null}
      </div>

      {open && (
        <div
          data-testid="scope-list"
          className="touch-scrollbar absolute inset-x-0 top-full z-30 mt-3 max-h-96 space-y-4 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 shadow-lg"
        >
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>}

          <div>
            <p className="mb-2 text-base font-semibold text-slate-700">Shifts, newest first</p>
            {shifts.length === 0 ? (
              <p className="text-base text-slate-500">No shifts recorded yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {shifts.map((shift) => {
                  const label = shiftScopeLabel({
                    id: shift.id,
                    windowType: shift.window_type,
                    openedAt: shift.clock_in,
                    closedAt: shift.clock_out
                  })
                  const selected = scope.kind === 'shift' && scope.shiftId === shift.id
                  return (
                    <button
                      key={shift.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => choose({ kind: 'shift', shiftId: shift.id, label })}
                      className={`min-h-11 rounded-lg border px-3 py-2 text-left text-base font-medium ${
                        selected ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-2">
              <Pager page={page} pageCount={pageCount} onChange={setPage} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-base font-semibold text-slate-700">Periods</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_CHOICES.map(({ key, label }) => {
                const selected = scope.kind === 'preset' && scope.preset === key
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => choose({ kind: 'preset', preset: key })}
                    className={`h-11 rounded-lg px-4 text-base font-semibold transition ${
                      selected ? 'bg-rose-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-base font-semibold text-slate-700">Custom range, Nairobi time</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-base text-slate-600">
                From
                <input
                  readOnly
                  value={from}
                  aria-label="Range from"
                  placeholder="YYYY-MM-DD HH:MM"
                  onClick={() => openField(from, setFrom, 'Range from (YYYY-MM-DD HH:MM)')}
                  className={`${FIELD_CLASS} mt-1 block`}
                />
              </label>
              <label className="text-base text-slate-600">
                To
                <input
                  readOnly
                  value={to}
                  aria-label="Range to"
                  placeholder="YYYY-MM-DD HH:MM"
                  onClick={() => openField(to, setTo, 'Range to (YYYY-MM-DD HH:MM)')}
                  className={`${FIELD_CLASS} mt-1 block`}
                />
              </label>
              <button
                type="button"
                onClick={applyCustom}
                className="h-11 rounded-lg bg-slate-800 px-5 text-base font-semibold text-white hover:bg-slate-900"
              >
                Use this range
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
