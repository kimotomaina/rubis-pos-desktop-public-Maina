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
  basePrice: z.number().finite().nonnegative().optional(),
  /** Device VAT class (A-E), sourced from the Shopify variant's `rubis.vat_class` metafield when present. */
  vatClass: z.string().optional(),
  /** Harmonized System code, sourced from the variant's `rubis.hs_code` metafield when present. */
  hsCode: z.string().optional(),
  /** Harmonized System name, sourced from the variant's `rubis.hs_name` metafield when present. */
  hsName: z.string().optional()
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
  companyName: z.string().optional(),
  cartDiscount: discountSchema.optional()
})

/** `orders:void` request payload — a single local order id. */
export const voidOrderSchema = z.number().int().positive()

/**
 * `fiscal:correct-pin-and-resend` request payload (phase-78, Part C) —
 * `buyerPin: null` removes the PIN, a non-blank string corrects it.
 * Format is not checked here: the renderer already gates this on
 * `isValidKraPinFormat` before calling it, and `submitInvoice`'s own
 * pre-send validation (`fiscal-validate.ts`) is the backstop either way.
 */
export const correctPinAndResendSchema = z.object({
  localId: z.number().int().positive(),
  buyerPin: z.string().min(1, 'PIN cannot be blank — remove it instead of sending an empty value').nullable()
})

/**
 * `fiscal:resend` request payload (phase-88, Step 4) — the back-office
 * list's plain "Resend" action (no PIN change), for a `needs_fixing`/
 * `system` row or a stuck-`waiting` row.
 */
export const resendFiscalizationSchema = z.object({
  localId: z.number().int().positive()
})

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

/**
 * `mpesa:log-transaction` request payload — records a newly initiated
 * STK Push for the M-Pesa Logs screen. No manager re-authorization:
 * this is a routine checkout-flow side effect, not a privileged write.
 */
export const mpesaLogTransactionSchema = z.object({
  orderLocalId: z.number().int().positive().optional(),
  checkoutRequestId: z.string().min(1, 'Checkout request id is required'),
  // Daraja issues no MerchantRequestID for a request it never accepted,
  // so a logged failure has none — only checkoutRequestId is required.
  merchantRequestId: z.string(),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  amount: z.number().int().positive(),
  status: z.enum(['pending', 'success', 'failed']).optional()
})

/**
 * `mpesa:query-status` request payload — a single Daraja checkout
 * request id to re-check, mirroring `voidOrderSchema`'s bare-value
 * shape.
 */
export const mpesaQueryStatusSchema = z.string().min(1, 'Checkout request id is required')

/**
 * `config:set` request payload — a single `app_configurations`
 * key/value write (manager re-authorization required, since these
 * control which integration providers a till talks to live).
 */
export const configSetSchema = managerAuthzSchema.extend({
  key: z.string().min(1, 'Config key is required'),
  value: z.string(),
  requiresRestart: z.boolean().optional(),
  category: z.enum(['shopify', 'mpesa', 'etims', 'printer', 'general']).optional()
})

/**
 * `secrets:set-mpesa-credentials` request payload (manager
 * re-authorization required) — at least one of `consumerSecret`/
 * `passkey` must be a non-blank value, mirroring
 * `secrets:set-shopify-token`'s "a non-empty value is required" rule.
 */
export const mpesaCredentialsSetSchema = managerAuthzSchema
  .extend({
    consumerSecret: z.string().optional(),
    passkey: z.string().optional()
  })
  .refine((data) => !!data.consumerSecret?.trim() || !!data.passkey?.trim(), {
    message: 'Provide a consumer secret or passkey to save'
  })

/**
 * Dotted-quad IPv4 check, mirroring `isIpv4Address` in the renderer's
 * `etimsConfig.ts`. Duplicated rather than imported: the main process
 * must not trust a value merely because a screen validated it, and
 * importing renderer code into main would drag in its module graph.
 */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Reports whether `value` is a dotted-quad IPv4 address.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value.trim())
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * The three non-secret fiscal device connection fields, with the same
 * rules and the same plain-language messages the Admin form applies —
 * re-checked here so a compromised renderer calling the channel
 * directly cannot store a malformed address.
 */
const etimsConnectionFields = {
  baseUrl: z.string().trim().min(1, 'Enter the fiscal server address'),
  deviceIp: z
    .string()
    .trim()
    .min(1, 'Enter the fiscal device IP address')
    .refine(isIpv4, 'That does not look like an IP address. It should look like 192.168.1.50'),
  devicePort: z
    .string()
    .trim()
    .min(1, 'Enter the fiscal device port')
    .refine(
      (port) => /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535,
      'The port must be a whole number between 1 and 65535'
    )
}

/**
 * `setup:save-etims-config` request payload — the mandatory eTIMS
 * setup gate's four required Real-eTIMS connection fields. No manager
 * re-authorization: this runs before any staff has necessarily
 * unblocked the till, mirroring `config:save`'s pre-login write.
 */
export const etimsConfigSaveSchema = z.object({
  ...etimsConnectionFields,
  password: z.string().trim().min(1, 'Enter the fiscal device password')
})

/**
 * `secrets:set-etims-password` request payload (manager
 * re-authorization required). A blank password is rejected rather than
 * stored: the Admin form treats an empty box as "leave the saved one
 * alone" and never sends one.
 */
export const etimsPasswordSetSchema = managerAuthzSchema.extend({
  password: z.string().trim().min(1, 'Enter the fiscal device password')
})

/**
 * `store:set-identity` request payload (manager re-authorization
 * required) — the store name and KRA PIN printed on every receipt.
 *
 * A KRA PIN is 11 characters (`P051234567X`), but a blank one is
 * allowed: a branch may not have entered it yet, and the receipt simply
 * omits the line. The name is required — every receipt has a header.
 */
export const storeIdentitySetSchema = managerAuthzSchema.extend({
  storeName: z.string().trim().min(1, 'Enter the store name'),
  storeKraPin: z
    .string()
    .trim()
    .refine(
      (pin) => pin === '' || /^[A-Za-z]\d{9}[A-Za-z]$/.test(pin),
      'A KRA PIN looks like P051234567X — one letter, nine digits, one letter'
    )
})

/**
 * `integrations:set-config` payload for the `etims` provider
 * specifically — applied on top of the generic schema so the device
 * fields get the same checks the setup gate enforces. `password` is
 * absent by construction: it goes to the vault via
 * `secrets:set-etims-password`.
 */
export const etimsIntegrationConfigSchema = z.object({
  ...etimsConnectionFields,
  defaultVatClass: z.string().trim().min(1, 'Enter the default tax class').optional()
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
