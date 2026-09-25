import { useState } from 'react'
import rubisLogo from '../assets/logo-rubis.png'
import LocationPicker, { type ShopifyLocationOption } from './LocationPicker.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'

/** Which step of the wizard is currently shown. */
type OnboardingStep = 'connect' | 'location'

const INPUT_CLASS =
  'h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-lg text-slate-900 placeholder-slate-400 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'

const LABEL_CLASS = 'mb-1 block text-base font-medium text-slate-600'

/**
 * First-run setup wizard — replaces the Login screen on a
 * fresh install that has no Shopify store URL/token configured yet,
 * so a packaged `.exe` never depends on a `.env` file being present
 * on the machine it's installed on.
 *
 * Step 1 verifies a store URL/token pair against the live Shopify API
 * (`window.api.validateShopifyConfig`) and fetches its locations.
 * Step 2 has the operator pick exactly one location — auto-selected
 * when only one exists — then persists everything via
 * `window.api.saveConfig` and reloads the window so the main
 * process's already-resolved config (store URL, vault token, location
 * id) is picked up by every service that depends on it.
 *
 * The step-1 fields are read-only and open the docked on-screen keyboard
 * (`text` layout) on tap; its keystrokes come back through the store's
 * relay into the same `setStoreUrl`/`setToken` state a physical keyboard
 * used to write. While the sheet is open the page top-aligns and reserves
 * the sheet's height, so Connect & Verify stays visible above it.
 *
 * @returns {JSX.Element}
 */
export default function OnboardingScreen() {
  const [step, setStep] = useState<OnboardingStep>('connect')
  const [storeUrl, setStoreUrl] = useState('')
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const [shopName, setShopName] = useState('')
  const [locations, setLocations] = useState<ShopifyLocationOption[]>([])
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const keyboardOpen = useKeyboardStore((state) => state.request?.docked === true)

  const openKeyboard = (label: string, value: string, onChange: (next: string) => void) =>
    useKeyboardStore.getState().open({ value, onChange, label, mode: 'text', docked: true })

  const handleConnect = async () => {
    useKeyboardStore.getState().close()
    if (!storeUrl.trim() || !token.trim()) {
      setConnectError('Enter both the store URL and the Admin API token')
      return
    }
    setConnecting(true)
    setConnectError(null)
    try {
      const result = await window.api.validateShopifyConfig(storeUrl.trim(), token.trim())
      if (!result.success || !result.data) {
        setConnectError(result.error ?? 'Could not connect to Shopify')
        return
      }
      setShopName(result.data.shopName)
      setLocations(result.data.locations)
      setSelectedLocationId(result.data.locations.length === 1 ? result.data.locations[0].id : '')
      setStep('location')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not connect to Shopify')
    } finally {
      setConnecting(false)
    }
  }

  const handleSave = async () => {
    if (!selectedLocationId) {
      setSaveError('Select a location')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const selectedLocationName =
        locations.find((location) => location.id === selectedLocationId)?.name ?? ''
      const result = await window.api.saveConfig(
        storeUrl.trim(),
        token.trim(),
        selectedLocationId,
        selectedLocationName
      )
      if (!result.success) {
        setSaveError(result.error ?? 'Failed to save configuration')
        return
      }
      window.location.reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`app-theme flex h-screen flex-col items-center overflow-y-auto px-4 ${
        keyboardOpen ? 'justify-start pt-8 pb-keyboard-sheet' : 'justify-center'
      }`}
    >
      <img src={rubisLogo} alt="Enjoy" className="mb-8 h-16 w-auto" />

      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-slate-900">Connect this till to Shopify</h1>
        <p className="mb-6 text-base text-slate-500">
          {step === 'connect'
            ? 'One-time setup — this only needs to happen once per till.'
            : `Connected to ${shopName}. Pick the location this till sells from.`}
        </p>

        {step === 'connect' && (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="onboarding-store-url" className={LABEL_CLASS}>
                  Shopify Store URL
                </label>
                <input
                  id="onboarding-store-url"
                  type="text"
                  value={storeUrl}
                  readOnly
                  onFocus={() => openKeyboard('Shopify Store URL', storeUrl, setStoreUrl)}
                  onClick={() => openKeyboard('Shopify Store URL', storeUrl, setStoreUrl)}
                  placeholder="your-store.myshopify.com"
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <label htmlFor="onboarding-token" className={LABEL_CLASS}>
                  Admin API Access Token
                </label>
                <input
                  id="onboarding-token"
                  type="password"
                  value={token}
                  readOnly
                  onFocus={() => openKeyboard('Admin API Access Token', token, setToken)}
                  onClick={() => openKeyboard('Admin API Access Token', token, setToken)}
                  placeholder="shpat_..."
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            {connectError && (
              <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
                {connectError}
              </p>
            )}

            <button
              type="button"
              disabled={connecting}
              onClick={() => void handleConnect()}
              className="h-14 w-full rounded-lg bg-rose-600 text-lg font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connecting ? 'Connecting…' : 'Connect & Verify'}
            </button>
          </div>
        )}

        {step === 'location' && (
          <LocationPicker
            shopName={shopName}
            locations={locations}
            selectedLocationId={selectedLocationId}
            onSelect={setSelectedLocationId}
            onConfirm={() => void handleSave()}
            confirming={saving}
            confirmError={saveError}
            confirmLabel={saving ? 'Saving…' : 'Save Configuration & Start'}
            onBack={() => setStep('connect')}
          />
        )}
      </div>
    </div>
  )
}
