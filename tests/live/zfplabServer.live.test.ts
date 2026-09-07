/**
 * LIVE smoke test against a real, running ZFPLabServer.
 *
 * This is NOT part of the mocked unit suite (`npm test`) — it dials
 * real HTTP against `http://localhost:4444/` (or `LIVE_ZFP_BASE_URL`),
 * which only exists on a machine with the vendor's ZFPLabServer
 * actually installed and running. `vite.config.ts` excludes
 * `tests/live/**` outright; this file only runs via:
 *
 *   npm run test:live
 *
 * which points Vitest at `vitest.live.config.ts` instead — that config
 * sets `LIVE_ZFP=1` (via Vitest's `env` option, so no shell-specific
 * `set`/`export` syntax is needed) and is the actual opt-in. The
 * `describe.skipIf` below is a second, independent gate in case this
 * file is ever pointed at some other way — without it, running the
 * default config against this path would silently hang or error trying
 * to reach a server that isn't there.
 *
 * What this proves, and what it deliberately does NOT require:
 *
 *   - It proves the transport, the `settings()` GET string, the
 *     `<Command Name>` POST envelope, and the session are all accepted
 *     by the real server — everything Phase 56 rebuilt from a
 *     decompiled vendor SDK rather than confirmed live, until now.
 *   - It does NOT require the physical fiscal device to be reachable or
 *     authenticated. The device TCP-password handshake (Code 31) is a
 *     separate, external, currently-unresolved blocker (see
 *     `docs/KNOWN_GAPS.md`) — a Code 31 on `ReadStatus` here is a
 *     **pass** for this phase, because it proves the server accepted
 *     the request's format and forwarded it far enough to get a
 *     device-specific answer. Only a malformed-request response
 *     (Code 63) or a transport failure (server not running, wrong
 *     port) is a failure here — those would mean the wire format this
 *     codebase sends is actually wrong, which is the one thing this
 *     test exists to catch before it reaches production.
 *
 * Every real response this test receives is captured verbatim to
 * `tests/fixtures/wire/` so the mocked suite's fixtures keep getting
 * more real over time — see Item 3 in the phase report for exactly
 * which file each outcome writes to.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFiscalHttpClient,
  getSettings,
  postXml,
  DEFAULT_ETIMS_BASE_URL,
  ETIMS_REQUEST_TIMEOUT_MS
} from '../../src/main/services/integrations/http-client.js'

const WIRE_FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'wire')

/**
 * The device details this suite talks to.
 *
 * `LIVE_ZFP_DEVICE_IP`/`_PORT`/`_PASSWORD` are required rather than
 * defaulted: the codebase no longer carries device defaults at all (a
 * guessed password reads as a device fault on the wire — see
 * `docs/phase-89.md` §5), and pointing a live test at a hardcoded IP
 * would be worse here than anywhere, since these tests talk to real
 * hardware. Only the server URL keeps a default, because ZFPLabServer is
 * a fixed-port local service.
 */
const baseUrl = process.env.LIVE_ZFP_BASE_URL || DEFAULT_ETIMS_BASE_URL
const deviceIp = process.env.LIVE_ZFP_DEVICE_IP ?? ''
const devicePort = process.env.LIVE_ZFP_DEVICE_PORT ?? ''
const devicePassword = process.env.LIVE_ZFP_DEVICE_PASSWORD ?? ''

if (process.env.LIVE_ZFP === '1' && !(deviceIp && devicePort && devicePassword)) {
  throw new Error(
    'Live ZFP tests need LIVE_ZFP_DEVICE_IP, LIVE_ZFP_DEVICE_PORT and LIVE_ZFP_DEVICE_PASSWORD set — ' +
      'there are no device defaults to fall back on.'
  )
}

/**
 * Classifies a transport-level failure (`ServiceResult.success === false`)
 * into an unambiguous cause, so the reported message never says "is the
 * server running?" when a *prior* call in the same test already proved
 * it was.
 *
 * Deliberately uses the *real*, unmodified `ETIMS_REQUEST_TIMEOUT_MS`
 * (production's own 5s per-request timeout — `postXml`/`getSettings`
 * hardcode it on every call, so there is no supported way to give this
 * test more headroom without changing production behavior, which is
 * out of scope here). A timeout at that real value is itself a genuine,
 * useful finding: it means production's `ReadStatus` would time out
 * against this exact device today, which is different information from
 * "the server is down."
 */
function classifyTransportFailure(errorMessage: string): string {
  if (/unreachable/i.test(errorMessage)) {
    return `server not running (or unreachable) at ${baseUrl} — connection was refused/reset`
  }
  if (/timed out/i.test(errorMessage)) {
    return (
      `server accepted the request but did not respond within ${ETIMS_REQUEST_TIMEOUT_MS}ms ` +
      `(production's own per-request timeout) — the server itself is very likely running (see the ` +
      `settings() result above) and is blocked waiting on its own TCP connection to the physical ` +
      `device at ${deviceIp}:${devicePort}. This is a device-reachability symptom, not a wire-format ` +
      `bug — see docs/KNOWN_GAPS.md.`
    )
  }
  return `unrecognized transport failure — ${errorMessage}`
}

/** Prints a single, greppable PASS/FAIL line for a human running `npm run test:live` to scan. */
function reportLine(status: 'PASS' | 'FAIL', label: string, detail: string): void {
  console.log(`[LIVE-ZFP] ${status} — ${label}: ${detail}`)
}

/** Writes `body` verbatim to `tests/fixtures/wire/<fileName>`, creating the directory if needed. */
function captureFixture(fileName: string, body: string): void {
  if (!existsSync(WIRE_FIXTURES_DIR)) mkdirSync(WIRE_FIXTURES_DIR, { recursive: true })
  const path = join(WIRE_FIXTURES_DIR, fileName)
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  console.log(`[LIVE-ZFP] captured real response → tests/fixtures/wire/${fileName}`)
}

describe.skipIf(process.env.LIVE_ZFP !== '1')('LIVE ZFPLabServer smoke test', () => {
  it(`settings() is accepted by the real server at ${baseUrl}`, async () => {
    const client = createFiscalHttpClient({ baseUrl })

    const result = await getSettings(client, deviceIp, devicePort, devicePassword)

    if (!result.success) {
      const cause = classifyTransportFailure(result.error ?? '')
      reportLine('FAIL', 'settings()', cause)
      throw new Error(`settings() against ${baseUrl} failed — ${cause}`)
    }

    const code = result.data?.code
    if (code !== '0') {
      reportLine('FAIL', 'settings()', `expected Code 0, got Code ${code} — ${result.data?.Message ?? ''}`)
    } else {
      reportLine('PASS', 'settings()', `Code 0, clientID=${result.data?.clientID ?? '<none>'}`)
    }

    expect(result.data?.code, 'settings() must return Res Code 0 — the literal GET string was rejected').toBe(
      '0'
    )
    expect(
      result.data?.clientID,
      'a Code-0 settings() response should echo a clientID — the server accepted and registered this session'
    ).toBeTruthy()
  })

  it('ReadStatus is server-accepted: Code 0 (device authed) or Code 31 (device auth pending) both pass', async () => {
    const client = createFiscalHttpClient({ baseUrl })
    // Re-establish the session for this request in isolation, in case
    // vitest ran this test file's two `it`s against separate workers.
    await getSettings(client, deviceIp, devicePort, devicePassword)

    const result = await postXml(client, '', 'ReadStatus', {})

    if (!result.success) {
      const cause = classifyTransportFailure(result.error ?? '')
      reportLine('FAIL', 'ReadStatus', cause)
      throw new Error(`ReadStatus against ${baseUrl} failed — ${cause}`)
    }

    const data = result.data ?? {}
    const code = data.code

    if (code === '63') {
      captureFixture('readstatus-live-captured-code63.xml', formatCapturedRes(data))
      reportLine(
        'FAIL',
        'ReadStatus',
        `Code 63 (malformed request) — the <Command Name="ReadStatus"/> envelope this codebase sends was rejected. ` +
          `This means the wire format itself is wrong, not just the device auth.`
      )
      throw new Error(
        'ReadStatus returned Code 63 (ClientInvalidPostFormat) — the request format is rejected by the ' +
          'real server. This is a real bug in the <Command> envelope, not the device-auth blocker.'
      )
    }

    if (code === '0') {
      captureFixture('readstatus-live-captured-code0.xml', formatCapturedRes(data))
      // A real Code-0 ReadStatus is strictly better ground truth than
      // the manually-sourced example from the manual — replace it.
      captureFixture('readstatus-ok-healthy.xml', formatCapturedRes(data))
      reportLine(
        'PASS',
        'ReadStatus',
        `Code 0 (device authed) — CU_fiscalized=${data.CU_fiscalized ?? '<absent>'}, ` +
          `Paired_with_TIMS=${data.Paired_with_TIMS ?? '<absent>'}`
      )
      expect(data.CU_fiscalized, 'a Code-0 ReadStatus should report CU_fiscalized').toBeDefined()
      expect(data.Paired_with_TIMS, 'a Code-0 ReadStatus should report Paired_with_TIMS').toBeDefined()
    } else if (code === '31') {
      captureFixture('readstatus-live-captured-code31.xml', formatCapturedRes(data))
      reportLine(
        'PASS',
        'ReadStatus',
        'Code 31 (device TCP-password auth pending) — request format + session accepted; ' +
          'device itself is not authed yet (see docs/KNOWN_GAPS.md)'
      )
    } else {
      captureFixture(`readstatus-live-captured-code${code ?? 'unknown'}.xml`, formatCapturedRes(data))
      reportLine('FAIL', 'ReadStatus', `unexpected Code ${code} — neither 0 nor 31 nor 63`)
      throw new Error(
        `ReadStatus returned an unexpected Code ${code} — not one of the three outcomes this phase ` +
          `anticipated (0, 31, 63). Raw fields: ${JSON.stringify(data)}`
      )
    }

    // Either accepted outcome (0 or 31) satisfies this test — the
    // throw()s above are what fail it for 63/transport/unexpected.
    expect(['0', '31']).toContain(code)
  })
})

/** Re-renders a parsed response back into a small, readable XML-ish body for the captured fixture file. */
function formatCapturedRes(data: Record<string, string>): string {
  const { code, errSource, ...rest } = data
  const attrs = errSource ? ` errSource="${errSource}"` : ''
  const children = Object.entries(rest)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')
  return `<Res Code="${code}"${attrs}>${children}</Res>`
}
