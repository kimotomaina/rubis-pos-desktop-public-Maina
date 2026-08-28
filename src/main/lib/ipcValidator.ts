/**
 * IPC payload validation.
 *
 * Every value crossing the IPC boundary from the renderer is
 * attacker-influenceable in principle — a compromised or buggy
 * renderer can send anything, not just what the preload's typed API
 * surface implies. `zod` schemas here validate structure and ranges
 * before a payload ever reaches a database call or business-logic
 * function, so a malformed `orders:checkout`/`orders:void`/
 * `auth:login` request returns a clean {@link ServiceResult} failure
 * instead of throwing deep inside `better-sqlite3` (a wrong bind-
 * parameter type) or corrupting application state.
 */

import { z } from 'zod'

/** A discount payload, shared by line items and the cart-level discount. */
const discountSchema = z.object({
  type: z.enum(['percent', 'fixed']),
  value: z.number().finite()
})

/** One cart line item as submitted at checkout. */
const cartItemSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  title: z.string().min(1),
  variantTitle: z.string(),
  price: z.number().finite().nonnegative(),
  quantity: z.number().int().positive(),
  image: z.string().nullable(),
  discount: discountSchema.optional(),
  basePrice: z.number().finite().nonnegative().optional()
})

/** `orders:checkout` request payload. */
export const checkoutRequestSchema = z.object({
  items: z.array(cartItemSchema).min(1, 'Cart is empty — add items before checking out'),
  total: z.number().finite().nonnegative(),
  staffId: z.number().int().positive(),
  paymentMethod: z.enum(['cash', 'mpesa', 'card']),
  tenderedAmount: z.number().finite(),
  changeDue: z.number().finite(),
  referenceNumber: z.string().optional(),
  shiftId: z.number().int().positive().optional(),
  customerPin: z.string().optional(),
  cartDiscount: discountSchema.optional()
})

/** `orders:void` request payload — a single local order id. */
export const voidOrderSchema = z.number().int().positive()

/** `auth:login` request payload. */
export const loginRequestSchema = z.object({
  staffId: z.number().int().positive(),
  pin: z.string().min(1, 'PIN is required')
})

/**
 * Shared re-authorization fields on every privileged Admin-screen
 * payload — the manager id/PIN `requireAdminPin` re-checks
 * server-side before the request's own action is allowed to proceed.
 */
const managerAuthzSchema = z.object({
  managerId: z.number().int().positive(),
  managerPin: z.string().min(1, 'Manager PIN is required')
})

/** `staff:create` request payload (manager re-authorization required). */
export const staffCreateSchema = managerAuthzSchema.extend({
  name: z.string().min(1, 'Name is required'),
  pin: z.string().min(1, 'PIN is required'),
  role: z.enum(['admin', 'cashier'])
})

/** `staff:resetPin` request payload (manager re-authorization required). */
export const staffResetPinSchema = managerAuthzSchema.extend({
  staffId: z.number().int().positive(),
  pin: z.string().min(1, 'A new PIN is required')
})

/** `integrations:set-config` request payload (manager re-authorization required). */
export const integrationsSetConfigSchema = managerAuthzSchema.extend({
  provider: z.enum(['mpesa', 'etims']),
  config: z.record(z.string(), z.unknown())
})

/**
 * `printers:save` request payload — a printer configuration
 * plus manager re-authorization, mirroring `integrationsSetConfigSchema`
 * since registering a printer interface is the same class of
 * privileged Admin-screen write.
 */
export const printerSaveSchema = managerAuthzSchema.extend({
  id: z.string().min(1, 'Printer id is required'),
  type: z.enum(['receipt', 'kitchen', 'label']),
  interfaceName: z.string().min(1, 'Printer interface is required'),
  enabled: z.boolean()
})

/** `printers:delete` request payload. */
export const printerDeleteSchema = managerAuthzSchema.extend({
  id: z.string().min(1, 'Printer id is required')
})

/**
 * `shopify:set-store-url` request payload — lets an install
 * be configured from the Admin screen instead of requiring a `.env`
 * file on every device. Gated the same as `integrations:set-config`:
 * pointing the till at a different store is a consequential admin
 * write, even though the URL itself isn't a secret.
 */
export const shopifySetStoreUrlSchema = managerAuthzSchema.extend({
  storeUrl: z.string().url('Enter a full URL, e.g. https://your-store.myshopify.com')
})

/**
 * `config:validate` request payload — the onboarding wizard's
 * "Connect & Verify" step. No manager re-authorization: this only
 * makes a read-only Shopify API call and returns its result, changing
 * nothing locally — the same risk class as `printers:test`.
 */
export const configValidateSchema = z.object({
  storeUrl: z.string().url('Enter a full URL, e.g. https://your-store.myshopify.com'),
  token: z.string().min(1, 'Admin API token is required')
})

/**
 * `config:save` request payload — persists the store URL,
 * token, and single selected location the first-run wizard just
 * verified. No manager re-authorization: this runs before any staff
 * has signed in (the wizard replaces the Login screen entirely until
 * a config exists), so there is no admin session yet to re-check.
 * Once a config exists, changing it is `config:clear`
 * from inside the already-authenticated Admin screen, which is gated like
 * every other privileged Admin write.
 */
export const configSaveSchema = z.object({
  storeUrl: z.string().url('Enter a full URL, e.g. https://your-store.myshopify.com'),
  token: z.string().min(1, 'Admin API token is required'),
  locationId: z.string().min(1, 'A location must be selected'),
  locationName: z.string().min(1, 'Location name is required')
})

/**
 * `config:clear` request payload — the Admin screen's
 * "Reset Configuration" action. Manager re-authorization required,
 * same as `shopify:set-store-url`: this wipes the store connection
 * every other screen depends on.
 */
export const configClearSchema = managerAuthzSchema

/**
 * `location:set` request payload — the post-login
 * location-confirmation screen's (and Admin screen's "Change
 * Location" control's) save action. Manager re-authorization
 * required, same class of write as `config:save`'s location id but
 * happens post-onboarding, so it needs the re-check
 * `shopify:set-store-url` also uses.
 */
export const locationSetSchema = managerAuthzSchema.extend({
  locationId: z.string().min(1, 'A location must be selected'),
  locationName: z.string().min(1, 'Location name is required')
})

/**
 * `printers:test` request payload — no manager
 * re-authorization: sending a test page reads and changes nothing, so
 * it carries the same risk as the existing read-only `staff:list`/
 * `integrations:get-config` channels, not a privileged write.
 */
export const printerTestSchema = z.object({
  interfaceName: z.string().min(1, 'Printer interface is required')
})

/** Result of {@link validate} — mirrors {@link ServiceResult}'s discriminated shape. */
export type ValidationResult<T> = { success: true; data: T } | { success: false; error: string }

/**
 * Validates `payload` against `schema`, collapsing every zod issue
 * into one human-readable message (`field: reason; field: reason`)
 * suitable for a {@link ServiceResult} error.
 *
 * @param {z.ZodType<T>} schema
 * @param {unknown} payload
 * @returns {ValidationResult<T>}
 */
export function validate<T>(schema: z.ZodType<T>, payload: unknown): ValidationResult<T> {
  const result = schema.safeParse(payload)
  if (result.success) {
    return { success: true, data: result.data }
  }
  const message = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ')
  return { success: false, error: message }
}
