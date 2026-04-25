/**
 * Local-TZ date helpers.
 *
 * `new Date().toISOString().slice(0, 10)` returns the UTC date — at 9pm ET
 * (= 01:00 UTC the next day) it already says tomorrow. Use these helpers
 * whenever the value represents a calendar day in the user's local TZ
 * (`today` keys, day-column ISO, overdue comparisons, etc.).
 */

/** Local-TZ `YYYY-MM-DD` for an arbitrary Date. */
export function toLocalDateKey(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Local-TZ `YYYY-MM-DD` for "right now". */
export function todayLocal(): string {
  return toLocalDateKey(new Date())
}
