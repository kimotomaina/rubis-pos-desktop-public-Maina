import ZReportBlock from './ZReportBlock.js'
import ModalShell from './ModalShell.js'
import type { ZReport } from '../../../main/services/reports.js'

interface ZReportModalProps {
  report: ZReport
  onClose: () => void
  /** Opens with the correction form already showing (docs/phase-239: the "Correct figures" action on Shift History). */
  startCorrecting?: boolean
  /** `false` hides Correct figures (docs/phase-254: a cashier's page). */
  canCorrect?: boolean
}

/**
 * The Z report in a window (docs/phase-246, R1): the report scrolls in the body of a {@link ModalShell} while the header,
 * the print message and the Print and Correct figures buttons stay in view. The report itself is {@link ZReportBlock};
 * before this phase the box sized to its content and a long report pushed its buttons off the screen.
 *
 * @param {ZReportModalProps} props
 * @returns {JSX.Element}
 */
export default function ZReportModal({ report, onClose, startCorrecting = false, canCorrect = true }: ZReportModalProps) {
  return (
    <ZReportBlock report={report} startCorrecting={startCorrecting} canCorrect={canCorrect}>
      {({ body, footer, correctionForm }) => (
        <>
          <ModalShell title="Z-Report" onClose={onClose} footer={footer}>
            {body}
          </ModalShell>
          {correctionForm}
        </>
      )}
    </ZReportBlock>
  )
}
