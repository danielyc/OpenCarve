import type { Bit, CutSettings, Material, Project } from '../model'

export const BITS: Bit[] = [
  { id: '1mm-endmill', name: '1 mm endmill', type: 'endmill', diameter: 1 },
  { id: '2mm-endmill', name: '2 mm endmill', type: 'endmill', diameter: 2 },
  { id: '3mm-endmill', name: '3 mm endmill', type: 'endmill', diameter: 3 },
  { id: '6mm-endmill', name: '6 mm endmill', type: 'endmill', diameter: 6 },
  { id: '1/16-endmill', name: '1/16" (1.5875 mm) endmill', type: 'endmill', diameter: 1.5875 },
  { id: '1/8-endmill', name: '1/8" (3.175 mm) endmill', type: 'endmill', diameter: 3.175 },
  { id: '1/4-endmill', name: '1/4" (6.35 mm) endmill', type: 'endmill', diameter: 6.35 },
  { id: '1/8-ballnose', name: '1/8" (3.175 mm) ballnose', type: 'ballnose', diameter: 3.175 },
  { id: '1/4-ballnose', name: '1/4" (6.35 mm) ballnose', type: 'ballnose', diameter: 6.35 },
  { id: '60-vbit', name: '60° V-bit, 1/2" (12.7 mm)', type: 'vbit', diameter: 12.7, angle: 60, flat: 0 },
  { id: '90-vbit', name: '90° V-bit, 1/2" (12.7 mm)', type: 'vbit', diameter: 12.7, angle: 90, flat: 0 },
]

// Conservative hobby-router defaults for a 1/8" (3.175 mm) bit on belt/lead-screw machines; recommendedSettings scales by diameter.
export const MATERIALS: Material[] = [
  { id: 'mdf', name: 'MDF', feed: 1500, plunge: 500, stepdownFrac: 0.5, rpm: 18000 },
  { id: 'plywood', name: 'Plywood', feed: 1200, plunge: 400, stepdownFrac: 0.4, rpm: 18000 },
  { id: 'softwood', name: 'Pine / softwood', feed: 1500, plunge: 500, stepdownFrac: 0.5, rpm: 18000 },
  { id: 'hardwood', name: 'Hardwood (oak, maple)', feed: 1000, plunge: 300, stepdownFrac: 0.3, rpm: 18000 },
  { id: 'acrylic', name: 'Acrylic', feed: 800, plunge: 250, stepdownFrac: 0.25, rpm: 16000 },
  { id: 'hdpe', name: 'HDPE', feed: 1200, plunge: 400, stepdownFrac: 0.4, rpm: 16000 },
  { id: 'aluminium', name: 'Aluminium', feed: 400, plunge: 100, stepdownFrac: 0.1, rpm: 16000 },
]

export const MACHINES: Project['machine'][] = [
  { name: 'Generic GRBL', w: 300, h: 300, maxRpm: 24000 },
  { name: '3018', w: 300, h: 180, maxRpm: 10000 },
  { name: 'X-Carve 750', w: 750, h: 750, maxRpm: 24000 },
  { name: 'X-Carve 1000', w: 1000, h: 1000, maxRpm: 24000 },
  { name: 'Shapeoko 4 XL', w: 838, h: 438, maxRpm: 24000 },
  { name: 'Shapeoko 4 XXL', w: 838, h: 838, maxRpm: 24000 },
  { name: 'Onefinity Woodworker', w: 816, h: 816, maxRpm: 24000 },
]

export const findBit = (id: string) => BITS.find((b) => b.id === id) ?? BITS[0]
export const findMaterial = (id: string) => MATERIALS.find((m) => m.id === id) ?? MATERIALS[0]

// Material numbers are for a 1/8" bit: feed and plunge scale with diameter (roughly constant chipload), V-bits unscaled.
// V-bit stepdown is min(flat, 1.5) mm, or 1 mm for a sharp tip.
export function recommendedSettings(material: Material, bit: Bit, maxRpm: number): CutSettings {
  const vbit = bit.type === 'vbit'
  const f = vbit ? 1 : Math.min(1.5, Math.max(0.3, bit.diameter / 3.175))
  const stepdown = vbit ? (bit.flat ? Math.min(bit.flat, 1.5) : 1) : Math.round(Math.min(6, Math.max(0.2, material.stepdownFrac * bit.diameter)) * 10) / 10
  return {
    feed: Math.round(material.feed * f),
    plunge: Math.round(material.plunge * f),
    stepdown,
    rpm: Math.min(material.rpm, maxRpm),
    safeZ: 5,
    stepover: 0.4,
    direction: 'conventional',
  }
}
