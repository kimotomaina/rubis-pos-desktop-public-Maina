import { useEffect, useMemo, useState } from 'react'
import type {
  StockTakeCommitSummary,
  StockTakePreview,
  StockTakeSessionView,
  StockTakeSettings
} from '../../../main/services/stock-take.js'
import { formatCurrency } from '../lib/currency.js'
import {
  describeCommit,
  formatVariance,
  STOCK_TAKE_STATUS_CLASSES,
  STOCK_TAKE_STATUS_LABELS,
  varianceClass
} from '../lib/stockTake.js'
import { pageOfIndex, paginate } from '../lib/paginate.js'
import Pager from '../components/Pager.js'
import { useAuthStore } from '../stores/authStore.js'
import { useProductStore } from '../stores/productStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import ManagerPinModal from '../components/ManagerPinModal.js'

/** Counted lines per page (docs/phase-166 Commit E4) — replaces this table's reliance on the outer Admin wrapper scrolling. */
export const STOCK_TAKE_LINES_PER_PAGE = 10

/** Which manager PIN the open modal is collecting, if any. */
type PinPurpose = 'commit' | 'secondApprover' | 'discard' | 'settings' | null

/** Opens the shared on-screen keyboard for a readOnly numeric field (docs/phase-156) — same helper as `AdminScreen.tsx`'s. */
function openField(
  value: string,
  onChange: (next: string) => void,
  label: string,
  mode: 'numeric' | 'decimal'
): void {
  useKeyboardStore.getState().open({ value, onChange, label, mode })
}

/** A verified first approver, held while the second approver is collected. */
interface PendingApproval {
  managerId: number
  managerPin: string
}

/**
 * The stock-take back-office screen: count the shelf, review the
 * variance against Shopify, and — on manager approval — push the
 * correction.
 *
 * Back-office only. Nothing here locks a variant or interferes with the
 * till: a stock take can be open all afternoon while the same items
 * keep selling, and the delta-against-snapshot arithmetic in
 * `stock-take.ts` is what makes those sales survive the correction.
 *
 * Counting works offline. Pushing does not, and says so — it has to
 * re-read Shopify's current figures first.
 *
 * The counted-lines table is paginated at {@link STOCK_TAKE_LINES_PER_PAGE}
 * (docs/phase-166 Commit E4) — recording a count jumps the table to the
 * page holding that line, same as `PosCartTable`'s identical jump for a
 * cart add/scan.
 *
 * @returns {JSX.Element}
 */
export default function StockTakePage() {
  const currentStaff = useAuthStore((state) => state.currentStaff)
  const products = useProductStore((state) => state.products)
  const fetchProducts = useProductStore((state) => state.fetchProducts)

  const [view, setView] = useState<StockTakeSessionView | null>(null)
  const [history, setHistory] = useState<StockTakeSessionView[]>([])
  const [settings, setSettings] = useState<StockTakeSettings | null>(null)
  const [preview, setPreview] = useState<StockTakePreview | null>(null)
  const [summary, setSummary] = useState<StockTakeCommitSummary | null>(null)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [countedQty, setCountedQty] = useState('')
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)

  const [pinPurpose, setPinPurpose] = useState<PinPurpose>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [confirmingCommit, setConfirmingCommit] = useState(false)

  const [thresholdInput, setThresholdInput] = useState('')
  const [selfApprovalInput, setSelfApprovalInput] = useState(false)
  const [expiryInput, setExpiryInput] = useState('')

  const [linesPage, setLinesPage] = useState(1)
  /** Variant id most recently recorded — jumps the lines table to its page (docs/phase-166 Commit E4). */
  const [lastRecordedVariantId, setLastRecordedVariantId] = useState<string | null>(null)

  const session = view?.session ?? null
  const items = view?.items ?? []
  const countable = session?.status === 'open' || session?.status === 'counting'
  const awaitingApproval = session?.status === 'awaiting_approval'

  const refresh = async (): Promise<void> => {
    const [active, list, policy] = await Promise.all([
      window.api.getActiveStockTake(),
      window.api.listStockTakes(),
      window.api.getStockTakeSettings()
    ])
    if (active.success) setView(active.data ?? null)
    if (list.success && list.data) setHistory(list.data)
    if (policy.success && policy.data) {
      setSettings(policy.data)
      setThresholdInput(String(policy.data.varianceThresholdKes))
      setSelfApprovalInput(policy.data.allowSelfApproval)
      setExpiryInput(String(policy.data.expiryHours))
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        await refresh()
        if (products.length === 0) await fetchProducts()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load stock takes')
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Runs one IPC action, clearing the previous message and surfacing
   * whatever went wrong. Kept in one place so no action can quietly
   * fail with a stale success notice still on screen.
   */
  const run = async <T,>(
    action: () => Promise<{ success: boolean; data?: T; error?: string }>,
    onSuccess: (data: T | undefined) => void
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      if (result.success) {
        onSuccess(result.data)
      } else {
        setError(result.error ?? 'That did not work')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const countedVariantIds = useMemo(
    () => new Set(items.map((item) => item.variant_id)),
    [items]
  )

  /**
   * Jumps the lines table to the page holding the just-recorded line
   * (docs/phase-166 Commit E4) — `items` is deliberately left out of the
   * dependency list, matching `PosCartTable`'s identical jump effect:
   * this should fire only when a NEW line is recorded, not on every
   * incidental refresh of `items` while the last recording is still the
   * most recent one.
   */
  useEffect(() => {
    if (!lastRecordedVariantId) return
    const index = items.findIndex((item) => item.variant_id === lastRecordedVariantId)
    if (index === -1) return
    setLinesPage(pageOfIndex(index, STOCK_TAKE_LINES_PER_PAGE))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRecordedVariantId])

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return []
    const flat = products.flatMap((product) =>
      product.variants.map((variant) => ({
        variantId: variant.id,
        label: `${product.title}${variant.title && variant.title !== 'Default Title' ? ` — ${variant.title}` : ''}`,
        barcode: variant.barcode
      }))
    )
    return flat
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(term) || entry.barcode?.toLowerCase() === term
      )
      .slice(0, 8)
  }, [products, search])

  const selected = matches.find((entry) => entry.variantId === selectedVariantId) ?? matches[0]

  const handleStart = (): void => {
    if (!currentStaff) return
    void run(() => window.api.openStockTake(currentStaff.id), (data) => {
      setView(data ?? null)
      setPreview(null)
      setSummary(null)
    })
  }

  const handleCount = (): void => {
    if (!session || !selected) return
    const parsed = Number(countedQty)
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError('Enter the counted quantity as a whole number.')
      return
    }
    void run(
      () =>
        window.api.recordStockTakeCount({
          sessionId: session.id,
          variantId: selected.variantId,
          variantLabel: selected.label,
          countedQty: parsed
        }),
      (data) => {
        setView(data ?? null)
        setSearch('')
        setCountedQty('')
        setLastRecordedVariantId(selected.variantId)
        setSelectedVariantId(null)
      }
    )
  }

  const handleRemove = (variantId: string): void => {
    if (!session) return
    void run(
      () => window.api.removeStockTakeCount(session.id, variantId),
      (data) => setView(data ?? null)
    )
  }

  const handleSubmit = (): void => {
    if (!session) return
    void run(
      () => window.api.submitStockTake(session.id),
      (data) => {
        setView(data ?? null)
        setPreview(null)
      }
    )
  }

  const handlePreview = (): void => {
    if (!session) return
    void run(
      () => window.api.previewStockTake(session.id),
      (data) => {
        setPreview(data ?? null)
        setConfirmingCommit(false)
      }
    )
  }

  const handleCommit = (managerId: number, managerPin: string, second?: PendingApproval): void => {
    if (!session) return
    void run(
      () =>
        window.api.commitStockTake({
          sessionId: session.id,
          managerId,
          managerPin,
          secondApproverId: second?.managerId,
          secondApproverPin: second?.managerPin
        }),
      (data) => {
        setSummary(data ?? null)
        setPreview(null)
        setConfirmingCommit(false)
        setPendingApproval(null)
        setNotice(
          data
            ? `Stock take #${data.sessionId} pushed to Shopify — ${data.applied} applied, ${data.skipped} already agreed, ${data.rejected} rejected.`
            : null
        )
        void refresh()
      }
    )
  }

  const handleAuthorized = (managerId: number, managerPin: string): void => {
    const purpose = pinPurpose
    setPinPurpose(null)

    if (purpose === 'discard' && session) {
      void run(
        () => window.api.abandonStockTake(session.id, managerId, managerPin),
        () => {
          setView(null)
          setPreview(null)
          setNotice('Stock take discarded. Nothing was sent to Shopify.')
          void refresh()
        }
      )
      return
    }

    if (purpose === 'settings') {
      const threshold = Number(thresholdInput)
      const expiry = Number(expiryInput)
      if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(expiry) || expiry <= 0) {
        setError('Enter a threshold of zero or more and an expiry of more than zero hours.')
        return
      }
      void run(
        () =>
          window.api.saveStockTakeSettings(
            {
              varianceThresholdKes: threshold,
              allowSelfApproval: selfApprovalInput,
              expiryHours: expiry
            },
            managerId,
            managerPin
          ),
        () => {
          setNotice('Stock take policy saved.')
          void refresh()
        }
      )
      return
    }

    if (purpose === 'commit') {
      if (preview?.requiresSecondApprover) {
        setPendingApproval({ managerId, managerPin })
        setPinPurpose('secondApprover')
        return
      }
      handleCommit(managerId, managerPin)
      return
    }

    if (purpose === 'secondApprover' && pendingApproval) {
      handleCommit(pendingApproval.managerId, pendingApproval.managerPin, {
        managerId,
        managerPin
      })
    }
  }

  if (loading) {
    return <p className="p-4 text-lg text-slate-500">Loading stock takes…</p>
  }

  const pushableLines = preview?.lines.filter((line) => line.delta !== 0 && !line.blockedReason) ?? []
  const linesPageResult = paginate(items, linesPage, STOCK_TAKE_LINES_PER_PAGE)

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-lg font-medium text-rose-700">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-4 py-3 text-lg font-medium text-emerald-800">
          {notice}
        </p>
      )}

      {!session && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-xl font-semibold text-slate-900">Start a stock take</h3>
          <p className="mt-1 max-w-3xl text-base text-slate-500">
            Counting works offline; pushing the correction needs an internet connection.
          </p>
          <button
            type="button"
            disabled={busy || !currentStaff}
            onClick={handleStart}
            className="mt-3 h-14 rounded-lg bg-rose-600 px-6 text-lg font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Start stock take'}
          </button>
        </section>
      )}

      {session && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Stock take #{session.id}</h3>
              <p className="text-base text-slate-500">
                Started {new Date(session.opened_at).toLocaleString()} · {items.length} item
                {items.length === 1 ? '' : 's'} counted
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-base font-semibold ${STOCK_TAKE_STATUS_CLASSES[session.status]}`}
            >
              {STOCK_TAKE_STATUS_LABELS[session.status]}
            </span>
          </div>

          {countable && (
            <div className="mt-4 space-y-2">
              <label className="block text-base font-medium text-slate-600">
                Scan or search for an item
              </label>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setSelectedVariantId(null)
                }}
                placeholder="Barcode or product name"
                className="h-14 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              />
              {matches.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {matches.map((entry) => (
                    <button
                      key={entry.variantId}
                      type="button"
                      onClick={() => setSelectedVariantId(entry.variantId)}
                      className={`rounded-lg border px-3 py-2 text-base ${
                        selected?.variantId === entry.variantId
                          ? 'border-rose-400 bg-rose-50 text-rose-700'
                          : 'border-slate-300 text-slate-600'
                      }`}
                    >
                      {entry.label}
                      {countedVariantIds.has(entry.variantId) && ' · counted'}
                    </button>
                  ))}
                </div>
              )}
              {selected && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-base font-medium text-slate-600">
                      Counted quantity for {selected.label}
                    </label>
                    <input
                      readOnly
                      value={countedQty}
                      onClick={() =>
                        openField(
                          countedQty,
                          (next) => setCountedQty(next.replace(/[^0-9]/g, '')),
                          `Counted quantity for ${selected.label}`,
                          'numeric'
                        )
                      }
                      className="h-14 w-full rounded-lg border border-slate-300 px-3 text-2xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy || countedQty === ''}
                    onClick={handleCount}
                    className="h-14 rounded-lg bg-slate-800 px-6 text-lg font-semibold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Record count
                  </button>
                </div>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-base">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-2">Item</th>
                    <th className="py-2 text-right">Shopify at start</th>
                    <th className="py-2 text-right">Counted</th>
                    <th className="py-2 text-right">Variance</th>
                    <th className="py-2 text-right">Value</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {linesPageResult.items.map((item) => (
                    <tr key={item.variant_id} className="border-t border-slate-100">
                      <td className="py-2 pr-2 text-slate-800">{item.variant_label}</td>
                      <td className="py-2 text-right text-slate-500">
                        {item.system_snapshot_qty}
                      </td>
                      <td className="py-2 text-right font-medium text-slate-800">
                        {item.counted_qty}
                      </td>
                      <td className={`py-2 text-right font-semibold ${varianceClass(item.variance)}`}>
                        {formatVariance(item.variance)}
                      </td>
                      <td className="py-2 text-right text-slate-500">
                        {formatCurrency(Math.abs(item.variance) * item.unit_price_at_count)}
                      </td>
                      <td className="py-2 text-right">
                        {countable && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleRemove(item.variant_id)}
                            className="text-base text-slate-400 underline hover:text-rose-600"
                          >
                            Remove
                          </button>
                        )}
                        {item.commit_status && (
                          <span className="text-base text-slate-500">{item.commit_status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3">
                <Pager
                  page={linesPageResult.page}
                  pageCount={linesPageResult.pageCount}
                  onChange={setLinesPage}
                />
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {countable && (
              <button
                type="button"
                disabled={busy || items.length === 0}
                onClick={handleSubmit}
                className="h-14 rounded-lg bg-rose-600 px-6 text-lg font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Submit for approval
              </button>
            )}
            {awaitingApproval && (
              <button
                type="button"
                disabled={busy}
                onClick={handlePreview}
                className="h-14 rounded-lg bg-slate-800 px-6 text-lg font-semibold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Re-reading Shopify…' : 'Review against Shopify'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setPinPurpose('discard')}
              className="h-14 rounded-lg border border-slate-300 px-6 text-lg font-medium text-slate-600 hover:bg-slate-50"
            >
              Discard
            </button>
          </div>
        </section>
      )}

      {preview && (
        <section className="rounded-xl border border-amber-300 bg-amber-50/40 p-4">
          <h3 className="text-xl font-semibold text-slate-900">
            What this will change in Shopify
          </h3>

          {preview.stalenessWarning && (
            <p className="mt-2 rounded-lg bg-white px-3 py-2 text-base text-slate-600">
              {preview.stalenessWarning}
            </p>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Shopify now</th>
                  <th className="py-2 text-right">Change</th>
                  <th className="py-2 text-right">Shopify after</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={line.variantId} className="border-t border-amber-200/60">
                    <td className="py-2 pr-2 text-slate-800">
                      {line.variantLabel}
                      {line.blockedReason && (
                        <span className="block text-base text-rose-700">{line.blockedReason}</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-slate-500">{line.freshQty ?? '—'}</td>
                    <td className={`py-2 text-right font-semibold ${varianceClass(line.delta)}`}>
                      {formatVariance(line.delta)}
                    </td>
                    <td className="py-2 text-right font-medium text-slate-900">
                      {line.resultingQty ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-lg font-medium text-slate-800">
            {describeCommit({
              pushableLines: pushableLines.length,
              totalUnitsMoving: preview.totalUnitsMoving
            })}{' '}
            Value moving: {formatCurrency(preview.totalValueMoving)}.
            {preview.agreeingCount > 0 &&
              ` ${preview.agreeingCount} counted item${preview.agreeingCount === 1 ? '' : 's'} already agree${preview.agreeingCount === 1 ? 's' : ''} and will not be touched.`}
          </p>

          {preview.requiresSecondApprover && (
            <p className="mt-2 rounded-lg bg-white px-3 py-2 text-base font-medium text-amber-900">
              Over the limit{settings ? ` of ${formatCurrency(settings.varianceThresholdKes)}` : ''},
              needs two managers&rsquo; approval.
            </p>
          )}

          {!confirmingCommit ? (
            <button
              type="button"
              disabled={busy || pushableLines.length === 0}
              onClick={() => setConfirmingCommit(true)}
              className="mt-3 h-14 rounded-lg border-2 border-rose-600 px-6 text-lg font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Push this correction to Shopify…
            </button>
          ) : (
            <div className="mt-3 rounded-lg border-2 border-rose-600 bg-white p-3">
              <p className="text-lg font-semibold text-rose-700">
                This changes live stock in Shopify and cannot be undone.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingCommit(false)}
                  className="h-14 rounded-lg border border-slate-300 px-6 text-lg font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPinPurpose('commit')}
                  className="h-14 rounded-lg bg-rose-600 px-6 text-lg font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Yes — push to Shopify
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {summary && (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
          <h3 className="text-xl font-semibold text-slate-900">Pushed to Shopify</h3>
          <p className="mt-1 text-base text-slate-600">
            Reference <code className="text-slate-800">{summary.referenceUri}</code> — find it in
            Shopify&rsquo;s own inventory history for these items.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-xl font-semibold text-slate-900">Approval policy</h3>
        <p className="mt-1 max-w-3xl text-base text-slate-500">
          Counts over the limit (zero by default) need two managers&rsquo; approval.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-base font-medium text-slate-600">
              Second-approver limit (KES)
            </label>
            <input
              readOnly
              value={thresholdInput}
              onClick={() =>
                openField(
                  thresholdInput,
                  (next) => setThresholdInput(next.replace(/[^0-9.]/g, '')),
                  'Second-approver limit (KES)',
                  'decimal'
                )
              }
              className="h-14 w-48 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
          </div>
          <div>
            <label className="block text-base font-medium text-slate-600">
              Count expires after (hours)
            </label>
            <input
              readOnly
              value={expiryInput}
              onClick={() =>
                openField(
                  expiryInput,
                  (next) => setExpiryInput(next.replace(/[^0-9]/g, '')),
                  'Count expires after (hours)',
                  'numeric'
                )
              }
              className="h-14 w-40 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
          </div>
          <label className="flex h-14 items-center gap-2 text-base text-slate-600">
            <input
              type="checkbox"
              checked={selfApprovalInput}
              onChange={(e) => setSelfApprovalInput(e.target.checked)}
              className="h-5 w-5"
            />
            Allow the counter to approve their own count
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPinPurpose('settings')}
            className="h-14 rounded-lg bg-slate-800 px-6 text-lg font-semibold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save policy
          </button>
        </div>
      </section>

      {history.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-xl font-semibold text-slate-900">Past stock takes</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">#</th>
                  <th className="py-2">Started</th>
                  <th className="py-2">Status</th>
                  <th className="py-2 text-right">Items</th>
                  <th className="py-2">Reference</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.session.id} className="border-t border-slate-100">
                    <td className="py-2 text-slate-800">{entry.session.id}</td>
                    <td className="py-2 text-slate-500">
                      {new Date(entry.session.opened_at).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-1 text-base font-medium ${STOCK_TAKE_STATUS_CLASSES[entry.session.status]}`}
                      >
                        {STOCK_TAKE_STATUS_LABELS[entry.session.status]}
                      </span>
                    </td>
                    <td className="py-2 text-right text-slate-500">{entry.items.length}</td>
                    <td className="py-2 text-slate-400">
                      {entry.session.committed_reference_uri ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {pinPurpose && (
        <ManagerPinModal
          title={
            pinPurpose === 'secondApprover'
              ? 'Second manager approval for this stock take'
              : pinPurpose === 'discard'
                ? 'Discard this stock take'
                : pinPurpose === 'settings'
                  ? 'Change the stock take approval policy'
                  : 'Approve and push this stock take to Shopify'
          }
          onAuthorized={handleAuthorized}
          onCancel={() => {
            setPinPurpose(null)
            setPendingApproval(null)
          }}
        />
      )}
    </div>
  )
}
