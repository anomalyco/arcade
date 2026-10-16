import { seedOf } from "@arcade/kit/sim/rng"
import { rugSpecFor, type RugRoomKind, type RugSpec } from "@arcade/kit/textures/rug"
import { CHUNK, type Building } from "../../shared/map"

/**
 * Seeded interior themes and rug placements for every building. Pure and deterministic: the chunk worker uses it to
 * emit rug quads and decor, the main thread uses it to bake the matching rug textures.
 */

export const INTERIOR_THEMES = ["plain", "mansion", "baker", "station", "village"] as const
export type InteriorTheme = (typeof INTERIOR_THEMES)[number]
export const INTERIOR_THEME_LABELS: Record<InteriorTheme, string> = {
  plain: "70s plaster",
  mansion: "Mansion (RE1)",
  baker: "Farmhouse (RE7)",
  station: "Precinct (RE2)",
  village: "Castle (Village)",
}

export type RugPlacement = {
  /** Index within the building, 0..3; with the building's stream slot it keys the rug directory. */
  idx: number
  /** Floor rectangle [x0, z0, x1, z1]. */
  rect: readonly [number, number, number, number]
  /** True when the rug's long side runs along world x. */
  alongX: boolean
  room: RugRoomKind
  spec: RugSpec
}

export type InteriorPlan = {
  theme: InteriorTheme
  /** Per-building variation 0..1 (wallpaper colourway, decor picks). */
  variant: number
  rugs: RugPlacement[]
}

/** Lab overrides; `theme: -1` keeps the seeded choice. */
export const interiorSettings = {
  theme: -1,
  rugSeed: 0,
  rugs: 1,
  decor: 1,
  wainscot: 1,
  wallCaps: 1,
}

/** Rug top height above the 0.13 m house floor. */
export const RUG_Y = 0.142

export function buildingSeed(b: Building, houseSeed: number): number {
  return (seedOf(b.id) ^ Math.imul(houseSeed + 0x3c6ef372, 0x9e3779b1)) >>> 0
}

/** Toroidal stream slot (0..8) of the chunk that owns a building, as the renderer's streamed level uses. */
export function buildingStreamSlot(b: Building): number {
  let cx: number, cy: number
  if (b.chunkKey) {
    const [a, c] = b.chunkKey.split(",")
    cx = Number(a)
    cy = Number(c)
  } else {
    cx = Math.floor((b.rect[0] + b.rect[2]) * 0.5 / CHUNK)
    cy = Math.floor((b.rect[1] + b.rect[3]) * 0.5 / CHUNK)
  }
  return (((cy % 3) + 3) % 3) * 3 + (((cx % 3) + 3) % 3)
}

/** Rug directory key used in vertex aux and the shader's directory lookup. */
export const rugKey = (slot: number, idx: number) => slot * 4 + idx

function pickTheme(arch: string, seed: number): InteriorTheme {
  const r = ((seed >>> 8) & 0xffff) / 0x10000
  const table: readonly (readonly [InteriorTheme, number])[] =
    arch === "house" ? [["mansion", 0.35], ["baker", 0.3], ["village", 0.2], ["plain", 0.15]]
    : arch === "ranch" ? [["baker", 0.4], ["mansion", 0.3], ["plain", 0.3]]
    : arch === "cottage" ? [["village", 0.4], ["baker", 0.4], ["plain", 0.2]]
    : arch === "cabin" ? [["baker", 0.7], ["plain", 0.3]]
    : arch === "police" || arch === "clinic" ? [["station", 1]]
    : arch === "church" ? [["village", 1]]
    : [["plain", 1]]
  let acc = 0
  for (const [t, w] of table) {
    acc += w
    if (r < acc) return t
  }
  return table[table.length - 1]![0]
}

export function isResidential(b: Building): boolean {
  const a = b.archetype ?? b.kind
  return a === "house" || a === "ranch" || a === "cottage" || a === "cabin"
}

/** Layout of procedural and classic houses (the formulas in `shared/world.ts` and `shared/map.ts`). */
export function houseLayout(b: Building): { x: number; y: number; r: number; e: number; doorX: number; split: number; lPlan: boolean } {
  const [x, y, r, e] = b.rect
  // Classic buildings (map.ts) carry no footprint; procedural ones always do.
  const classic = !b.footprint
  const lPlan = b.kind === "house"
  const doorX = classic ? x + 5 : x + Math.min(5.0, Math.max(2.6, (r - x) * 0.42))
  const split = classic ? y + 5.5 : y + Math.min(5.5, (e - y) * 0.5)
  return { x, y, r, e, doorX, split, lPlan }
}

const cache = new Map<string, InteriorPlan>()

export function planInterior(b: Building, houseSeed: number): InteriorPlan {
  const key = `${b.id}|${b.rect.join(",")}|${houseSeed}|${interiorSettings.theme}|${interiorSettings.rugSeed}|${interiorSettings.rugs}`
  const hit = cache.get(key)
  if (hit) return hit
  const seed = buildingSeed(b, houseSeed)
  const arch = b.archetype ?? b.kind
  const theme = interiorSettings.theme >= 0 ? INTERIOR_THEMES[interiorSettings.theme] ?? "plain" : pickTheme(arch, seed)
  const variant = ((seed >>> 4) & 0xfff) / 0x1000
  const rugs: RugPlacement[] = []
  const age = theme === "baker" ? 0.95 : theme === "mansion" ? 0.65 : theme === "village" ? 0.7 : 0.45
  const rugSeed = (seed ^ Math.imul(interiorSettings.rugSeed + 1, 0x85ebca6b)) >>> 0
  const add = (rect: readonly [number, number, number, number], room: RugRoomKind) => {
    if (!interiorSettings.rugs || rugs.length >= 4) return
    const w = rect[2] - rect[0], d = rect[3] - rect[1]
    if (w < 0.5 || d < 0.5) return
    const alongX = w > d
    const spec = rugSpecFor((rugSeed + rugs.length * 0x632be5ab) >>> 0, room, Math.min(w, d), Math.max(w, d), age)
    if (theme === "mansion" && spec.style === "persian" && (rugSeed >>> (rugs.length + 3)) & 1) spec.palette = "mansion"
    rugs.push({ idx: rugs.length, rect, alongX, room, spec })
  }
  const L = houseLayout(b)
  const { x, y, r, e, doorX, split } = L
  if (isResidential(b)) {
    if (L.lPlan) {
      // L-plan (classic Ash/Elm and procedural bungalows): living, bedroom, entry hall and kitchen.
      add([x + 1.55, e - 4.35, x + 4.42, e - 0.85], "living")
      add([x + 4.92, y + 1.35, x + 6.82, y + 4.25], "bedroom")
      add([doorX + 0.25, y + 6.15, doorX + 1.15, e - 1.75], "hall")
      add([r - 4.95, y + 6.45, r - 2.25, y + 7.22], "kitchen")
    } else {
      // Rectangular plan: living rug under the coffee table, bedroom rug beside the bed, entry runner.
      const northX = x + 2.2
      add([x + 1.55, Math.max(split + 0.5, e - 3.9), Math.min(doorX - 0.15, x + 3.9), e - 0.6], "living")
      const bz1 = Math.min(split - 0.2, y + 4.0)
      add([northX + 0.95, y + 1.45, Math.min(r - 0.4, northX + 2.65), bz1], "bedroom")
      add([doorX + 0.25, split + 0.45, doorX + 1.15, e - 0.6], "hall")
    }
  } else if (arch === "church") {
    const cx = (x + r) / 2
    add([cx - 0.55, y + 2.6, cx + 0.55, e - 0.5], "church")
  } else if (arch === "police") {
    add([x + 3.3, e - 3.6, Math.min(r - 2.6, x + 6.1), e - 0.7], "lobby")
  }
  const plan: InteriorPlan = { theme, variant, rugs }
  if (cache.size > 256) cache.delete(cache.keys().next().value!)
  cache.set(key, plan)
  return plan
}

/** Theme index used by the shader (matches `INTERIOR_THEMES`). */
export const themeIndex = (t: InteriorTheme) => INTERIOR_THEMES.indexOf(t)

/** Cache-key fragment for everything in `interiorSettings` that changes level geometry. */
export const interiorSignature = () => `${interiorSettings.theme}|${interiorSettings.rugSeed}|${interiorSettings.rugs}|${interiorSettings.decor}|${interiorSettings.wainscot}|${interiorSettings.wallCaps}`
