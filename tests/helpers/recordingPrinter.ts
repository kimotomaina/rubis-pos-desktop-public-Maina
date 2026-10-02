/**
 * A printer factory whose every client is one recorded job (docs/phase-198-1).
 * `fail` decides, per job number (1-based), how that job goes wrong.
 */

import type { ThermalPrinterLike } from '../../src/main/services/printer.js'

/** What one printer job printed. */
export interface RecordedJob {
  lines: string[]
  cuts: number
}

export function recordingPrinter(fail: (job: number) => 'offline' | 'error' | null = () => null) {
  const jobs: RecordedJob[] = []
  const factory = (): ThermalPrinterLike => {
    const number = jobs.length + 1
    const job: RecordedJob = { lines: [], cuts: 0 }
    jobs.push(job)
    const noop = (): void => undefined
    return {
      isPrinterConnected: async () => fail(number) !== 'offline',
      alignCenter: noop,
      alignLeft: noop,
      alignRight: noop,
      bold: noop,
      setTextNormal: noop,
      setTextQuadArea: noop,
      println: (text: string) => {
        job.lines.push(text)
      },
      drawLine: noop,
      printQR: (text: string) => {
        job.lines.push(`[QR ${text}]`)
      },
      cut: () => {
        job.cuts++
      },
      execute: async () => {
        if (fail(number) === 'error') throw new Error('paper jam')
        return undefined
      }
    }
  }
  return { factory, jobs }
}
