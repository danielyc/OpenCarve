export type Units = 'mm' | 'in'

export const mmToIn = (mm: number) => mm / 25.4
export const inToMm = (inches: number) => inches * 25.4

export const formatLength = (mm: number, units: Units) =>
  units === 'mm' ? mm.toFixed(2) : mmToIn(mm).toFixed(3)

export function parseLength(text: string, units: Units): number | null {
  const t = text.trim()
  const v = Number(t)
  if (!t || !Number.isFinite(v)) return null
  return units === 'mm' ? v : inToMm(v)
}

export const SNAP_SIZES: Record<Units, { mm: number; label: string }[]> = {
  mm: [0.5, 1, 2, 5, 10].map((mm) => ({ mm, label: `${mm} mm` })),
  in: (['1/16', '1/8', '1/4', '1/2', '1'] as const).map((f, i) => ({ mm: inToMm(1 / 2 ** (4 - i)), label: `${f}"` })),
}

// The snap size stays in mm across unit switches; the grid uses the nearest size offered for the current units.
export const nearestSnap = (mm: number, units: Units) =>
  SNAP_SIZES[units].reduce((a, b) => (Math.abs(b.mm - mm) < Math.abs(a.mm - mm) ? b : a)).mm

// Grid origin is the stock's bottom-left (stock coordinates); halves round up. size 0 leaves the point alone.
const snap = (v: number, size: number) => (size ? Math.round(v / size) * size + 0 : v)
export const snapPoint = ([x, y]: [number, number], size: number): [number, number] => [snap(x, size), snap(y, size)]
// The delta that lands `corner + delta` on the grid.
export const snapDelta = (corner: [number, number], delta: [number, number], size: number): [number, number] => {
  const [x, y] = snapPoint([corner[0] + delta[0], corner[1] + delta[1]], size)
  return [x - corner[0], y - corner[1]]
}
