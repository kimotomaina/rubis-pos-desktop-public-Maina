/**
 * Connectivity monitor for the till's external dependencies — M-Pesa
 * (Daraja), the local fiscal device (ZFPLabServer), and the receipt
 * printer. Polls each on an interval (default 30s) plus an immediate
 * check on `start()`, and reports the full status set on every pass
 * (not just on transition) so a details view can show a live "last
 * checked"/"response time" even when nothing has changed.
 *
 * Kept free of Electron imports, mirroring `network.ts`, so the
 * module stays importable in tests without booting Electron. Each
 * check is injected as a `ConnectivityChecker` — `index.ts` supplies
 * the real HTTP/TCP probes (see {@link checkHttpReachable} and
 * {@link checkTcpReachable}), while tests inject fakes.
 */

import { Socket } from 'node:net'
import axios from 'axios'

/** Result of one reachability probe. */
export interface ConnectivityCheckResult {
  connected: boolean
  /** ISO timestamp of when this check ran. */
  lastCheckedAt: string
  /** Round-trip time in milliseconds, present only on a successful check. */
  latencyMs?: number
  /** Human-readable failure reason, present only when `connected` is false. */
  error?: string
}

/** Combined status of every monitored integration. */
export interface ConnectivityStatus {
  mpesa: ConnectivityCheckResult
  fiscal: ConnectivityCheckResult
  printer: ConnectivityCheckResult
}

/** A single integration's reachability probe. */
export type ConnectivityChecker = () => Promise<ConnectivityCheckResult>

/** Dependencies for {@link createConnectivityMonitor}. */
export interface ConnectivityMonitorOptions {
  checkMpesa: ConnectivityChecker
  checkFiscal: ConnectivityChecker
  checkPrinter: ConnectivityChecker
  /** Called with the full status set after every check pass (poll or manual). */
  emit: (status: ConnectivityStatus) => void
  /** Poll interval in milliseconds. Defaults to 30s. */
  intervalMs?: number
}

/** Handle returned by {@link createConnectivityMonitor}. */
export interface ConnectivityMonitor {
  /** Runs an immediate check, then starts the interval timer. */
  start(): void
  /** Stops the interval timer. */
  stop(): void
  /** Runs one check pass now; concurrent calls coalesce into one in-flight run. */
  checkNow(): Promise<ConnectivityStatus>
  /** The most recently completed status set. */
  getStatus(): ConnectivityStatus
}

/** Status reported before the first check has ever completed. */
function pendingResult(): ConnectivityCheckResult {
  return { connected: false, lastCheckedAt: '', error: 'Not yet checked' }
}

/**
 * Creates the connectivity monitor.
 *
 * @param {ConnectivityMonitorOptions} options
 * @returns {ConnectivityMonitor}
 */
export function createConnectivityMonitor(options: ConnectivityMonitorOptions): ConnectivityMonitor {
  const { checkMpesa, checkFiscal, checkPrinter, emit } = options
  const intervalMs = options.intervalMs ?? 30_000

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<ConnectivityStatus> | null = null
  let status: ConnectivityStatus = {
    mpesa: pendingResult(),
    fiscal: pendingResult(),
    printer: pendingResult()
  }

  async function runCheck(): Promise<ConnectivityStatus> {
    if (inFlight) return inFlight

    inFlight = (async () => {
      const [mpesa, fiscal, printer] = await Promise.all([
        checkMpesa(),
        checkFiscal(),
        checkPrinter()
      ])
      status = { mpesa, fiscal, printer }
      emit(status)
      return status
    })()

    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  return {
    start(): void {
      if (timer) return
      void runCheck()
      timer = setInterval(() => void runCheck(), intervalMs)
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    checkNow: runCheck,

    getStatus(): ConnectivityStatus {
      return status
    }
  }
}

/**
 * Probes an HTTP(S) endpoint for reachability — any response (even a
 * 4xx/5xx) counts as "connected", since the goal is proving the host
 * is reachable, not that a request succeeds. Only a transport-level
 * failure (DNS, refused connection, timeout) counts as disconnected.
 *
 * @param {string} url
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<ConnectivityCheckResult>}
 */
export async function checkHttpReachable(
  url: string,
  timeoutMs = 5000
): Promise<ConnectivityCheckResult> {
  const startedAt = Date.now()
  try {
    await axios.get(url, { timeout: timeoutMs, validateStatus: () => true })
    return {
      connected: true,
      lastCheckedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      connected: false,
      lastCheckedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unreachable'
    }
  }
}

/**
 * Probes a `tcp://host:port` interface (as used by
 * `VITE_PRINTER_INTERFACE`) for TCP reachability by opening and
 * immediately closing a socket.
 *
 * @param {string} interfaceString
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<ConnectivityCheckResult>}
 */
export function checkTcpReachable(
  interfaceString: string,
  timeoutMs = 5000
): Promise<ConnectivityCheckResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(interfaceString)
    } catch {
      resolve({
        connected: false,
        lastCheckedAt: new Date().toISOString(),
        error: `Invalid printer interface: ${interfaceString}`
      })
      return
    }

    const port = Number(parsed.port)
    if (!parsed.hostname || !Number.isFinite(port)) {
      resolve({
        connected: false,
        lastCheckedAt: new Date().toISOString(),
        error: `Invalid printer interface: ${interfaceString}`
      })
      return
    }

    const socket = new Socket()
    let settled = false

    const finish = (result: ConnectivityCheckResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish({
        connected: true,
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt
      })
    })
    socket.once('timeout', () => {
      finish({
        connected: false,
        lastCheckedAt: new Date().toISOString(),
        error: `Timed out connecting to ${parsed.hostname}:${port}`
      })
    })
    socket.once('error', (error) => {
      finish({
        connected: false,
        lastCheckedAt: new Date().toISOString(),
        error: error.message
      })
    })

    socket.connect(port, parsed.hostname)
  })
}

/**
 * Reported for an integration genuinely simulated locally with no
 * external counterpart to fail — e.g. a mock printer that logs
 * receipts to the console instead of using hardware. Always
 * "connected", since there's nothing external to be disconnected
 * from.
 *
 * @returns {ConnectivityCheckResult}
 */
export function mockConnectedResult(): ConnectivityCheckResult {
  return { connected: true, lastCheckedAt: new Date().toISOString(), latencyMs: 0 }
}

/**
 * Reported for an integration running against a mock provider instead
 * of its real backend (e.g. M-Pesa/eTIMS in mock mode) — deliberately
 * shown as disconnected, since no real connection to Daraja or a
 * fiscal device actually exists while mocked.
 *
 * @param {string} [message]
 * @returns {ConnectivityCheckResult}
 */
export function mockDisconnectedResult(
  message = 'Mock mode enabled — not a real connection'
): ConnectivityCheckResult {
  return { connected: false, lastCheckedAt: new Date().toISOString(), error: message }
}
