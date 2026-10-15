/**
 * How worn a barricade looks, read from the AI's portal state so the boards show their health instead of a number.
 * Wear is the barricade's hit points over a nominal 100 per plank: reinforced boards (180) stay flush longer.
 */

/** Nominal hit points of one plank, the scale wear is measured against. */
export const NOMINAL_PLANK_HP = 100
/** Board health at or below which a plank bows inward and cracks down the middle. */
export const PLANK_BOW_AT = 0.5
/** Board health at or below which a plank hangs from one nail. */
export const PLANK_HANG_AT = 0.2

export type PlankLook = "flush" | "bowed" | "hanging"

/** 0..1: the barricade's hit points against its planks' nominal total (1 = fresh, 0 = about to give). */
export function barricadeWear(planks: number, hp: number): number {
  if (planks <= 0) return 0
  return Math.max(0, Math.min(1, hp / (planks * NOMINAL_PLANK_HP)))
}

/**
 * Health of each plank, first nailed first. Damage comes off the last board nailed, so a worn three-plank
 * barricade has two sound boards and one hanging loose rather than three evenly scuffed ones.
 */
export function plankHealths(planks: number, wear: number): number[] {
  const total = Math.max(0, Math.min(planks, wear * planks))
  return Array.from({ length: Math.max(0, planks) }, (_, i) => Math.max(0, Math.min(1, total - i)))
}

export function plankLook(health: number): PlankLook {
  if (health <= PLANK_HANG_AT) return "hanging"
  if (health <= PLANK_BOW_AT) return "bowed"
  return "flush"
}

/** Hit points over nominal, up to twice: above 1 the boards are reinforced (scrap strapped across, extra nails). */
export const MAX_STRENGTH = 2

/** 0..2: the barricade's hit points against plain planks' (above 1 it is reinforced). */
export function barricadeStrength(planks: number, hp: number): number {
  if (planks <= 0) return 0
  return Math.max(0, Math.min(MAX_STRENGTH, hp / (planks * NOMINAL_PLANK_HP)))
}

/** Packs a plank count (0..3) and strength into one wire byte: two bits of planks, six of strength (0..2). */
export function packPlanks(planks: number, hp: number): number {
  const n = Math.max(0, Math.min(3, Math.round(planks)))
  if (n === 0) return 0
  return n | (Math.round((barricadeStrength(n, hp) / MAX_STRENGTH) * 63) << 2)
}

export function unpackPlanks(byte: number): { planks: number; hp: number } {
  const planks = byte & 3
  if (!planks) return { planks: 0, hp: 0 }
  const strength = ((byte >> 2) / 63) * MAX_STRENGTH
  return { planks, hp: planks * NOMINAL_PLANK_HP * strength }
}
