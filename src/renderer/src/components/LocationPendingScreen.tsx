import rubisLogo from '../assets/logo-rubis.png'

interface LocationPendingScreenProps {
  onLogout: () => void
}

/**
 * Blocking screen shown to a non-admin staff member when this till's
 * location hasn't been confirmed yet. Only an admin can see/pick a
 * location (`LocationConfirmScreen`), so a cashier is stopped here
 * with no location data exposed, and a way out via Log Out.
 */
export default function LocationPendingScreen({ onLogout }: LocationPendingScreenProps) {
  return (
    <div className="app-theme flex h-screen flex-col items-center justify-center px-4">
      <img src={rubisLogo} alt="Enjoy" className="mb-8 h-16 w-auto" />

      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl">
        <h1 className="mb-2 text-2xl font-bold text-slate-900">Ask a manager to set this till&rsquo;s location</h1>
        <p className="mb-6 text-base text-slate-500">
          This till hasn&rsquo;t been assigned a Shopify location yet. Log in as an admin, or ask a
          manager to sign in, to finish setup before selling.
        </p>
        <button
          type="button"
          onClick={onLogout}
          className="h-14 w-full rounded-lg border border-slate-300 bg-white text-lg font-bold text-slate-700 transition active:scale-95 hover:bg-slate-100"
        >
          Log Out
        </button>
      </div>
    </div>
  )
}
