import { useEffect, useState } from 'react'
import { formatCurrency } from '../lib/currency.js'
import { usePaymentActivityStore } from '../stores/paymentActivityStore.js'
import { amountDue, canAddPayment, canCompleteSplit, maxNonCashPayment, splitChange } from '../lib/splitPayments.js'
import PaymentModal from './PaymentModal.js'
import type { ManualMpesaEntryInput } from './PaymentModal.js'
import CardEntryPanel from './CardEntryPanel.js'
import VirtualNumpad from './VirtualNumpad.js'
import type { CardManualEntry, CheckoutIpcPaymentLeg } from '../../../main/services/database.js'

interface SplitPaymentPanelProps {
  /** The sale's total. */
  total: number
  /** Sends the one checkout with every payment; called only when the payments add up to the total. */
  onComplete: (payments: CheckoutIpcPaymentLeg[], change: number) => void
  /** Back to paying one way. Drops every payment recorded here; nothing has been written. */
  onCancel: () => void
  /** Whether a checkout is in flight. */
  submitting: boolean
  heldLabel?: string
}

/** Where the panel is: the payment list, or taking one payment. */
type Step = { kind: 'list' } | { kind: 'amount'; method: 'mpesa' | 'card' } | { kind: 'pay'; method: 'mpesa' | 'card'; amount: number } | { kind: 'cash' }

const METHOD_NAMES: Record<CheckoutIpcPaymentLeg['method'], string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card' }

/**
 * Split payment (docs/phase-252): the cashier records the payments one by one, each through the same screen a sale paid
 * that way uses (the M-Pesa code or STK push, the PDQ reference, the cash handed over), and each must succeed there
 * before it is added. Complete sale is active only when the payments add up to the total exactly, and sends one checkout
 * with the whole list; the main process checks it again and writes the sale and every payment together, or nothing.
 *
 * An M-Pesa or card payment is for an amount the cashier types, no more than what is still due. Cash is always last and
 * covers the rest, so only cash gives change. Hold is refused while any payment is recorded.
 *
 * @param {SplitPaymentPanelProps} props
 * @returns {JSX.Element}
 */
export default function SplitPaymentPanel({ total, onComplete, onCancel, submitting, heldLabel }: SplitPaymentPanelProps) {
  const [legs, setLegs] = useState<CheckoutIpcPaymentLeg[]>([])
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [input, setInput] = useState('')

  const setPaymentActive = usePaymentActivityStore((state) => state.setActive)
  useEffect(() => {
    setPaymentActive('split', legs.length > 0)
  }, [legs.length, setPaymentActive])
  useEffect(() => () => setPaymentActive('split', false), [setPaymentActive])

  const due = amountDue(total, legs)
  const typed = parseFloat(input) || 0
  const backToList = () => {
    setInput('')
    setStep({ kind: 'list' })
  }
  const add = (leg: CheckoutIpcPaymentLeg) => {
    setLegs((previous) => [...previous, leg])
    backToList()
  }

  if (step.kind === 'pay' && step.method === 'mpesa') {
    return (
      <PaymentModal
        total={step.amount}
        actionLabel="Record payment"
        heldLabel={heldLabel}
        onCancel={backToList}
        onPaid={(referenceNumber: string, manual?: ManualMpesaEntryInput) =>
          add({ method: 'mpesa', amount: step.amount, referenceNumber, ...(manual ? { mpesaManual: manual } : {}) })
        }
      />
    )
  }
  if (step.kind === 'pay' && step.method === 'card') {
    return (
      <CardEntryPanel
        total={step.amount}
        actionLabel="Record payment"
        heldLabel={heldLabel}
        onCancel={backToList}
        onPaid={(_reference: string, manual: CardManualEntry) => add({ method: 'card', amount: step.amount, cardManual: manual })}
      />
    )
  }

  if (step.kind === 'amount') {
    const most = maxNonCashPayment(total, legs)
    const valid = typed > 0 && Math.round(typed * 100) <= Math.round(most * 100)
    return (
      <div data-testid="split-amount">
        <button type="button" onClick={backToList} className="mb-2 text-base text-slate-500 hover:text-slate-700">
          ← Back to payments
        </button>
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2">
          <span className="text-base font-medium text-slate-600">{METHOD_NAMES[step.method]} amount</span>
          <span className="text-xl font-mono">Ksh {input || '0'}</span>
        </div>
        <p className="mb-2 text-sm text-slate-500">Up to {formatCurrency(most)}</p>
        <VirtualNumpad value={input} onChange={setInput} size="compact" />
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            setInput('')
            setStep({ kind: 'pay', method: step.method, amount: Math.round(typed * 100) / 100 })
          }}
          className="mt-3 h-14 w-full rounded-xl bg-rose-600 text-xl font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    )
  }

  if (step.kind === 'cash') {
    const enough = Math.round(typed * 100) >= Math.round(due * 100)
    return (
      <div data-testid="split-cash">
        <button type="button" onClick={backToList} className="mb-2 text-base text-slate-500 hover:text-slate-700">
          ← Back to payments
        </button>
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2">
          <span className="text-base font-medium text-slate-600">Cash handed over</span>
          <span className="text-xl font-mono">Ksh {input || '0'}</span>
        </div>
        <p className="mb-2 text-sm text-slate-500">
          Cash due {formatCurrency(due)}
          {enough && typed > due ? ` · change ${formatCurrency(Math.round((typed - due) * 100) / 100)}` : ''}
        </p>
        <VirtualNumpad value={input} onChange={setInput} size="compact" />
        <button
          type="button"
          disabled={!enough}
          onClick={() => add({ method: 'cash', amount: due, tendered: Math.round(typed * 100) / 100 })}
          className="mt-3 h-14 w-full rounded-xl bg-rose-600 text-xl font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Record cash
        </button>
      </div>
    )
  }

  const adding = canAddPayment(total, legs)
  const firstPayment = legs.length === 0
  return (
    <div data-testid="split-panel">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-base font-semibold text-slate-700">Split payment</p>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700">
          Cancel split
        </button>
      </div>
      <ul className="mb-2 divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="split-payments">
        {legs.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No payments recorded yet.</li>}
        {legs.map((leg, index) => (
          <li key={index} className="flex items-center justify-between gap-2 px-3 py-2 text-base" data-testid={`split-payment-${index}`}>
            <span className="min-w-0 truncate">
              {METHOD_NAMES[leg.method]}
              {leg.method === 'mpesa' ? ` · ${leg.mpesaManual?.code ?? leg.referenceNumber ?? ''}` : ''}
              {leg.method === 'card' ? ` · ${leg.cardManual?.reference ?? ''}` : ''}
              {leg.method === 'cash' && (leg.tendered ?? 0) > leg.amount ? ` · change ${formatCurrency(splitChange(legs))}` : ''}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-mono tabular-nums">{formatCurrency(leg.amount)}</span>
              <button
                type="button"
                aria-label={`Remove ${METHOD_NAMES[leg.method]} payment`}
                onClick={() => setLegs((previous) => previous.filter((_, at) => at !== index))}
                className="text-sm text-slate-400 hover:text-rose-600"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="mb-2 flex justify-between text-lg font-semibold">
        <span className="text-slate-600">Still due</span>
        <span className="tabular-nums text-slate-900" data-testid="split-due">
          {formatCurrency(due)}
        </span>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={!adding || firstPayment}
          onClick={() => setStep({ kind: 'cash' })}
          className="h-12 rounded-xl border border-slate-200 text-lg font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Cash
        </button>
        <button
          type="button"
          disabled={!adding}
          onClick={() => setStep({ kind: 'amount', method: 'mpesa' })}
          className="h-12 rounded-xl border border-slate-200 text-lg font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + M-Pesa
        </button>
        <button
          type="button"
          disabled={!adding}
          onClick={() => setStep({ kind: 'amount', method: 'card' })}
          className="h-12 rounded-xl border border-slate-200 text-lg font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Card
        </button>
      </div>
      <button
        type="button"
        disabled={!canCompleteSplit(total, legs) || submitting}
        onClick={() => onComplete(legs, splitChange(legs))}
        className="h-16 w-full rounded-xl bg-rose-600 text-2xl font-extrabold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'PROCESSING…' : 'COMPLETE SALE'}
      </button>
    </div>
  )
}
