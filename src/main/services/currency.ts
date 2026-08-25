const formatter = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' })

/** Formats an amount as Kenyan Shillings, e.g. `Ksh 1,234.50`. */
export function formatCurrency(amount: number): string {
  return formatter.format(amount)
}
