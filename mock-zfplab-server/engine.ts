/**
 * Mock ZFPLabServer engine (Chunk 2, `docs/phase-62.md` roadmap).
 *
 * A faithful fake of the vendor's local HTTP bridge
 * (`http://localhost:4444/`) — see `docs/phase-61.md` §2 / §4.1-4.2 for the
 * transport this replicates. It serves the **same ground-truth fixture
 * files** materialized in Chunk 1 (`tests/fixtures/wire/*.xml`) rather than
 * inventing response shapes — this is the one and only server
 * implementation (no divergent second one for `npm run mock:zfplab` vs.
 * Chunk 3's in-process boot; both call {@link createMockZfpLabServer}).
 *
 * Transport handled, per the confirmed contract:
 *   - `GET /settings(ip=…,port=…,password=…,tcp=1)` → `settings-ok.xml`
 *     verbatim (the real capture), regardless of the parameters sent — this
 *     mock doesn't validate device credentials, since there is no mock
 *     device, only a mock bridge.
 *   - `GET /clientremove(who=me)` → `success-ack.xml` (bare `Code="0"` — no
 *     dedicated fixture exists for this ack; `success-ack.xml` is the
 *     correct generic shape, not a fabricated one).
 *   - `POST /` with `<Command Name="X">…</Command>` (or `<Command
 *     Name="X"/>`) → the fixture the command→fixture map (Appendix A of the
 *     master brief) says, unless a fault has been injected for `X`.
 *   - A POST body with no matching `<Command Name="…">` → `code63-
 *     invalidpost.xml` (real Code-63 shape) — this is what the real server
 *     is confirmed to do (`docs/phase-61.md` §4 finding basis).
 *
 * Every response is HTTP 200 with the fixture's XML body verbatim — the
 * real server carries protocol/business errors *inside* the `<Res Code>`
 * envelope, never as a non-2xx HTTP status (confirmed by
 * `http-client.ts#describeFiscalHttpError`, which only treats a present
 * `axiosError.response` with a non-2xx status as a distinct "server
 * rejected" case from a `<Res Code>` error read out of a 2xx body).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WIRE_FIXTURES_DIR = join(__dirname, '..', 'tests', 'fixtures', 'wire')

/** Default port — matches the real ZFPLabServer's fixed local port. */
export const DEFAULT_MOCK_PORT = 4444

/**
 * Command (or the two literal-GET pseudo-commands `settings`/`clientremove`)
 * → the ground-truth fixture file it returns by default. Every value here
 * is a real file already materialized under `tests/fixtures/wire/` — Chunk
 * 1's ground-truth set, never invented for this engine. A command not
 * listed here still gets a response (`success-ack.xml`, with a console
 * warning) rather than a hang or a 404 — the mock's job is to keep the demo
 * running, not to gate every one of the contract's 122 commands.
 */
const DEFAULT_FIXTURE_MAP: Record<string, string> = {
  settings: 'settings-ok.xml',
  clientremove: 'success-ack.xml',
  ReadStatus: 'readstatus-fiscalized-full.xml',
  OpenInvoiceWithFreeCustomerData: 'success-ack.xml',
  SellPLUfromExtDB: 'success-ack.xml',
  SellPLUfromExtDB_HS: 'success-ack.xml',
  ReadCurrentReceiptInfo: 'readcurrentreceiptinfo-ok.xml',
  CloseReceipt: 'closereceipt-ok.xml',
  ReadDateTime: 'readdatetime-ok.xml',
  OpenCreditNoteWithFreeCustomerData: 'success-ack.xml',
  OpenDebitNoteWithFreeCustomerData: 'success-ack.xml',
  ReadCUinvoiceNumber: 'readcuinvoicenumber-ok.xml',
  CancelReceipt: 'success-ack.xml',
  ReadCUnumbers: 'readcunumbers-ok.xml'
}

/** The fixture served for a POST body with no recognizable `<Command Name="…">`. */
const INVALID_POST_FIXTURE = 'code63-invalidpost.xml'

/** One captured raw request, in arrival order — for test/demo introspection. */
export interface MockRequestLogEntry {
  method: 'GET' | 'POST'
  url: string
  /** Raw request body (POST only). */
  body?: string
  /** The `<Command Name="…">` value, when this was a recognizable POST. */
  commandName?: string
  /** `'settings'` / `'clientremove'` for the two literal GETs. */
  pseudoCommand?: 'settings' | 'clientremove'
  /** The fixture file name actually served for this request. */
  servedFixture: string
  timestamp: number
}

/** A one-shot or persistent override for what a given command name returns next. */
interface FaultEntry {
  fixtureFileName: string
  persistent: boolean
}

/** Handle returned by {@link createMockZfpLabServer}. */
export interface MockZfpLabServerHandle {
  port: number
  /** `http://localhost:<port>/` — pass straight to `createFiscalHttpClient({ baseUrl })`. */
  baseUrl: string
  /** Every request received so far, in arrival order. Mutated in place — read, don't replace. */
  requests: MockRequestLogEntry[]
  /**
   * Makes the next request for `commandName` (or `'settings'` /
   * `'clientremove'`) return `fixtureFileName` instead of its default —
   * any fixture under `tests/fixtures/wire/`, success or error. One-shot
   * unless `persistent` is set, matching the brief's Code-53 scenario
   * ("served on the first command then success").
   */
  setFault(commandName: string, fixtureFileName: string, options?: { persistent?: boolean }): void
  /** Removes any pending fault for `commandName`. */
  clearFault(commandName: string): void
  /** Removes every pending fault. */
  clearAllFaults(): void
  /** Empties the request log. */
  clearRequests(): void
  close(): Promise<void>
}

/** Options accepted by {@link createMockZfpLabServer}. */
export interface MockZfpLabServerOptions {
  /** Port to listen on. Defaults to {@link DEFAULT_MOCK_PORT}. Pass `0` for an OS-assigned ephemeral port (used by Chunk 3's in-process tests). */
  port?: number
}

const fixtureCache = new Map<string, string>()

/** Reads a fixture file from `tests/fixtures/wire/`, caching its content (fixtures are static). */
function loadFixture(fileName: string): string {
  const cached = fixtureCache.get(fileName)
  if (cached !== undefined) return cached
  const content = readFileSync(join(WIRE_FIXTURES_DIR, fileName), 'utf8')
  fixtureCache.set(fileName, content)
  return content
}

/** Extracts the `Name="…"` attribute off a `<Command Name="X">` or `<Command Name="X"/>` POST body. */
function extractCommandName(body: string): string | undefined {
  const match = body.match(/<Command\s+Name="([^"]*)"/)
  return match?.[1]
}

/**
 * Starts the mock server and resolves once it's listening.
 *
 * @param {MockZfpLabServerOptions} options
 * @returns {Promise<MockZfpLabServerHandle>}
 */
export function createMockZfpLabServer(
  options: MockZfpLabServerOptions = {}
): Promise<MockZfpLabServerHandle> {
  const requests: MockRequestLogEntry[] = []
  const faults = new Map<string, FaultEntry>()

  /** Resolves the fixture to serve for `key` (a command name or pseudo-command), consuming a one-shot fault if present. */
  function resolveFixture(key: string): string {
    const fault = faults.get(key)
    if (fault) {
      if (!fault.persistent) faults.delete(key)
      return fault.fixtureFileName
    }
    const defaultFixture = DEFAULT_FIXTURE_MAP[key]
    if (!defaultFixture) {
      console.warn(
        `[mock-zfplab] no fixture mapped for "${key}" — serving success-ack.xml (Code 0) as a safe default`
      )
      return 'success-ack.xml'
    }
    return defaultFixture
  }

  function sendXml(res: ServerResponse, fixtureFileName: string): void {
    const body = loadFixture(fixtureFileName)
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
    res.end(body)
  }

  function handleGet(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''
    if (url.startsWith('/settings(')) {
      const fixture = resolveFixture('settings')
      requests.push({
        method: 'GET',
        url,
        pseudoCommand: 'settings',
        servedFixture: fixture,
        timestamp: Date.now()
      })
      sendXml(res, fixture)
      return
    }
    if (url.startsWith('/clientremove(')) {
      const fixture = resolveFixture('clientremove')
      requests.push({
        method: 'GET',
        url,
        pseudoCommand: 'clientremove',
        servedFixture: fixture,
        timestamp: Date.now()
      })
      sendXml(res, fixture)
      return
    }
    console.warn(`[mock-zfplab] unrecognized GET ${url} — serving success-ack.xml`)
    requests.push({ method: 'GET', url, servedFixture: 'success-ack.xml', timestamp: Date.now() })
    sendXml(res, 'success-ack.xml')
  }

  function handlePost(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = req.url ?? ''
    const commandName = extractCommandName(body)
    const fixture = commandName ? resolveFixture(commandName) : INVALID_POST_FIXTURE
    requests.push({
      method: 'POST',
      url,
      body,
      commandName,
      servedFixture: fixture,
      timestamp: Date.now()
    })
    sendXml(res, fixture)
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      handleGet(req, res)
      return
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => handlePost(req, res, Buffer.concat(chunks).toString('utf8')))
      return
    }
    res.writeHead(405, { 'Content-Type': 'text/plain' })
    res.end('Method Not Allowed')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    // Bind 127.0.0.1 explicitly, not the 0.0.0.0 Node defaults to when no
    // host is given — this is a stand-in for the local vendor bridge, never
    // meant to be reachable from another machine, and binding all
    // interfaces is both wrong for that and (per this project's history)
    // sometimes rejected outright in a locked-down sandbox.
    server.listen(options.port ?? DEFAULT_MOCK_PORT, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_MOCK_PORT)
      resolve({
        port,
        baseUrl: `http://localhost:${port}/`,
        requests,
        setFault(commandName, fixtureFileName, opts) {
          faults.set(commandName, { fixtureFileName, persistent: opts?.persistent ?? false })
        },
        clearFault(commandName) {
          faults.delete(commandName)
        },
        clearAllFaults() {
          faults.clear()
        },
        clearRequests() {
          requests.length = 0
        },
        close() {
          return new Promise((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()))
          })
        }
      })
    })
  })
}
