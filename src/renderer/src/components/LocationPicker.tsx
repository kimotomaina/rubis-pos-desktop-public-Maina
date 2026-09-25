export interface ShopifyLocationOption {
  id: string
  name: string
}

interface LocationPickerProps {
  shopName: string
  locations: ShopifyLocationOption[]
  selectedLocationId: string
  onSelect: (id: string) => void
  onConfirm: () => void
  confirming: boolean
  confirmError: string | null
  /** Label for the primary button — differs by caller (onboarding vs. the post-login gate vs. Admin's "Change Location"). */
  confirmLabel: string
  /** Optional back/cancel affordance — omit when there's no prior step to return to. */
  onBack?: () => void
}

/**
 * Radio-list location picker shared by `OnboardingScreen`,
 * `LocationConfirmScreen`, and `AdminScreen`'s "Change Location"
 * control — auto-selects the sole location when only one exists.
 */
export default function LocationPicker({
  shopName,
  locations,
  selectedLocationId,
  onSelect,
  onConfirm,
  confirming,
  confirmError,
  confirmLabel,
  onBack
}: LocationPickerProps) {
  return (
    <div>
      <p className="mb-2 rounded-lg bg-emerald-100 px-3 py-2 text-base font-medium text-emerald-700">
        Connected to {shopName}
      </p>

      {locations.length === 1 ? (
        <p className="mb-4 text-base text-slate-500">
          Only one location exists — <strong>{locations[0].name}</strong> was automatically
          selected.
        </p>
      ) : (
        <div className="mb-4 space-y-2">
          {locations.map((location) => (
            <label
              key={location.id}
              className={`flex h-14 cursor-pointer items-center gap-3 rounded-lg border px-4 text-lg ${
                selectedLocationId === location.id
                  ? 'border-rose-400 bg-rose-50 text-slate-900'
                  : 'border-slate-300 bg-white text-slate-900'
              }`}
            >
              <input
                type="radio"
                name="location"
                value={location.id}
                checked={selectedLocationId === location.id}
                onChange={() => onSelect(location.id)}
                className="h-5 w-5"
              />
              {location.name}
            </label>
          ))}
        </div>
      )}

      {confirmError && (
        <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
          {confirmError}
        </p>
      )}

      <button
        type="button"
        disabled={confirming || !selectedLocationId}
        onClick={onConfirm}
        className="h-14 w-full rounded-lg bg-rose-600 text-lg font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {confirmLabel}
      </button>

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mt-3 w-full text-center text-base text-slate-500 hover:text-slate-700"
        >
          ← Back
        </button>
      )}
    </div>
  )
}
