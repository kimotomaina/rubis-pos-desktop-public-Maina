import { useState } from 'react'
import { LOCATIONS_PER_PAGE, pageOfIndex, paginate } from '../lib/paginate.js'

export interface ShopifyLocationOption {
  id: string
  name: string
  /** One line of address, when Shopify holds one — shown under the name to tell branches apart. */
  address?: string
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

const CARD_CLASS =
  'flex h-20 flex-col justify-center rounded-lg border px-3 text-left transition active:scale-95'

const PAGE_BUTTON_CLASS =
  'h-11 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40'

/**
 * Card-grid location picker shared by `OnboardingScreen`,
 * `LocationConfirmScreen`, and `AdminScreen`'s "Change Location"
 * control — auto-selects the sole location when only one exists.
 *
 * Paginated at {@link LOCATIONS_PER_PAGE} (phase-141): the account this
 * ships to has around 106 locations, and the radio list this replaced
 * rendered every one of them in a screen that does not scroll. The page
 * controls always render once there is more than one location, so their
 * disabled state is what tells the operator they are at an end, rather
 * than the buttons vanishing.
 *
 * Paging is presentation only. Selection still goes out through
 * `onSelect`, so the PIN-gated `location:set` and the onboarding
 * `config:save` paths behind it are untouched, and a location chosen on
 * one page stays chosen while the operator looks at another.
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
  /**
   * Opens on the page holding the current selection, so a till whose
   * location is the 93rd does not open on page 1 looking unset. Read once
   * at mount: every caller fetches the list before rendering this, and
   * paging afterwards is the operator's own choice to keep.
   */
  const [page, setPage] = useState(() =>
    pageOfIndex(
      locations.findIndex((location) => location.id === selectedLocationId),
      LOCATIONS_PER_PAGE
    )
  )

  const pageResult = paginate(locations, page, LOCATIONS_PER_PAGE)

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
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            {pageResult.items.map((location) => {
              const selected = selectedLocationId === location.id
              return (
                <button
                  key={location.id}
                  type="button"
                  onClick={() => onSelect(location.id)}
                  aria-pressed={selected}
                  className={`${CARD_CLASS} ${
                    selected
                      ? 'border-rose-400 bg-rose-50 text-slate-900'
                      : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  <span className="truncate text-base font-semibold">{location.name}</span>
                  {location.address && (
                    <span className="truncate text-sm text-slate-500">{location.address}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="mb-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setPage(pageResult.page - 1)}
              disabled={!pageResult.hasPrev}
              className={PAGE_BUTTON_CLASS}
            >
              Previous
            </button>
            <span className="text-base font-medium text-slate-600">
              Page {pageResult.page} of {pageResult.pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage(pageResult.page + 1)}
              disabled={!pageResult.hasNext}
              className={PAGE_BUTTON_CLASS}
            >
              Next
            </button>
          </div>
        </>
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
