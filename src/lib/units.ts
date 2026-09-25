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
