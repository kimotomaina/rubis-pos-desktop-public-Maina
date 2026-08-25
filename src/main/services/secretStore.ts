/**
 * Secure secret storage (Phase 12, Task 1).
 *
 * Wraps `keytar` (the OS credential vault — Windows Credential Manager
 * on this project's target platform) behind a narrow interface,
 * following the same dependency-injection convention as `printer.ts`'s
 * `ThermalPrinterLike` and `updater.ts`'s `AutoUpdaterLike`: the real
 * `keytar` module is never imported by the functions below (only by
 * {@link loadKeytar}, which `main/index.ts` calls once at startup), so
 * unit tests inject a recording fake instead of the native binary.
 *
 * The `.env` file remains insecure for anything beyond local
 * development — it ships in plaintext next to the packaged app
 * (`electron-builder`'s `extraResources`) and can be read by anyone
 * with filesystem access to the install directory. `resolveShopifyToken`
 * is the policy that keeps that acceptable in dev (Phase 12 Q1
 * default) while refusing to fall back to it once the app is packaged.
 */

/** Narrow surface of `keytar` this module depends on. */
export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

/** `keytar`'s "service" namespace for every credential this app stores. */
export const SECRET_SERVICE_NAME = 'RUBIS POS'

/** `keytar` account name for the Shopify Admin API token. */
export const SHOPIFY_TOKEN_ACCOUNT = 'shopify-admin-api-token'

/**
 * No-op fallback used when the real `keytar` native module fails to
 * load (e.g. its binding wasn't rebuilt for the current Electron ABI —
 * see {@link loadKeytar}). Every read returns "not found" and every
 * write silently fails rather than throwing, so a broken credential
 * vault degrades the app to "Shopify sync unavailable" instead of
 * crashing it outright, matching this codebase's "fail safely"
 * convention from `errorHandler.ts`.
 */
export const NULL_KEYTAR: KeytarLike = {
  async getPassword() {
    return null
  },
  async setPassword() {
    console.error('[rubis-pos] keytar unavailable — secret was not saved')
  },
  async deletePassword() {
    return false
  }
}

/**
 * Reads one secret from the OS credential vault. Never throws — a
 * vault-access failure (locked keychain, permissions issue) is logged
 * and treated as "not found" rather than propagating.
 *
 * @param {KeytarLike} keytar
 * @param {string} service
 * @param {string} account
 * @returns {Promise<string | null>}
 */
export async function getSecret(
  keytar: KeytarLike,
  service: string,
  account: string
): Promise<string | null> {
  try {
    return await keytar.getPassword(service, account)
  } catch (err) {
    console.error('[rubis-pos] keytar getPassword failed:', err)
    return null
  }
}

/**
 * Writes one secret to the OS credential vault.
 *
 * @param {KeytarLike} keytar
 * @param {string} service
 * @param {string} account
 * @param {string} value
 * @returns {Promise<boolean>} `true` on success
 */
export async function setSecret(
  keytar: KeytarLike,
  service: string,
  account: string,
  value: string
): Promise<boolean> {
  try {
    await keytar.setPassword(service, account, value)
    return true
  } catch (err) {
    console.error('[rubis-pos] keytar setPassword failed:', err)
    return false
  }
}

/**
 * Deletes one secret from the OS credential vault.
 *
 * @param {KeytarLike} keytar
 * @param {string} service
 * @param {string} account
 * @returns {Promise<boolean>} `true` if a credential was removed
 */
export async function deleteSecret(
  keytar: KeytarLike,
  service: string,
  account: string
): Promise<boolean> {
  try {
    return await keytar.deletePassword(service, account)
  } catch (err) {
    console.error('[rubis-pos] keytar deletePassword failed:', err)
    return false
  }
}

/** Where {@link resolveShopifyToken} found (or failed to find) the token. */
export type ShopifyTokenSource = 'keytar' | 'env' | 'none'

/** Result of {@link resolveShopifyToken}. */
export interface ShopifyTokenResolution {
  token: string | null
  source: ShopifyTokenSource
}

/**
 * Resolves the Shopify Admin API token at startup (Phase 12, Task 1 —
 * Q1 default):
 *   1. The credential vault is always checked first — once a token has
 *      been saved there, it is always the source of truth.
 *   2. Only in dev (`isDev`) does a missing vault entry fall back to
 *      `envToken` (from `.env`) — and when it does, the value is
 *      immediately persisted into the vault so every subsequent launch
 *      reads from `keytar`, not the plaintext file.
 *   3. In production, a missing vault entry resolves to `null` — the
 *      Admin screen's Integrations panel is where an operator sets it
 *      (`secrets:set-shopify-token`), never a `.env` fallback.
 *
 * @param {object} options
 * @param {KeytarLike} options.keytar
 * @param {boolean} options.isDev
 * @param {string} [options.envToken]
 * @returns {Promise<ShopifyTokenResolution>}
 */
export async function resolveShopifyToken(options: {
  keytar: KeytarLike
  isDev: boolean
  envToken?: string
}): Promise<ShopifyTokenResolution> {
  const stored = await getSecret(options.keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT)
  if (stored) {
    return { token: stored, source: 'keytar' }
  }

  if (options.isDev && options.envToken) {
    await setSecret(options.keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT, options.envToken)
    return { token: options.envToken, source: 'env' }
  }

  return { token: null, source: 'none' }
}

/**
 * Loads the real `keytar` native module, falling back to
 * {@link NULL_KEYTAR} when it can't be loaded (native binding not
 * built for the current Electron/Node ABI — a real possibility in a
 * fresh dev checkout before `npm run postinstall`'s `electron-rebuild`
 * has completed). Dynamic `import()` rather than a static one so this
 * failure is caught and handled instead of crashing the whole main
 * process at module-load time.
 *
 * @returns {Promise<KeytarLike>}
 */
export async function loadKeytar(): Promise<KeytarLike> {
  try {
    const imported = (await import('keytar')) as unknown as
      | KeytarLike
      | { default: KeytarLike }
    const candidate = 'default' in imported ? imported.default : imported
    if (typeof candidate?.getPassword !== 'function') {
      throw new Error('keytar module loaded but does not expose the expected API')
    }
    return candidate
  } catch (err) {
    console.error('[rubis-pos] keytar unavailable — falling back to no-op secret storage:', err)
    return NULL_KEYTAR
  }
}
