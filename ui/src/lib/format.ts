/**
 * Shared presentation formatters for Mission UI.
 *
 * Currency values are integer cents (the authoritative unit for all
 * budget/cost decisions). Formatters never introduce floating-point
 * estimates: cents are converted to a fixed two-decimal currency string
 * only for display.
 */

/** Format integer cents as a USD currency string (`$5.00`, `$0.00`). */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
