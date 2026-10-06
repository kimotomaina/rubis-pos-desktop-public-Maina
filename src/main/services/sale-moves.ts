/** The `shifts:move-sale` request as the renderer sends it (validated by `moveSaleSchema`, docs/phase-232). */
export interface MoveSaleRequest {
  managerId: number
  managerPin: string
  orderId: number
  toShiftId: number
  reason: string
  /** Required when the sale was made in a different window from the shift it goes to. */
  acknowledgeDifferentWindow?: boolean
}
