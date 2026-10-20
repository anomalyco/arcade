import type { Rng } from "@arcade/kit/sim/rng"
import type { FenceKind, GarageKind, HouseCondition, HouseForm, HouseStyle, Household, PorchStyle, RoofShape, Siding, WindowPattern } from "./style"
import type { HouseVariety } from "./variety"

/** Smallest lot (width × depth, metres) each form needs. */
const MIN_LOT: Record<HouseForm, readonly [number, number]> = {
  bungalow: [9, 8.6],
  colonial: [9.6, 8.6],
  ranch: [12.5, 10.2],
  duplex: [13, 8.6],
  shotgun: [5, 10],
  farmhouse: [11, 9.4],
  trailer: [11, 4.4],
  apartment: [13, 10],
  corner_store: [9.4, 9],
}

/** Forms that suit a district's homes (woodland cabins keep to small rural ones). */
const RURAL: readonly HouseForm[] = ["bungalow", "shotgun", "trailer", "farmhouse"]

export function fittingForms(lotW: number, lotD: number, archetype: string): HouseForm[] {
  const forms = (Object.keys(MIN_LOT) as HouseForm[]).filter((f) => lotW >= MIN_LOT[f][0] && lotD >= MIN_LOT[f][1])
  return archetype === "cabin" ? forms.filter((f) => RURAL.includes(f)) : forms
}

function weighted<T extends string>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of items) total += Math.max(0, w)
  let r = rng.next() * total
  for (const [t, w] of items) {
    r -= Math.max(0, w)
    if (r < 0) return t
  }
  return items[items.length - 1]![0]
}

export function pickForm(rng: Rng, forms: readonly HouseForm[], v: HouseVariety): HouseForm | null {
  const items = forms.map((f) => [f, v.weights[f]] as const).filter(([, w]) => w > 0)
  if (!items.length) return null
  return weighted(rng, items)
}

export function pickCondition(rng: Rng, form: HouseForm, v: HouseVariety): HouseCondition {
  const r = rng.next()
  // Stores and flats are rarely left half built.
  const build = form === "apartment" || form === "corner_store" ? v.construction * 0.4 : v.construction
  if (r < v.burnt) return "burnt"
  if (r < v.burnt + v.derelict) return "derelict"
  if (r < v.burnt + v.derelict + build) return "construction"
  return "kept"
}

/** Muted Darkwood paints: bone, sage, khaki, slate, faded terracotta, cream, moss, mauve-grey, olive, mustard, grey, oxblood. */
const PAINTS = [0xa9a493, 0x8f9a8a, 0x9a8f78, 0x8a9396, 0x9c7f6a, 0xb0a68a, 0x7f8a7a, 0x95887e, 0x8c8670, 0xa39070, 0x7a7f86, 0x8f7461]
const BRICKS = [0x7a4a3a, 0x6e4636, 0x845444, 0x6a4a3e]
const STUCCO = [0xb3aa94, 0xa89c84, 0x9ea294, 0xa89a8a]
const METAL = [0x9aa09a, 0xa8a48e, 0x8e9a9e, 0xa09484]
const TRIMS = [0xc8c4b8, 0xc8c4b8, 0x3b3f3a, 0x5a3f2e, 0x8a8a80, 0x2e3a40]
/** Asphalt greys from light to near black, red-brown, moss green, slate blue, galvanised tin. */
const ROOFS = [0x4e4b46, 0x6e6a60, 0x2e2c2a, 0x6a3e30, 0x3a4a3e, 0x3e4a5a, 0x7e807a, 0x56524a]

const ROOF_BY_FORM: Record<HouseForm, readonly (readonly [RoofShape, number])[]> = {
  bungalow: [["gable", 3], ["hip", 2], ["cross", 2]],
  colonial: [["gable", 3], ["hip", 2], ["gambrel", 1.5]],
  ranch: [["hip", 3], ["gable", 2]],
  duplex: [["gable", 2], ["hip", 2]],
  shotgun: [["cross", 4], ["shed", 1]],
  farmhouse: [["gable", 2], ["gambrel", 2], ["cross", 1]],
  trailer: [["shed", 1], ["flat", 1]],
  apartment: [["flat", 4], ["hip", 1]],
  corner_store: [["flat", 1]],
}

const SIDING_BY_FORM: Record<HouseForm, readonly (readonly [Siding, number])[]> = {
  bungalow: [["clapboard", 3], ["shingle", 2], ["brick", 1], ["stucco", 1]],
  colonial: [["clapboard", 3], ["brick", 2], ["shingle", 1]],
  ranch: [["brick", 2], ["stucco", 2], ["clapboard", 2]],
  duplex: [["clapboard", 2], ["stucco", 2], ["brick", 1]],
  shotgun: [["clapboard", 4], ["shingle", 1]],
  farmhouse: [["clapboard", 3], ["shingle", 2]],
  trailer: [["metal", 1]],
  apartment: [["brick", 3], ["stucco", 1]],
  corner_store: [["brick", 3], ["clapboard", 1]],
}

const PORCH_BY_FORM: Record<HouseForm, readonly (readonly [PorchStyle, number])[]> = {
  bungalow: [["gable", 2], ["hood", 1], ["stoop", 1]],
  colonial: [["gable", 2], ["hood", 2], ["stoop", 1]],
  ranch: [["shed", 2], ["stoop", 1], ["none", 1]],
  duplex: [["shed", 3], ["stoop", 1]],
  shotgun: [["shed", 4], ["stoop", 1]],
  farmhouse: [["wrap", 1]],
  trailer: [["deck", 1]],
  apartment: [["hood", 2], ["stoop", 1]],
  corner_store: [["awning", 1]],
}

const HOUSEHOLDS: readonly (readonly [Household, number])[] = [["family", 3], ["elderly", 2], ["student", 1.2], ["hoarder", 1], ["ransacked", 1.4], ["hideout", 0.7]]

export type HouseDressing = Omit<HouseStyle, "rooms" | "yard" | "outbuilding">

/** Everything about a house's look and household except its rooms and yard (which the plan lays out), and its wall paint. */
export function pickDressing(rng: Rng, form: HouseForm, condition: HouseCondition): { dressing: HouseDressing; paint: number } {
  const storeys: 1 | 2 = form === "colonial" || form === "apartment" || form === "corner_store" || (form === "farmhouse" && rng.next() < 0.45) ? 2 : 1
  const roof = weighted(rng, ROOF_BY_FORM[form])
  const siding = weighted(rng, SIDING_BY_FORM[form])
  const palette = siding === "brick" ? BRICKS : siding === "stucco" ? STUCCO : siding === "metal" ? METAL : PAINTS
  let paint = rng.pick(palette)
  let roofColor = form === "trailer" ? 0x6a665c : rng.pick(ROOFS)
  let porch = weighted(rng, PORCH_BY_FORM[form])
  let household = weighted(rng, HOUSEHOLDS)
  const wear = condition === "kept" ? 0.2 + rng.next() * 0.5 : 0.75 + rng.next() * 0.25
  if (condition === "burnt") {
    paint = rng.pick([0x3a332c, 0x2f2a25, 0x443a30])
    roofColor = 0x1e1b18
    household = "ransacked"
  } else if (condition === "construction") {
    paint = rng.pick([0xb8b4a6, 0xa89a7c])
    household = "family"
    if (porch === "wrap" || porch === "gable" || porch === "shed") porch = "stoop"
  } else if (condition === "derelict" && household !== "hideout") {
    household = rng.next() < 0.6 ? "ransacked" : "hoarder"
  }
  const garage: GarageKind = form === "ranch" ? "attached" : form === "apartment" || form === "corner_store" ? "none" : weighted(rng, [["none", 3], ["detached", 1.2], ["carport", 1.2]])
  const fence: FenceKind = weighted(rng, [["none", 1.5], ["picket", 2], ["chainlink", 1.5], ["hedge", 1.2], ["rail", form === "farmhouse" ? 2 : 0.5]])
  const windows: WindowPattern = form === "ranch" ? weighted(rng, [["band", 2], ["picture", 1]]) : form === "trailer" ? "single" : weighted(rng, [["pairs", 2], ["single", 2], ["picture", 1]])
  const dressing: HouseDressing = {
    form,
    condition,
    storeys,
    roof,
    roofColor,
    siding,
    trim: rng.pick(TRIMS),
    wear: Number(wear.toFixed(2)),
    porch,
    chimney: form === "trailer" || form === "corner_store" || rng.next() < 0.35 ? 0 : Number((0.18 + rng.next() * 0.64).toFixed(2)),
    garage,
    fence,
    windows,
    shutters: siding !== "metal" && rng.next() < 0.45,
    household,
  }
  return { dressing, paint }
}
