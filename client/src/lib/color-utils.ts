/**
 * Lighten a hex color by blending toward white.
 * @param hex - 6-digit hex color (e.g., "#E31A38")
 * @param amount - blend amount 0–1 (0 = unchanged, 1 = white)
 */
export function lightenHex(hex: string, amount: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lr = Math.round(r + (255 - r) * amount)
  const lg = Math.round(g + (255 - g) * amount)
  const lb = Math.round(b + (255 - b) * amount)
  return `rgb(${lr}, ${lg}, ${lb})`
}
