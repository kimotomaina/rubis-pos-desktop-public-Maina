import { useEffect, useState } from 'react'
import { useCartStore } from './stores/cartStore'
import { useProductStore } from './stores/productStore'
import { useNetworkStore } from './stores/networkStore'
import { useUiStore } from './stores/uiStore'
import { useAuthStore } from './stores/authStore'
import { useBarcodeScanner } from './hooks/useBarcodeScanner'
import { formatCurrency } from './lib/currency'
import { filterProducts } from './lib/productSearch'
import type { CartItem, Discount, VariantSummary, ProductSummary } from './types/shopify'
import ProductCard from './components/ProductCard'
import ProductSearchBar from './components/ProductSearchBar'
import CartLineItem from './components/CartLineItem'
import EmptyState from './components/EmptyState'
import VariantModal from './components/VariantModal'
import OrderHistory from './components/OrderHistory'
import LoginScreen from './components/LoginScreen'
import CheckoutModal from './components/CheckoutModal'
import AdminScreen from './components/AdminScreen'
import UpdateToast from './components/UpdateToast'
import ManagerPinModal from './components/ManagerPinModal'
import { requiresManagerPinForDiscount } from './lib/checkoutMath'
import rubisLogo from './assets/logo-rubis.png'

/** A pending manager-gated action awaiting PIN authorization. */
interface PinGateRequest {
  title: string
  /**
   * Receives the authorizing admin's id and PIN (Phase 14) so callers
   * that hit a privileged IPC channel (`createStaff`, `resetStaffPin`,
   * `setIntegrationConfig`) can forward them for the main process's
   * independent `requireAdminPin` re-check.
   */
  onAuthorized: (managerId: number, managerPin: string) => void
}

/** Transient banner shown after a barcode scan attempt. */
interface ScanToast {
  kind: 'success' | 'error'
  message: string
}

/**
 * Converts a product + variant pair into the cart-line shape expected
 * by `useCartStore.addItem`.
 *
 * @param {ProductSummary} product
 * @param {VariantSummary} variant
 * @returns {Omit<CartItem, 'quantity'>}
 */
function buildCartItem(
  product: ProductSummary,
  variant: VariantSummary
): Omit<CartItem, 'quantity'> {
  return {
    id: variant.id,
    productId: variant.productId,
    title: product.title,
    variantTitle: variant.title,
    price: variant.price,
    image: variant.image ?? product.featuredImage
  }
}

/**
 * Root POS shell.
 *
 * Orchestrates two Zustand stores:
 *   - `useProductStore` — fetches the Shopify catalog via IPC
 *   - `useCartStore`    — manages the cashier's line items
 *
 * The layout is a touch-friendly 2-pane design: a scrollable product
 * grid on the left and a fixed-width cart sidebar on the right.
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
  const [scanToast, setScanToast] = useState<ScanToast | null>(null)

  const cartItems = useCartStore((state) => state.items)
  const cartTotal = useCartStore((state) => state.getTotal())
  const cartSubtotal = useCartStore((state) => state.getSubtotal())
  const cartDiscount = useCartStore((state) => state.cartDiscount)
  const cartCount = useCartStore((state) => state.getItemCount())
  const addItem = useCartStore((state) => state.addItem)
  const updateQuantity = useCartStore((state) => state.updateQuantity)
  const removeItem = useCartStore((state) => state.removeItem)
  const setItemPrice = useCartStore((state) => state.setItemPrice)
  const setItemDiscount = useCartStore((state) => state.setItemDiscount)
  const setCartDiscount = useCartStore((state) => state.setCartDiscount)

  const [pinGate, setPinGate] = useState<PinGateRequest | null>(null)
  const requestManagerPin = (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => setPinGate({ title, onAuthorized })

  const [showCartDiscountEditor, setShowCartDiscountEditor] = useState(false)
  const [cartDiscountType, setCartDiscountType] = useState<Discount['type']>('percent')
  const [cartDiscountValue, setCartDiscountValue] = useState('')

  const applyCartDiscount = () => {
    const value = parseFloat(cartDiscountValue)
    if (!Number.isFinite(value) || value <= 0) {
      setCartDiscount(null)
      setShowCartDiscountEditor(false)
      return
    }
    const discount: Discount = { type: cartDiscountType, value }
    const apply = () => {
      setCartDiscount(discount)
      setShowCartDiscountEditor(false)
    }
    if (requiresManagerPinForDiscount(discount, cartSubtotal)) {
      requestManagerPin('Cart discount over 10%', apply)
    } else {
      apply()
    }
  }

  const products = useProductStore((state) => state.products)
  const status = useProductStore((state) => state.status)
  const error = useProductStore((state) => state.error)
  const fetchProducts = useProductStore((state) => state.fetchProducts)
  const cached = useProductStore((state) => state.cached)

  const online = useNetworkStore((state) => state.online)
  const initNetwork = useNetworkStore((state) => state.init)

  const selectedProductForModal = useUiStore((state) => state.selectedProductForModal)
  const activeView = useUiStore((state) => state.activeView)
  const setSelectedProduct = useUiStore((state) => state.setSelectedProduct)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const checkoutModalOpen = useUiStore((state) => state.checkoutModalOpen)
  const setCheckoutModalOpen = useUiStore((state) => state.setCheckoutModalOpen)
  const searchQuery = useUiStore((state) => state.searchQuery)
  const setSearchQuery = useUiStore((state) => state.setSearchQuery)
  const [searchInputFocused, setSearchInputFocused] = useState(false)

  const currentStaff = useAuthStore((state) => state.currentStaff)
  const logout = useAuthStore((state) => state.logout)

  const checkoutStatus = useCartStore((state) => state.checkoutStatus)
  const checkoutError = useCartStore((state) => state.checkoutError)

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

  const handleAddToCart = (product: ProductSummary, variant: VariantSummary) => {
    addItem(buildCartItem(product, variant), 1)
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
      const result = await window.api.printReceipt(localId)
      setScanToast(
        result.success
          ? {
              kind: 'success',
              message: result.data?.mock
                ? 'Receipt printed (mock mode)'
                : 'Receipt sent to printer'
            }
          : { kind: 'error', message: result.error ?? 'Failed to print receipt' }
      )
    } catch (err) {
      setScanToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to print receipt'
      })
    }
  }

  const handleSelectVariant = (variant: VariantSummary) => {
    if (selectedProductForModal) {
      handleAddToCart(selectedProductForModal, variant)
    }
    setSelectedProduct(null)
  }

  useEffect(() => {
    if (!scanToast) return
    const id = setTimeout(() => setScanToast(null), 2500)
    return () => clearTimeout(id)
  }, [scanToast])

  const handleScan = (barcode: string) => {
    for (const product of products) {
      const variant = product.variants.find((v) => v.barcode === barcode)
      if (variant) {
        handleAddToCart(product, variant)
        const label =
          variant.title === 'Default Title'
            ? product.title
            : `${product.title} (${variant.title})`
        setScanToast({ kind: 'success', message: `Added: ${label}` })
        return
      }
    }
    setScanToast({ kind: 'error', message: `Barcode not recognized: ${barcode}` })
  }

  useBarcodeScanner(handleScan, {
    enabled: activeView === 'catalog' && !!currentStaff && !searchInputFocused
  })

  const filteredProducts = filterProducts(products, searchQuery)

  const demoModeBanner = import.meta.env.VITE_DEMO_MODE === 'true' && (
    <div className="bg-amber-500 py-2 text-center text-sm font-bold uppercase tracking-wide text-white">
      ⚠️ Demo Mode Active — Sales are local only and will not sync to Shopify ⚠️
    </div>
  )

  if (!currentStaff) {
    return (
      <>
        {demoModeBanner}
        <LoginScreen />
      </>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      {demoModeBanner}
      {/* Header */}
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6 shadow-sm">
        <div className="flex items-center gap-6">
          <img src={rubisLogo} alt="RUBIS Energie" className="h-9 w-auto" />
          <nav className="flex gap-1">
            <button
              type="button"
              onClick={() => setActiveView('catalog')}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
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
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
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
                onClick={() => setActiveView('admin')}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
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
        <div className="flex items-center gap-4 text-sm text-slate-600">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-700">
              {currentStaff.name}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-500">
              {currentStaff.role}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="text-xs font-medium text-rose-600 hover:text-rose-700"
            >
              Log Out
            </button>
          </div>
          {online ? (
            <span className="flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-700">
              <span
                className="h-2.5 w-2.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              Online
            </span>
          ) : (
            <span className="flex items-center gap-2 rounded-full bg-rose-100 px-3 py-1 font-medium text-rose-700">
              <span
                className="h-2.5 w-2.5 rounded-full bg-rose-500"
                aria-hidden
              />
              Offline — sales will queue
            </span>
          )}
          <span className="font-mono tabular-nums" aria-label="clock">
            {now}
          </span>
        </div>
      </header>

      {/* Main: product grid + cart, or order history */}
      {activeView === 'catalog' ? (
        <main className="flex flex-1 overflow-hidden">
          {/* Product grid */}
          <section className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-700">Products</h2>
              {cached && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                  Cached catalog (offline)
                </span>
              )}
              <ProductSearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onFocus={() => setSearchInputFocused(true)}
                onBlur={() => setSearchInputFocused(false)}
              />
            </div>

            {status === 'loading' && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[160px] animate-pulse rounded-xl bg-slate-200"
                  />
                ))}
              </div>
            )}

            {status === 'error' && (
              <EmptyState
                icon="⚠️"
                title={error ?? 'Failed to load products'}
                subtitle="Check your .env credentials and restart the app."
              />
            )}

            {status === 'ready' && products.length === 0 && (
              <EmptyState
                icon="📭"
                title="No products found"
                subtitle="Your Shopify store has no active products."
              />
            )}

            {status === 'ready' && products.length > 0 && filteredProducts.length === 0 && (
              <EmptyState
                icon="🔍"
                title="No matches"
                subtitle={`Nothing found for "${searchQuery.trim()}".`}
              />
            )}

            {status === 'ready' && filteredProducts.length > 0 && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {filteredProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onAddToCart={(variant) => handleAddToCart(product, variant)}
                    onSelectProduct={setSelectedProduct}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Cart sidebar */}
          <aside className="flex w-md shrink-0 flex-col border-l border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-4">
              <h2 className="text-lg font-semibold text-slate-700">
                Cart ({cartCount} items)
              </h2>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {cartItems.length === 0 ? (
                <EmptyState icon="🛒" title="Cart is empty" />
              ) : (
                cartItems.map((item) => (
                  <CartLineItem
                    key={item.id}
                    item={item}
                    onUpdateQuantity={updateQuantity}
                    onRemove={removeItem}
                    onSetPrice={setItemPrice}
                    onSetDiscount={setItemDiscount}
                    requestManagerPin={requestManagerPin}
                    showToast={setScanToast}
                  />
                ))
              )}
            </div>

            <div className="border-t border-slate-200 p-4">
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    setCartDiscountValue(cartDiscount ? String(cartDiscount.value) : '')
                    setCartDiscountType(cartDiscount?.type ?? 'percent')
                    setShowCartDiscountEditor((prev) => !prev)
                  }}
                  className="text-xs font-medium text-slate-500 hover:text-rose-600"
                >
                  {cartDiscount ? 'Edit Discount' : '+ Discount'}
                </button>
                {cartDiscount && (
                  <span className="text-xs font-medium text-emerald-600">
                    {cartDiscount.type === 'percent'
                      ? `${cartDiscount.value}% off`
                      : `${formatCurrency(cartDiscount.value)} off`}
                  </span>
                )}
              </div>

              {showCartDiscountEditor && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 p-2">
                  <select
                    value={cartDiscountType}
                    onChange={(e) => setCartDiscountType(e.target.value as Discount['type'])}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
                  >
                    <option value="percent">%</option>
                    <option value="fixed">Ksh</option>
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cartDiscountValue}
                    onChange={(e) => setCartDiscountValue(e.target.value)}
                    autoFocus
                    className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={applyCartDiscount}
                    className="text-xs font-medium text-rose-600 hover:text-rose-700"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCartDiscountEditor(false)}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {cartDiscount && (
                <div className="mb-1 flex justify-between text-sm text-slate-500">
                  <span>Subtotal</span>
                  <span>{formatCurrency(cartSubtotal)}</span>
                </div>
              )}

              <div className="mb-3 flex justify-between text-lg font-semibold">
                <span>Total</span>
                <span>{formatCurrency(cartTotal)}</span>
              </div>

              {checkoutStatus === 'synced' && (
                <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
                  ✓ Order synced to Shopify
                </p>
              )}

              {checkoutStatus === 'queued-offline' && (
                <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
                  Saved Offline — Will Sync
                </p>
              )}

              {checkoutStatus === 'error' && (
                <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                  {checkoutError ?? 'Checkout failed'}
                </p>
              )}

              <button
                type="button"
                disabled={cartCount === 0 || checkoutStatus === 'submitting'}
                onClick={() => setCheckoutModalOpen(true)}
                className="w-full rounded-lg bg-rose-600 px-6 py-4 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Checkout
              </button>
            </div>
          </aside>
        </main>
      ) : activeView === 'orders' ? (
        <main className="flex-1 overflow-y-auto p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-700">
            Order History
          </h2>
          <OrderHistory
            onRetry={(localId) => void handleRetryOrder(localId)}
            onPrint={(localId) => void handlePrintReceipt(localId)}
            requestManagerPin={requestManagerPin}
          />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-700">Admin</h2>
          <AdminScreen requestManagerPin={requestManagerPin} />
        </main>
      )}

      {/* Barcode scan toast */}
      {scanToast && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg ${
            scanToast.kind === 'success' ? 'bg-emerald-600' : 'bg-rose-600'
          }`}
        >
          {scanToast.message}
        </div>
      )}

      {/* Variant picker modal */}
      {selectedProductForModal && (
        <VariantModal
          product={selectedProductForModal}
          onSelectVariant={handleSelectVariant}
          onClose={() => setSelectedProduct(null)}
        />
      )}

      {/* Checkout modal */}
      {checkoutModalOpen && (
        <CheckoutModal onClose={() => setCheckoutModalOpen(false)} />
      )}

      {/* Manager PIN gate for discounts/price overrides/voids */}
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

      {/* Auto-update toast */}
      <UpdateToast />
    </div>
  )
}

