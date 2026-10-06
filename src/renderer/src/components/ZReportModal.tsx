import { useEffect, useState } from 'react'
import type { ZReport } from '../../../main/services/reports.js'
import { formatCurrency } from '../lib/currency.js'
import { zReportMpesaLines } from '../lib/zReportMpesa.js'
import { zReportRetroLines } from '../lib/zReportRetro.js'
import { zReportCorrectionBlocks } from '../lib/zReportCorrections.js'
import ShiftCorrectionForm from './ShiftCorrectionForm.js'
import { zReportAdjustmentBlocks, zReportLabelledLine, zReportMergedLine, zReportSalesAtCloseLine } from '../lib/zReportAdjustments.js'
import { titleCaseName } from '../lib/text.js'
import { formatVatRateLabel } from '../lib/vatLabel.js'
import ModalShell from './ModalShell.js'

interface ZReportModalProps {
  report: ZReport
  onClose: () => void
  /** Opens with the correction form already showing (docs/phase-239: the "Correct figures" action on Shift History). */
  startCorrecting?: boolean
}

/**
 * Displays a clean, readable summary of a till shift's financials —
 * mirroring the printed Z-report layout — with a button to send the
 * same report to the thermal printer.
 *
 * Usable at any length (docs/phase-246, R1): the report scrolls in the body of a {@link ModalShell} while the header, the
 * print message and the Print and Correct figures buttons stay in view. Before, the box sized to its content and a long
 * report pushed its buttons off the screen (docs/phase-158 had ruled out an internal scroll).
 *
 * @param {ZReportModalProps} props
 * @returns {JSX.Element}
 */
export default function ZReportModal({ report: initialReport, onClose, startCorrecting = false }: ZReportModalProps) {
  // docs/phase-224: the report is re-read after a correction, so the modal holds the one it shows.
  const [report, setReport] = useState(initialReport)
  const [correcting, setCorrecting] = useState(startCorrecting && initialReport.status === 'closed' && !initialReport.mergedInto)
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

  // docs/phase-232: sales that joined or left this shift after it was opened or made, the type's note, and what the
  // shift held at close when later changes mean the figures above now count more or fewer sales.
  const adjustments = zReportAdjustmentBlocks(report, formatCurrency, (iso) => new Date(iso).toLocaleString())
  const latestAdjustment = adjustments[adjustments.length - 1]
  const labelledLine = zReportLabelledLine(report)
  // docs/phase-239: a shift merged into another says so; its figures are history and are not corrected here.
  const mergedLine = zReportMergedLine(report, (iso) => new Date(iso).toLocaleString())
  const salesAtCloseLine = zReportSalesAtCloseLine(report, formatCurrency)
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

  // docs/phase-246, R1: the report scrolls in the body; the print message and the buttons stay in view in the footer.
  const footer = (
    <>
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
      {report.status === 'closed' && !report.mergedInto && (
        <button
          type="button"
          onClick={() => setCorrecting(true)}
          className="w-48 shrink-0 rounded-xl border border-slate-300 py-3 text-lg font-medium text-slate-700 hover:bg-slate-50"
        >
          Correct figures
        </button>
      )}
    </div>
    </>
  )

  // The correction form is a sibling of the modal, not inside it: a click on its backdrop must not reach `onClose`.
  return (
    <>
      <ModalShell title="Z-Report" onClose={onClose} footer={footer}>
            <div className="mb-3 space-y-1 text-slate-600">
              <p>Shift #{report.shiftId}</p>
              {report.shiftWindowLabel && <p>{report.shiftWindowLabel}</p>}
              {labelledLine && <p className="text-slate-500">{labelledLine}</p>}
              {mergedLine && (
                <p className="rounded-lg bg-amber-50 px-2 py-1 font-semibold text-amber-900" data-testid="merged-into">
                  {mergedLine}
                </p>
              )}
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
                <p>Opened by: {titleCaseName(report.staffName)}</p>
              )}
            </div>

            <div className="mb-3 space-y-1.5 rounded-lg bg-slate-50 p-3">
              {!report.cashNotCounted && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Starting Cash</span>
                  <span className="font-medium">{formatCurrency(report.startingCash)}</span>
                </div>
              )}
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

            {salesAtCloseLine && (
              <p className="mb-3 text-sm text-slate-500" data-testid="sales-at-close">
                {salesAtCloseLine}
              </p>
            )}

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
              {report.cashNotCounted ? (
                <div className="rounded-lg border border-slate-200 p-3" data-testid="cash-not-counted">
                  <p className="text-lg font-semibold text-slate-700">Cash not counted</p>
                  <p className="text-sm text-slate-500">Nobody counted the drawer for this shift, so no difference is worked out.</p>
                </div>
              ) : (
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
              )}

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

            {latestAdjustment && (
              <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-2 text-sm text-slate-700" data-testid="latest-adjustment">
                <p className="line-clamp-2 font-semibold">{latestAdjustment.heading}</p>
                {adjustments.length > 1 && (
                  <p className="text-slate-500">{adjustments.length} changes to the sales in all; the printed report lists each one.</p>
                )}
              </div>
            )}
      </ModalShell>
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
