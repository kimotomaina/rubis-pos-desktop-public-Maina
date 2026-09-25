import { useEffect, useState } from 'react'
import rubisLogo from '../assets/logo-rubis.png'
import LocationPicker, { type ShopifyLocationOption } from './LocationPicker'
import { useProductStore } from '../stores/productStore'

interface LocationConfirmScreenProps {
  /** The till's currently-persisted location id, if any — pre-selected in the list when it matches a fetched location. */
  currentLocationId: string | null
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
  /** Called after the location is successfully confirmed, so App.tsx can re-fetch config status and proceed to the POS shell. */
  onConfirmed: () => void
}

/**
 * Mandatory post-login gate shown to an admin when this till's
 * location hasn't been explicitly confirmed yet — replaces the old
 * silent "Phase 4" auto-detect that picked whichever location
 * Shopify returned first with no admin ever reviewing it.
 */
export default function LocationConfirmScreen({
  currentLocationId,
  requestManagerPin,
  onConfirmed
}: LocationConfirmScreenProps) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shopName, setShopName] = useState('')
  const [locations, setLocations] = useState<ShopifyLocationOption[]>([])
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    window.api
      .listLocations()
      .then((result) => {
        if (cancelled) return
        if (!result.success || !result.data) {
          setLoadError(result.error ?? 'Could not fetch locations from Shopify')
          return
        }
        setShopName(result.data.shopName)
        setLocations(result.data.locations)
        const preselect = result.data.locations.find((l) => l.id === currentLocationId)
        setSelectedLocationId(
          preselect?.id ?? (result.data.locations.length === 1 ? result.data.locations[0].id : '')
        )
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Could not fetch locations from Shopify')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentLocationId])

  const handleConfirm = () => {
    const location = locations.find((l) => l.id === selectedLocationId)
    if (!location) {
      setConfirmError('Select a location')
      return
    }
    requestManagerPin('Confirm this till’s location', (managerId, managerPin) => {
      setConfirming(true)
      setConfirmError(null)
      window.api
        .setLocation(location.id, location.name, managerId, managerPin)
        .then((result) => {
          if (!result.success) {
            setConfirmError(result.error ?? 'Failed to save location')
            return
          }
          // The catalog fetch that ran on app mount used whatever
          // location (if any) was resolved before this confirmation —
          // re-fetch now so the POS shell that's about to render shows
          // the newly-confirmed location's live catalog immediately.
          void useProductStore.getState().fetchProducts()
          onConfirmed()
        })
        .catch((err) => {
          setConfirmError(err instanceof Error ? err.message : 'Failed to save location')
        })
        .finally(() => setConfirming(false))
    })
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-slate-900 px-4 text-white">
      <img src={rubisLogo} alt="Enjoy" className="mb-8 h-16 w-auto" />

      <div className="w-full max-w-md rounded-2xl bg-slate-800 p-6 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-white">Confirm this till&rsquo;s location</h1>
        <p className="mb-6 text-base text-slate-400">
          Pick which Shopify location this till sells from before continuing.
        </p>

        {loading && <p className="text-base text-slate-400">Loading locations…</p>}

        {!loading && loadError && (
          <p className="rounded-lg bg-rose-950 px-3 py-2 text-base font-medium text-rose-300">
            {loadError}
          </p>
        )}

        {!loading && !loadError && (
          <LocationPicker
            shopName={shopName}
            locations={locations}
            selectedLocationId={selectedLocationId}
            onSelect={setSelectedLocationId}
            onConfirm={handleConfirm}
            confirming={confirming}
            confirmError={confirmError}
            confirmLabel={confirming ? 'Saving…' : 'Confirm Location'}
          />
        )}
      </div>
    </div>
  )
}
