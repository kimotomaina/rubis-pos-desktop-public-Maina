import { useEffect, useState } from 'react'
import type { ZReport } from '../../../main/services/reports.js'
import { formatCurrency } from '../lib/currency.js'
import { zReportMpesaLines } from '../lib/zReportMpesa.js'
import { zReportRetroLines } from '../lib/zReportRetro.js'
import { zReportCorrectionBlocks } from '../lib/zReportCorrections.js'
import ShiftCorrectionForm from './ShiftCorrectionForm.js'
import { titleCaseName } from '../lib/text.js'
import { formatVatRateLabel } from '../lib/vatLabel.js'
import { CloseIcon } from './icons.js'

interface ZReportModalProps {
  report: ZReport
  onClose: () => void
}

/**
 * Displays a clean, readable summary of a till shift's financials —
 * mirroring the printed Z-report layout — with a button to send the
 * same report to the thermal printer.
 *
 * Sized to fit the 1366x772 design box with no internal scroll
 * (docs/phase-158, Phase E's own no-scroll rule — the previous
 * `min-h-[75vh]`/`overflow-y-auto` combination was never guarded by
 * `screensFitDesignBox.test.ts`, see docs/phase-157 Part 3 G15). The
 * report's own content is a fixed handful of lines, so a plain
 * `max-w-2xl` box that sizes to its content is enough — no pagination
 * needed here, unlike a list screen.
 *
 * @param {ZReportModalProps} props
 * @returns {JSX.Element}
 */
export default function ZReportModal({ report: initialReport, onClose }: ZReportModalProps) {
  // docs/phase-224: the report is re-read after a correction, so the modal holds the one it shows.
  const [report, setReport] = useState(initialReport)
  const [correcting, setCorrecting] = useState(false)
  useEffect(() => setReport(initialReport), [initialReport])

  const [printStatus, setPrintStatus] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null)
  const [printing, setPrinting] = useState(false)

  const discrepancyColor =
    report.discrepancy === null
      ? 'text-slate-500'
      : report.discrepancy === 0
        ? 'text-emerald-600'
        : report.discrepancy > 0
          ? 'text-emerald-600'
          : 'text-rose-600'

  // docs/phase-223: a shift recorded afterwards says so and names who recorded it, in place of a cashier.
  const retroLines = zReportRetroLines(report, (iso) => new Date(iso).toLocaleString())

  // docs/phase-224: the latest correction, compactly. The original figures above are never replaced.
  const corrections = zReportCorrectionBlocks(report, formatCurrency, (iso) => new Date(iso).toLocaleString())
  const latestCorrection = corrections[corrections.length - 1]
  const CORRECTION_SUMMARY = ['Counted Cash', 'Discrepancy', 'M-Pesa counted', 'Check against the M-Pesa statement']

  const handleCorrected = async (): Promise<void> => {
    setCorrecting(false)
    const result = await window.api.getZReport(report.shiftId)
    if (result.success && result.data) setReport(result.data)
  }

  const handlePrint = async () => {
    setPrinting(true)
    setPrintStatus(null)
    try {
      const result = await window.api.printZReport(report.shiftId)
      setPrintStatus(
        result.success
          ? {
              kind: 'success',
              message: result.data?.mock ? 'Z-report printed (mock mode)' : 'Z-report sent to printer'
            }
          : { kind: 'error', message: result.error ?? 'Failed to print Z-report' }
      )
    } catch (err) {
      setPrintStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to print Z-report'
      })
    } finally {
      setPrinting(false)
    }
  }

  // The correction form is a sibling of the modal, not inside it: a click on its backdrop must not reach `onClose`.
  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
      >
        <div
          className="flex w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-4">
            <h3 className="text-xl font-semibold text-slate-900">Z-Report</h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="p-4 text-base">
            <div className="mb-3 space-y-1 text-slate-600">
              <p>Shift #{report.shiftId}</p>
              {report.shiftWindowLabel && <p>{report.shiftWindowLabel}</p>}
              <p>Opened: {new Date(report.openedAt).toLocaleString()}</p>
              <p>
                Closed:{' '}
                {report.closedAt ? new Date(report.closedAt).toLocaleString() : 'In progress'}
              </p>
              {retroLines.length > 0 ? (
                retroLines.map((line, index) => (
                  <p key={line} className={index === 0 ? 'font-semibold text-slate-800' : undefined}>
                    {line}
                  </p>
                ))
              ) : (
                <p>Cashier: {titleCaseName(report.staffName)}</p>
              )}
            </div>

            <div className="mb-3 space-y-1.5 rounded-lg bg-slate-50 p-3">
              <div className="flex justify-between">
                <span className="text-slate-600">Starting Cash</span>
                <span className="font-medium">{formatCurrency(report.startingCash)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Cash Sales</span>
                <span className="font-medium">{formatCurrency(report.totalsByMethod.cash)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">M-Pesa Sales</span>
                <span className="font-medium">{formatCurrency(report.totalsByMethod.mpesa)}</span>
              </div>
              <div className="flex justify-between pl-4 text-sm text-slate-500">
                <span>Manual / Daraja</span>
                <span>
                  {formatCurrency(report.mpesaByMode.manual)} / {formatCurrency(report.mpesaByMode.daraja)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Card Sales</span>
                <span className="font-medium">{formatCurrency(report.totalsByMethod.card)}</span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1.5">
                <span className="text-slate-600">Orders</span>
                <span className="font-medium">{report.orderCount}</span>
              </div>
            </div>

            <div className="mb-3 space-y-1.5 rounded-lg bg-slate-50 p-3">
              <div className="flex justify-between text-lg font-semibold">
                <span>Total Revenue</span>
                <span>{formatCurrency(report.totalRevenue)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">{formatVatRateLabel(report.vatRate)}</span>
                <span className="font-medium">{formatCurrency(report.vatIncluded)}</span>
              </div>
            </div>

            {/* docs/phase-222: beside the cash card, not under it, so the modal is no taller than before. */}
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div className="space-y-1.5 rounded-lg border border-slate-200 p-3">
                <div className="flex justify-between">
                  <span className="text-slate-600">Expected Cash</span>
                  <span className="font-medium">{formatCurrency(report.expectedCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Counted Cash</span>
                  <span className="font-medium">
                    {report.endingCash !== null ? formatCurrency(report.endingCash) : 'Pending'}
                  </span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 text-lg font-semibold">
                  <span>Discrepancy</span>
                  <span className={discrepancyColor}>
                    {report.discrepancy !== null ? formatCurrency(report.discrepancy) : 'Pending'}
                  </span>
                </div>
              </div>

              <div className="space-y-0.5 rounded-lg border border-slate-200 p-2 text-sm">
                {zReportMpesaLines(report, formatCurrency).map((line) => (
                  <div key={line.label} className="flex justify-between">
                    <span className="text-slate-600">{line.label}</span>
                    <span className="font-medium">{line.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {latestCorrection && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-slate-700">
                <p className="line-clamp-2 font-semibold">{latestCorrection.heading}</p>
                <p>
                  {latestCorrection.details
                    .filter((line) => CORRECTION_SUMMARY.some((label) => line.startsWith(`${label}:`)))
                    .join(' · ')}
                </p>
                {corrections.length > 1 && (
                  <p className="text-slate-500">
                    {corrections.length} corrections in all; the printed report lists each one.
                  </p>
                )}
              </div>
            )}

            {printStatus && (
              <p
                className={`mb-3 rounded-lg px-3 py-2 text-base font-medium ${
                  printStatus.kind === 'success'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-rose-50 text-rose-700'
                }`}
              >
                {printStatus.message}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                disabled={printing}
                onClick={() => void handlePrint()}
                className="min-w-0 flex-1 rounded-xl bg-rose-600 py-3 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {printing ? 'Printing…' : 'Print Z-Report'}
              </button>
              {report.status === 'closed' && (
                <button
                  type="button"
                  onClick={() => setCorrecting(true)}
                  className="w-48 shrink-0 rounded-xl border border-slate-300 py-3 text-lg font-medium text-slate-700 hover:bg-slate-50"
                >
                  Correct figures
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {correcting && (
        <ShiftCorrectionForm
          report={report}
          onCancel={() => setCorrecting(false)}
          onCorrected={() => void handleCorrected()}
        />
      )}
    </>
  )
}
