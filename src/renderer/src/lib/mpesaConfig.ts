/**
 * Pure helpers for the Admin screen's M-Pesa form — kept framework-free
 * (no React import) so they can be unit tested without mounting the
 * component tree, mirroring `etimsConfig.ts`.
 */

/**
 * Whether the till can actually recognise an M-Pesa confirmation SMS yet.
 *
 * Mirrors `MPESA_SMS_PARSER_READY` in `src/main/lib/mpesaSms.ts` — kept
 * as a separate renderer-local constant rather than imported, the same
 * way `DEFAULT_ETIMS_BASE_URL` duplicates its main-process value in
 * `etimsConfig.ts`, since a renderer file cannot import from the main
 * process. Used only to disable the "SMS modem" option in the Admin
 * dropdown before the till can even try to save it; the main process's
 * own copy in `mpesaIntegrationConfigSchema` is the actual gate. Flip
 * both together when the parser is finally implemented.
 */
export const MPESA_SMS_PARSER_READY = false
