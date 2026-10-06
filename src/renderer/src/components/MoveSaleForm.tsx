import { useState } from 'react'
import type { SaleMovePreview } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import { useKeyboardStore, type KeyboardMode } from '../stores/keyboardStore.js'
import ManagerPinModal from './ManagerPinModal.js'

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'

interface MoveSaleFormProps {
  onCancel: () => void
  /** Called once the sale is moved, with the sentence to show on the history screen. */
  onMoved: (message: string) => void
}

/**
 * @param {number | null} figures
 * @returns {string}
 */
function moneyOrDash(figures: number | null | undefined): string {
  return figures === null || figures === undefined ? 'Not applicable' : formatCurrency(figures)
}

/**
 * Moves one sale to another shift (docs/phase-232, S5): the only way a sale ever leaves the shift it is in. The
 * admin names the order and the shift it goes to, sees what both shifts would show afterwards, gives a reason and
 * their PIN. No figure is typed here: a recount comes afterwards, by correction. The main process re-checks every
 * rule inside the transaction that writes; what this screen shows is a courtesy and is never the guard.
 *
 * @param {MoveSaleFormProps} props
 * @returns {JSX.Element}
 */
export default function MoveSaleForm({ onCancel, onMoved }: MoveSaleFormProps) {
  const [orderText, setOrderText] = useState('')
  const [shiftText, setShiftText] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<SaleMovePreview | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [override, setOverride] = useState(false)
  const [collectingPin, setCollectingPin] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openField = (value: string, onChange: (next: string) => void, label: string, mode: KeyboardMode, maxLength?: number): void => {
    useKeyboardStore.getState().open({ value, onChange, label, mode, maxLength })
  }

  const orderId = Number(orderText)
  const toShiftId = Number(shiftText)
  const numbersOk = Number.isInteger(orderId) && orderId > 0 && Number.isInteger(toShiftId) && toShiftId > 0

  const handleCheck = async (): Promise<void> => {
    setError(null)
    setPreview(null)
    setAcknowledged(false)
    setOverride(false)
    if (!numbersOk) {
      setError('Enter the order number and the number of the shift it goes to')
      return
    }
    await loadPreview(false)
  }

  const loadPreview = async (withOverride: boolean): Promise<void> => {
    try {
      const result = withOverride
        ? await window.api.previewSaleMove(orderId, toShiftId, true)
        : await window.api.previewSaleMove(orderId, toShiftId)
      if (result.success && result.data) setPreview(result.data)
      else setError(result.error ?? 'Failed to check this move')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check this move')
    }
  }

  // docs/phase-244: ticking the override asks the main process for the preview with phase 243's closed-shift rules lifted.
  const handleOverrideTick = (checked: boolean): void => {
    setError(null)
    setAcknowledged(false)
    setOverride(checked)
    void loadPreview(checked)
  }

  const handleMove = (): void => {
    setError(null)
    if (!preview || preview.problem) {
      setError(preview?.problem ?? 'Check the move first')
      return
    }
    if (preview.differentWindow && !acknowledged) {
      setError('This sale was made in a different window from that shift. Tick the box to confirm it belongs there.')
      return
    }
    if (reason.trim() === '') {
      setError('Say why this sale is being moved')
      return
    }
    setCollectingPin(true)
  }

  const handleAuthorized = (managerId: number, managerPin: string): void => {
    setCollectingPin(false)
    void (async () => {
      setSaving(true)
      try {
        const result = await window.api.moveSale({
          managerId,
          managerPin,
          orderId,
          toShiftId,
          reason: reason.trim(),
          ...(preview?.differentWindow ? { acknowledgeDifferentWindow: true } : {}),
          ...(override ? { override: true } : {})
        })
        if (result.success && result.data) {
          onMoved(`Order #${orderId} moved from shift #${result.data.fromShiftId} to shift #${result.data.toShiftId}.`)
          return
        }
        setError(result.error ?? 'Failed to move this sale')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to move this sale')
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-2xl font-bold text-slate-800">Move a sale to another shift</h3>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
      <p className="mb-3 text-base text-slate-600">
        Only an admin can move a sale, with a reason and their PIN. Both shifts keep a permanent record of it. To change
        a counted figure afterwards, use Correct figures.
      </p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>}

      <div className="mb-3 grid grid-cols-3 items-end gap-2">
        <div>
          <label className="mb-1 block text-base font-medium text-slate-600">Order number</label>
          <input
            readOnly
            value={orderText}
            aria-label="Order number"
            onClick={() => openField(orderText, setOrderText, 'Order number', 'decimal')}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label className="mb-1 block text-base font-medium text-slate-600">Move to shift number</label>
          <input
            readOnly
            value={shiftText}
            aria-label="Shift number"
            onClick={() => openField(shiftText, setShiftText, 'Shift number', 'decimal')}
            className={FIELD_CLASS}
          />
        </div>
        <button
          type="button"
          onClick={() => void handleCheck()}
          className="h-11 rounded-lg bg-slate-700 text-base font-semibold text-white hover:bg-slate-800"
        >
          Check
        </button>
      </div>

      {preview && !preview.problem && (
        <div className="mb-3 rounded-lg bg-slate-50 p-3 text-base text-slate-700" data-testid="move-preview">
          <p className="font-medium">
            Order #{preview.orderId}: {formatCurrency(preview.total)}
            {preview.paymentMethod ? `, ${preview.paymentMethod}` : ''}. Now in shift #{preview.fromShiftId}.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <p className="font-semibold">Shift #{preview.fromShiftId} afterwards</p>
              <p>Expected cash: {moneyOrDash(preview.from?.expectedCash)}</p>
              <p>Difference: {moneyOrDash(preview.from?.discrepancy)}</p>
            </div>
            <div>
              <p className="font-semibold">Shift #{preview.toShiftId} afterwards</p>
              <p>Expected cash: {moneyOrDash(preview.to?.expectedCash)}</p>
              <p>Difference: {moneyOrDash(preview.to?.discrepancy)}</p>
            </div>
          </div>
          {preview.differentWindow && (
            <label className="mt-2 flex items-center gap-2 text-amber-900">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>This sale was made in a different window from shift #{preview.toShiftId}. It belongs there.</span>
            </label>
          )}
        </div>
      )}
      {preview?.problem && <p className="mb-3 text-base font-medium text-rose-700">{preview.problem}</p>}
      {(preview?.overridable || override) && (
        <label className="mb-3 flex items-center gap-2 text-base text-amber-900">
          <input type="checkbox" checked={override} onChange={(event) => handleOverrideTick(event.target.checked)} />
          <span>Override: this shift is closed and not the latest</span>
        </label>
      )}

      <label className="mb-1 block text-base font-medium text-slate-600">Why is this sale being moved?</label>
      <input
        readOnly
        value={reason}
        aria-label="Reason"
        onClick={() => openField(reason, setReason, 'Reason for moving this sale', 'text', 300)}
        className={`${FIELD_CLASS} mb-3`}
      />
      <button
        type="button"
        disabled={saving}
        onClick={handleMove}
        className="h-12 w-full rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Moving…' : 'Move sale'}
      </button>

      {collectingPin && (
        <ManagerPinModal
          title={`Move order #${orderId} to shift #${toShiftId}. It cannot be edited afterwards.`}
          onAuthorized={handleAuthorized}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </div>
  )
}
