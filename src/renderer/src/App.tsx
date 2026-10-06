import { useEffect, useRef, useState } from 'react'
import { useCartStore } from './stores/cartStore'
import { useProductStore } from './stores/productStore'
import { useNetworkStore } from './stores/networkStore'
import { useConnectivityStore } from './stores/connectivityStore'
import { useUiStore } from './stores/uiStore'
import { useAuthStore } from './stores/authStore'
import { useBarcodeScanner } from './hooks/useBarcodeScanner'
import type { ScanResult } from './hooks/useBarcodeScanner'
import type { VariantSummary, ProductSummary } from './types/shopify'
import PosSearchBar from './components/PosSearchBar'
import PosCartTable, { CART_LINES_PER_PAGE } from './components/PosCartTable'
import HeldSalesStrip from './components/HeldSalesStrip'
import LogoutHeldWarning from './components/LogoutHeldWarning'
import PosCheckoutPanel from './components/PosCheckoutPanel'
import EmptyState from './components/EmptyState'
import VariantModal from './components/VariantModal'
import OrderHistory from './components/OrderHistory'
import LoginScreen from './components/LoginScreen'
import OnboardingScreen from './components/OnboardingScreen'
import LocationConfirmScreen from './components/LocationConfirmScreen'
import LocationPendingScreen from './components/LocationPendingScreen'
import AdminScreen from './components/AdminScreen'
import EtimsSetupGate from './components/EtimsSetupGate'
import UpdateToast from './components/UpdateToast'
import UpdatePrompt from './components/UpdatePrompt'
import ManagerPinModal from './components/ManagerPinModal'
import type { ConnectivityIntegration } from './types/connectivity'
import ConnectivityModal from './components/ConnectivityModal'
import NavStatusButton from './components/NavStatusButton'
import { useUnfiledCountStore } from './stores/unfiledCountStore'
import { useShopifyReconciliationStore } from './stores/shopifyReconciliationStore'
import { useFiscalModeStore } from './stores/fiscalModeStore'
import ConnectivityToast from './components/ConnectivityToast'
import FiscalNotice from './components/FiscalNotice'
import ShopifyCheckNotice from './components/ShopifyCheckNotice'
import NeedsAttentionPage from './pages/NeedsAttentionPage'
import SaleCompleteToast from './components/SaleCompleteToast'
import ToastStack from './components/ToastStack'
import { useToastStore } from './stores/toastStore'
import { useHeldSalesStore } from './stores/heldSalesStore'
import { isPaymentInProgress, usePaymentActivityStore } from './stores/paymentActivityStore'
import { shouldShowNoShiftNotice, useShiftStore } from './stores/shiftStore'
import NoShiftNotice from './components/NoShiftNotice'
import WindowEndBanner, { shouldShowWindowEndBanner } from './components/WindowEndBanner'
import { useShiftWindowStatus } from './lib/useShiftWindowStatus'
import OpenShiftDialog from './components/OpenShiftDialog'
import { HOLD_PAYMENT_REASON } from './lib/heldSale'
import { decideHold, heldAgeTone } from './lib/heldSale'
import { CART_LOCKED_BY_SPLIT_MESSAGE } from './lib/splitPayments'
import {
  CART_CHANGE_BLOCKED_TOAST_TIMEOUT_MS,
  CART_RESTORED_TOAST_TIMEOUT_MS,
  HELD_SALE_NOTICE_TOAST_TIMEOUT_MS,
  SCAN_TOAST_TIMEOUT_MS
} from './lib/toastTimeouts'
import { createCartDraftSaver, restoreCartDraft, restoreToastMessage } from './lib/cartDraft'
import { createGuardedCartActions } from './lib/guardedCartActions'
import { CUSTOMER_SLIP_FAILURE_MESSAGE } from './lib/autoPrintToast'
import { buildCartItem } from './lib/cartItem'
import { WarningIcon } from './components/icons'
import { useKeyboardStore } from './stores/keyboardStore'
import ZReportModal from './components/ZReportModal'
import type { ZReport } from '../../main/services/reports.js'
import type { ReconciliationResult } from '../../main/services/reconciliation.js'
import rubisLogo from './assets/logo-rubis.png'

/**
 * check:fit-only synthetic data (docs/phase-167 Part B item 1) — never
 * used outside `'zReport'`/`'variantModal'` (`checkFitForcedScreen`
 * below): a renderer-only prop, no database write, not even against the
 * throwaway copy `check:fit` otherwise launches against.
 */
const CHECK_FIT_SYNTHETIC_Z_REPORT: ZReport = {
  shiftId: 999999,
  staffName: 'Demo Cashier',
  openedAt: '2026-01-01T08:00:00.000Z',
  closedAt: '2026-01-01T16:00:00.000Z',
  status: 'closed',
  startingCash: 100,
  totalsByMethod: { cash: 200, mpesa: 80, card: 0 },
  mpesaByMode: { manual: 30, daraja: 50 },
  orderCount: 5,
  totalRevenue: 280,
  vatIncluded: 38.62,
  vatRate: 0.16,
  expectedCash: 300,
  endingCash: 300,
  discrepancy: 0
}

/** check:fit-only synthetic data (docs/phase-167 Part B item 1) — see {@link CHECK_FIT_SYNTHETIC_Z_REPORT}'s own doc comment. */
const CHECK_FIT_SYNTHETIC_PRODUCT: ProductSummary = {
  id: 'check-fit-demo-product',
  title: 'Demo Product',
  handle: 'demo-product',
  featuredImage: null,
  variants: Array.from({ length: 6 }, (_, i) => ({
    id: `check-fit-demo-variant-${i + 1}`,
    productId: 'check-fit-demo-product',
    title: `Variant ${i + 1}`,
    price: 100 + i,
    availableForSale: true,
    inventoryQuantity: 10,
    image: null,
    barcode: null
  }))
}

/**
 * check:fit-only synthetic data (docs/phase-170 commit 3) - see
 * {@link CHECK_FIT_SYNTHETIC_Z_REPORT}'s own doc comment. Covers every
 * finding kind the Admin "Shopify check" card can show, so all of them
 * are actually measured at every supported size, not just whichever
 * ones happen to exist in this dev environment's own copied database.
 */
const CHECK_FIT_SYNTHETIC_RECONCILIATION_RESULT: ReconciliationResult = {
  checkedAt: new Date('2026-01-01T08:05:00.000Z').getTime(),
  ok: true,
  findings: [
    { kind: 'linked', localId: 101, shopifyOrderId: 'gid://shopify/Order/9001', shopifyName: '#1043' },
    {
      kind: 'duplicate',
      localId: 102,
      shopifyIds: ['gid://shopify/Order/9002', 'gid://shopify/Order/9003'],
      shopifyNames: ['#1050', '#1051']
    },
    { kind: 'held-cancelled', localId: 103, shopifyId: 'gid://shopify/Order/9004' },
    { kind: 'missing', localId: 104, shopifyOrderId: 'gid://shopify/Order/9005' }
  ],
  otherTillsCount: 340
}

/** A pending manager-gated action awaiting PIN authorization. */
interface PinGateRequest {
  title: string
  /**
   * Receives the authorizing admin's id and PIN so callers
   * that hit a privileged IPC channel (`createStaff`, `resetStaffPin`,
   * `setIntegrationConfig`) can forward them for the main process's
   * independent `requireAdminPin` re-check.
   */
  onAuthorized: (managerId: number, managerPin: string) => void
}

/**
 * Pushes a transient toast (phase-84) into the shared stack after a
 * barcode scan or product-search attempt — kept as a plain helper
 * rather than its own component since it has no state of its own
 * beyond the message itself.
 */
function showScanToast(kind: 'success' | 'error', message: string): void {
  const id = 'scan'
  useToastStore.getState().show({
    id,
    tone: kind,
    message,
    timeoutMs: SCAN_TOAST_TIMEOUT_MS,
    onDismiss: () => useToastStore.getState().dismiss(id)
  })
}

/**
 * Root POS shell.
 *
 * Orchestrates two Zustand stores:
 *   - `useProductStore` — fetches the Shopify catalog via IPC
 *   - `useCartStore`    — manages the cashier's line items
 *
 * The catalog view is a fast-checkout layout (Phase 44): a left zone
 * (`PosSearchBar` + `PosCartTable`, ~65% width on a `lg:` screen and
 * up) for scanning/searching and reviewing the ticket, and a right
 * zone (`PosCheckoutPanel`, ~35%) that is always visible — no
 * "Checkout" button/modal — so the total, payment method, and
 * amount-tendered/M-Pesa flow are on screen throughout the sale.
 * Below the `lg:` breakpoint (1024px) the zones stack vertically
 * instead of compressing.
 *
 * @returns {JSX.Element}
 */
export default function App() {
  const [now, setNow] = useState<string>(
    new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  )
  const demoMode = import.meta.env.VITE_DEMO_MODE === 'true'
  /**
   * Whether this till has a working Shopify connection yet.
   * Demo Mode skips the check entirely — it never talks to
   * Shopify, so onboarding would be a pointless gate in front of a
   * trial install that's deliberately configured to run without
   * credentials.
   */
  const [configStatus, setConfigStatus] = useState<'loading' | 'unconfigured' | 'ready'>(
    demoMode ? 'ready' : 'loading'
  )
  /**
   * Whether an admin has explicitly confirmed this till's Shopify
   * location. Demo Mode bypasses this the same way it bypasses
   * `configStatus`.
   */
  const [locationConfirmed, setLocationConfirmed] = useState(demoMode)
  const [confirmedLocationId, setConfirmedLocationId] = useState<string | null>(null)

  /**
   * Whether this till may proceed past the mandatory eTIMS setup gate.
   * Demo Mode bypasses it, matching `configStatus`/`locationConfirmed`
   * above — checkout never fiscalizes in Demo Mode either way.
   */
  const [etimsComplete, setEtimsComplete] = useState(demoMode)

  useEffect(() => {
    if (demoMode) return
    window.api.checkEtimsCompletion().then((result) => {
      setEtimsComplete(result.success ? !!result.data?.isComplete : false)
    })
  }, [demoMode])

  /**
   * check:fit's own force-show hook (docs/phase-166 Commit E3, extended
   * docs/phase-167 Part B item 1) — always resolves to `null` in a real
   * launch (see `getCheckFitForcedScreen`'s own doc comment). When set,
   * it overrides the gates below and seeds a little demo state, so the
   * fit-check harness can reach a screen a normal click-driven flow
   * can't: an intermediate onboarding-gate state (`'locationPending'`,
   * `'etimsGate'`), the fiscal notice paired with two routine toasts at
   * the stack's cap (`'fiscalNoticeAndToastLimit'`), the manual M-Pesa
   * code field with its docked keyboard open (`'mpesaManualKeyboard'`),
   * a closed shift's Z-report (`'zReport'`), a six-variant product's
   * picker (`'variantModal'`), or the Admin "Shopify check" card with
   * every finding kind at once (`'shopifyCheckCard'`, docs/phase-170
   * commit 3) — the last four with entirely synthetic, renderer-only
   * data (`CHECK_FIT_SYNTHETIC_Z_REPORT`/`CHECK_FIT_SYNTHETIC_PRODUCT`/
   * `CHECK_FIT_SYNTHETIC_RECONCILIATION_RESULT` above), never a
   * database write, not even against the throwaway copy `check:fit`
   * otherwise launches against — this till's real M-Pesa mode/shift
   * history/catalog/Shopify check result cannot be relied on to have
   * the shape any of these four need.
   */
  const [checkFitForcedScreen, setCheckFitForcedScreen] = useState<string | null>(null)
  useEffect(() => {
    window.api
      .getCheckFitForcedScreen?.()
      .then(setCheckFitForcedScreen)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (checkFitForcedScreen !== 'fiscalNoticeAndToastLimit') return
    useCartStore.setState({
      lastReceipt: {
        localId: 999999,
        mode: 'synced',
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Wrong client PIN',
        fiscalErrorKind: 'data',
        fiscalDataIssue: 'wrong-pin'
      }
    })
    useToastStore.getState().show({
      id: 'check-fit-demo-toast-1',
      tone: 'info',
      message: 'Demo toast 1 (check:fit)',
      timeoutMs: null,
      onDismiss: () => {}
    })
    useToastStore.getState().show({
      id: 'check-fit-demo-toast-2',
      tone: 'info',
      message: 'Demo toast 2 (check:fit)',
      timeoutMs: null,
      onDismiss: () => {}
    })
  }, [checkFitForcedScreen])

  useEffect(() => {
    if (checkFitForcedScreen !== 'mpesaManualKeyboard') return
    addItem({
      id: 'check-fit-demo-variant-1',
      productId: 'check-fit-demo-product',
      title: 'Demo Product',
      variantTitle: 'Default',
      price: 100,
      image: null
    })
    useKeyboardStore.getState().open({
      value: '',
      onChange: () => {},
      maxLength: 10,
      label: 'M-Pesa code from the customer’s message',
      mode: 'caps',
      docked: true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkFitForcedScreen])

  const refreshConfigStatus = () =>
    window.api.getConfigStatus().then((result) => {
      setConfigStatus(result.success && result.data?.hasConfig ? 'ready' : 'unconfigured')
      setLocationConfirmed(!!result.data?.locationConfirmed)
      setConfirmedLocationId(result.data?.config?.locationId ?? null)
    })

  useEffect(() => {
    if (demoMode) return
    void refreshConfigStatus()
  }, [demoMode])

  const cartItems = useCartStore((state) => state.items)
  const addItem = useCartStore((state) => state.addItem)
  const updateQuantity = useCartStore((state) => state.updateQuantity)
  const removeItem = useCartStore((state) => state.removeItem)
  const clearCart = useCartStore((state) => state.clearCart)

  const [pinGate, setPinGate] = useState<PinGateRequest | null>(null)
  const requestManagerPin = (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => setPinGate({ title, onAuthorized })

  /**
   * Remove, reduce and clear need a manager (docs/phase-197); increasing a
   * quantity does not. Cancelling the PIN prompt leaves the cart unchanged.
   */
  const guardedCart = createGuardedCartActions({
    getItems: () => useCartStore.getState().items,
    getCartToken: () => useCartStore.getState().cartToken,
    getStaffId: () => useAuthStore.getState().currentStaff?.id ?? null,
    requestManagerPin,
    recordRemovals: (request) => window.api.recordCartRemovals(request),
    apply: { setQuantity: updateQuantity, remove: removeItem, clear: clearCart },
    // docs/phase-252-1: no change, and no PIN asked, while a split holds a recorded payment.
    lockedReason: () => (useCartStore.getState().splitLocked ? CART_LOCKED_BY_SPLIT_MESSAGE : null),
    notify: (message) =>
      useToastStore.getState().show({
        id: 'cart-change-blocked',
        tone: 'warning',
        message,
        timeoutMs: CART_CHANGE_BLOCKED_TOAST_TIMEOUT_MS,
        onDismiss: () => useToastStore.getState().dismiss('cart-change-blocked')
      })
  })

  /**
   * Saves the cart to SQLite as it changes, debounced, so it survives a
   * restart (docs/phase-197). Paused while a checkout is in flight: the main
   * process deletes the draft in the sale's own transaction, and a late
   * save must not bring it back.
   */
  useEffect(() => {
    const saver = createCartDraftSaver({
      save: (draft) => window.api.saveCartDraft(draft),
      clear: () => window.api.clearCartDraft()
    })
    const unsubscribe = useCartStore.subscribe((state, previous) => {
      if (
        state.items === previous.items &&
        state.cartToken === previous.cartToken &&
        state.checkoutKey === previous.checkoutKey &&
        state.checkoutStatus === previous.checkoutStatus
      ) {
        return
      }
      if (state.checkoutStatus === 'submitting') {
        saver.cancel()
        return
      }
      // docs/phase-249-1: the checkout key is saved with the cart, so a cart put back after a crash is the same checkout.
      saver.update({ items: state.items, cartToken: state.cartToken, checkoutKey: state.checkoutKey })
    })
    const stopFlushListener = window.api.onCartFlushRequest(() => saver.flush())
    return () => {
      unsubscribe()
      stopFlushListener()
      saver.cancel()
    }
  }, [])

  /**
   * Once the cashier is signed in and the catalogue is loaded, puts back the
   * cart saved before the last restart, with today's prices (docs/phase-197).
   * Runs once; skipped if the cart already has lines. The retired
   * localStorage copy is deleted so it can never come back.
   */
  const restoredCartRef = useRef(false)
  const catalogStatus = useProductStore((state) => state.status)
  const signedInStaff = useAuthStore((state) => state.currentStaff)
  useEffect(() => {
    if (restoredCartRef.current || catalogStatus !== 'ready' || !signedInStaff) return
    restoredCartRef.current = true
    void (async () => {
      try {
        window.localStorage.removeItem('rubis-pos-cart')
      } catch {
        // Storage unavailable: nothing to remove.
      }
      const result = await window.api.loadCartDraft()
      if (!result.success || !result.data) return
      if (useCartStore.getState().items.length > 0) return
      const restored = restoreCartDraft(result.data.payloadJson, useProductStore.getState().products)
      if (!restored || restored.items.length === 0) {
        await window.api.clearCartDraft()
      }
      if (!restored) return
      if (restored.items.length > 0) {
        useCartStore.getState().restoreCart(restored.items, restored.cartToken, restored.checkoutKey)
      }
      useToastStore.getState().show({
        id: 'cart-restored',
        tone: 'info',
        message: restoreToastMessage(restored),
        timeoutMs: CART_RESTORED_TOAST_TIMEOUT_MS,
        onDismiss: () => useToastStore.getState().dismiss('cart-restored')
      })
    })()
  }, [catalogStatus, signedInStaff])

  /**
   * Held sales (docs/phase-217): read from the till's database once a cashier is signed in,
   * so a restart brings them back onto the sale screen, and again after every completed
   * sale, because the order's own transaction marks a resumed sale completed.
   */
  useEffect(() => {
    if (signedInStaff) void useHeldSalesStore.getState().load()
  }, [signedInStaff])
  useEffect(() => {
    if (signedInStaff) void useShiftStore.getState().load()
  }, [signedInStaff])
  useEffect(
    () =>
      useCartStore.subscribe((state, previous) => {
        if (state.lastReceipt !== previous.lastReceipt) {
          void useHeldSalesStore.getState().load()
          void useShiftStore.getState().load()
        }
      }),
    []
  )

  const heldSales = useHeldSalesStore((state) => state.sales)
  const paymentActive = usePaymentActivityStore((state) => state.active)
  const resumedHeld = useCartStore((state) => state.resumedHeld)
  const heldInStrip = heldSales.filter((sale) => sale.status === 'held')
  const holdDecision = decideHold({
    itemCount: cartItems.length,
    paymentInProgress: isPaymentInProgress(paymentActive),
    openHeldCount: heldSales.length,
    cartIsResumedSale: resumedHeld !== null
  })
  const [logoutWarningOpen, setLogoutWarningOpen] = useState(false)

  /** Parks the cart on screen and leaves a fresh empty one (docs/phase-217). */
  const handleHold = async (): Promise<void> => {
    const staffId = useAuthStore.getState().currentStaff?.id
    if (staffId === undefined) return
    const result = await useHeldSalesStore.getState().hold(staffId)
    if (!result.ok) {
      useToastStore.getState().show({
        id: 'held-sale-notice',
        tone: 'warning',
        message: result.error,
        timeoutMs: HELD_SALE_NOTICE_TOAST_TIMEOUT_MS,
        onDismiss: () => useToastStore.getState().dismiss('held-sale-notice')
      })
    }
  }

  /** Log Out warns about held sales but never refuses: a cashier must be able to hand over mid-wait. */
  const handleLogoutClick = (): void => {
    if (useHeldSalesStore.getState().sales.length > 0) setLogoutWarningOpen(true)
    else void logout()
  }

  /** Variant id most recently added via search/scan — flashes its `PosCartTable` row, then self-clears. */
  const [flashId, setFlashId] = useState<string | null>(null)

  const products = useProductStore((state) => state.products)
  const status = useProductStore((state) => state.status)
  const error = useProductStore((state) => state.error)
  const fetchProducts = useProductStore((state) => state.fetchProducts)
  const cached = useProductStore((state) => state.cached)

  const online = useNetworkStore((state) => state.online)
  const initNetwork = useNetworkStore((state) => state.init)

  const connectivityStatus = useConnectivityStore((state) => state.status)
  const initConnectivity = useConnectivityStore((state) => state.init)
  const [selectedConnectivity, setSelectedConnectivity] = useState<ConnectivityIntegration | null>(
    null
  )
  const [barcodeStatus, setBarcodeStatus] = useState<'unknown' | 'connected'>('unknown')

  const unfiledCount = useUnfiledCountStore((state) => state.count)
  const initUnfiledCount = useUnfiledCountStore((state) => state.init)
  const initShopifyReconciliation = useShopifyReconciliationStore((state) => state.init)
  const initFiscalMode = useFiscalModeStore((state) => state.init)
  const [adminInitialTab, setAdminInitialTab] = useState<'needsAttention' | 'reports' | undefined>(undefined)
  // docs/phase-227: the cart's "No shift open" notice and its dialog.
  const shiftPresence = useShiftStore((state) => state.presence)
  // docs/phase-232: the open shift's window end, read from the main process so the cart holds no time rule.
  const { status: windowStatus } = useShiftWindowStatus()
  const showWindowEndBanner = shouldShowWindowEndBanner(windowStatus)
  const [openShiftDialogShown, setOpenShiftDialogShown] = useState(false)

  const selectedProductForModal = useUiStore((state) => state.selectedProductForModal)
  const activeView = useUiStore((state) => state.activeView)
  // docs/phase-227: back on the cart, read the shift again: the Admin screen may have opened or closed one.
  useEffect(() => {
    if (activeView === 'catalog' && signedInStaff) void useShiftStore.getState().load()
  }, [activeView, signedInStaff])
  const setSelectedProduct = useUiStore((state) => state.setSelectedProduct)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const [searchInputFocused, setSearchInputFocused] = useState(false)

  const currentStaff = useAuthStore((state) => state.currentStaff)
  const logout = useAuthStore((state) => state.logout)

  useEffect(() => {
    const id = setInterval(() => {
      setNow(
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      )
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    void fetchProducts()
  }, [fetchProducts])

  useEffect(() => {
    void initNetwork()
  }, [initNetwork])

  useEffect(() => {
    void initConnectivity()
  }, [initConnectivity])

  useEffect(() => {
    void initUnfiledCount()
  }, [initUnfiledCount])

  useEffect(() => {
    void initShopifyReconciliation()
  }, [initShopifyReconciliation])

  useEffect(() => {
    void initFiscalMode()
  }, [initFiscalMode])

  /**
   * Adds an item and briefly flashes its `PosCartTable` row, giving
   * the cashier feedback that a search/scan add actually registered.
   */
  const handleAddToCart = (product: ProductSummary, variant: VariantSummary) => {
    addItem(buildCartItem(product, variant), 1)
    setFlashId(variant.id)
    window.setTimeout(() => setFlashId((prev) => (prev === variant.id ? null : prev)), 700)
  }

  const handleRetryOrder = async (localId: number) => {
    try {
      await window.api.retryOrderSync(localId)
    } catch (err) {
      console.error('[rubis-pos] retry failed:', err)
    }
  }

  const handlePrintReceipt = async (localId: number) => {
    try {
      const result = await window.api.printReceipt(localId, { staffId: currentStaff?.id })
      if (result.success && result.data?.mode !== 'pdf' && result.data?.customerSlip === 'failed') {
        showScanToast('error', CUSTOMER_SLIP_FAILURE_MESSAGE)
      } else if (result.success) {
        showScanToast(
          'success',
          result.data?.mode === 'pdf'
            ? 'Printer offline. Receipt saved to Desktop as PDF.'
            : result.data?.mock
              ? 'Receipt printed (mock mode)'
              : 'Receipt sent to printer'
        )
      } else {
        showScanToast('error', result.error ?? 'Failed to print receipt')
      }
    } catch (err) {
      showScanToast('error', err instanceof Error ? err.message : 'Failed to print receipt')
    }
  }

  const handleSelectVariant = (variant: VariantSummary) => {
    if (selectedProductForModal) {
      handleAddToCart(selectedProductForModal, variant)
    }
    setSelectedProduct(null)
  }

  /**
   * Routes a parsed scan by its {@link ScanResult.source}:
   * `'UNKNOWN'` (an unprogrammed scanner, or any scanner never
   * programmed with a prefix), `'SC1'`, and `'SC2'` are treated as
   * regular till stations and add the scanned item to the cart.
   * `'KITCHEN'` demonstrates a distinct routing action instead of a
   * cart add — a real back-of-house integration would replace this
   * toast with whatever the kitchen station actually needs (e.g. an
   * IPC call to fire a kitchen ticket).
   */
  const handleScan = ({ source, barcode }: ScanResult) => {
    if (source === 'KITCHEN') {
      showScanToast('success', `Kitchen order routed: ${barcode}`)
      return
    }

    for (const product of products) {
      const variant = product.variants.find((v) => v.barcode === barcode)
      if (variant) {
        handleAddToCart(product, variant)
        const label =
          variant.title === 'Default Title'
            ? product.title
            : `${product.title} (${variant.title})`
        showScanToast('success', `Added: ${label}`)
        return
      }
    }
    showScanToast('error', `Barcode not recognized: ${barcode}`)
  }

  useBarcodeScanner(handleScan, {
    enabled: activeView === 'catalog' && !!currentStaff && !searchInputFocused
  })

  const demoModeBanner = demoMode && (
    <div className="flex items-center justify-center gap-2 bg-amber-500 py-2.5 text-center text-base font-bold uppercase tracking-wide text-white">
      <WarningIcon className="h-5 w-5" />
      Demo Mode Active — Sales are local only and will not sync to Shopify
      <WarningIcon className="h-5 w-5" />
    </div>
  )

  if (configStatus === 'loading') {
    return <div className="app-theme h-screen" />
  }

  if (configStatus === 'unconfigured') {
    return <OnboardingScreen />
  }

  if (!currentStaff) {
    return (
      <>
        {demoModeBanner}
        <LoginScreen />
      </>
    )
  }

  if (checkFitForcedScreen === 'locationPending') {
    return <LocationPendingScreen onLogout={() => void logout()} />
  }

  if (checkFitForcedScreen === 'etimsGate') {
    return <EtimsSetupGate onComplete={() => setEtimsComplete(true)} />
  }

  if (!demoMode && !locationConfirmed) {
    if (currentStaff.role === 'admin') {
      return (
        <>
          <LocationConfirmScreen
            currentLocationId={confirmedLocationId}
            requestManagerPin={requestManagerPin}
            onConfirmed={() => void refreshConfigStatus()}
          />
          {pinGate && (
            <ManagerPinModal
              title={pinGate.title}
              onAuthorized={(managerId, managerPin) => {
                pinGate.onAuthorized(managerId, managerPin)
                setPinGate(null)
              }}
              onCancel={() => setPinGate(null)}
            />
          )}
        </>
      )
    }
    return <LocationPendingScreen onLogout={() => void logout()} />
  }

  if (!etimsComplete) {
    return <EtimsSetupGate onComplete={() => setEtimsComplete(true)} />
  }

  return (
    <div className="app-theme flex h-screen flex-col">
      {demoModeBanner}
      <header className="flex h-20 w-full shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 shadow-sm">
        <div className="flex shrink-0 items-center gap-6">
          <img src={rubisLogo} alt="Enjoy" className="h-9 w-auto shrink-0" />
          <nav className="flex min-w-0 gap-2">
            <button
              type="button"
              onClick={() => setActiveView('catalog')}
              className={`flex h-14 items-center rounded-lg px-6 text-lg font-medium transition-colors ${
                activeView === 'catalog'
                  ? 'bg-rose-100 text-rose-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Catalog
            </button>
            <button
              type="button"
              onClick={() => setActiveView('orders')}
              className={`flex h-14 items-center rounded-lg px-6 text-lg font-medium transition-colors ${
                activeView === 'orders'
                  ? 'bg-rose-100 text-rose-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Orders
            </button>
            {currentStaff.role === 'admin' && (
              <button
                type="button"
                onClick={() => {
                  setActiveView('admin')
                  setAdminInitialTab(undefined)
                }}
                className={`flex h-14 items-center rounded-lg px-6 text-lg font-medium transition-colors ${
                  activeView === 'admin'
                    ? 'bg-rose-100 text-rose-700'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Admin
              </button>
            )}
          </nav>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-4 text-base text-slate-600">
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-40 truncate font-medium text-slate-700">
              {currentStaff.name}
            </span>
            {currentStaff.role.toLowerCase() !== currentStaff.name.toLowerCase() && (
              <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-sm font-medium capitalize text-slate-500 2xl:inline-block">
                {currentStaff.role}
              </span>
            )}
            <button
              type="button"
              onClick={handleLogoutClick}
              className="shrink-0 text-sm font-medium text-rose-600 hover:text-rose-700"
            >
              Log Out
            </button>
          </div>
          {/**
           * One button consolidates every status the header used to show
           * as five separate items (Online/Offline, unfiled sales, and
           * the four connectivity badges) — NavStatusButton's own dot
           * carries the at-a-glance signal; the dialog it opens carries
           * the detail. Each row's trigger is unchanged: the unfiled row
           * still runs the same admin-gated navigate, and each
           * connectivity row still opens the same `ConnectivityModal`.
           */}
          <NavStatusButton
            online={online}
            unfiledCount={unfiledCount}
            onUnfiledClick={() => {
              if (currentStaff.role !== 'admin') return
              setActiveView('admin')
              setAdminInitialTab('needsAttention')
            }}
            connectivityStatus={connectivityStatus}
            barcodeStatus={barcodeStatus}
            onSelectIntegration={setSelectedConnectivity}
          />
          {heldInStrip.length > 0 && (
            <span
              data-testid="held-count-chip"
              className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${
                heldAgeTone(heldInStrip[0].heldAt, Date.now()) === 'red'
                  ? 'bg-rose-100 text-rose-800'
                  : heldAgeTone(heldInStrip[0].heldAt, Date.now()) === 'amber'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-100 text-slate-700'
              }`}
            >
              Held {heldInStrip.length}
            </span>
          )}
          <span className="shrink-0 font-mono tabular-nums" aria-label="clock">
            {now}
          </span>
        </div>
      </header>

      {selectedConnectivity && (
        <ConnectivityModal
          integration={selectedConnectivity}
          status={connectivityStatus}
          barcodeStatus={barcodeStatus}
          onBarcodeDetected={() => setBarcodeStatus('connected')}
          onClose={() => setSelectedConnectivity(null)}
        />
      )}

      {activeView === 'catalog' ? (
        <main className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:w-[65%] lg:flex-none">
            <PosSearchBar
              products={products}
              onAddVariant={handleAddToCart}
              onOpenVariantPicker={setSelectedProduct}
              onNotFound={(query) => showScanToast('error', `Product Not Found: "${query}"`)}
              onFocusChange={setSearchInputFocused}
            />

            {status === 'loading' && (
              <p className="px-4 py-2 text-base text-slate-400">Loading catalog…</p>
            )}

            {status === 'error' && (
              <div className="flex flex-col items-center gap-2 p-4">
                <EmptyState
                  icon={<WarningIcon className="h-10 w-10" />}
                  title={error ?? 'Failed to load products'}
                  subtitle="Check your network connection, or the Store URL/Admin API Token in Admin > Integrations."
                />
                <button
                  type="button"
                  onClick={() => void fetchProducts()}
                  className="h-12 rounded-lg border border-slate-300 px-6 text-lg font-medium text-slate-700 hover:bg-slate-50"
                >
                  Try again
                </button>
              </div>
            )}

            {cached && (
              <span className="mx-4 mt-2 inline-flex w-fit shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-sm font-medium text-amber-700">
                Cached catalog (offline)
              </span>
            )}

            {shouldShowNoShiftNotice(shiftPresence) && (
              <NoShiftNotice
                blockedReason={isPaymentInProgress(paymentActive) ? HOLD_PAYMENT_REASON : null}
                onOpenShift={() => setOpenShiftDialogShown(true)}
              />
            )}

            {showWindowEndBanner && windowStatus && <WindowEndBanner status={windowStatus} />}

            <HeldSalesStrip requestManagerPin={requestManagerPin} />

            <PosCartTable
              items={cartItems}
              onUpdateQuantity={guardedCart.updateQuantity}
              onRemove={guardedCart.remove}
              onClear={guardedCart.clear}
              flashId={flashId}
              onHold={() => void handleHold()}
              holdBlockedReason={holdDecision.allowed ? null : holdDecision.reason}
              linesPerPage={
                CART_LINES_PER_PAGE -
                (heldInStrip.length > 0 ? 1 : 0) -
                (shouldShowNoShiftNotice(shiftPresence) || showWindowEndBanner ? 1 : 0)
              }
            />
          </section>

          <aside className="flex w-full shrink-0 flex-col border-t border-slate-200 lg:w-[35%] lg:border-l lg:border-t-0">
            <PosCheckoutPanel
              requestManagerPin={requestManagerPin}
              forceMpesaManualKeyboard={checkFitForcedScreen === 'mpesaManualKeyboard'}
            />
          </aside>
        </main>
      ) : activeView === 'orders' ? (
        /**
         * `overflow-hidden`, not `-auto`: `OrderHistory` scrolls its own
         * list (docs/phase-225), so the title stays put and nothing here
         * is ever taller than this box.
         */
        <main className="flex flex-1 flex-col overflow-hidden p-6">
          <h2 className="mb-4 shrink-0 text-xl font-semibold text-slate-700">
            Order History
          </h2>
          <OrderHistory
            onRetry={(localId) => void handleRetryOrder(localId)}
            onPrint={(localId) => void handlePrintReceipt(localId)}
            requestManagerPin={requestManagerPin}
          />
        </main>
      ) : (
        /**
         * Scrolls (docs/phase-247). It was `overflow-hidden` since docs/phase-167 Part B item 2, on the ground that every section
         * fits the design box; a list longer than the screen (staff, printers, Needs Attention, Stock Take, the fiscal test hops)
         * was cut off with no way to reach it. Whatever an Admin page holds now scrolls, with the always-visible bar. The Reports tab
         * fills the height it is given and so never scrolls here: its sections scroll in their own areas (docs/phase-246-1). The
         * plain "Admin" heading that sat above `AdminScreen` is gone
         * (docs/phase-220): the header tab and the breadcrumb say it.
         */
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="touch-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
            <AdminScreen
              requestManagerPin={requestManagerPin}
              initialTab={adminInitialTab}
            />
          </div>
        </main>
      )}

      {openShiftDialogShown && (
        <OpenShiftDialog
          staff={currentStaff}
          requestManagerPin={requestManagerPin}
          onClose={() => setOpenShiftDialogShown(false)}
          onOpened={() => {
            setOpenShiftDialogShown(false)
            void useShiftStore.getState().load()
          }}
        />
      )}

      {selectedProductForModal && (
        <VariantModal
          product={selectedProductForModal}
          onSelectVariant={handleSelectVariant}
          onClose={() => setSelectedProduct(null)}
        />
      )}

      {checkFitForcedScreen === 'zReport' && (
        <ZReportModal report={CHECK_FIT_SYNTHETIC_Z_REPORT} onClose={() => {}} />
      )}

      {checkFitForcedScreen === 'variantModal' && (
        <VariantModal product={CHECK_FIT_SYNTHETIC_PRODUCT} onSelectVariant={() => {}} onClose={() => {}} />
      )}

      {checkFitForcedScreen === 'shopifyCheckCard' && (
        // Deliberately no internally-scrolling class here — Phase E's
        // no-scroll rule (`noUnexpectedScroll.test.ts`'s own
        // `ZERO_SCROLL_FILES` for App.tsx) applies here too, and
        // `NeedsAttentionPage` already keeps its own content within the
        // viewport via pagination, exactly as the normal Admin >
        // Needs Attention navigation path already proves.
        <div className="fixed inset-0 z-50 bg-slate-50 p-6">
          <NeedsAttentionPage shopifyCheckOverride={CHECK_FIT_SYNTHETIC_RECONCILIATION_RESULT} />
        </div>
      )}

      {logoutWarningOpen && (
        <LogoutHeldWarning
          sales={heldSales}
          onStay={() => setLogoutWarningOpen(false)}
          onLogout={() => {
            setLogoutWarningOpen(false)
            void logout()
          }}
        />
      )}

      {pinGate && (
        <ManagerPinModal
          title={pinGate.title}
          onAuthorized={(managerId, managerPin) => {
            pinGate.onAuthorized(managerId, managerPin)
            setPinGate(null)
          }}
          onCancel={() => setPinGate(null)}
        />
      )}

      {/**
        * Toast producers (phase-84): each decides its own content off its
        * own trigger (IPC stream or cartStore) and renders nothing itself;
        * ToastStack is the only thing that actually draws a toast, in one
        * unified top-center column.
        */}
      <UpdateToast />
      <UpdatePrompt />
      <ConnectivityToast />
      <FiscalNotice />
      <ShopifyCheckNotice />
      <SaleCompleteToast />
      <ToastStack />
    </div>
  )
}

