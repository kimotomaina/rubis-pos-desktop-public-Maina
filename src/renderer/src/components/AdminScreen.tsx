import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { formatCurrency } from '../lib/currency'
import EmptyState from './EmptyState'
import ZReportModal from './ZReportModal'
import type { DailySummary, ZReport } from '../../../main/services/reports.js'
import type { ShiftRow, StaffRole, StaffSummary } from '../../../main/services/database.js'

/**
 * Back-office screen for managers/admins: today's sales, staff
 * management, and till-shift controls (open/close with cash
 * reconciliation, triggering the Z-report).
 *
 * Access is gated on `currentStaff.role === 'admin'` — enforced both
 * by `App.tsx` (no nav entry for non-admins) and here (defense in
 * depth, in case navigation state outlives a role switch).
 *
 * @returns {JSX.Element}
 */
export default function AdminScreen() {
  const currentStaff = useAuthStore((state) => state.currentStaff)

  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null)
  const [currentShift, setCurrentShift] = useState<ShiftRow | null>(null)
  const [staffList, setStaffList] = useState<StaffSummary[]>([])
  const [loading, setLoading] = useState(true)

  const [startingCashInput, setStartingCashInput] = useState('')
  const [endingCashInput, setEndingCashInput] = useState('')
  const [showOpenForm, setShowOpenForm] = useState(false)
  const [showCloseForm, setShowCloseForm] = useState(false)
  const [shiftActionError, setShiftActionError] = useState<string | null>(null)
  const [zReport, setZReport] = useState<ZReport | null>(null)

  const [showAddStaffForm, setShowAddStaffForm] = useState(false)
  const [newStaffName, setNewStaffName] = useState('')
  const [newStaffPin, setNewStaffPin] = useState('')
  const [newStaffRole, setNewStaffRole] = useState<StaffRole>('cashier')
  const [staffActionError, setStaffActionError] = useState<string | null>(null)
  const [resetPinTargetId, setResetPinTargetId] = useState<number | null>(null)
  const [resetPinValue, setResetPinValue] = useState('')

  const [checkingForUpdates, setCheckingForUpdates] = useState(false)
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<'overview' | 'integrations'>('overview')
  const [mpesaPaybill, setMpesaPaybill] = useState('')
  const [mpesaTill, setMpesaTill] = useState('')
  const [etimsMiddlewareUrl, setEtimsMiddlewareUrl] = useState('')
  const [integrationsLoading, setIntegrationsLoading] = useState(false)
  const [integrationsMessage, setIntegrationsMessage] = useState<string | null>(null)

  const [shopifyTokenConfigured, setShopifyTokenConfigured] = useState(false)
  const [shopifyTokenInput, setShopifyTokenInput] = useState('')
  const [shopifyTokenMessage, setShopifyTokenMessage] = useState<string | null>(null)

  const loadIntegrationsConfig = async () => {
    setIntegrationsLoading(true)
    const [mpesaResult, etimsResult, tokenStatusResult] = await Promise.all([
      window.api.getIntegrationConfig('mpesa'),
      window.api.getIntegrationConfig('etims'),
      window.api.getShopifyTokenStatus()
    ])
    if (mpesaResult.success && mpesaResult.data) {
      setMpesaPaybill(String(mpesaResult.data.paybill ?? ''))
      setMpesaTill(String(mpesaResult.data.till ?? ''))
    }
    if (etimsResult.success && etimsResult.data) {
      setEtimsMiddlewareUrl(String(etimsResult.data.middlewareUrl ?? ''))
    }
    if (tokenStatusResult.success && tokenStatusResult.data) {
      setShopifyTokenConfigured(tokenStatusResult.data.configured)
    }
    setIntegrationsLoading(false)
  }

  /**
   * Saves a new Shopify Admin API token to the OS credential vault
   * (Phase 12, Task 1). The input is intentionally write-only — the
   * field is never pre-filled with the stored value, since the main
   * process never sends the secret itself back to the renderer.
   */
  const handleSaveShopifyToken = async () => {
    setShopifyTokenMessage(null)
    if (!shopifyTokenInput.trim()) {
      setShopifyTokenMessage('Enter a token to save')
      return
    }
    const result = await window.api.setShopifyToken(shopifyTokenInput.trim())
    if (result.success) {
      setShopifyTokenInput('')
      setShopifyTokenConfigured(true)
      setShopifyTokenMessage('Shopify token saved to the credential vault.')
    } else {
      setShopifyTokenMessage(result.error ?? 'Failed to save token')
    }
  }

  useEffect(() => {
    if (activeTab === 'integrations') void loadIntegrationsConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  const handleSaveIntegrationsConfig = async () => {
    setIntegrationsMessage(null)
    const [mpesaResult, etimsResult] = await Promise.all([
      window.api.setIntegrationConfig('mpesa', { paybill: mpesaPaybill.trim(), till: mpesaTill.trim() }),
      window.api.setIntegrationConfig('etims', { middlewareUrl: etimsMiddlewareUrl.trim() })
    ])
    setIntegrationsMessage(
      mpesaResult.success && etimsResult.success
        ? 'Integration settings saved.'
        : (mpesaResult.error ?? etimsResult.error ?? 'Failed to save integration settings')
    )
  }

  const refresh = async () => {
    setLoading(true)
    const [summaryResult, shiftResult, staffResult] = await Promise.all([
      window.api.getDailySummary(),
      window.api.getCurrentShift(),
      window.api.getStaffList()
    ])
    if (summaryResult.success && summaryResult.data) setDailySummary(summaryResult.data)
    if (shiftResult.success) setCurrentShift(shiftResult.data ?? null)
    if (staffResult.success && staffResult.data) setStaffList(staffResult.data)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (!currentStaff || currentStaff.role !== 'admin') {
    return (
      <EmptyState
        icon="🔒"
        title="Access restricted"
        subtitle="This screen is only available to admin accounts."
      />
    )
  }

  const handleOpenShift = async () => {
    setShiftActionError(null)
    const startingCash = parseFloat(startingCashInput)
    if (!Number.isFinite(startingCash) || startingCash < 0) {
      setShiftActionError('Enter a valid starting cash amount')
      return
    }
    const result = await window.api.openShift(currentStaff.id, startingCash)
    if (!result.success) {
      setShiftActionError(result.error ?? 'Failed to open shift')
      return
    }
    setStartingCashInput('')
    setShowOpenForm(false)
    await refresh()
  }

  const handleCloseShift = async () => {
    if (!currentShift) return
    setShiftActionError(null)
    const endingCash = parseFloat(endingCashInput)
    if (!Number.isFinite(endingCash) || endingCash < 0) {
      setShiftActionError('Enter a valid ending cash amount')
      return
    }
    const result = await window.api.closeShift(currentShift.id, endingCash)
    if (!result.success) {
      setShiftActionError(result.error ?? 'Failed to close shift')
      return
    }
    setEndingCashInput('')
    setShowCloseForm(false)

    const reportResult = await window.api.getZReport(currentShift.id)
    if (reportResult.success && reportResult.data) {
      setZReport(reportResult.data)
    }
    await refresh()
  }

  const handleAddStaff = async () => {
    setStaffActionError(null)
    if (!newStaffName.trim() || !newStaffPin.trim()) {
      setStaffActionError('Name and PIN are required')
      return
    }
    const result = await window.api.createStaff(newStaffName.trim(), newStaffPin.trim(), newStaffRole)
    if (!result.success) {
      setStaffActionError(result.error ?? 'Failed to create staff account')
      return
    }
    setNewStaffName('')
    setNewStaffPin('')
    setNewStaffRole('cashier')
    setShowAddStaffForm(false)
    await refresh()
  }

  const handleResetPin = async (staffId: number) => {
    setStaffActionError(null)
    if (!resetPinValue.trim()) {
      setStaffActionError('Enter a new PIN')
      return
    }
    const result = await window.api.resetStaffPin(staffId, resetPinValue.trim())
    if (!result.success) {
      setStaffActionError(result.error ?? 'Failed to reset PIN')
      return
    }
    setResetPinTargetId(null)
    setResetPinValue('')
  }

  const handleCheckForUpdates = async () => {
    setCheckingForUpdates(true)
    setUpdateCheckMessage(null)
    const result = await window.api.checkForUpdates()
    setUpdateCheckMessage(
      result.success
        ? "Checking — you'll see a toast if an update is found."
        : (result.error ?? 'Update check failed')
    )
    setCheckingForUpdates(false)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
            activeTab === 'overview' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          Overview
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('integrations')}
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition ${
            activeTab === 'integrations' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          Integrations
        </button>
      </div>

      {activeTab === 'integrations' ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-base font-semibold text-slate-800">M-Pesa &amp; eTIMS</h3>
          <p className="mb-4 text-sm text-slate-500">
            Saved to the local `integrations` table. Only mock providers are wired up as of
            Phase 9/10 — these values are ready for the real Daraja/eTIMS backends in a later
            phase.
          </p>

          {integrationsLoading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">M-Pesa</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">
                      Paybill Number
                    </label>
                    <input
                      type="text"
                      value={mpesaPaybill}
                      onChange={(e) => setMpesaPaybill(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">
                      Till Number
                    </label>
                    <input
                      type="text"
                      value={mpesaTill}
                      onChange={(e) => setMpesaTill(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">eTIMS</h4>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Middleware URL
                </label>
                <input
                  type="text"
                  value={etimsMiddlewareUrl}
                  onChange={(e) => setEtimsMiddlewareUrl(e.target.value)}
                  placeholder="http://localhost:9000"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                />
              </div>

              {integrationsMessage && (
                <p className="text-sm text-slate-500">{integrationsMessage}</p>
              )}

              <button
                type="button"
                onClick={() => void handleSaveIntegrationsConfig()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
              >
                Save Integration Settings
              </button>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'integrations' && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-base font-semibold text-slate-800">Shopify Admin API Token</h3>
          <p className="mb-4 text-sm text-slate-500">
            Stored in the Windows Credential Manager, never in a plaintext file (Phase 12). This
            field is write-only — the current value is never sent back here, only whether one is
            configured.
          </p>

          <p className="mb-3 text-sm font-medium">
            Status:{' '}
            <span className={shopifyTokenConfigured ? 'text-emerald-600' : 'text-amber-600'}>
              {shopifyTokenConfigured ? 'Configured' : 'Not configured'}
            </span>
          </p>

          <label className="mb-1 block text-xs font-medium text-slate-600">
            New Token (starts with shpat_)
          </label>
          <input
            type="password"
            value={shopifyTokenInput}
            onChange={(e) => setShopifyTokenInput(e.target.value)}
            placeholder="shpat_••••••••••••••••"
            className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
          />

          {shopifyTokenMessage && (
            <p className="mb-3 text-sm text-slate-500">{shopifyTokenMessage}</p>
          )}

          <button
            type="button"
            onClick={() => void handleSaveShopifyToken()}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
          >
            Save Token
          </button>
        </section>
      )}

      {activeTab === 'overview' && (
        <>
      {/* Today's Sales */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-base font-semibold text-slate-800">Today&apos;s Sales</h3>
        {loading || !dailySummary ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Orders</p>
              <p className="text-lg font-semibold text-slate-900">{dailySummary.orderCount}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Revenue</p>
              <p className="text-lg font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalRevenue)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Cash</p>
              <p className="text-lg font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalsByMethod.cash)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">M-Pesa / Card</p>
              <p className="text-lg font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalsByMethod.mpesa + dailySummary.totalsByMethod.card)}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Shift Controls */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">Shift Controls</h3>
          {currentShift ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Shift #{currentShift.id} open
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              No open shift
            </span>
          )}
        </div>

        {currentShift && (
          <p className="mb-3 text-sm text-slate-600">
            Opened {new Date(currentShift.clock_in).toLocaleString()} with{' '}
            {formatCurrency(currentShift.starting_cash)} starting cash.
          </p>
        )}

        {shiftActionError && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
            {shiftActionError}
          </p>
        )}

        {!currentShift && !showOpenForm && (
          <button
            type="button"
            onClick={() => setShowOpenForm(true)}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
          >
            Open Shift
          </button>
        )}

        {!currentShift && showOpenForm && (
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Starting Cash
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={startingCashInput}
                onChange={(e) => setStartingCashInput(e.target.value)}
                className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void handleOpenShift()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setShowOpenForm(false)
                setStartingCashInput('')
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        )}

        {currentShift && !showCloseForm && (
          <button
            type="button"
            onClick={() => setShowCloseForm(true)}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
          >
            Close Shift
          </button>
        )}

        {currentShift && showCloseForm && (
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Ending Cash (counted)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={endingCashInput}
                onChange={(e) => setEndingCashInput(e.target.value)}
                className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void handleCloseShift()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCloseForm(false)
                setEndingCashInput('')
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Staff Management */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">Staff</h3>
          <button
            type="button"
            onClick={() => setShowAddStaffForm((prev) => !prev)}
            className="text-sm font-medium text-rose-600 hover:text-rose-700"
          >
            {showAddStaffForm ? 'Cancel' : '+ Add Staff'}
          </button>
        </div>

        {staffActionError && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
            {staffActionError}
          </p>
        )}

        {showAddStaffForm && (
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
            <input
              type="text"
              placeholder="Name"
              value={newStaffName}
              onChange={(e) => setNewStaffName(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
            />
            <input
              type="password"
              placeholder="PIN"
              value={newStaffPin}
              onChange={(e) => setNewStaffPin(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
            />
            <select
              value={newStaffRole}
              onChange={(e) => setNewStaffRole(e.target.value as StaffRole)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
            >
              <option value="cashier">Cashier</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={() => void handleAddStaff()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Create
            </button>
          </div>
        )}

        <div className="space-y-2">
          {staffList.map((staff) => (
            <div
              key={staff.id}
              className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{staff.name}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-500">
                  {staff.role}
                </span>
              </div>

              {resetPinTargetId === staff.id ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    placeholder="New PIN"
                    value={resetPinValue}
                    onChange={(e) => setResetPinValue(e.target.value)}
                    className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => void handleResetPin(staff.id)}
                    className="text-sm font-medium text-rose-600 hover:text-rose-700"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResetPinTargetId(null)
                      setResetPinValue('')
                    }}
                    className="text-sm text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setResetPinTargetId(staff.id)}
                  className="text-sm font-medium text-slate-500 hover:text-slate-700"
                >
                  Reset PIN
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* App & Updates */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-base font-semibold text-slate-800">App &amp; Updates</h3>
        <button
          type="button"
          disabled={checkingForUpdates}
          onClick={() => void handleCheckForUpdates()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
        </button>
        {updateCheckMessage && (
          <p className="mt-2 text-sm text-slate-500">{updateCheckMessage}</p>
        )}
      </section>
        </>
      )}

      {zReport && <ZReportModal report={zReport} onClose={() => setZReport(null)} />}
    </div>
  )
}
