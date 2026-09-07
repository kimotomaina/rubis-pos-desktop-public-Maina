/**
 * Standalone runner for the mock ZFPLabServer engine — `npm run mock:zfplab`.
 *
 * Starts the exact same engine `tests/mockServerHappyPath.test.ts` boots
 * in-process (`engine.ts#createMockZfpLabServer`) as a real, freestanding
 * HTTP server on port 4444, so the POS app can be pointed at it with zero
 * code changes — the real provider is the default, so this only needs
 * Admin → Integrations left pointing at `http://localhost:4444/`. This is
 * the demo target: a cashier can complete a sale and see a fiscalized
 * (synthetic) receipt with no physical device attached at all.
 */

import { createMockZfpLabServer, DEFAULT_MOCK_PORT } from './engine.js'

const port = Number(process.env.MOCK_ZFPLAB_PORT) || DEFAULT_MOCK_PORT

async function main(): Promise<void> {
  const server = await createMockZfpLabServer({ port })

  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  MOCK ZFPLabServer — synthetic, NOT KRA-registered                  ║')
  console.log('║  Every invoice number / QR code this serves is fake and             ║')
  console.log('║  visibly so (see tests/fixtures/wire/*.xml). Do not treat any       ║')
  console.log('║  output from this process as a real fiscal receipt.                 ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`[mock-zfplab] listening at ${server.baseUrl}`)
  console.log('')
  console.log('[mock-zfplab] DEMO MODE — how to point the POS at this server:')
  console.log('[mock-zfplab]   The real provider is the default, so nothing needs enabling.')
  console.log('[mock-zfplab]   Just leave the Admin -> Integrations fiscal server address at')
  console.log('[mock-zfplab]   http://localhost:4444/ and complete a sale.')
  console.log('[mock-zfplab] Do NOT set VITE_USE_MOCK_ETIMS=true for this demo — that swaps in')
  console.log('[mock-zfplab] the in-process mock provider, which never touches this server at')
  console.log('[mock-zfplab] all, so this process would sit idle receiving nothing.')
  console.log('')

  const shutdown = async (): Promise<void> => {
    console.log('\n[mock-zfplab] shutting down…')
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[mock-zfplab] failed to start:', error)
  process.exit(1)
})
