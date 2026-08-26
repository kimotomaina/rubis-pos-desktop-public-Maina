/**
 * IPC payload validation (Phase 12, Task 2).
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
 * payload (Phase 14) — the manager id/PIN `requireAdminPin` re-checks
 * server-side before the request's own action is allowed to proceed.
 */
const managerAuthzSchema = z.object({
  managerId: z.number().int().positive(),
  managerPin: z.string().min(1, 'Manager PIN is required')
})

/** `staff:create` request payload (Phase 14 — adds manager re-authorization). */
export const staffCreateSchema = managerAuthzSchema.extend({
  name: z.string().min(1, 'Name is required'),
  pin: z.string().min(1, 'PIN is required'),
  role: z.enum(['admin', 'cashier'])
})

/** `staff:resetPin` request payload (Phase 14 — adds manager re-authorization). */
export const staffResetPinSchema = managerAuthzSchema.extend({
  staffId: z.number().int().positive(),
  pin: z.string().min(1, 'A new PIN is required')
})

/** `integrations:set-config` request payload (Phase 14 — adds manager re-authorization). */
export const integrationsSetConfigSchema = managerAuthzSchema.extend({
  provider: z.enum(['mpesa', 'etims']),
  config: z.record(z.string(), z.unknown())
})

/**
 * `printers:save` request payload (Phase 15) — a printer configuration
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

/** `printers:delete` request payload (Phase 15). */
export const printerDeleteSchema = managerAuthzSchema.extend({
  id: z.string().min(1, 'Printer id is required')
})

/**
 * `printers:test` request payload (Phase 15) — no manager
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
