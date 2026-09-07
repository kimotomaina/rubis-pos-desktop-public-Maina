# Phase 85 — Task 3: on-screen keyboard, Audit

Read-only. No code changed. STOP for review before Apply.

## 1. Does a touch keyboard already exist?

**A numpad exists (`VirtualNumpad.tsx`, phase-16/17); a full alphanumeric
keyboard does not, anywhere in the renderer.**

`VirtualNumpad` (`src/renderer/src/components/VirtualNumpad.tsx`) is a
fully-controlled (`value`/`onChange`) 3-column grid of digits `1`-`9`,
an optional `.`, `0`, `⌫` (backspace), a `Clear` key, and an optional
`Enter` key. **Digits and a decimal point only — no letters, no way to
extend it to letters without changing its shape.** It's wired into:

- `PosCheckoutPanel.tsx` — Amount Tendered (cash checkout).
- `ManagerPinModal.tsx` — the numeric admin PIN, `allowDecimal={false}`,
  added *alongside* the existing `<input type="password">`, not
  replacing it.
- `CheckoutModal.tsx` — same use as `PosCheckoutPanel`, but that
  component isn't mounted anywhere (dead code, confirmed in an earlier
  phase).

No installed library either: `package.json` has no keyboard-related
dependency (grepped `dependencies`/`devDependencies` for "keyboard"),
and nothing keyboard-named exists in `node_modules` even transitively.

**Verdict: nothing to extend for letters. A new component is needed if
this is built — but see §5 for exactly how small it can be, and the
important prior-art note in §5 about how it should be tested.**

## 2. Is it even needed? (the input-hardware question)

**Strong, repo-documented evidence this is a touch-primary till with an
unreliable path to a system keyboard — but not an absolute, explicit
"there is no physical keyboard" statement. Flagging the gap rather than
assuming.**

What the repo actually says, in its own words:

- `docs/phase-16.md` ("Touch UI Overhaul"): *"A site visit ahead of the
  1-week Proof of Concept showed the existing UI reads too small for a
  15" retail touchscreen…"* — this is the origin of `VirtualNumpad`
  itself, built specifically because a physical keyboard couldn't be
  relied on for numeric fields.
- That same phase explicitly **cut** a different, larger piece of work:
  *"The originating brief also asked for a custom QWERTY `TouchKeyboard`
  component and a `keyboard:show` IPC handler that shells out to
  Windows' `tabtip.exe` for text fields. That was cut from this pass…
  Free-text fields (M-Pesa reference, staff names, product search) are
  left to Windows' own touch keyboard."* Confirmed nothing from that cut
  piece was ever added later — no `tabtip`, `keyboard:show`, or
  `TouchKeyboard` anywhere in `src/`.
- `docs/phase-17.md` ("Touch UI Optimization for 15" 1080p Screen")
  confirms the target resolution (1920×1080) and continues sizing
  everything for touch.
- **`VirtualNumpad.tsx`'s own doc comment, still live in the code today,
  directly contradicts phase-16's "leave it to Windows' own touch
  keyboard" plan**: *"a 15" retail touchscreen cannot rely on a physical
  keyboard, and Windows' own touch keyboard is unreliable to trigger
  from an Electron (non-UWP) window."* This is the single most important
  finding for this question — it reads as a lesson learned *after*
  phase-16 shipped (the file is dated one day later in git history) that
  the punt-to-OS-keyboard plan doesn't actually work reliably in this
  app. That's very likely exactly why this task exists now: the company
  name and KRA PIN fields are two of the free-text fields phase-16
  explicitly punted on, and the punt appears not to hold up in practice.
- No `kiosk: true` on the `BrowserWindow`, and no README/config
  statement that the deployed hardware has literally no physical
  keyboard attached. The window does `maximize()` on launch and has an
  F11 fullscreen toggle (`main/index.ts`), consistent with a touch-first
  kiosk-style deployment, but that's circumstantial, not a hardware
  inventory.

**My reading**: the weight of evidence says build it — a POC site visit
already found the UI needed touch accommodation, the numpad was built
for exactly that reason, and its own comment says the OS keyboard
fallback is unreliable. But since no document states "this till has no
physical keyboard, full stop," I'm flagging it as your call rather than
assuming: if the actual deployed till *does* have a reliable physical
keyboard for these two fields specifically, this task may be lower
priority than it looks from the code alone.

## 3. Exactly which fields need it

**In scope**, per the brief:

| Field | File | Current input | Validation/limit |
|---|---|---|---|
| Company name | `PosCheckoutPanel.tsx` (~line 154) | `<input type="text">`, no aid | none (free text) |
| Customer KRA PIN | `PosCheckoutPanel.tsx` (~line 164) | `<input type="text">`, uppercased on change | `maxLength={KRA_PIN_MAX_LENGTH}` (11); format only checked on submit (`customerPinError`, non-blocking) |
| Corrected KRA PIN (wrong-PIN fix-and-resend) | `FiscalNotice.tsx` (phase-79) | `<input type="text">`, uppercased on change | `maxLength={KRA_PIN_MAX_LENGTH}`; Save is **disabled** until `isValidKraPinFormat` passes |

All three currently rely entirely on whatever keyboard focusing a text
input brings up — none has any on-screen aid today. `isValidKraPinFormat`
(`lib/kraPin.ts`) is the single format check both PIN fields already
share: one letter (`P` or `A`), nine digits, one trailing letter,
uppercased. Company name has no format check (KRA doesn't constrain it
the same way; the real fiscal provider sanitizes/truncates it separately
at submit time — not this task's concern).

**Deliberately out of scope, noted for completeness**: Amount Tendered
(already has `VirtualNumpad`); the discount value field
(`PosCheckoutPanel`, `type="number"`, no aid); the M-Pesa reference
number (`PaymentModal.tsx`, plain text, no aid); product search
(`PosSearchBar.tsx`, plain text, no aid); `ManagerPinModal`/`LoginScreen`
(already have numeric pads). All four of those are exactly the
"free-text fields... left to Windows' own touch keyboard" phase-16 named
— if the OS-keyboard reliability problem is real (per §2), they have the
same latent gap this task is closing for company name/PIN, just not
commissioned here. Worth keeping in mind if a shared keyboard component
gets built: it would trivially serve these later without redesign.

## 4. The screen-space constraint

Both containers are narrow and already vertically tight — an inline,
space-competing keyboard is a real risk in both:

- **`PosCheckoutPanel`**: the company/PIN fields sit in a fixed
  (non-scrolling) header block at the *top* of the panel. Below it:
  another fixed block (total + discount), then a `flex-1
  overflow-y-auto` section holding the payment-method toggle, the
  numeric numpad, and the Complete Sale button. The panel itself is only
  ~35% of the window width (~480-670px at the documented 1920px target).
  Docking a QWERTY-sized keyboard **inline, directly below the fields**
  would push the total/numpad/Complete-Sale-button stack further down —
  since that stack is scrollable, it wouldn't be destroyed, but it could
  easily be pushed out of view without scrolling, which is a bad place
  to lose sight of the Complete Sale button mid-transaction.
- **`FiscalNotice`**: the PIN-correction input lives inside a single
  toast in the phase-84 top-center stack, itself only `w-80` (320px)
  wide. There is no realistic way a usable QWERTY layout fits *inside*
  that toast without the toast becoming far wider than every other toast
  in the stack (breaking the just-shipped unified column) or extending
  well below the fold into the product grid beneath it.

**Placement options, surfaced not decided:**

1. **Bottom-docked, full-width bar** — appears fixed to the bottom of
   the window whenever any in-scope field is focused, regardless of
   which of the three triggered it (one shared keyboard instance, not
   three). Keeps both containers themselves untouched/compact. Needs an
   explicit answer for "does it cover the Complete Sale button" — the
   button isn't pinned to the viewport bottom today, so this likely
   means scrolling the focused field/button into view above the
   keyboard when it opens, the way a mobile web view does.
2. **A modal/overlay keyboard** — a `fixed inset-0` layer (matching this
   app's existing modal convention — `VariantModal`, `ConnectivityModal`,
   the pre-phase-16 `CheckoutModal` numpad usage), opened on focus,
   closed by a "Done" button (mirroring `PosCheckoutPanel`'s existing
   "Done" button for its own PIN/company edit mode). Guarantees zero
   permanent layout competition with the toast stack or the checkout
   panel, at the cost of covering more of the screen while open.
3. **Anchored near the field** (like a dropdown positioned off the
   input's own bounding box) — the option I'd weight lowest: both
   containers are so narrow that an anchored keyboard would need to
   overflow far outside its anchor's own width to be usable anyway,
   which mostly collapses into option 1 or 2 in practice while adding
   position-tracking complexity (scroll/resize handling) neither of the
   other two needs.

The toast-stack visual check you just did on a real screen (phase-84) is
the baseline none of these should disrupt — whichever option Apply picks,
it needs to coexist with that top-center column, not compete with it for
the same vertical space.

## 5. Smallest viable approach

**Recommendation: build a small, self-contained React QWERTY component,
following `VirtualNumpad`'s own pattern exactly — not a new dependency,
and importantly, not the native `tabtip.exe`-automation approach phase-16
already rejected.**

That distinction matters: what phase-16 cut was OS-level automation (an
IPC handler shelling out to a Windows process, "a new OS-automation
surface with no existing test coverage pattern"). It did **not** reject
a self-contained on-screen component — that's precisely what
`VirtualNumpad` is, and it shipped in the same phase. A new alphanumeric
keyboard in the same style (fully controlled, `value`/`onChange`, no
Electron/IPC involvement at all) was never rejected and carries none of
the risk that specific cut was about.

**A new dependency is not needed and I'd avoid one.** The only thing a
library like `react-simple-keyboard` would buy here is a QWERTY layout
generator and multi-locale support — this app needs exactly one layout
(A-Z, 0-9, backspace, done) with no locale switching, which is a small,
fully-testable hand-built grid, consistent with how `VirtualNumpad`
already solved the equivalent numeric problem in-house rather than
pulling in a library. Pulling one in would mean vetting an external
component's touch-event handling, bundle size, and styling override
surface for a feature this narrow — a worse KISS trade than ~150 lines
matching a pattern already proven in this codebase.

**What it does not need to be** (per the brief, confirmed against the
actual requirement in §3): not a full OS keyboard, no punctuation beyond
what free-text company names need, no symbols. Concretely: 26 letters
A-Z, 10 digits, backspace, and a way to close/confirm (a "Done" button,
matching the surrounding UI's own convention) is the entire key set. The
existing validators are the backstop exactly as today — `Save` on the
`FiscalNotice` correction stays disabled until `isValidKraPinFormat`
passes; the keyboard only ever calls the same `onChange` the plain
`<input>` already calls, so it composes with whatever validation each
field already does without needing to know about KRA-specific rules
itself (mirroring `VirtualNumpad`'s "fully controlled, caller owns
validation" design exactly).

**Important correction to how Apply should plan its tests**: earlier
phases in this project (the toast/fiscal-notice work) established "no
component-rendering tests, only pure `lib/*.ts` functions and store
actions get tested" — but `VirtualNumpad` is a documented **exception**
to that, not covered by it: `tests/VirtualNumpad.test.ts` mounts the
real component with `react-dom/client` and drives it with actual
`button.click()` calls (matching `useBarcodeScanner.test.ts`'s "inject
the real thing, mock only I/O" style). A new keyboard component is the
same *kind* of thing VirtualNumpad is — self-contained, stateless
besides what the caller controls, no IPC — so it should very likely get
the same direct-mount treatment in Apply, not be forced into a
pure-function abstraction that doesn't fit an inherently interactive
grid of buttons.

## Deliverable summary

- **Verdict: build.** Nothing exists to reuse for letters; no library is
  installed; the evidence for needing it is strong but not airtight (see
  §2) — flagging that gap for your call rather than assuming.
- **In scope**: `PosCheckoutPanel.tsx`'s company-name and customer-PIN
  fields; `FiscalNotice.tsx`'s PIN-correction field. Three call sites,
  one shared component.
- **Placement**: three options above (bottom-docked, modal/overlay,
  anchored-near-field) — not decided, needs your call given the specific
  screen-space risk in both containers.
- **Approach**: hand-built React component matching `VirtualNumpad`'s
  existing pattern and its `VirtualNumpad.test.ts` testing precedent, no
  new dependency, no OS-keyboard automation (that was already
  and separately rejected in phase-16, for different reasons than
  apply here).

Holding here for your call on the hardware question, the placement
option, and the overall approach before building anything.
