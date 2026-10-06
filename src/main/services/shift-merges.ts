/** `shifts:merge` request (docs/phase-239): an admin merges one closed shift into another of the same window. */
export interface MergeShiftsRequest {
  managerId: number
  managerPin: string
  absorbedShiftId: number
  intoShiftId: number
  reason: string
}
