/**
 * Minimal logger surface shared across the fiscalization path
 * (`checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts`,
 * `integrations/real-etims-provider.ts`) — wraps `console` in
 * production, a fake in tests. Kept to the three levels these callers
 * actually use, per phase-80's audit: one shared, testable logger
 * instead of a mix of an injected logger nobody else used and raw
 * `console.*` calls scattered through the device-protocol layer.
 */
export interface Logger {
  log(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
