import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore.js'
import { useUnfiledCountStore } from '../stores/unfiledCountStore.js'
import { formatCurrency } from '../lib/currency.js'
import EmptyState from './EmptyState.js'
import ZReportModal from './ZReportModal.js'
import LocationPicker, { type ShopifyLocationOption } from './LocationPicker.js'
import { useProductStore } from '../stores/productStore.js'
import {
  LockIcon,
  ChartBarIcon,
  LinkIcon,
  PrinterIcon,
  CalendarIcon,
  DocumentChartIcon,
  WarningIcon,
  InboxIcon,
  PackageIcon
} from './icons.js'
import BackButton from './BackButton.js'
import SectionCardGrid, { type SectionCard } from './SectionCardGrid.js'
import MpesaLogsPage from '../pages/MpesaLogsPage.js'
import NeedsAttentionPage from '../pages/NeedsAttentionPage.js'
import StockTakePage from '../pages/StockTakePage.js'
import EndOfDayPage from '../pages/EndOfDayPage.js'
import ReportsPage from '../pages/ReportsPage.js'
import RestartCountdownModal from './RestartCountdownModal.js'
import { useKeyboardStore, type KeyboardMode } from '../stores/keyboardStore.js'
import type { DailySummary, ZReport } from '../../../main/services/reports.js'
import type {
  ShiftRow,
  StaffRole,
  StaffSummary,
  PrinterConfig,
  PrinterType
} from '../../../main/services/database.js'
import {
  DEFAULT_ETIMS_BASE_URL,
  DEFAULT_ETIMS_DEVICE_PORT,
  DEFAULT_ETIMS_VAT_CLASS,
  validateEtimsConnection
} from '../lib/etimsConfig.js'
import { MPESA_SMS_PARSER_READY } from '../lib/mpesaConfig.js'
import type { FiscalConnectionTestResult } from '../../../main/services/integrations/fiscal-connection-test.js'

/**
 * Opens the shared on-screen keyboard (`PosCheckoutPanel`,
 * `OnboardingScreen`, `EtimsSetupGate`) for one Admin field — a thin
 * wrapper over `useKeyboardStore.getState().open(...)`, kept only to
 * avoid repeating the same call shape at every one of this screen's
 * ~20 text fields (docs/phase-155). Every field it opens for stays a
 * `readOnly` input; the keyboard relays keystrokes back through
 * `onChange`, exactly as it always has.
 *
 * @param {string} value — the field's current value
 * @param {(next: string) => void} onChange — the field's own setter
 * @param {string} label — shown above the key grid
 * @param {object} [options]
 * @param {KeyboardMode} [options.mode] — defaults to `caps` (`useKeyboardStore`'s own default)
 * @param {boolean} [options.secret] — masks the echo, for a credential field
 * @param {number} [options.maxLength]
 */
function openField(
  value: string,
  onChange: (next: string) => void,
  label: string,
  options: { mode?: KeyboardMode; secret?: boolean; maxLength?: number } = {}
): void {
  useKeyboardStore.getState().open({ value, onChange, label, ...options })
}

/** Every top-level Admin section, in card-grid order (phase-167). */
type AdminTabKey =
  | 'overview'
  | 'integrations'
  | 'peripherals'
  | 'mpesaLogs'
  | 'needsAttention'
  | 'stockTake'
  | 'endOfDay'
  | 'reports'
  | 'system'

/** Every Integrations sub-section, in card-grid order (phase-167). */
type IntegrationSectionKey = 'shopify' | 'location' | 'fiscal' | 'mpesa' | 'printer'

/**
 * The Admin card grid's contents (phase-167 Part A) — icon and title
 * only, per the brief. `unfiledCount` is threaded in so Needs
 * Attention's card can carry the same badge `NavStatusButton` already
 * shows for it, without a second source of truth.
 *
 * @param {number | null} unfiledCount
 * @returns {SectionCard<AdminTabKey>[]}
 */
function adminSections(unfiledCount: number | null): SectionCard<AdminTabKey>[] {
  return [
    { key: 'overview', label: 'Overview', icon: <ChartBarIcon className="h-8 w-8" /> },
    { key: 'integrations', label: 'Integrations', icon: <LinkIcon className="h-8 w-8" /> },
    { key: 'peripherals', label: 'Peripherals', icon: <PrinterIcon className="h-8 w-8" /> },
    { key: 'mpesaLogs', label: 'M-Pesa Logs', icon: <InboxIcon className="h-8 w-8" /> },
    {
      key: 'needsAttention',
      label: 'Needs Attention',
      icon: <WarningIcon className="h-8 w-8" />,
      badge: unfiledCount ?? undefined
    },
    { key: 'stockTake', label: 'Stock Take', icon: <PackageIcon className="h-8 w-8" /> },
    { key: 'endOfDay', label: 'End of Day', icon: <CalendarIcon className="h-8 w-8" /> },
    { key: 'reports', label: 'Reports', icon: <DocumentChartIcon className="h-8 w-8" /> },
    { key: 'system', label: 'System', icon: <LockIcon className="h-8 w-8" /> }
  ]
}

/** Integrations' own card grid contents (phase-167 Part A item 3). */
const INTEGRATION_SECTIONS: SectionCard<IntegrationSectionKey>[] = [
  { key: 'shopify', label: 'Shopify', icon: <LinkIcon className="h-8 w-8" /> },
  { key: 'location', label: 'Location', icon: <PackageIcon className="h-8 w-8" /> },
  { key: 'fiscal', label: 'Fiscal Device', icon: <LockIcon className="h-8 w-8" /> },
  { key: 'mpesa', label: 'M-Pesa', icon: <InboxIcon className="h-8 w-8" /> },
  { key: 'printer', label: 'Printer', icon: <PrinterIcon className="h-8 w-8" /> }
]

interface AdminScreenProps {
  /**
   * Opens the Manager PIN gate; calls `onAuthorized` with the
   * authorizing admin's id and PIN once verified. Staff
   * creation, PIN resets, and integration config changes all route
   * through this so the credentials can be forwarded to the main
   * process's `requireAdminPin` re-check — the renderer's own
   * `currentStaff.role === 'admin'` gate below is UI-only and not a
   * substitute for it.
   */
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
  /**
   * Opens directly on a specific tab instead of Overview — used by the
   * header's unfiled-sales row (inside `NavStatusButton`'s status
   * dialog) so tapping it jumps straight to the list, rather than
   * requiring an extra tap once inside Admin.
   * Read once at mount only (this screen unmounts on every navigation
   * away from Admin, so a fresh value here always takes effect for the
   * next visit).
   */
  initialTab?: 'needsAttention'
}

/**
 * Back-office screen for managers/admins: today's sales, staff
 * management, and till-shift controls (open/close with cash
 * reconciliation, triggering the Z-report).
 *
 * Access is gated on `currentStaff.role === 'admin'` — enforced both
 * by `App.tsx` (no nav entry for non-admins) and here (defense in
 * depth, in case navigation state outlives a role switch). Privileged
 * writes (staff create/PIN reset, integration config) additionally
 * re-verify a Manager PIN server-side via `requireAdminPin` rather
 * than trusting this screen-level gate alone.
 *
 * @param {AdminScreenProps} props
 * @returns {JSX.Element}
 */
export default function AdminScreen({ requestManagerPin, initialTab }: AdminScreenProps) {
  const currentStaff = useAuthStore((state) => state.currentStaff)
  const unfiledCount = useUnfiledCountStore((state) => state.count)

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

  const [resettingConfig, setResettingConfig] = useState(false)
  const [resetConfigError, setResetConfigError] = useState<string | null>(null)

  /**
   * `null` shows the card grid (phase-167); a section is only ever
   * entered by picking its card, so every existing
   * `{activeTab === '...' && (...)}` block below is completely
   * unchanged — only what decides which one renders (a card tap, not a
   * tab click) is new.
   */
  const [activeTab, setActiveTab] = useState<AdminTabKey | null>(initialTab ?? null)
  /**
   * Which Integrations section is on screen (Phase E2(e)) — the tab used
   * to show Shopify/Location/Fiscal device/M-Pesa/Printer all at once,
   * whose combined height was measured overflowing by ~2200px at scale 1
   * (phase-142). Each now renders alone; none of their state or save
   * handlers changed, only which one is visible at a time.
   *
   * `null` shows Integrations' own card grid (phase-167), same reasoning
   * as `activeTab` above.
   */
  const [integrationSection, setIntegrationSection] = useState<IntegrationSectionKey | null>(null)
  const [mpesaConsumerKey, setMpesaConsumerKey] = useState('')
  const [mpesaShortcode, setMpesaShortcode] = useState('')
  const [mpesaEnvironment, setMpesaEnvironment] = useState<'sandbox' | 'production'>('sandbox')
  const [mpesaCallbackUrl, setMpesaCallbackUrl] = useState('')
  /**
   * How this till confirms an M-Pesa payment, and where the messages
   * arrive when it does so by message. Defaults to `'manual'` — the
   * cashier reads the code off the customer's own phone, with no
   * request or verification call to anyone — matching the main
   * process's own default (`resolveMpesaProvider`,
   * `mpesaIntegrationConfigSchema`) for a fresh/never-configured till.
   *
   * Loaded and saved alongside the Daraja fields on purpose: saving an
   * integration replaces the whole stored row, so an Admin screen that
   * sent only the Daraja fields would switch a message-based till back to
   * manual and erase its folder, discovered only when payments stopped
   * confirming.
   */
  const [mpesaConfirmationMethod, setMpesaConfirmationMethod] = useState<
    'manual' | 'daraja' | 'sms'
  >('manual')
  const [mpesaSmsInboxPath, setMpesaSmsInboxPath] = useState('')
  /**
   * Whether this till may also complete a sale on a manually entered
   * Daraja/SMS code nobody confirmed — the older fallback alongside a
   * confirming method, never instead of one. Meaningless, and hidden,
   * when `mpesaConfirmationMethod` is already `'manual'`: that mode
   * already works exactly this way for every sale.
   */
  const [mpesaManualEntryEnabled, setMpesaManualEntryEnabled] = useState(false)
  const [mpesaConsumerSecretInput, setMpesaConsumerSecretInput] = useState('')
  const [mpesaPasskeyInput, setMpesaPasskeyInput] = useState('')
  const [mpesaConsumerSecretConfigured, setMpesaConsumerSecretConfigured] = useState(false)
  const [mpesaPasskeyConfigured, setMpesaPasskeyConfigured] = useState(false)
  const [mpesaTesting, setMpesaTesting] = useState(false)
  const [mpesaTestMessage, setMpesaTestMessage] = useState<string | null>(null)
  const [etimsBaseUrl, setEtimsBaseUrl] = useState('')
  const [etimsDeviceIp, setEtimsDeviceIp] = useState('')
  const [etimsDevicePort, setEtimsDevicePort] = useState('')
  /** Blank means "leave the stored password alone" — it is never read back from the vault. */
  const [etimsPassword, setEtimsPassword] = useState('')
  const [etimsPasswordConfigured, setEtimsPasswordConfigured] = useState(false)
  const [etimsDefaultVatClass, setEtimsDefaultVatClass] = useState('')
  /** Per-field validation messages, keyed by field, cleared on every save attempt. */
  const [etimsFieldErrors, setEtimsFieldErrors] = useState<Record<string, string>>({})
  const [etimsTesting, setEtimsTesting] = useState(false)
  const [etimsTestResult, setEtimsTestResult] = useState<FiscalConnectionTestResult | null>(null)
  const [etimsTestError, setEtimsTestError] = useState<string | null>(null)

  const [storeName, setStoreName] = useState('')
  const [storeKraPin, setStoreKraPin] = useState('')

  /**
   * Whether this till has everything it needs to file a sale. Mirrors
   * `RealFiscalizationProvider.isConfigured` — the password comes from
   * the vault-backed status flag, never from a form value.
   */
  const etimsReady =
    Boolean(etimsBaseUrl.trim()) &&
    Boolean(etimsDeviceIp.trim()) &&
    Boolean(etimsDevicePort.trim()) &&
    etimsPasswordConfigured
  const [integrationsLoading, setIntegrationsLoading] = useState(false)
  /**
   * One message/saving flag per Admin Integrations save action (Phase
   * 148 step 1) — M-Pesa, Fiscal Device and Store Details used to share
   * a single `integrationsMessage` because one handler saved all three
   * together. Each is now independent so a failure or restart prompt in
   * one section never appears under, or is caused by, another.
   */
  const [mpesaMessage, setMpesaMessage] = useState<string | null>(null)
  const [mpesaSaving, setMpesaSaving] = useState(false)
  const [fiscalMessage, setFiscalMessage] = useState<string | null>(null)
  const [fiscalSaving, setFiscalSaving] = useState(false)
  const [storeIdentityMessage, setStoreIdentityMessage] = useState<string | null>(null)
  const [storeIdentitySaving, setStoreIdentitySaving] = useState(false)

  const [printers, setPrinters] = useState<PrinterConfig[]>([])
  const [printersLoading, setPrintersLoading] = useState(false)
  const [newPrinterId, setNewPrinterId] = useState('')
  const [newPrinterType, setNewPrinterType] = useState<PrinterType>('receipt')
  const [newPrinterInterface, setNewPrinterInterface] = useState('')
  const [printerActionError, setPrinterActionError] = useState<string | null>(null)
  const [printerTestMessages, setPrinterTestMessages] = useState<Record<string, string>>({})
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null)

  const [shopifyTokenConfigured, setShopifyTokenConfigured] = useState(false)
  const [shopifyTokenInput, setShopifyTokenInput] = useState('')
  const [shopifyTokenMessage, setShopifyTokenMessage] = useState<string | null>(null)

  const [shopifyStoreUrl, setShopifyStoreUrlInput] = useState('')
  const [shopifyStoreUrlMessage, setShopifyStoreUrlMessage] = useState<string | null>(null)

  const [currentLocationName, setCurrentLocationName] = useState<string | null>(null)
  const [currentLocationId, setCurrentLocationId] = useState<string | null>(null)
  const [changingLocation, setChangingLocation] = useState(false)
  const [locationOptions, setLocationOptions] = useState<ShopifyLocationOption[]>([])
  const [locationShopName, setLocationShopName] = useState('')
  const [locationOptionsLoading, setLocationOptionsLoading] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [locationSaving, setLocationSaving] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const [mockMpesaFlag, setMockMpesaFlag] = useState(true)
  /** Mirrors the main process: eTIMS defaults to REAL when no config row exists. */
  const [mockEtimsFlag, setMockEtimsFlag] = useState(false)
  const [startupConfigLoading, setStartupConfigLoading] = useState(false)
  const [startupConfigSaving, setStartupConfigSaving] = useState(false)
  const [startupConfigMessage, setStartupConfigMessage] = useState<string | null>(null)
  const [showRestartModal, setShowRestartModal] = useState(false)

  /** M-Pesa's own slice of the Integrations tab — reloaded after an M-Pesa save, never after a Fiscal or Store Details one. */
  const loadMpesaConfig = async () => {
    const [mpesaResult, mpesaCredStatusResult] = await Promise.all([
      window.api.getIntegrationConfig('mpesa'),
      window.api.getMpesaCredentialStatus()
    ])
    if (mpesaResult.success && mpesaResult.data) {
      setMpesaConsumerKey(String(mpesaResult.data.consumerKey ?? ''))
      setMpesaShortcode(String(mpesaResult.data.shortcode ?? ''))
      setMpesaEnvironment(mpesaResult.data.environment === 'production' ? 'production' : 'sandbox')
      setMpesaCallbackUrl(String(mpesaResult.data.callbackUrl ?? ''))
      setMpesaConfirmationMethod(
        mpesaResult.data.confirmationMethod === 'sms'
          ? 'sms'
          : mpesaResult.data.confirmationMethod === 'daraja'
            ? 'daraja'
            : 'manual'
      )
      setMpesaSmsInboxPath(String(mpesaResult.data.smsInboxPath ?? ''))
      setMpesaManualEntryEnabled(mpesaResult.data.manualEntryEnabled === true)
    }
    if (mpesaCredStatusResult.success && mpesaCredStatusResult.data) {
      setMpesaConsumerSecretConfigured(mpesaCredStatusResult.data.consumerSecretConfigured)
      setMpesaPasskeyConfigured(mpesaCredStatusResult.data.passkeyConfigured)
    }
  }

  /** Fiscal device's own slice of the Integrations tab — reloaded after a Fiscal save, never after an M-Pesa or Store Details one. */
  const loadFiscalConfig = async () => {
    const [etimsResult, etimsSecretStatusResult] = await Promise.all([
      window.api.getIntegrationConfig('etims'),
      window.api.getEtimsSecretStatus()
    ])
    if (etimsResult.success && etimsResult.data) {
      const config = etimsResult.data
      setEtimsBaseUrl(String(config.baseUrl ?? ''))
      setEtimsDeviceIp(String(config.deviceIp ?? ''))
      setEtimsDevicePort(String(config.devicePort ?? ''))
      setEtimsDefaultVatClass(String(config.defaultVatClass ?? ''))
      // The password is deliberately not read back — it lives in the
      // credential vault and never crosses to the renderer. The box
      // stays blank and only its "configured" status is shown.
      setEtimsFieldErrors({})
    }
    if (etimsSecretStatusResult.success && etimsSecretStatusResult.data) {
      setEtimsPasswordConfigured(etimsSecretStatusResult.data.passwordConfigured)
    }
  }

  /** Store Details' own slice of the Integrations tab — reloaded after a Store Details save, never after an M-Pesa or Fiscal one. */
  const loadStoreIdentityConfig = async () => {
    const storeIdentityResult = await window.api.getStoreIdentity()
    if (storeIdentityResult.success && storeIdentityResult.data) {
      setStoreName(storeIdentityResult.data.storeName)
      setStoreKraPin(storeIdentityResult.data.storeKraPin)
    }
  }

  /**
   * Initial paint of the whole Integrations tab: fires every section's
   * loader together, purely for a fast first render — this is not the
   * cross-section reload the split above removes. No save handler calls
   * this; each calls only its own section's loader (see above).
   */
  const loadIntegrationsConfig = async () => {
    setIntegrationsLoading(true)
    await Promise.all([
      loadMpesaConfig(),
      loadFiscalConfig(),
      loadStoreIdentityConfig(),
      (async () => {
        const tokenStatusResult = await window.api.getShopifyTokenStatus()
        if (tokenStatusResult.success && tokenStatusResult.data) {
          setShopifyTokenConfigured(tokenStatusResult.data.configured)
        }
      })(),
      (async () => {
        const storeUrlResult = await window.api.getShopifyStoreUrl()
        if (storeUrlResult.success && storeUrlResult.data) {
          setShopifyStoreUrlInput(storeUrlResult.data.storeUrl ?? '')
        }
      })(),
      (async () => {
        const configStatusResult = await window.api.getConfigStatus()
        if (configStatusResult.success && configStatusResult.data?.config) {
          setCurrentLocationId(configStatusResult.data.config.locationId)
          setCurrentLocationName(configStatusResult.data.config.locationName)
        }
      })()
    ])
    setIntegrationsLoading(false)
  }

  /** Opens the inline "Change Location" picker, fetching this till's current Shopify locations. */
  const handleOpenChangeLocation = () => {
    setChangingLocation(true)
    setLocationError(null)
    setLocationOptionsLoading(true)
    void window.api.listLocations().then((result) => {
      setLocationOptionsLoading(false)
      if (!result.success || !result.data) {
        setLocationError(result.error ?? 'Could not fetch locations from Shopify')
        return
      }
      setLocationShopName(result.data.shopName)
      setLocationOptions(result.data.locations)
      const preselect = result.data.locations.find((l) => l.id === currentLocationId)
      setSelectedLocationId(
        preselect?.id ?? (result.data.locations.length === 1 ? result.data.locations[0].id : '')
      )
    })
  }

  /**
   * Saves the newly picked location — routes through `ManagerPinModal`,
   * the same pattern as every other privileged Admin-screen write.
   */
  const handleConfirmChangeLocation = () => {
    const location = locationOptions.find((l) => l.id === selectedLocationId)
    if (!location) {
      setLocationError('Select a location')
      return
    }
    requestManagerPin('Change till location', (managerId, managerPin) => {
      setLocationSaving(true)
      setLocationError(null)
      void window.api
        .setLocation(location.id, location.name, managerId, managerPin)
        .then((result) => {
          if (!result.success) {
            setLocationError(result.error ?? 'Failed to save location')
            return
          }
          setCurrentLocationId(location.id)
          setCurrentLocationName(location.name)
          setChangingLocation(false)
          // The catalog cache was cleared server-side for the old
          // location — re-fetch now so the Catalog tab shows the new
          // location's live assortment/stock immediately.
          void useProductStore.getState().fetchProducts()
        })
        .finally(() => setLocationSaving(false))
    })
  }

  /**
   * Saves the Shopify store URL to the local settings table — routes
   * through `ManagerPinModal`, matching every other privileged
   * Admin-screen write. Unlike the API token, the field is pre-filled
   * with the current value on load,
   * since the store URL isn't a secret.
   */
  const handleSaveShopifyStoreUrl = () => {
    setShopifyStoreUrlMessage(null)
    const trimmed = shopifyStoreUrl.trim()
    if (!trimmed) {
      setShopifyStoreUrlMessage('Enter a store URL')
      return
    }
    requestManagerPin('Save Shopify store URL', (managerId, managerPin) => {
      void (async () => {
        const result = await window.api.setShopifyStoreUrl(trimmed, managerId, managerPin)
        setShopifyStoreUrlMessage(
          result.success ? 'Store URL saved.' : (result.error ?? 'Failed to save store URL')
        )
      })()
    })
  }

  /**
   * Saves a new Shopify Admin API token to the OS credential vault.
   * The input is intentionally write-only — the
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

  /** Loads every configured printer for the Peripherals tab. */
  const loadPrinters = async () => {
    setPrintersLoading(true)
    const result = await window.api.getPrinters()
    if (result.success && result.data) setPrinters(result.data)
    setPrintersLoading(false)
  }

  /** Loads the M-Pesa/eTIMS mock-vs-real toggles for the System tab's "Startup Configuration" panel. */
  const loadStartupConfigs = async () => {
    setStartupConfigLoading(true)
    const result = await window.api.getAllConfigs()
    if (result.success && result.data) {
      setMockMpesaFlag(result.data.mock_mpesa_enabled !== 'false')
      // Absent row means REAL for eTIMS, so this reads the opposite way to M-Pesa.
      setMockEtimsFlag(result.data.mock_etims_enabled === 'true')
    }
    setStartupConfigLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'integrations') void loadIntegrationsConfig()
    // Printer registration moved from Peripherals into Integrations >
    // Printer (Phase E2(e)); loaded once that section is actually on
    // screen, same as every other section's data.
    if (activeTab === 'integrations' && integrationSection === 'printer') void loadPrinters()
    if (activeTab === 'system') void loadStartupConfigs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, integrationSection])

  /**
   * Saves the M-Pesa/eTIMS mock-vs-real toggles to `app_configurations`
   * and, on success, shows `RestartCountdownModal` — both providers
   * are constructed once at startup, so the change has no effect
   * until the app relaunches.
   */
  const handleSaveStartupConfigs = () => {
    setStartupConfigMessage(null)
    requestManagerPin('Save startup configuration', (managerId, managerPin) => {
      void (async () => {
        setStartupConfigSaving(true)
        try {
          const [mpesaResult, etimsResult] = await Promise.all([
            window.api.setConfig(
              'mock_mpesa_enabled',
              String(mockMpesaFlag),
              { requiresRestart: true, category: 'mpesa' },
              managerId,
              managerPin
            ),
            window.api.setConfig(
              'mock_etims_enabled',
              String(mockEtimsFlag),
              { requiresRestart: true, category: 'etims' },
              managerId,
              managerPin
            )
          ])
          if (!mpesaResult.success || !etimsResult.success) {
            setStartupConfigMessage(
              mpesaResult.error ?? etimsResult.error ?? 'Failed to save configuration'
            )
            return
          }
          setShowRestartModal(true)
        } finally {
          setStartupConfigSaving(false)
        }
      })()
    })
  }

  /**
   * Saves only the M-Pesa integration row (Phase 148 step 1 — this used
   * to be bundled with Fiscal Device and Store Details behind one
   * handler and one fiscal-only validation gate, so a till could not
   * save M-Pesa settings at all until its fiscal device IP/port were
   * already valid; phase-147 Part 6 #5). Validates only M-Pesa's own
   * fields — it must succeed with the fiscal fields blank or invalid.
   *
   * M-Pesa's resolved provider and credentials are read once at boot
   * (phase-147 §2.6: no `applyMpesaConfigToProvider` exists), so unlike
   * the Fiscal save this cannot hot-apply — it prompts for a restart
   * instead of claiming "Settings saved." while the old values are
   * still live.
   */
  const handleSaveMpesaConfig = () => {
    setMpesaMessage(null)
    const consumerKey = mpesaConsumerKey.trim()
    const shortcode = mpesaShortcode.trim()
    const callbackUrl = mpesaCallbackUrl.trim()
    const consumerSecret = mpesaConsumerSecretInput.trim()
    const passkey = mpesaPasskeyInput.trim()

    requestManagerPin('Save M-Pesa settings', (managerId, managerPin) => {
      void (async () => {
        setMpesaSaving(true)
        try {
          const calls = [
            window.api.setIntegrationConfig(
              'mpesa',
              {
                consumerKey,
                shortcode,
                environment: mpesaEnvironment,
                callbackUrl: callbackUrl || undefined,
                confirmationMethod: mpesaConfirmationMethod,
                smsInboxPath: mpesaSmsInboxPath.trim() || undefined,
                manualEntryEnabled: mpesaManualEntryEnabled
              },
              managerId,
              managerPin
            )
          ]
          // A blank box means "leave the stored value alone", so a
          // credential call is only made when something was typed.
          if (consumerSecret || passkey) {
            calls.push(
              window.api.setMpesaCredentials(
                { consumerSecret: consumerSecret || undefined, passkey: passkey || undefined },
                managerId,
                managerPin
              )
            )
          }

          const results = await Promise.all(calls)
          const failed = results.find((result) => !result.success)
          if (failed) {
            setMpesaMessage(failed.error ?? 'Failed to save M-Pesa settings')
            return
          }
          setMpesaConsumerSecretInput('')
          setMpesaPasskeyInput('')
          await loadMpesaConfig()
          setShowRestartModal(true)
        } finally {
          setMpesaSaving(false)
        }
      })()
    })
  }

  /**
   * Saves only the Fiscal Device integration row (Phase 148 step 1).
   * Validates only fiscal fields — an M-Pesa field is never read here.
   * Fiscal changes hot-apply via `applyEtimsConfigToProvider()`
   * server-side, so this keeps the immediate "Settings saved." message
   * rather than the M-Pesa save's restart prompt.
   */
  const handleSaveFiscalConfig = () => {
    setFiscalMessage(null)
    setEtimsTestResult(null)
    setEtimsTestError(null)
    const baseUrl = etimsBaseUrl.trim() || DEFAULT_ETIMS_BASE_URL
    const deviceIp = etimsDeviceIp.trim()
    const devicePort = etimsDevicePort.trim() || DEFAULT_ETIMS_DEVICE_PORT
    const password = etimsPassword.trim()
    const defaultVatClass = etimsDefaultVatClass.trim() || DEFAULT_ETIMS_VAT_CLASS

    // Validate before asking for a manager PIN — no point interrupting
    // someone for a PIN only to reject the form afterwards. Device IP has
    // no default on purpose: silently substituting one would store a
    // wrong address that looks configured.
    const fieldErrors = validateEtimsConnection({ baseUrl, deviceIp, devicePort })
    if (fieldErrors.length > 0) {
      setEtimsFieldErrors(
        Object.fromEntries(fieldErrors.map((error) => [error.field, error.message]))
      )
      setFiscalMessage('Check the highlighted fiscal device details above.')
      return
    }
    setEtimsFieldErrors({})

    requestManagerPin('Save fiscal device settings', (managerId, managerPin) => {
      void (async () => {
        setFiscalSaving(true)
        try {
          const calls = [
            window.api.setIntegrationConfig(
              'etims',
              { baseUrl, deviceIp, devicePort, defaultVatClass },
              managerId,
              managerPin
            )
          ]
          // A blank password box means "leave the stored one alone", so it
          // is only sent when the manager actually typed a new one.
          if (password) {
            calls.push(window.api.setEtimsPassword(password, managerId, managerPin))
          }

          const results = await Promise.all(calls)
          const failed = results.find((result) => !result.success)
          setFiscalMessage(
            failed ? (failed.error ?? 'Failed to save fiscal device settings') : 'Settings saved.'
          )
          if (!failed) {
            setEtimsPassword('')
            await loadFiscalConfig()
          }
        } finally {
          setFiscalSaving(false)
        }
      })()
    })
  }

  /**
   * Saves only the store name/KRA PIN printed on receipts (Phase 148
   * step 1 — split out of the combined save so a failing Store Details
   * write, e.g. a bad KRA-PIN format server-side, cannot be mistaken for
   * an M-Pesa or Fiscal Device failure, and vice versa).
   */
  const handleSaveStoreIdentity = () => {
    setStoreIdentityMessage(null)
    requestManagerPin('Save store details', (managerId, managerPin) => {
      void (async () => {
        setStoreIdentitySaving(true)
        try {
          const result = await window.api.setStoreIdentity(
            { storeName: storeName.trim(), storeKraPin: storeKraPin.trim() },
            managerId,
            managerPin
          )
          setStoreIdentityMessage(
            result.success ? 'Store details saved.' : (result.error ?? 'Failed to save store details')
          )
          if (result.success) await loadStoreIdentityConfig()
        } finally {
          setStoreIdentitySaving(false)
        }
      })()
    })
  }

  /**
   * Runs the three-hop fiscal device check behind the "Test connection"
   * button — the action a branch presses at go-live once the real device
   * details are in.
   */
  const handleTestEtimsConnection = async () => {
    setEtimsTestResult(null)
    setEtimsTestError(null)
    setEtimsTesting(true)
    try {
      const result = await window.api.testEtimsConnection()
      if (result.success && result.data) {
        setEtimsTestResult(result.data)
      } else {
        setEtimsTestError(result.error ?? 'Could not test the fiscal device connection.')
      }
    } finally {
      setEtimsTesting(false)
    }
  }

  /**
   * Verifies the currently saved Daraja credentials via an OAuth2
   * token exchange only (no STK Push, no charge) — the Integrations
   * tab's "Test Connection" action.
   */
  const handleTestMpesaConnection = async () => {
    setMpesaTestMessage(null)
    setMpesaTesting(true)
    try {
      const result = await window.api.testMpesaConnection()
      setMpesaTestMessage(
        result.success
          ? 'Daraja credentials verified successfully.'
          : (result.error ?? 'Connection test failed')
      )
    } finally {
      setMpesaTesting(false)
    }
  }

  /**
   * Validates the new-printer form, then routes through
   * `ManagerPinModal` (the same pattern as other privileged writes) so
   * `savePrinter` can forward a re-verifiable `managerId`/`managerPin`
   * to the main process.
   */
  const handleAddPrinter = () => {
    setPrinterActionError(null)
    if (!newPrinterId.trim() || !newPrinterInterface.trim()) {
      setPrinterActionError('Printer id and interface are required')
      return
    }
    const config: PrinterConfig = {
      id: newPrinterId.trim(),
      type: newPrinterType,
      interfaceName: newPrinterInterface.trim(),
      enabled: true
    }
    requestManagerPin('Add printer', (managerId, managerPin) => {
      void (async () => {
        const result = await window.api.savePrinter(config, managerId, managerPin)
        if (!result.success) {
          setPrinterActionError(result.error ?? 'Failed to save printer')
          return
        }
        setNewPrinterId('')
        setNewPrinterInterface('')
        setNewPrinterType('receipt')
        await loadPrinters()
      })()
    })
  }

  /**
   * Routes through `ManagerPinModal` so `deletePrinter` can forward a
   * re-verifiable `managerId`/`managerPin` to the main process.
   *
   * @param {string} id
   */
  const handleDeletePrinter = (id: string) => {
    setPrinterActionError(null)
    requestManagerPin(`Remove printer ${id}`, (managerId, managerPin) => {
      void (async () => {
        const result = await window.api.deletePrinter(id, managerId, managerPin)
        if (!result.success) {
          setPrinterActionError(result.error ?? 'Failed to delete printer')
          return
        }
        await loadPrinters()
      })()
    })
  }

  /**
   * Sends a test page to `interfaceName` — no Manager PIN required,
   * since this is a read-only connectivity check (see `printerTestSchema`).
   *
   * @param {string} id
   * @param {string} interfaceName
   */
  const handleTestPrinter = (id: string, interfaceName: string) => {
    setTestingPrinterId(id)
    void (async () => {
      try {
        const result = await window.api.testPrinter(interfaceName)
        setPrinterTestMessages((prev) => ({
          ...prev,
          [id]: result.success ? 'Test page sent successfully.' : (result.error ?? 'Test failed')
        }))
      } finally {
        setTestingPrinterId(null)
      }
    })()
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
        icon={<LockIcon className="h-10 w-10" />}
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

  /**
   * Validates the new-staff form, then routes through `ManagerPinModal`
   * so `createStaff` can forward a re-verifiable
   * `managerId`/`managerPin` to the main process.
   */
  const handleAddStaff = () => {
    setStaffActionError(null)
    if (!newStaffName.trim() || !newStaffPin.trim()) {
      setStaffActionError('Name and PIN are required')
      return
    }
    const name = newStaffName.trim()
    const pin = newStaffPin.trim()
    requestManagerPin('Create staff account', (managerId, managerPin) => {
      void (async () => {
        const result = await window.api.createStaff(name, pin, newStaffRole, managerId, managerPin)
        if (!result.success) {
          setStaffActionError(result.error ?? 'Failed to create staff account')
          return
        }
        setNewStaffName('')
        setNewStaffPin('')
        setNewStaffRole('cashier')
        setShowAddStaffForm(false)
        await refresh()
      })()
    })
  }

  /**
   * Validates the reset-PIN form, then routes through `ManagerPinModal`
   * so `resetStaffPin` can forward a re-verifiable
   * `managerId`/`managerPin` to the main process.
   *
   * @param {number} staffId
   */
  const handleResetPin = (staffId: number) => {
    setStaffActionError(null)
    if (!resetPinValue.trim()) {
      setStaffActionError('Enter a new PIN')
      return
    }
    const newPin = resetPinValue.trim()
    requestManagerPin('Reset staff PIN', (managerId, managerPin) => {
      void (async () => {
        const result = await window.api.resetStaffPin(staffId, newPin, managerId, managerPin)
        if (!result.success) {
          setStaffActionError(result.error ?? 'Failed to reset PIN')
          return
        }
        setResetPinTargetId(null)
        setResetPinValue('')
      })()
    })
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

  /**
   * Clears this till's Shopify connection — the
   * counterpart to the first-run `OnboardingScreen`. Requires a
   * re-verified admin Manager PIN since there is no undo: reloading
   * the window afterward brings the onboarding wizard back.
   */
  const handleResetConfig = () => {
    requestManagerPin('Reset Shopify configuration', (managerId, managerPin) => {
      void (async () => {
        setResetConfigError(null)
        setResettingConfig(true)
        try {
          const result = await window.api.clearConfig(managerId, managerPin)
          if (!result.success) {
            setResetConfigError(result.error ?? 'Failed to reset configuration')
            return
          }
          window.location.reload()
        } catch (err) {
          setResetConfigError(err instanceof Error ? err.message : 'Failed to reset configuration')
        } finally {
          setResettingConfig(false)
        }
      })()
    })
  }

  return (
    <div className="h-full min-h-full w-full space-y-6">
      {activeTab === null ? (
        <SectionCardGrid sections={adminSections(unfiledCount)} onSelect={setActiveTab} />
      ) : (
        <BackButton label="Back to Admin" onClick={() => setActiveTab(null)} />
      )}

      {activeTab === 'mpesaLogs' && <MpesaLogsPage />}

      {activeTab === 'needsAttention' && <NeedsAttentionPage />}

      {activeTab === 'stockTake' && <StockTakePage />}

      {activeTab === 'endOfDay' && <EndOfDayPage />}

      {activeTab === 'reports' && <ReportsPage />}

      {activeTab === 'system' && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-2xl font-bold text-slate-800">Startup Configuration</h3>
          <p className="mb-4 text-base text-slate-500">
            Selects which providers this till talks to. Both are constructed once at startup, so
            a change here only takes effect after a restart.
          </p>

          {startupConfigLoading ? (
            <p className="text-base text-slate-400">Loading…</p>
          ) : (
            <div className="space-y-3">
              <label className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-3">
                <span className="text-lg font-medium text-slate-700">Use Mock M-Pesa</span>
                <input
                  type="checkbox"
                  checked={mockMpesaFlag}
                  onChange={(e) => setMockMpesaFlag(e.target.checked)}
                  className="h-6 w-6 accent-rose-600"
                />
              </label>
              {/* Development only. A packaged build never ships the mock fiscalization
                  provider, so this toggle would be inert — Vite drops the block at build time. */}
              {import.meta.env.DEV && (
                <label className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-3">
                  <span className="text-lg font-medium text-slate-700">Use Mock eTIMS</span>
                  <input
                    type="checkbox"
                    checked={mockEtimsFlag}
                    onChange={(e) => setMockEtimsFlag(e.target.checked)}
                    className="h-6 w-6 accent-rose-600"
                  />
                </label>
              )}

              {startupConfigMessage && (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
                  {startupConfigMessage}
                </p>
              )}

              <button
                type="button"
                disabled={startupConfigSaving}
                onClick={handleSaveStartupConfigs}
                className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {startupConfigSaving ? 'Saving…' : 'Save & Restart'}
              </button>
            </div>
          )}
        </section>
      )}

      {activeTab === 'system' && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-2xl font-bold text-slate-800">Reset Configuration</h3>
          <p className="mb-4 text-base text-slate-500">
            Clears this till's saved Shopify store URL, Admin API token, and confirmed
            location, then returns it to first-run setup. Use this to point the till at a
            different store — there is no undo. To just switch locations on the same store,
            use "Change Location" above instead.
          </p>

          {resetConfigError && (
            <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {resetConfigError}
            </p>
          )}

          <button
            type="button"
            disabled={resettingConfig}
            onClick={handleResetConfig}
            className="h-12 rounded-lg border border-rose-300 px-4 text-lg font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resettingConfig ? 'Resetting…' : 'Reset Configuration'}
          </button>
        </section>
      )}

      {activeTab === 'peripherals' && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-2xl font-bold text-slate-800">Barcode Scanner Stations</h3>
 
          <ol className="list-inside list-decimal space-y-1 text-base text-slate-600">
            <li>
              Open the Datalogic QD2100 programming guide and find the barcode for
              &quot;Add Prefix&quot;.
            </li>
            <li>
              Scan the &quot;Add Prefix&quot; barcode, then scan the characters for the station's
              prefix — <code className="rounded bg-slate-100 px-1">SC1:</code> for till 1,{' '}
              <code className="rounded bg-slate-100 px-1">SC2:</code> for till 2, or{' '}
              <code className="rounded bg-slate-100 px-1">KITCHEN:</code> for a back-of-house unit
              — then scan &quot;Save&quot; to commit the change.
            </li>
            <li>
              Every scan from that unit now arrives prefixed automatically — no app restart or
              configuration needed here.
            </li>
          </ol>
          <p className="mt-3 text-sm text-slate-400">
            A scanner that is never programmed keeps working exactly as before, labeled
            &quot;UNKNOWN&quot; internally.
          </p>
        </section>
      )}

      {activeTab === 'integrations' && (
        /**
         * One section on screen at a time (Phase E2(e)) — Shopify,
         * Location, Fiscal device, M-Pesa and Printer used to render
         * stacked together here, measuring ~2200-2529px tall at scale 1
         * (phase-142). M-Pesa, Fiscal Device and Store Details save
         * independently as of phase-148 step 1 — `handleSaveMpesaConfig`,
         * `handleSaveFiscalConfig` and `handleSaveStoreIdentity` each
         * validate, PIN-gate and message only their own fields, so a
         * till can save M-Pesa settings with the fiscal device fields
         * blank, and vice versa (phase-147 Part 6 #5 fixed).
         */
        <div className="space-y-4">
          {integrationSection === null ? (
            <SectionCardGrid sections={INTEGRATION_SECTIONS} onSelect={setIntegrationSection} />
          ) : (
            <BackButton label="Back to Integrations" onClick={() => setIntegrationSection(null)} />
          )}

          {integrationsLoading ? (
            <p className="text-base text-slate-400">Loading…</p>
          ) : (
            <>
              {integrationSection === 'shopify' && (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="mb-1 text-2xl font-bold text-slate-800">Shopify Connection</h3>
                  <p className="mb-4 text-base text-slate-500">
                    Shopify store URL and Admin API token. These credentials are stored securely
                    on this device and only need to be entered once per till.
                  </p>

                  <label className="mb-1 block text-lg font-medium text-slate-600">Store URL</label>
                  <input
                    type="text"
                    readOnly
                    value={shopifyStoreUrl}
                    onClick={() =>
                      openField(shopifyStoreUrl, setShopifyStoreUrlInput, 'Store URL', { mode: 'text' })
                    }
                    placeholder="https://your-store.myshopify.com"
                    className="mb-1 w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                  />
                  {shopifyStoreUrlMessage && (
                    <p className="mb-2 text-base text-slate-500">{shopifyStoreUrlMessage}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => handleSaveShopifyStoreUrl()}
                    className="mb-4 rounded-lg border border-slate-300 px-4 py-2 text-base font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Save Store URL
                  </button>

                  <div className="border-t border-slate-100 pt-4">
                    <h4 className="mb-1 text-xl font-semibold text-slate-700">Admin API Token</h4>
                    <p className="mb-3 text-sm text-slate-500">
                      Stored securely on this device. For your protection, once saved the token
                      cannot be viewed again here — only whether one is currently configured.
                    </p>

                    <p className="mb-3 text-base font-medium">
                      Status:{' '}
                      <span className={shopifyTokenConfigured ? 'text-emerald-600' : 'text-amber-600'}>
                        {shopifyTokenConfigured ? 'Configured' : 'Not configured'}
                      </span>
                    </p>

                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      New Token (starts with shpat_)
                    </label>
                    <input
                      type="password"
                      readOnly
                      value={shopifyTokenInput}
                      onClick={() =>
                        openField(shopifyTokenInput, setShopifyTokenInput, 'Shopify Admin API Token', {
                          mode: 'text',
                          secret: true
                        })
                      }
                      placeholder="shpat_••••••••••••••••"
                      className="mb-3 w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />

                    {shopifyTokenMessage && (
                      <p className="mb-3 text-base text-slate-500">{shopifyTokenMessage}</p>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleSaveShopifyToken()}
                      className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
                    >
                      Save Token
                    </button>
                  </div>
                </section>
              )}

              {integrationSection === 'location' && (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="mb-1 text-2xl font-bold text-slate-800">Location</h3>
                  <p className="mb-4 text-sm text-slate-500">
                    The Shopify location this till scopes inventory and sales to.
                  </p>

                  {!changingLocation ? (
                    <>
                      <p className="mb-3 text-base font-medium text-slate-700">
                        Current location:{' '}
                        <span className="text-slate-900">{currentLocationName ?? 'Not set'}</span>
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenChangeLocation}
                        className="rounded-lg border border-slate-300 px-4 py-2 text-base font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Change Location
                      </button>
                    </>
                  ) : locationOptionsLoading ? (
                    <p className="text-base text-slate-400">Loading locations…</p>
                  ) : (
                    <div className="max-w-3xl">
                      {locationOptions.length > 0 ? (
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <LocationPicker
                            shopName={locationShopName}
                            locations={locationOptions}
                            selectedLocationId={selectedLocationId}
                            onSelect={setSelectedLocationId}
                            onConfirm={handleConfirmChangeLocation}
                            confirming={locationSaving}
                            confirmError={locationError}
                            confirmLabel={locationSaving ? 'Saving…' : 'Save Location'}
                            onBack={() => setChangingLocation(false)}
                          />
                        </div>
                      ) : (
                        <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
                          {locationError ?? 'No locations returned by Shopify'}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}

              {integrationSection === 'mpesa' && (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="mb-1 text-2xl font-bold text-slate-800">M-Pesa</h3>
                  <p className="mb-4 text-base text-slate-500">How this till takes M-Pesa payments.</p>
                  <div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      How payments are confirmed
                    </label>
                    <select
                      value={mpesaConfirmationMethod}
                      onChange={(e) => {
                        const value = e.target.value
                        setMpesaConfirmationMethod(
                          value === 'sms' ? 'sms' : value === 'daraja' ? 'daraja' : 'manual'
                        )
                      }}
                      aria-label="How payments are confirmed"
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    >
                      <option value="manual">Record the code myself, after checking the customer&rsquo;s phone</option>
                      <option value="daraja">Send a payment request to the customer</option>
                      {/*
                        Left selectable (not removed) so a till already saved
                        with 'sms' still shows its own current setting — but
                        disabled, so nobody can newly choose a method that
                        cannot confirm a single payment yet (MPESA_SMS_PARSER_READY,
                        phase-147 §1.4). The main process refuses the save too.
                      */}
                      <option value="sms" disabled={!MPESA_SMS_PARSER_READY}>
                        {MPESA_SMS_PARSER_READY
                          ? 'Read the payment message on this till'
                          : 'SMS modem (not available yet)'}
                      </option>
                    </select>
                    <p className="mt-1 text-base text-slate-500">
                      Manual is the default: the cashier checks the confirmation message on the
                      customer&rsquo;s own phone and records the code. Choose sending a request
                      only once Daraja credentials are ready below.
                    </p>
                  </div>

                  {mpesaConfirmationMethod === 'manual' && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-base text-slate-600">
                      No Daraja credentials are needed for this mode. The cashier reads the code
                      off the customer&rsquo;s phone and enters it at the till for every M-Pesa
                      sale.
                    </div>
                  )}

                  {mpesaConfirmationMethod === 'daraja' && (
                    <>
                      <div>
                        <label className="mb-1 block text-lg font-medium text-slate-600">
                          Environment
                        </label>
                        <select
                          value={mpesaEnvironment}
                          onChange={(e) =>
                            setMpesaEnvironment(e.target.value as 'sandbox' | 'production')
                          }
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        >
                          <option value="sandbox">Sandbox</option>
                          <option value="production">Production</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-lg font-medium text-slate-600">
                          Shortcode
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={mpesaShortcode}
                          onClick={() => openField(mpesaShortcode, setMpesaShortcode, 'Shortcode', { mode: 'caps' })}
                          placeholder="174379"
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-lg font-medium text-slate-600">
                          Consumer Key
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={mpesaConsumerKey}
                          onClick={() =>
                            openField(mpesaConsumerKey, setMpesaConsumerKey, 'Consumer Key', { mode: 'text' })
                          }
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-lg font-medium text-slate-600">
                          Consumer Secret <LockIcon className="h-4 w-4 text-slate-400" />
                        </label>
                        <input
                          type="password"
                          readOnly
                          value={mpesaConsumerSecretInput}
                          onClick={() =>
                            openField(mpesaConsumerSecretInput, setMpesaConsumerSecretInput, 'Consumer Secret', {
                              mode: 'text',
                              secret: true
                            })
                          }
                          placeholder={
                            mpesaConsumerSecretConfigured ? '•••••••• (configured)' : 'Not configured'
                          }
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-lg font-medium text-slate-600">
                          Passkey <LockIcon className="h-4 w-4 text-slate-400" />
                        </label>
                        <input
                          type="password"
                          readOnly
                          value={mpesaPasskeyInput}
                          onClick={() =>
                            openField(mpesaPasskeyInput, setMpesaPasskeyInput, 'Passkey', {
                              mode: 'text',
                              secret: true
                            })
                          }
                          placeholder={mpesaPasskeyConfigured ? '•••••••• (configured)' : 'Not configured'}
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-lg font-medium text-slate-600">
                          Callback URL
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={mpesaCallbackUrl}
                          onClick={() =>
                            openField(mpesaCallbackUrl, setMpesaCallbackUrl, 'Callback URL', { mode: 'text' })
                          }
                          placeholder="https://example.com/callback"
                          className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                      </div>
                    </>
                  )}

                  {mpesaConfirmationMethod === 'sms' && (
                    <div>
                      <label className="mb-1 block text-lg font-medium text-slate-600">
                        Where payment messages arrive
                      </label>
                      <input
                        type="text"
                        readOnly
                        value={mpesaSmsInboxPath}
                        onClick={() =>
                          openField(mpesaSmsInboxPath, setMpesaSmsInboxPath, 'Where payment messages arrive', {
                            mode: 'text'
                          })
                        }
                        placeholder="C:\\gammu\\inbox"
                        aria-label="Where payment messages arrive"
                        className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                      />
                      <p className="mt-1 text-base text-slate-500">
                        The folder on this till where the message reader saves each payment message.
                      </p>
                    </div>
                  )}

                  {/*
                    Deliberately not an option inside the select above, and
                    shown only for Daraja: this permits an exception
                    alongside a confirming method, not a way of confirming
                    one. Meaningless in manual mode, which already works this
                    way for every sale — hidden there rather than shown
                    checked-and-disabled, since there's nothing to opt into.
                  */}
                  {mpesaConfirmationMethod === 'daraja' && (
                    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/60 p-3">
                      <label className="flex items-start gap-2 text-lg font-medium text-amber-900">
                        <input
                          type="checkbox"
                          checked={mpesaManualEntryEnabled}
                          onChange={(e) => setMpesaManualEntryEnabled(e.target.checked)}
                          aria-label="Allow recording unverified M-Pesa payments"
                          className="mt-1 h-5 w-5"
                        />
                        Allow recording unverified M-Pesa payments
                      </label>
                      <p className="mt-1 text-base text-amber-900/80">
                        Lets a cashier complete a sale by typing the customer&rsquo;s M-Pesa code when
                        the confirmation has not reached this till. <strong>Nothing checks that the
                        payment really happened.</strong> Each one needs a manager&rsquo;s PIN, is
                        recorded as unverified, and stays on the Reconciliation tab until someone
                        matches it to the M-Pesa statement. Takes effect after a restart.
                      </p>
                    </div>
                  )}
                </div>
                {mpesaConfirmationMethod === 'daraja' && (
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      disabled={mpesaTesting}
                      onClick={() => void handleTestMpesaConnection()}
                      className="rounded-lg border border-slate-300 px-4 py-2 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mpesaTesting ? 'Testing…' : 'Test Connection'}
                    </button>
                    {mpesaTestMessage && (
                      <p className="text-base text-slate-500">{mpesaTestMessage}</p>
                    )}
                  </div>
                )}
              </div>

              <p className="mt-4 text-sm text-slate-500">
                M-Pesa settings are read once when the till starts, so saving here applies them
                after a restart.
              </p>

              {mpesaMessage && (
                <p className="mt-2 text-base text-slate-500">{mpesaMessage}</p>
              )}
              <button
                type="button"
                disabled={mpesaSaving}
                onClick={() => void handleSaveMpesaConfig()}
                className="mt-3 rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mpesaSaving ? 'Saving…' : 'Save & Restart'}
              </button>
                </section>
              )}

              {integrationSection === 'fiscal' && (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-2xl font-bold text-slate-800">Fiscal Device</h3>
                    <span
                      className={`text-base font-medium ${etimsReady ? 'text-emerald-600' : 'text-amber-600'}`}
                    >
                      {etimsReady ? 'Set up' : 'Not set up yet'}
                    </span>
                  </div>

                {/**
                 * Three fields per row, not two (phase-167 Part B item 2):
                 * this section alone measured ~365px over the design box
                 * at the tightest supported size with the old two-column
                 * layout plus a static description under every field.
                 * Every field below already has an obvious placeholder
                 * and a label — the removed descriptions restated one or
                 * the other, so nothing here is undiscoverable, only
                 * shorter. The password field's own hint is dynamic (it
                 * differs once a password is already saved) so it stays.
                 */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Fiscal server address
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={etimsBaseUrl}
                      onClick={() =>
                        openField(etimsBaseUrl, setEtimsBaseUrl, 'Fiscal server address', { mode: 'text' })
                      }
                      placeholder={DEFAULT_ETIMS_BASE_URL}
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    {etimsFieldErrors.baseUrl && (
                      <p className="mt-1 text-sm font-medium text-rose-700">
                        {etimsFieldErrors.baseUrl}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Fiscal device IP address
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={etimsDeviceIp}
                      onClick={() =>
                        openField(etimsDeviceIp, setEtimsDeviceIp, 'Fiscal device IP address', { mode: 'ip' })
                      }
                      placeholder="192.168.1.50"
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    {etimsFieldErrors.deviceIp && (
                      <p className="mt-1 text-sm font-medium text-rose-700">
                        {etimsFieldErrors.deviceIp}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Fiscal device port
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={etimsDevicePort}
                      onClick={() =>
                        openField(etimsDevicePort, setEtimsDevicePort, 'Fiscal device port', { mode: 'numeric' })
                      }
                      placeholder={DEFAULT_ETIMS_DEVICE_PORT}
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    {etimsFieldErrors.devicePort && (
                      <p className="mt-1 text-sm font-medium text-rose-700">
                        {etimsFieldErrors.devicePort}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Fiscal device password
                    </label>
                    <input
                      type="password"
                      readOnly
                      value={etimsPassword}
                      onClick={() =>
                        openField(etimsPassword, setEtimsPassword, 'Fiscal device password', {
                          mode: 'text',
                          secret: true
                        })
                      }
                      placeholder={etimsPasswordConfigured ? '•••••••• (saved)' : 'Required'}
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    <p className="mt-1 text-sm text-slate-500">
                      {etimsPasswordConfigured ? 'Blank keeps it.' : 'Set on the control unit.'}
                    </p>
                  </div>

                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Default tax class
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={etimsDefaultVatClass}
                      onClick={() =>
                        openField(etimsDefaultVatClass, setEtimsDefaultVatClass, 'Default tax class', {
                          mode: 'caps'
                        })
                      }
                      placeholder={DEFAULT_ETIMS_VAT_CLASS}
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={etimsTesting}
                    onClick={() => void handleTestEtimsConnection()}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {etimsTesting ? 'Testing…' : 'Test connection'}
                  </button>
                </div>

                {etimsTestError && (
                  <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
                    {etimsTestError}
                  </p>
                )}

                {etimsTestResult && (
                  <div
                    className={`mt-3 rounded-lg px-3 py-3 ${
                      etimsTestResult.ok ? 'bg-emerald-50' : 'bg-amber-50'
                    }`}
                  >
                    <ul className="mb-2 space-y-1">
                      {etimsTestResult.hops.map((hop) => (
                        <li key={hop.hop} className="flex items-center gap-2 text-base">
                          <span
                            aria-hidden="true"
                            className={
                              hop.passed === true
                                ? 'text-emerald-600'
                                : hop.passed === false
                                  ? 'text-rose-600'
                                  : 'text-slate-400'
                            }
                          >
                            {hop.passed === true ? '✓' : hop.passed === false ? '✕' : '–'}
                          </span>
                          <span
                            className={
                              hop.passed === undefined ? 'text-slate-400' : 'text-slate-700'
                            }
                          >
                            {hop.label}
                            {hop.passed === undefined && ' (not checked)'}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p
                      className={`text-base font-medium ${
                        etimsTestResult.ok ? 'text-emerald-800' : 'text-amber-900'
                      }`}
                    >
                      {etimsTestResult.message}
                    </p>
                  </div>
                )}

              {fiscalMessage && (
                <p className="mt-4 text-base text-slate-500">{fiscalMessage}</p>
              )}
              <button
                type="button"
                disabled={fiscalSaving}
                onClick={() => void handleSaveFiscalConfig()}
                className="mt-3 rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {fiscalSaving ? 'Saving…' : 'Save Fiscal Device Settings'}
              </button>

              <div className="mt-4 border-t border-slate-100 pt-4">
                <h4 className="mb-2 text-xl font-semibold text-slate-700">Store Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Store name
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={storeName}
                      onClick={() => openField(storeName, setStoreName, 'Store name', { mode: 'text' })}
                      placeholder="Rubis Haile Selassie"
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-lg font-medium text-slate-600">
                      Store KRA PIN
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={storeKraPin}
                      onClick={() =>
                        openField(storeKraPin, (next) => setStoreKraPin(next.toUpperCase()), 'Store KRA PIN', {
                          mode: 'caps'
                        })
                      }
                      placeholder="P051234567X"
                      className="w-full h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    />
                    <p className="mt-1 text-sm text-slate-500">Not the customer&apos;s PIN.</p>
                  </div>
                </div>
              </div>

              {storeIdentityMessage && (
                <p className="mt-4 text-base text-slate-500">{storeIdentityMessage}</p>
              )}
              <button
                type="button"
                disabled={storeIdentitySaving}
                onClick={() => void handleSaveStoreIdentity()}
                className="mt-3 rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {storeIdentitySaving ? 'Saving…' : 'Save Store Details'}
              </button>
                </section>
              )}

              {integrationSection === 'printer' && (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="mb-1 text-2xl font-bold text-slate-800">Printers</h3>
                  <p className="mb-4 text-base text-slate-500">
                    Register additional printers — a secondary kitchen or label printer
                    alongside the main receipt printer. A store with no printers registered here
                    keeps using the single receipt printer configured via environment variables,
                    unchanged.
                  </p>

                  {printerActionError && (
                    <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
                      {printerActionError}
                    </p>
                  )}

                  {printersLoading ? (
                    <p className="text-base text-slate-400">Loading…</p>
                  ) : (
                    <div className="space-y-2">
                      {printers.length === 0 && (
                        <p className="text-base text-slate-400">No printers registered yet.</p>
                      )}
                      {printers.map((printer) => (
                        <div
                          key={printer.id}
                          className="rounded-lg border border-slate-100 px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-800">{printer.id}</span>
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium capitalize text-slate-500">
                                {printer.type}
                              </span>
                              {!printer.enabled && (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-700">
                                  Disabled
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={testingPrinterId === printer.id}
                                onClick={() => handleTestPrinter(printer.id, printer.interfaceName)}
                                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {testingPrinterId === printer.id ? 'Testing…' : 'Test'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeletePrinter(printer.id)}
                                className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          <p className="mt-1 text-sm text-slate-500">{printer.interfaceName}</p>
                          {printerTestMessages[printer.id] && (
                            <p className="mt-1 text-sm text-slate-600">{printerTestMessages[printer.id]}</p>
                          )}
                        </div>
                      ))}

                      <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
                        <input
                          type="text"
                          readOnly
                          placeholder="Printer id (e.g. kitchen-1)"
                          value={newPrinterId}
                          onClick={() =>
                            openField(newPrinterId, setNewPrinterId, 'Printer id', { mode: 'text' })
                          }
                          className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                        <select
                          value={newPrinterType}
                          onChange={(e) => setNewPrinterType(e.target.value as PrinterType)}
                          className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        >
                          <option value="receipt">Receipt</option>
                          <option value="kitchen">Kitchen</option>
                          <option value="label">Label</option>
                        </select>
                        <input
                          type="text"
                          readOnly
                          placeholder="tcp://192.168.0.101:9100"
                          value={newPrinterInterface}
                          onClick={() =>
                            openField(newPrinterInterface, setNewPrinterInterface, 'Printer interface', {
                              mode: 'text'
                            })
                          }
                          className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                        />
                        <button
                          type="button"
                          onClick={() => handleAddPrinter()}
                          className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
                        >
                          Add Printer
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'overview' && (
        <>
      {/* Today's Sales */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">Today&apos;s Sales</h3>
        {loading || !dailySummary ? (
          <p className="text-base text-slate-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Orders</p>
              <p className="text-xl font-semibold text-slate-900">{dailySummary.orderCount}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Revenue</p>
              <p className="text-xl font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalRevenue)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Cash</p>
              <p className="text-xl font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalsByMethod.cash)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">M-Pesa / Card</p>
              <p className="text-xl font-semibold text-slate-900">
                {formatCurrency(dailySummary.totalsByMethod.mpesa + dailySummary.totalsByMethod.card)}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Shift Controls */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-2xl font-bold text-slate-800">Shift Controls</h3>
          {currentShift ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-sm font-medium text-emerald-700">
              Shift #{currentShift.id} open
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-500">
              No open shift
            </span>
          )}
        </div>

        {currentShift && (
          <p className="mb-3 text-base text-slate-600">
            Opened {new Date(currentShift.clock_in).toLocaleString()} with{' '}
            {formatCurrency(currentShift.starting_cash)} starting cash.
          </p>
        )}

        {shiftActionError && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {shiftActionError}
          </p>
        )}

        {!currentShift && !showOpenForm && (
          <button
            type="button"
            onClick={() => setShowOpenForm(true)}
            className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
          >
            Open Shift
          </button>
        )}

        {!currentShift && showOpenForm && (
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-lg font-medium text-slate-600">
                Starting Cash
              </label>
              <input
                type="text"
                readOnly
                value={startingCashInput}
                onClick={() => openField(startingCashInput, setStartingCashInput, 'Starting Cash', { mode: 'decimal' })}
                onFocus={() => openField(startingCashInput, setStartingCashInput, 'Starting Cash', { mode: 'decimal' })}
                className="w-32 h-12 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void handleOpenShift()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setShowOpenForm(false)
                setStartingCashInput('')
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-base text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        )}

        {currentShift && !showCloseForm && (
          <button
            type="button"
            onClick={() => setShowCloseForm(true)}
            className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
          >
            Close Shift
          </button>
        )}

        {currentShift && showCloseForm && (
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-lg font-medium text-slate-600">
                Ending Cash (counted)
              </label>
              <input
                type="text"
                readOnly
                value={endingCashInput}
                onClick={() => openField(endingCashInput, setEndingCashInput, 'Ending Cash (counted)', { mode: 'decimal' })}
                onFocus={() => openField(endingCashInput, setEndingCashInput, 'Ending Cash (counted)', { mode: 'decimal' })}
                className="w-32 h-12 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void handleCloseShift()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCloseForm(false)
                setEndingCashInput('')
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-base text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Staff Management */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-2xl font-bold text-slate-800">Staff</h3>
          <button
            type="button"
            onClick={() => setShowAddStaffForm((prev) => !prev)}
            className="text-base font-medium text-rose-600 hover:text-rose-700"
          >
            {showAddStaffForm ? 'Cancel' : '+ Add Staff'}
          </button>
        </div>

        {staffActionError && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {staffActionError}
          </p>
        )}

        {showAddStaffForm && (
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
            <input
              type="text"
              readOnly
              placeholder="Name"
              value={newStaffName}
              onClick={() => openField(newStaffName, setNewStaffName, 'Staff name', { mode: 'text' })}
              className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <input
              type="password"
              readOnly
              placeholder="PIN"
              value={newStaffPin}
              onClick={() => openField(newStaffPin, setNewStaffPin, 'New staff PIN', { mode: 'numeric', secret: true })}
              className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <select
              value={newStaffRole}
              onChange={(e) => setNewStaffRole(e.target.value as StaffRole)}
              className="h-12 rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            >
              <option value="cashier">Cashier</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={() => void handleAddStaff()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-base font-semibold text-white hover:bg-rose-700"
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
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium capitalize text-slate-500">
                  {staff.role}
                </span>
              </div>

              {resetPinTargetId === staff.id ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    readOnly
                    placeholder="New PIN"
                    value={resetPinValue}
                    onClick={() =>
                      openField(resetPinValue, setResetPinValue, 'New PIN', { mode: 'numeric', secret: true })
                    }
                    onFocus={() =>
                      openField(resetPinValue, setResetPinValue, 'New PIN', { mode: 'numeric', secret: true })
                    }
                    className="h-12 w-28 rounded-lg border border-slate-300 px-2 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => void handleResetPin(staff.id)}
                    className="text-base font-medium text-rose-600 hover:text-rose-700"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResetPinTargetId(null)
                      setResetPinValue('')
                    }}
                    className="text-base text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setResetPinTargetId(staff.id)}
                  className="text-base font-medium text-slate-500 hover:text-slate-700"
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
          className="rounded-lg border border-slate-300 px-4 py-2 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
        </button>
        {updateCheckMessage && (
          <p className="mt-2 text-base text-slate-500">{updateCheckMessage}</p>
        )}
      </section>
        </>
      )}

      {zReport && <ZReportModal report={zReport} onClose={() => setZReport(null)} />}

      {showRestartModal && (
        <RestartCountdownModal
          onRestart={() => void window.api.restartApp()}
          onCancel={() => setShowRestartModal(false)}
        />
      )}
    </div>
  )
}
