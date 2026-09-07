/**
 * Pure helpers for the back-office "needs attention" list (phase-94) —
 * kept framework-free and tested directly, matching how `fiscalNotice.ts`
 * is tested independently of `FiscalNotice`.
 *
 * Copy rules: plain language only, no device codes, no jargon — the
 * same rules `fiscalNotice.ts` follows for the till-side notice.
 */

import type { FiscalResendResult, NeedsAttentionRow } from '../../../main/services/database.js'

/**
 * Plain-language label for a row's status — the only thing that tells
 * a `needs_fixing` row apart from a stuck `waiting` row, since both can
 * appear on the same list.
 *
 * @param {NeedsAttentionRow['fiscal_status']} status
 * @returns {string}
 */
export function describeNeedsAttentionStatus(status: NeedsAttentionRow['fiscal_status']): string {
  return status === 'waiting' ? 'Stuck — retrying automatically' : 'Needs fixing'
}

/**
 * Whether a resend outcome means the row should leave the list — true
 * once the sale is fiscalized, i.e. the resend actually filed it.
 *
 * @param {FiscalResendResult} result
 * @returns {boolean}
 */
export function resendClearsRow(result: FiscalResendResult): boolean {
  return result.fiscalStatus === 'fiscalized'
}

/**
 * Applies a resend's outcome to the in-memory list: drops the row when
 * it fiscalized, otherwise merges the fresh status/reason/kind/data-issue
 * into the existing row so its displayed text reflects this latest
 * attempt — a `waiting` row that comes back rejected as a data problem,
 * for instance, must show as `needs_fixing` immediately, not on the
 * next full refetch.
 *
 * @param {NeedsAttentionRow[]} rows
 * @param {FiscalResendResult} result
 * @returns {NeedsAttentionRow[]}
 */
export function applyResendResult(
  rows: NeedsAttentionRow[],
  result: FiscalResendResult
): NeedsAttentionRow[] {
  if (resendClearsRow(result)) {
    return rows.filter((row) => row.local_id !== result.localId)
  }
  return rows.map((row) =>
    row.local_id === result.localId
      ? {
          ...row,
          fiscal_status:
            result.fiscalStatus === 'waiting' || result.fiscalStatus === 'needs_fixing'
              ? result.fiscalStatus
              : row.fiscal_status,
          fiscal_error_reason: result.fiscalErrorReason,
          fiscal_error_kind: result.fiscalErrorKind,
          fiscal_data_issue: result.fiscalDataIssue
        }
      : row
  )
}
