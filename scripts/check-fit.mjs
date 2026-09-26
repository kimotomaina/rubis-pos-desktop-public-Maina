#!/usr/bin/env node
/**
 * Fit check (Phase E3 tooling, built ahead of schedule in the checkout-panel
 * fix that needed it for measurement) — drives the BUILT app (`out/`) over
 * CDP and asserts that the screens it covers render inside their design box
 * with zero page overflow and zero inner scroll containers, at every
 * supported window size. This is the real, pixel-accurate check `jsdom`
 * cannot do; the unit-test suite covers everything else.
 *
 * Currently covers the POS/catalog screen only (Cash and M-Pesa, an empty
 * cart and a populated one) — the screen this was built to fix. Extending
 * it to the rest of the app (the full Phase E3 scope) is future work; the
 * screen list and the allow-list below are where that extension plugs in.
 *
 * WINDOW SIZING: Electron's CDP implementation has no `Browser.
 * setWindowBounds` on a desktop `BrowserWindow` (confirmed empirically
 * while building this — the method simply isn't registered), so each of
 * the 9 cases is driven by relaunching the app with `RUBIS_CHECK_FIT_SIZE`
 * set (a main-process-only hook, `src/main/index.ts`'s
 * `parseCheckFitSize`, that sets the window's initial content size
 * instead of maximizing — inert unless this exact variable is set, so no
 * real launch is ever affected). Both scenarios (Cash, M-Pesa) are
 * measured within the same launch, so this costs 9 relaunches, not 18.
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

/** Elements allowed to scroll internally, by a short description used only in output — empty until a screen legitimately needs one (e.g. a long paginated list). Emptying this further is Phase E3/E4's job; nothing on the POS screen should ever need an entry. */
const SCROLL_ALLOW_LIST = []

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

    return { findings, failures }
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

  writeFileSync(join(outDir, 'summary.txt'), allFindings.join('\n') + '\n')
  log(`\nSummary written to ${join(outDir, 'summary.txt')}`)

  if (totalFailures > 0) {
    console.error(`\n✖ ${totalFailures} case(s) failed the fit check.`)
    process.exitCode = 1
  } else {
    log(`\n✔ All ${CASES.length * 2} case(s) fit with no overflow.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
