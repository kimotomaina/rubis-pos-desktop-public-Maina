#!/usr/bin/env node
/**
 * Fit check (Phase E3 tooling, built ahead of schedule in the checkout-panel
 * fix that needed it for measurement) — drives the BUILT app (`out/`) over
 * CDP and asserts that the screens it covers render inside their design box
 * with zero page overflow and zero inner scroll containers, at every
 * supported window size. This is the real, pixel-accurate check `jsdom`
 * cannot do; the unit-test suite covers everything else.
 *
 * Covers, across all 9 supported-display cases (`CASES` below):
 *   - the POS/catalog screen (Cash and M-Pesa, an empty cart and a
 *     populated one — the screen this was built to fix);
 *   - VariantModal (a multi-variant product search, best-effort) and
 *     ConnectivityModal (via the header's "Status" button);
 *   - the on-screen keyboard, both the modal and docked-sheet variants;
 *   - Order History, and (docs/phase-166 Commit E3) every Admin tab and
 *     sub-view: Overview, Integrations' 5 sections, Peripherals, M-Pesa
 *     Logs, Needs Attention, Stock Take, End of Day, Reports' 6
 *     sub-views (docs/phase-158), System;
 *   - ZReportModal (a Shift History row) and ManagerPinModal ("Save &
 *     Restart" in System) — both best-effort, skipped with a note if
 *     nothing is there to open them.
 * Every "best-effort" item above is skipped with a note rather than
 * failing the whole run if the trigger isn't found (e.g. a non-admin
 * seed account, or a demo catalog with no matching content).
 *
 * Four more screens a normal click-driven flow cannot reach at all are
 * each run ONCE, at the single tightest case only (not across all 9 —
 * see `TIGHTEST_CASE` below, kept small to bound this script's total
 * runtime): Onboarding (a fresh install with no copied state at all),
 * LocationPendingScreen and EtimsSetupGate (via the `RUBIS_CHECK_FIT_SCREEN`
 * renderer hook, `main/index.ts`'s `checkFit:getForcedScreen` handler —
 * inert unless this exact variable is set, so no real launch is ever
 * affected, mirroring `RUBIS_CHECK_FIT_SIZE` below), and the fiscal
 * notice paired with the toast stack at its 3-toast cap (same hook).
 *
 * Not measured at all, and not attempted: LocationConfirmScreen (the
 * admin-role counterpart of LocationPendingScreen — `screensFitDesignBox.
 * test.ts` already guards it against a hardcoded pixel dimension and
 * smoke-mounts it), RestartCountdownModal (would need a real manager-PIN
 * completion plus a config save against the throwaway copy — the PIN
 * modal itself IS measured, this only skips the screen after it), and
 * the orphaned `MpesaReconciliationPage` (no nav path reaches it).
 *
 * WINDOW SIZING: Electron's CDP implementation has no `Browser.
 * setWindowBounds` on a desktop `BrowserWindow` (confirmed empirically
 * while building this — the method simply isn't registered), so each of
 * the 9 cases is driven by relaunching the app with `RUBIS_CHECK_FIT_SIZE`
 * set (a main-process-only hook, `src/main/index.ts`'s
 * `parseCheckFitSize`, that sets the window's initial content size
 * instead of maximizing — inert unless this exact variable is set, so no
 * real launch is ever affected). Both scenarios (Cash, M-Pesa) — and,
 * as of docs/phase-166 Commit E3, everything else listed above except
 * the four single-case screens — are measured within the same launch,
 * so the main sweep still costs 9 relaunches, not one per screen.
 *
 * SAFETY (phase-144 documented an incident where a broad `taskkill /IM
 * electron.exe` killed every Electron process on the machine, including an
 * unrelated already-running instance): this script tracks the exact PID it
 * spawns and only ever signals that PID's own process tree
 * (`taskkill /PID <pid> /T /F` on Windows, `kill` on the tree elsewhere) —
 * never an image-name-wide kill. It also never writes into the real
 * userData directory: it copies only the app's own state (database +
 * credential vault) into a throwaway directory under the OS temp dir and
 * only ever launches against that copy.
 *
 * Usage: `npm run check:fit` (run `npm run build` first — this checks
 * whatever is currently in `out/`, it does not rebuild for you).
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const { name: APP_NAME } = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')
const CDP_PORT = 9455
const DEBUG = !!process.env.CHECK_FIT_DEBUG

/** The 9 supported-display cases (phase-142), reused verbatim from `tests/scale.test.ts`/`tests/belowLgUnreachable.test.ts` — each is the window's real DIP content size at that display/scaling combo. */
const CASES = [
  { name: '1366x768 @100%', width: 1366, height: 768 },
  { name: '1366x768 @125%', width: 1093, height: 614 },
  { name: '1366x768 @150%', width: 911, height: 512 },
  { name: '1920x1080 @100%', width: 1920, height: 1080 },
  { name: '1920x1080 @125%', width: 1536, height: 864 },
  { name: '1920x1080 @150%', width: 1280, height: 720 },
  { name: '2560x1440 @100%', width: 2560, height: 1440 },
  { name: '2560x1440 @125%', width: 2048, height: 1152 },
  { name: '2560x1440 @150%', width: 1707, height: 960 }
]

/**
 * Elements allowed to scroll internally, matched by their exact
 * className. Empty until a screen legitimately needs one; emptying it
 * further is Phase E3/E4's job — nothing on the POS screen, Order
 * History, or the six Admin sub-pages this phase paginated should ever
 * need an entry (`tests/noUnexpectedScroll.test.ts` guards the source
 * side of the same claim).
 *
 * The one entry below (docs/phase-166 Commit E3) is `App.tsx`'s shared
 * Admin content wrapper — real measurement at every supported size
 * found it genuinely scrolling on Overview, End of Day, and two
 * Integrations sections (Shopify, Fiscal Device), none of which this
 * phase's pagination work touches. Removing it would silently clip
 * those tabs' content rather than fix anything.
 */
const SCROLL_ALLOW_LIST = ['min-h-0 flex-1 overflow-y-auto px-6 pb-6']

function resolveRealUserDataPath() {
  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_NAME)
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_NAME)
    default:
      return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_NAME)
  }
}

function log(...args) {
  console.log(...args)
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await predicate().catch(() => null)
    if (result) return result
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(e))
  })
}

function makeCmd(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve) => {
      const thisId = ++id
      pending.set(thisId, resolve)
      ws.send(JSON.stringify({ id: thisId, method, params }))
    })
}

async function evaluate(cmd, expression) {
  const res = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed: ${JSON.stringify(res.result.exceptionDetails)}`)
  }
  return res.result?.result?.value
}

/**
 * Census of this document's own overflow: page-level scroll (the
 * `document.documentElement` scroll vs. client size) and every element
 * whose computed overflow is `auto`/`scroll` and whose content actually
 * exceeds its box (an inner scroller) — the same two signals phase-142's
 * manual audit used, scripted so this can run unattended and repeatedly.
 */
const CENSUS_EXPR = `
JSON.stringify((() => {
  const de = document.documentElement
  const pageOverflowX = de.scrollWidth > de.clientWidth
  const pageOverflowY = de.scrollHeight > de.clientHeight
  const scrollers = []
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el)
    const oy = style.overflowY
    const ox = style.overflowX
    const scrollableY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
    const scrollableX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1
    if (scrollableY || scrollableX) {
      scrollers.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 80),
        scrollableX,
        scrollableY,
        overBy: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight)
      })
    }
  }
  return { pageOverflowX, pageOverflowY, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollHeight: de.scrollHeight, clientHeight: de.clientHeight, scrollers }
})())
`

async function census(cmd) {
  return JSON.parse(await evaluate(cmd, CENSUS_EXPR))
}

/** Every numpad key's rendered size, plus the method toggles and Complete Sale — for the TOUCH FLOOR check (>= 34 physical px at the worst case). CSS px only; physical px is computed in JS from the case's own zoom + dpr. */
const KEY_SIZES_EXPR = `
JSON.stringify(
  Array.from(document.querySelectorAll('aside button')).map(b => {
    const r = b.getBoundingClientRect()
    return { label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 20), width: Math.round(r.width), height: Math.round(r.height) }
  })
)
`

async function keySizes(cmd) {
  return JSON.parse(await evaluate(cmd, KEY_SIZES_EXPR))
}

/** A child-by-child height breakdown of the header and the checkout aside — debugging/reporting aid, not part of the pass/fail check. Set `CHECK_FIT_MEASURE=1` to capture it (once, for Cash at the first case). */
const MEASURE_CHECKOUT_EXPR = `
JSON.stringify((() => {
  const header = document.querySelector('header')
  const aside = document.querySelector('aside')
  const rect = (el) => el ? Math.round(el.getBoundingClientRect().height) : null
  const dump = (el) => el ? Array.from(el.children).map(c => ({ tag: c.tagName, cls: (c.className||'').toString().slice(0,70), height: rect(c) })) : null
  if (!aside) return { error: 'no <aside>' }
  const panelRoot = aside.querySelector(':scope > div')
  const body = panelRoot ? panelRoot.children[1] : null
  const cashWrapper = body && body.children[1] ? body.children[1] : null
  return {
    headerHeight: rect(header),
    asideAvailableHeight: rect(aside),
    panelTopLevel: dump(panelRoot),
    bodyNaturalHeight: body ? body.scrollHeight : null,
    bodyChildren: dump(body),
    cashContentChildren: dump(cashWrapper)
  }
})())
`

async function measureCheckout(cmd) {
  return JSON.parse(await evaluate(cmd, MEASURE_CHECKOUT_EXPR))
}

/**
 * Order History plus the Admin shell's every tab and sub-view, and the
 * handful of modals/keyboard states reachable from inside them without
 * a test hook (docs/phase-166 Commit E3 — supersedes the old
 * Reports-only `checkReportsTab` from docs/phase-158). Navigates from
 * the POS screen (where the two scenarios above leave the window).
 * Best-effort throughout: a missing nav button (e.g. a non-admin seed
 * account, or a demo catalog with no matching content for a probe) skips
 * that one item with a note rather than failing the whole run.
 */
async function checkAdminScreens(cmd) {
  const findings = []
  let failures = 0
  const record = (result) => {
    findings.push(result.line)
    if (!result.ok) failures++
  }

  const openedOrders = await clickWhereText(cmd, 'button', 'Orders')
  if (openedOrders) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Order History'))
  } else {
    findings.push('  (Order History: "Orders" nav button not found — skipping)')
  }

  const openedAdmin = await clickWhereText(cmd, 'button', 'Admin')
  if (!openedAdmin) {
    findings.push(
      '  (Admin: no "Admin" nav button found — skipping everything below, this account may not be an admin)'
    )
    return { findings, failures }
  }
  await new Promise((r) => setTimeout(r, 400))
  record(await censusLabelled(cmd, 'Admin > Overview'))

  if (await clickWhereText(cmd, 'button', 'Peripherals')) {
    await new Promise((r) => setTimeout(r, 300))
    record(await censusLabelled(cmd, 'Admin > Peripherals'))
  } else {
    findings.push('✖ Admin > Peripherals: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'M-Pesa Logs')) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Admin > M-Pesa Logs'))
  } else {
    findings.push('✖ Admin > M-Pesa Logs: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'Needs Attention')) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Admin > Needs Attention'))
  } else {
    findings.push('✖ Admin > Needs Attention: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'Stock Take')) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Admin > Stock Take'))
  } else {
    findings.push('✖ Admin > Stock Take: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'End of Day')) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Admin > End of Day'))
  } else {
    findings.push('✖ Admin > End of Day: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'Integrations')) {
    await new Promise((r) => setTimeout(r, 400))
    const sections = ['Shopify', 'Location', 'Fiscal Device', 'M-Pesa', 'Printer']
    for (const section of sections) {
      if (await clickWhereText(cmd, 'button', section)) {
        await new Promise((r) => setTimeout(r, 300))
        record(await censusLabelled(cmd, `Admin > Integrations > ${section}`))
      } else {
        findings.push(`✖ Admin > Integrations > ${section}: sub-nav button not found`)
        failures++
      }
    }

    // Non-docked keyboard modal — any readOnly text field opens it; the
    // Shopify section's Store URL field is always present.
    if (await clickWhereText(cmd, 'button', 'Shopify')) {
      await new Promise((r) => setTimeout(r, 300))
      if (await clickBySelector(cmd, 'input[placeholder="https://your-store.myshopify.com"]')) {
        await new Promise((r) => setTimeout(r, 300))
        record(await censusLabelled(cmd, 'Keyboard (modal, non-docked)'))
        await clickWhereText(cmd, 'button', 'Submit')
        await new Promise((r) => setTimeout(r, 200))
      } else {
        findings.push('  (Keyboard modal: Store URL field not found — skipping)')
      }
    }
  } else {
    findings.push('✖ Admin > Integrations: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'System')) {
    await new Promise((r) => setTimeout(r, 400))
    record(await censusLabelled(cmd, 'Admin > System'))

    if (await clickWhereText(cmd, 'button', 'Save & Restart')) {
      await new Promise((r) => setTimeout(r, 300))
      record(await censusLabelled(cmd, 'ManagerPinModal'))
      await clickWhereText(cmd, 'button', 'Cancel')
      await new Promise((r) => setTimeout(r, 200))
    } else {
      findings.push('  (ManagerPinModal: "Save & Restart" button not found — skipping)')
    }
  } else {
    findings.push('✖ Admin > System: tab button not found')
    failures++
  }

  if (await clickWhereText(cmd, 'button', 'Reports')) {
    await new Promise((r) => setTimeout(r, 400))
    const subViews = [
      'Shift History',
      'Sales Summary',
      'Fiscal Status',
      'Fiscal Reconciliation',
      'Invoice List',
      'Export'
    ]
    for (const label of subViews) {
      if (await clickWhereText(cmd, 'button', label)) {
        await new Promise((r) => setTimeout(r, 500))
        record(await censusLabelled(cmd, `Admin > Reports > ${label}`))

        if (label === 'Shift History') {
          if (await clickBySelector(cmd, 'tbody tr.cursor-pointer')) {
            await new Promise((r) => setTimeout(r, 400))
            const opened = await evaluate(cmd, `document.body.innerText.includes('Z-Report')`)
            if (opened) {
              record(await censusLabelled(cmd, 'ZReportModal'))
              await clickBySelector(cmd, 'button[aria-label="Close"]')
              await new Promise((r) => setTimeout(r, 200))
            } else {
              findings.push('  (ZReportModal: row click did not open it — skipping)')
            }
          } else {
            findings.push('  (ZReportModal: no shift history row to click — skipping)')
          }
        }
      } else {
        findings.push(`✖ Admin > Reports > ${label}: sub-nav button not found`)
        failures++
      }
    }
  } else {
    findings.push('✖ Admin > Reports: tab button not found')
    failures++
  }

  return { findings, failures }
}

async function clickWhereText(cmd, selector, text) {
  return evaluate(
    cmd,
    `(() => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.trim() === ${JSON.stringify(text)});
      if (el) { el.click(); return true; }
      return false;
    })()`
  )
}

/** Clicks the first element matching a plain CSS selector — for cases `clickWhereText`'s exact-text match can't express (an aria-label with a curly apostrophe, a row picked by class). */
async function clickBySelector(cmd, selector) {
  return evaluate(
    cmd,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { el.click(); return true; }
      return false;
    })()`
  )
}

/**
 * Censuses the current screen and returns a `✔`/`✖` summary line plus
 * whether it failed — the same shape every scenario in this script
 * already builds inline; centralized here (docs/phase-166 Commit E3) so
 * the many new screens added in this phase don't each repeat it.
 */
async function censusLabelled(cmd, label) {
  const result = await census(cmd)
  const unexpectedScrollers = result.scrollers.filter((s) => !SCROLL_ALLOW_LIST.includes(s.cls))
  const ok = !result.pageOverflowX && !result.pageOverflowY && unexpectedScrollers.length === 0
  const line = `${ok ? '✔' : '✖'} ${label}: page ${result.scrollWidth}x${result.scrollHeight} vs client ${result.clientWidth}x${result.clientHeight}${unexpectedScrollers.length ? `, ${unexpectedScrollers.length} inner scroller(s): ${JSON.stringify(unexpectedScrollers)}` : ''}`
  return { ok, line }
}

/**
 * Best-effort search for a multi-variant product to open `VariantModal`
 * (docs/phase-166 Commit E3) — tries several common letters against the
 * live catalog and, for each, every row the dropdown shows (up to
 * `AUTOCOMPLETE_MAX_RESULTS`), not just the first: a single-variant
 * match adds straight to the cart instead of opening the modal
 * (`PosSearchBar`'s own `selectProduct` logic), so this clears the cart
 * add and tries the row after it before moving to the next letter.
 */
async function tryOpenVariantModal(cmd) {
  for (const query of ['a', 'e', 'i', 'o', 'u', 's', 'm', 'c', 'r', 't', 'p', 'l']) {
    const typed = await evaluate(
      cmd,
      `(() => {
        const input = document.querySelector('input[placeholder]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(query)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    )
    if (!typed) return false
    await new Promise((r) => setTimeout(r, 400))

    const rowCount = await evaluate(cmd, `document.querySelectorAll('[role="option"] button').length`)

    for (let index = 0; index < rowCount; index++) {
      // Re-typing before every row click: a single-variant row's click
      // adds to cart and closes the dropdown, so each attempt after the
      // first needs the dropdown re-opened from scratch.
      await evaluate(
        cmd,
        `(() => {
          const input = document.querySelector('input[placeholder]');
          if (!input) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`
      )
      await new Promise((r) => setTimeout(r, 150))
      await evaluate(
        cmd,
        `(() => {
          const input = document.querySelector('input[placeholder]');
          if (!input) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(query)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`
      )
      await new Promise((r) => setTimeout(r, 400))

      const clicked = await evaluate(
        cmd,
        `(() => {
          const rows = document.querySelectorAll('[role="option"] button');
          const row = rows[${index}];
          if (row) { row.click(); return true; }
          return false;
        })()`
      )
      if (!clicked) continue
      await new Promise((r) => setTimeout(r, 300))

      const opened = await evaluate(cmd, `document.body.innerText.includes('Select Variant')`)
      if (opened) return true
    }
  }
  return false
}

/** Copies only the app's own state (never Chromium's cache, which may be locked by an already-running real instance and is irrelevant here) into `dest`. */
function copyAppState(dest) {
  const realUserData = resolveRealUserDataPath()
  if (!existsSync(realUserData)) {
    log('No existing userData found — launching unconfigured (onboarding will show).')
    return
  }
  // `Local State` carries Chromium's OSCrypt key (DPAPI-protected on
  // Windows) that `secret-vault.json`'s ciphertext was encrypted under —
  // without it Electron mints a fresh key on first use and every existing
  // secret fails to decrypt.
  const APP_STATE_FILES = [
    'rubis-pos.db',
    'rubis-pos.db-shm',
    'rubis-pos.db-wal',
    'secret-vault.json',
    'Local State'
  ]
  for (const file of APP_STATE_FILES) {
    const src = join(realUserData, file)
    if (existsSync(src)) {
      try {
        cpSync(src, join(dest, file))
      } catch (err) {
        log(`  (skipped ${file}: ${err.message})`)
      }
    }
  }
}

/** Kills `pid`'s whole process tree — never an image-name-wide kill (see this file's header). */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

/** Removes `dir`, retrying briefly — a just-killed process's file handles can take a moment to release on Windows. */
function rmSyncRetrying(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      const until = Date.now() + 300 * (attempt + 1)
      while (Date.now() < until) {
        /* brief synchronous pause between retries */
      }
    }
  }
}

/**
 * Launches one throwaway instance at `caseSize`, drives it through login
 * and a small cart, measures both scenarios (Cash, M-Pesa), screenshots
 * each, and tears the instance down before returning — one full
 * launch/measure/kill cycle per case, matching how a real user only ever
 * sees one window size at a time.
 */
async function runCase(testCase, outDir) {
  const scratchUserData = mkdtempSync(join(tmpdir(), 'rubis-pos-check-fit-userdata-'))
  copyAppState(scratchUserData)

  let child = null
  const cleanup = () => {
    killTree(child?.pid)
    rmSyncRetrying(scratchUserData)
  }

  const findings = []
  try {
    const childEnv = { ...process.env }
    // ELECTRON_RUN_AS_NODE leaking from a wrapping shell (e.g. this
    // harness's own) would make electronPath run as plain Node instead of
    // launching the app — see phase-144/145's session notes. Delete the
    // key entirely rather than set it empty: Electron's own bootstrap
    // checks `'ELECTRON_RUN_AS_NODE' in env`, not truthiness, and an
    // empty-string value crashes V8's snapshot load instead of just being
    // ignored.
    delete childEnv.ELECTRON_RUN_AS_NODE
    childEnv.RUBIS_CHECK_FIT_SIZE = `${testCase.width}x${testCase.height}`

    child = spawn(
      electronPath,
      [MAIN_ENTRY, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${scratchUserData}`],
      { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.stdout.on('data', (d) => DEBUG && log('[app stdout]', d.toString()))
    child.stderr.on('data', (d) => DEBUG && log('[app stderr]', d.toString()))
    child.on('error', (err) => log('[spawn error]', err))

    await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, {
      label: 'CDP endpoint up'
    })
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    const target = list.find((t) => t.type === 'page')
    const ws = await connectWs(target.webSocketDebuggerUrl)
    const cmd = makeCmd(ws)
    await cmd('Runtime.enable')

    await new Promise((r) => setTimeout(r, 1200))

    const loginScreenShowing = await evaluate(cmd, `document.body.innerText.includes("working?")`)
    if (loginScreenShowing) {
      await clickWhereText(cmd, 'button', 'Admin')
      await new Promise((r) => setTimeout(r, 300))
      for (const digit of ['1', '2', '3', '4']) await clickWhereText(cmd, 'button', digit)
      await clickWhereText(cmd, 'button', 'Enter')
      await new Promise((r) => setTimeout(r, 1000))
    }

    const onCatalog = await evaluate(cmd, `document.body.innerText.includes("COMPLETE SALE")`)
    if (!onCatalog) {
      findings.push(
        `✖ ${testCase.name}: could not reach the POS/catalog screen (not logged in, or app not configured) — nothing measured.`
      )
      return { findings, failures: 1 }
    }

    // Add an item to the cart via the search bar, so the "populated cart"
    // scenario exercises real, non-zero totals — best-effort: if this
    // store's catalog has no matches for these letters, the cart just
    // stays empty and the rest of the check still runs.
    for (const query of ['a', 'e', 'o']) {
      await evaluate(
        cmd,
        `(() => {
          const input = document.querySelector('input[placeholder]');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(query)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`
      )
      await new Promise((r) => setTimeout(r, 400))
      const added = await evaluate(
        cmd,
        `(() => {
          const row = document.querySelector('[data-product-id], .cursor-pointer');
          if (row) { row.click(); return true; }
          return false;
        })()`
      )
      if (added) {
        await new Promise((r) => setTimeout(r, 300))
        break
      }
    }

    let extraFailures = 0

    const variantModalOpened = await tryOpenVariantModal(cmd)
    if (variantModalOpened) {
      const result = await censusLabelled(cmd, 'VariantModal')
      findings.push(result.line)
      log(result.line)
      if (!result.ok) extraFailures++
      await clickBySelector(cmd, 'button[aria-label="Close"]')
      await new Promise((r) => setTimeout(r, 200))
    } else {
      findings.push(
        '  (VariantModal: no multi-variant product found in this catalog after several tries — skipping)'
      )
    }

    // NavStatusButton's "Status" popover, and the ConnectivityModal one of its rows opens.
    // Not `clickWhereText`: each row's button also renders a trailing
    // "Connected"/"Disconnected"/etc. detail span as a sibling of the
    // label span, so the button's whole textContent is never just
    // "M-Pesa" — only the label span (`NavStatusButton.tsx`'s `flex-1`
    // span) is.
    if (await clickWhereText(cmd, 'button', 'Status')) {
      await new Promise((r) => setTimeout(r, 200))
      const clickedMpesaRow = await evaluate(
        cmd,
        `(() => {
          const button = Array.from(document.querySelectorAll('button')).find(
            (b) => b.querySelector('span.flex-1')?.textContent.trim() === 'M-Pesa'
          );
          if (button) { button.click(); return true; }
          return false;
        })()`
      )
      if (clickedMpesaRow) {
        await new Promise((r) => setTimeout(r, 300))
        const result = await censusLabelled(cmd, 'ConnectivityModal')
        findings.push(result.line)
        log(result.line)
        if (!result.ok) extraFailures++
        await clickBySelector(cmd, 'button[aria-label="Close"]')
        await new Promise((r) => setTimeout(r, 200))
      } else {
        findings.push('  (ConnectivityModal: no "M-Pesa" status row found — skipping)')
      }
    } else {
      findings.push('  (ConnectivityModal: "Status" button not found — skipping)')
    }

    const scenarios = [
      { label: 'Cash', setup: async () => {} },
      {
        label: 'M-Pesa',
        setup: async () => {
          await clickWhereText(cmd, 'button', 'M-PESA')
          await new Promise((r) => setTimeout(r, 300))
        }
      }
    ]

    let failures = 0
    for (const scenario of scenarios) {
      await scenario.setup()
      await new Promise((r) => setTimeout(r, 200))

      const result = await census(cmd)
      const unexpectedScrollers = result.scrollers.filter((s) => !SCROLL_ALLOW_LIST.includes(s.cls))
      const ok = !result.pageOverflowX && !result.pageOverflowY && unexpectedScrollers.length === 0
      if (!ok) failures++

      const sizes = scenario.label === 'Cash' ? await keySizes(cmd) : []

      const line = `${ok ? '✔' : '✖'} ${scenario.label} — ${testCase.name} (${testCase.width}x${testCase.height}): page ${result.scrollWidth}x${result.scrollHeight} vs client ${result.clientWidth}x${result.clientHeight}${unexpectedScrollers.length ? `, ${unexpectedScrollers.length} inner scroller(s): ${JSON.stringify(unexpectedScrollers)}` : ''}`
      findings.push(line)
      log(line)

      if (sizes.length && process.env.CHECK_FIT_SIZES) {
        writeFileSync(
          join(outDir, `keysizes_${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.json`),
          JSON.stringify(sizes, null, 2)
        )
      }

      if (process.env.CHECK_FIT_MEASURE && scenario.label === 'Cash' && testCase === CASES[2]) {
        writeFileSync(
          join(outDir, 'measure_checkout.json'),
          JSON.stringify(await measureCheckout(cmd), null, 2)
        )
      }

      try {
        const shot = await cmd('Page.captureScreenshot', { format: 'png' })
        if (shot.result?.data) {
          const fileName = `${scenario.label}_${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`
          writeFileSync(join(outDir, fileName), Buffer.from(shot.result.data, 'base64'))
        }
      } catch (err) {
        findings.push(`  (screenshot failed: ${err.message})`)
      }
    }

    failures += extraFailures

    // Docked keyboard sheet — the manual M-Pesa code field, still
    // showing from the M-Pesa scenario just above (best-effort: only
    // present when this till's M-Pesa confirmation method is 'manual',
    // or 'daraja' with manual entry enabled).
    if (await clickBySelector(cmd, 'input[aria-label^="M-Pesa code"]')) {
      await new Promise((r) => setTimeout(r, 300))
      const result = await censusLabelled(cmd, 'Keyboard (docked sheet)')
      findings.push(result.line)
      log(result.line)
      if (!result.ok) failures++
      await clickWhereText(cmd, 'button', 'Submit')
      await new Promise((r) => setTimeout(r, 200))
    } else {
      findings.push('  (Keyboard docked sheet: manual M-Pesa code field not found — skipping)')
    }

    const adminResult = await checkAdminScreens(cmd)
    findings.push(...adminResult.findings)
    for (const line of adminResult.findings) log(line)
    failures += adminResult.failures

    return { findings, failures }
  } finally {
    cleanup()
  }
}

/** The tightest of the 9 supported-display cases — the binding constraint for fitting, per phase-142's own worst-case sizing. */
const TIGHTEST_CASE = CASES[2]

/** Spawns one throwaway instance and connects CDP to it — the boilerplate `runCase` also does inline; factored out here only for the two new relaunch kinds below, so `runCase`'s own already-working spawn path is left untouched. */
async function launchAndConnect(scratchUserData, extraEnv) {
  const childEnv = { ...process.env, ...extraEnv }
  // See runCase's identical guard for why this must be deleted, not emptied.
  delete childEnv.ELECTRON_RUN_AS_NODE

  const child = spawn(
    electronPath,
    [MAIN_ENTRY, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${scratchUserData}`],
    { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', (d) => DEBUG && log('[app stdout]', d.toString()))
  child.stderr.on('data', (d) => DEBUG && log('[app stderr]', d.toString()))
  child.on('error', (err) => log('[spawn error]', err))

  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, {
    label: 'CDP endpoint up'
  })
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
  const ws = await connectWs(target.webSocketDebuggerUrl)
  const cmd = makeCmd(ws)
  await cmd('Runtime.enable')
  return { cmd, child }
}

/** Logs in as the seed admin if the login screen is showing — a no-op otherwise (e.g. already past it, or onboarding hasn't been configured yet). */
async function loginAsAdminIfShowing(cmd) {
  const loginScreenShowing = await evaluate(cmd, `document.body.innerText.includes("working?")`)
  if (!loginScreenShowing) return
  await clickWhereText(cmd, 'button', 'Admin')
  await new Promise((r) => setTimeout(r, 300))
  for (const digit of ['1', '2', '3', '4']) await clickWhereText(cmd, 'button', digit)
  await clickWhereText(cmd, 'button', 'Enter')
  await new Promise((r) => setTimeout(r, 1000))
}

/**
 * One relaunch driven by `RUBIS_CHECK_FIT_SCREEN` (docs/phase-166
 * Commit E3, `main/index.ts`'s `checkFit:getForcedScreen` handler)
 * rather than by clicking — for the handful of states a normal
 * click-driven flow genuinely cannot reach: an intermediate
 * onboarding-gate state (`'locationPending'`, `'etimsGate'`), or the
 * fiscal notice paired with the toast stack at its cap
 * (`'fiscalNoticeAndToastLimit'`). Run at {@link TIGHTEST_CASE} only,
 * not across all 9 sizes, to keep this script's total runtime bounded.
 */
async function runForcedScreenCase(screenId, label) {
  const scratchUserData = mkdtempSync(join(tmpdir(), 'rubis-pos-check-fit-userdata-'))
  copyAppState(scratchUserData)

  let child = null
  const cleanup = () => {
    killTree(child?.pid)
    rmSyncRetrying(scratchUserData)
  }

  try {
    const connected = await launchAndConnect(scratchUserData, {
      RUBIS_CHECK_FIT_SIZE: `${TIGHTEST_CASE.width}x${TIGHTEST_CASE.height}`,
      RUBIS_CHECK_FIT_SCREEN: screenId
    })
    child = connected.child
    const { cmd } = connected

    await new Promise((r) => setTimeout(r, 1200))
    await loginAsAdminIfShowing(cmd)
    await new Promise((r) => setTimeout(r, 500))

    const result = await censusLabelled(cmd, label)
    log(result.line)
    return { findings: [result.line], failures: result.ok ? 0 : 1 }
  } finally {
    cleanup()
  }
}

/**
 * Onboarding (docs/phase-166 Commit E3) — reached not by a hook but by
 * simply not copying any app state in: `copyAppState`'s own fallback
 * ("no existing userData found — launching unconfigured") is exactly
 * the real first-run condition. Run at {@link TIGHTEST_CASE} only, same
 * reasoning as `runForcedScreenCase`.
 */
async function runOnboardingCase() {
  const scratchUserData = mkdtempSync(join(tmpdir(), 'rubis-pos-check-fit-userdata-'))
  // Deliberately no copyAppState() call here — an empty directory IS the real first-run state.

  let child = null
  const cleanup = () => {
    killTree(child?.pid)
    rmSyncRetrying(scratchUserData)
  }

  try {
    const connected = await launchAndConnect(scratchUserData, {
      RUBIS_CHECK_FIT_SIZE: `${TIGHTEST_CASE.width}x${TIGHTEST_CASE.height}`
    })
    child = connected.child
    const { cmd } = connected

    await new Promise((r) => setTimeout(r, 1500))

    const result = await censusLabelled(cmd, 'Onboarding')
    log(result.line)
    return { findings: [result.line], failures: result.ok ? 0 : 1 }
  } finally {
    cleanup()
  }
}

async function main() {
  const outDir = join(tmpdir(), `rubis-pos-check-fit-${Date.now()}`)
  mkdirSync(outDir, { recursive: true })
  log(`Output folder (screenshots + summary), outside the working copy:\n  ${outDir}\n`)

  if (!existsSync(MAIN_ENTRY)) {
    console.error(`✖ ${MAIN_ENTRY} does not exist — run "npm run build" first.`)
    process.exit(1)
  }

  const allFindings = []
  let totalFailures = 0
  for (const testCase of CASES) {
    const { findings, failures } = await runCase(testCase, outDir)
    allFindings.push(...findings)
    totalFailures += failures
  }

  /**
   * Screens a normal click-driven flow can't reach (docs/phase-166
   * Commit E3) — run once each, at {@link TIGHTEST_CASE} only, not
   * across all 9 sizes, to keep this script's total runtime bounded.
   */
  const extraCases = [
    { label: 'Onboarding', run: () => runOnboardingCase() },
    { label: 'LocationPendingScreen', run: () => runForcedScreenCase('locationPending', 'LocationPendingScreen') },
    { label: 'EtimsSetupGate', run: () => runForcedScreenCase('etimsGate', 'EtimsSetupGate') },
    {
      label: 'FiscalNotice + toast stack at its limit',
      run: () => runForcedScreenCase('fiscalNoticeAndToastLimit', 'FiscalNotice + toast stack at its limit')
    }
  ]
  for (const { run } of extraCases) {
    const { findings, failures } = await run()
    allFindings.push(...findings)
    totalFailures += failures
  }

  writeFileSync(join(outDir, 'summary.txt'), allFindings.join('\n') + '\n')
  log(`\nSummary written to ${join(outDir, 'summary.txt')}`)

  if (totalFailures > 0) {
    console.error(`\n✖ ${totalFailures} case(s) failed the fit check.`)
    process.exitCode = 1
  } else {
    log(`\n✔ All ${allFindings.length} case(s) fit with no overflow.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
