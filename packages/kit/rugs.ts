import type { LabControl } from "./lab-panel"
import { Rng } from "./sim/rng"
import { buildLinearMipChain, linearToSrgbByte, srgbByteToLinear, type MipLevelData } from "./textures/loader"
import { wgslStruct } from "./gpu/wgsl"

export type RugStyleId =
  | "persian_medallion"
  | "turkmen_gul"
  | "kilim_geometric"
  | "art_deco"
  | "braided_oval"
  | "shag_70s"

export type RugPaletteId =
  | "madder_indigo"
  | "indigo_ivory"
  | "saffron_walnut"
  | "turkmen_oxblood"
  | "faded_antique"
  | "emerald_crimson"

export type RugMotifId = "auto" | "rosette" | "boteh" | "gul" | "herati" | "vine_scroll"

export type RugSymmetryMode = 2 | 4

export type RugParams = {
  seed: number
  tuningSeed: number
  style: RugStyleId
  palette: RugPaletteId
  motif: RugMotifId
  symmetry: RugSymmetryMode
  aspect: number
  borderWidth: number
  medallionScale: number
  motifScale: number
  knotDensity: number
  abrash: number
  wear: number
  fringeLength: number
  pileHeight: number
}

export type RugStyleDef = {
  id: RugStyleId
  index: number
  label: string
  summary: string
  defaults: Omit<RugParams, "seed" | "tuningSeed">
}

export type RugPaletteColors = {
  id: RugPaletteId
  index: number
  label: string
  /** sRGB [0..1] triples for the 6 traditional dye roles */
  field: readonly [number, number, number]
  medallion: readonly [number, number, number]
  borderMain: readonly [number, number, number]
  borderGuard: readonly [number, number, number]
  accent: readonly [number, number, number]
  foundation: readonly [number, number, number]
}

export const RUG_STYLE_DEFS: Readonly<Record<RugStyleId, RugStyleDef>> = {
  persian_medallion: {
    id: "persian_medallion",
    index: 0,
    label: "Persian Medallion (Tabriz / Kashan)",
    summary: "Scalloped central medallion, pendant palmettes, corner spandrels, herati vine field, and nested floral borders.",
    defaults: {
      style: "persian_medallion",
      palette: "madder_indigo",
      motif: "auto",
      symmetry: 4,
      aspect: 1.45,
      borderWidth: 0.24,
      medallionScale: 0.92,
      motifScale: 1.0,
      knotDensity: 1.15,
      abrash: 0.36,
      wear: 0.34,
      fringeLength: 0.04,
      pileHeight: 0.85,
    },
  },
  turkmen_gul: {
    id: "turkmen_gul",
    index: 1,
    label: "Turkmen Bokhara Gul (Tekke)",
    summary: "Repeating octagonal elephant-foot guls and cruciform chemche minor motifs in a deep oxblood/madder weave.",
    defaults: {
      style: "turkmen_gul",
      palette: "turkmen_oxblood",
      motif: "gul",
      symmetry: 4,
      aspect: 1.5,
      borderWidth: 0.22,
      medallionScale: 0.95,
      motifScale: 1.1,
      knotDensity: 1.2,
      abrash: 0.42,
      wear: 0.38,
      fringeLength: 0.04,
      pileHeight: 0.8,
    },
  },
  kilim_geometric: {
    id: "kilim_geometric",
    index: 2,
    label: "Anatolian Kilim Geometric",
    summary: "Flatweave slit-tapestry stepped diamonds, ram's-horn latch hooks, and reciprocal serrated guard borders.",
    defaults: {
      style: "kilim_geometric",
      palette: "saffron_walnut",
      motif: "rosette",
      symmetry: 2,
      aspect: 1.65,
      borderWidth: 0.2,
      medallionScale: 1.0,
      motifScale: 1.05,
      knotDensity: 1.0,
      abrash: 0.52,
      wear: 0.32,
      fringeLength: 0.05,
      pileHeight: 0.55,
    },
  },
  art_deco: {
    id: "art_deco",
    index: 3,
    label: "Art Deco (Spencer / RPD Grand Salon)",
    summary: "1920s stepped ziggurat spandrels, brass-gold sunburst geometry, and architectural greek-key border framing.",
    defaults: {
      style: "art_deco",
      palette: "emerald_crimson",
      motif: "vine_scroll",
      symmetry: 4,
      aspect: 1.4,
      borderWidth: 0.22,
      medallionScale: 0.88,
      motifScale: 0.95,
      knotDensity: 1.1,
      abrash: 0.22,
      wear: 0.28,
      fringeLength: 0.025,
      pileHeight: 0.9,
    },
  },
  braided_oval: {
    id: "braided_oval",
    index: 4,
    label: "Braided Oval (Colonial / Cottage)",
    summary: "Concentric oval braided wool coils in alternating heritage bands with directional stitch-twist relief.",
    defaults: {
      style: "braided_oval",
      palette: "faded_antique",
      motif: "auto",
      symmetry: 4,
      aspect: 1.55,
      borderWidth: 0.26,
      medallionScale: 0.85,
      motifScale: 1.0,
      knotDensity: 1.05,
      abrash: 0.4,
      wear: 0.36,
      fringeLength: 0.0,
      pileHeight: 0.95,
    },
  },
  shag_70s: {
    id: "shag_70s",
    index: 5,
    label: "70s Shag & Moroccan Trellis",
    summary: "High-pile tufted wool with organic retro wave/diamond trellis lines and deep plush pile normal variation.",
    defaults: {
      style: "shag_70s",
      palette: "saffron_walnut",
      motif: "herati",
      symmetry: 2,
      aspect: 1.35,
      borderWidth: 0.16,
      medallionScale: 0.9,
      motifScale: 0.9,
      knotDensity: 0.8,
      abrash: 0.46,
      wear: 0.3,
      fringeLength: 0.05,
      pileHeight: 1.35,
    },
  },
}

export const RUG_STYLE_IDS = Object.keys(RUG_STYLE_DEFS) as readonly RugStyleId[]

export const RUG_PALETTES: Readonly<Record<RugPaletteId, RugPaletteColors>> = {
  madder_indigo: {
    id: "madder_indigo",
    index: 0,
    label: "Madder Red & Midnight Indigo",
    field: [0.47, 0.14, 0.11],
    medallion: [0.11, 0.16, 0.24],
    borderMain: [0.12, 0.17, 0.25],
    borderGuard: [0.76, 0.69, 0.56],
    accent: [0.72, 0.53, 0.24],
    foundation: [0.58, 0.51, 0.4],
  },
  indigo_ivory: {
    id: "indigo_ivory",
    index: 1,
    label: "Isfahan Indigo & Bone Ivory",
    field: [0.12, 0.17, 0.25],
    medallion: [0.78, 0.72, 0.59],
    borderMain: [0.48, 0.18, 0.13],
    borderGuard: [0.32, 0.43, 0.38],
    accent: [0.71, 0.55, 0.28],
    foundation: [0.62, 0.56, 0.45],
  },
  saffron_walnut: {
    id: "saffron_walnut",
    index: 2,
    label: "Heriz Saffron, Walnut & Rust",
    field: [0.27, 0.17, 0.11],
    medallion: [0.54, 0.22, 0.14],
    borderMain: [0.74, 0.55, 0.23],
    borderGuard: [0.17, 0.23, 0.28],
    accent: [0.8, 0.74, 0.6],
    foundation: [0.54, 0.46, 0.35],
  },
  turkmen_oxblood: {
    id: "turkmen_oxblood",
    index: 3,
    label: "Tekke Oxblood & Cochineal",
    field: [0.38, 0.1, 0.09],
    medallion: [0.11, 0.13, 0.18],
    borderMain: [0.26, 0.1, 0.09],
    borderGuard: [0.77, 0.71, 0.58],
    accent: [0.69, 0.41, 0.2],
    foundation: [0.55, 0.47, 0.37],
  },
  faded_antique: {
    id: "faded_antique",
    index: 4,
    label: "Spencer Faded Antique Sage & Rose",
    field: [0.26, 0.32, 0.29],
    medallion: [0.48, 0.26, 0.2],
    borderMain: [0.72, 0.66, 0.54],
    borderGuard: [0.2, 0.24, 0.23],
    accent: [0.62, 0.5, 0.31],
    foundation: [0.56, 0.51, 0.42],
  },
  emerald_crimson: {
    id: "emerald_crimson",
    index: 5,
    label: "Manor Emerald, Claret & Gilt",
    field: [0.12, 0.24, 0.19],
    medallion: [0.44, 0.13, 0.14],
    borderMain: [0.19, 0.13, 0.1],
    borderGuard: [0.72, 0.56, 0.28],
    accent: [0.79, 0.73, 0.6],
    foundation: [0.52, 0.46, 0.36],
  },
}

export const RUG_PALETTE_IDS = Object.keys(RUG_PALETTES) as readonly RugPaletteId[]

export const RUG_MOTIF_IDS: readonly RugMotifId[] = ["auto", "rosette", "boteh", "gul", "herati", "vine_scroll"]

export const RUG_MOTIF_LABELS: Readonly<Record<RugMotifId, string>> = {
  auto: "Auto (by style & seed)",
  rosette: "Lotus Rosettes & Palmettes",
  boteh: "Boteh (Persian Paisley)",
  gul: "Octagonal Tribal Guls",
  herati: "Herati Diamond & Acanthus",
  vine_scroll: "Arabesque Vine Scrolls",
}

export function isRugStyleId(v: unknown): v is RugStyleId {
  return typeof v === "string" && v in RUG_STYLE_DEFS
}

export function isRugPaletteId(v: unknown): v is RugPaletteId {
  return typeof v === "string" && v in RUG_PALETTES
}

export function isRugMotifId(v: unknown): v is RugMotifId {
  return typeof v === "string" && (RUG_MOTIF_IDS as readonly string[]).includes(v)
}

export function createDefaultRugParams(style: RugStyleId = "persian_medallion", seed = 7): RugParams {
  return {
    seed,
    tuningSeed: 41,
    ...RUG_STYLE_DEFS[style].defaults,
  }
}

export function resolveMotifIndex(motif: RugMotifId, style: RugStyleId, seed: number): number {
  if (motif === "rosette") return 0
  if (motif === "boteh") return 1
  if (motif === "gul") return 2
  if (motif === "herati") return 3
  if (motif === "vine_scroll") return 4
  if (style === "turkmen_gul") return 2
  if (style === "kilim_geometric") return (seed & 1) === 0 ? 0 : 2
  if (style === "art_deco") return 4
  return Math.abs(Math.trunc(seed * 7 + RUG_STYLE_DEFS[style].index * 3)) % 5
}

/**
 * Generates deterministic, varied `RugParams` for a specific house/building seed and room slot (`0..7`).
 * Guarantees every house and room gets a distinct, historically grounded rug recipe.
 */
export function seededRugParamsForSlot(buildingSeed: number, slotIndex: number, archetype = "house"): RugParams {
  const rng = new Rng(((buildingSeed * 2654435761) ^ ((slotIndex + 1) * 0x9e3779b9)) >>> 0)
  let stylePool: readonly RugStyleId[] = ["persian_medallion", "turkmen_gul", "kilim_geometric", "art_deco"]
  let palettePool: readonly RugPaletteId[] = [
    "madder_indigo",
    "indigo_ivory",
    "saffron_walnut",
    "turkmen_oxblood",
    "faded_antique",
    "emerald_crimson",
  ]
  if (archetype === "cottage" || archetype === "cabin") {
    stylePool = ["kilim_geometric", "braided_oval", "turkmen_gul", "persian_medallion"]
    palettePool = ["saffron_walnut", "turkmen_oxblood", "faded_antique", "madder_indigo"]
  } else if (archetype === "ranch") {
    stylePool = ["persian_medallion", "kilim_geometric", "shag_70s", "turkmen_gul"]
  } else if (archetype === "police" || archetype === "church") {
    stylePool = ["persian_medallion", "art_deco", "turkmen_gul"]
    palettePool = ["emerald_crimson", "madder_indigo", "indigo_ivory", "faded_antique"]
  }

  // Slot 0 = Living room / main hall area rug, Slot 1 = Bedroom / back parlor rug, Slot 2 = Hallway runner
  const style: RugStyleId =
    slotIndex === 2
      ? rng.pick(["persian_medallion", "turkmen_gul", "kilim_geometric"] as const)
      : stylePool[(slotIndex + Math.floor(rng.next() * stylePool.length)) % stylePool.length]!
  const palette: RugPaletteId =
    palettePool[(slotIndex * 2 + Math.floor(rng.next() * palettePool.length)) % palettePool.length]!
  const base = RUG_STYLE_DEFS[style].defaults
  const motifChoices: readonly RugMotifId[] = ["rosette", "boteh", "gul", "herati", "vine_scroll"]
  const motif = motifChoices[(slotIndex + Math.floor(rng.next() * motifChoices.length)) % motifChoices.length]!

  return {
    seed: ((buildingSeed * 31 + slotIndex * 97 + 13) % 9999) + 1,
    tuningSeed: 41 + slotIndex * 17,
    style,
    palette,
    motif,
    symmetry: style === "kilim_geometric" && rng.next() < 0.45 ? 2 : 4,
    aspect: slotIndex === 2 ? 3.1 : slotIndex === 1 ? 1.52 : 1.25,
    borderWidth: Number((base.borderWidth + (rng.next() - 0.5) * 0.05).toFixed(3)),
    medallionScale: Number((base.medallionScale + (rng.next() - 0.5) * 0.18).toFixed(3)),
    motifScale: Number((0.88 + rng.next() * 0.32).toFixed(3)),
    knotDensity: Number((1.0 + rng.next() * 0.35).toFixed(3)),
    abrash: Number((0.28 + rng.next() * 0.28).toFixed(3)),
    wear: Number((0.26 + rng.next() * 0.3).toFixed(3)),
    fringeLength: style === "braided_oval" ? 0 : Number((0.032 + rng.next() * 0.018).toFixed(3)),
    pileHeight: base.pileHeight,
  }
}

function snap(v: number, min: number, max: number, step: number): number {
  const c = Math.max(min, Math.min(max, v))
  return Number((min + Math.round((c - min) / step) * step).toFixed(4))
}

/**
 * Deterministic parameter randomization using an isolated `tuningSeed` (per docs/lab.md).
 * Leaves the structural `seed` unchanged.
 */
export function randomizeRugParams(current: RugParams, tuningSeed = current.tuningSeed): RugParams {
  const rng = new Rng(((Math.trunc(tuningSeed) || 1) * 0x9e3779b9) ^ 0x85ebca6b)
  const style = rng.pick(RUG_STYLE_IDS)
  const palette = rng.pick(RUG_PALETTE_IDS)
  const motif = rng.pick(RUG_MOTIF_IDS)
  const symmetry: RugSymmetryMode = rng.next() < 0.72 ? 4 : 2
  return {
    ...current,
    style,
    palette,
    motif,
    symmetry,
    borderWidth: snap(0.16 + rng.next() * 0.16, 0.12, 0.38, 0.01),
    medallionScale: snap(0.65 + rng.next() * 0.65, 0.25, 1.6, 0.05),
    motifScale: snap(0.75 + rng.next() * 0.65, 0.5, 2.0, 0.05),
    knotDensity: snap(0.85 + rng.next() * 0.65, 0.5, 2.0, 0.05),
    abrash: snap(0.15 + rng.next() * 0.6, 0.0, 1.0, 0.02),
    wear: snap(0.15 + rng.next() * 0.55, 0.0, 1.0, 0.02),
    fringeLength: style === "braided_oval" ? 0 : snap(0.02 + rng.next() * 0.04, 0.0, 0.08, 0.005),
    pileHeight: snap(0.55 + rng.next() * 0.65, 0.1, 1.5, 0.05),
  }
}

export type RugPresetV1 = {
  version: 1
  params: RugParams
}

export function validateRugParams(
  input: unknown,
): { ok: true; value: RugParams } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Rug parameters must be an object." }
  }
  const raw = input as Record<string, unknown>
  if (!isRugStyleId(raw.style)) {
    return { ok: false, error: `Invalid rug style: "${String(raw.style)}".` }
  }
  if (!isRugPaletteId(raw.palette)) {
    return { ok: false, error: `Invalid rug palette: "${String(raw.palette)}".` }
  }
  const motif = raw.motif ?? "auto"
  if (!isRugMotifId(motif)) {
    return { ok: false, error: `Invalid rug motif: "${String(motif)}".` }
  }
  const symmetry = raw.symmetry === 2 ? 2 : raw.symmetry === 4 ? 4 : null
  if (!symmetry) {
    return { ok: false, error: `Invalid symmetry mode: "${String(raw.symmetry)}" (expected 2 or 4).` }
  }
  const num = (key: string, min: number, max: number, step: number, fallback: number): number | null => {
    const v = raw[key] ?? fallback
    if (typeof v !== "number" || !Number.isFinite(v) || v < min - 1e-5 || v > max + 1e-5) return null
    return snap(v, min, max, step)
  }
  const defaults = createDefaultRugParams(raw.style)
  const seed = num("seed", 1, 9999, 1, defaults.seed)
  const tuningSeed = num("tuningSeed", 1, 9999, 1, defaults.tuningSeed)
  const aspect = num("aspect", 0.5, 3.5, 0.05, defaults.aspect)
  const borderWidth = num("borderWidth", 0.12, 0.38, 0.01, defaults.borderWidth)
  const medallionScale = num("medallionScale", 0.25, 1.6, 0.05, defaults.medallionScale)
  const motifScale = num("motifScale", 0.5, 2.0, 0.05, defaults.motifScale)
  const knotDensity = num("knotDensity", 0.5, 2.0, 0.05, defaults.knotDensity)
  const abrash = num("abrash", 0.0, 1.0, 0.02, defaults.abrash)
  const wear = num("wear", 0.0, 1.0, 0.02, defaults.wear)
  const fringeLength = num("fringeLength", 0.0, 0.08, 0.005, defaults.fringeLength)
  const pileHeight = num("pileHeight", 0.1, 1.5, 0.05, defaults.pileHeight)

  if (
    seed === null ||
    tuningSeed === null ||
    aspect === null ||
    borderWidth === null ||
    medallionScale === null ||
    motifScale === null ||
    knotDensity === null ||
    abrash === null ||
    wear === null ||
    fringeLength === null ||
    pileHeight === null
  ) {
    return { ok: false, error: "One or more numeric rug parameters are out of range or non-finite." }
  }

  return {
    ok: true,
    value: {
      seed: Math.trunc(seed),
      tuningSeed: Math.trunc(tuningSeed),
      style: raw.style,
      palette: raw.palette,
      motif,
      symmetry,
      aspect,
      borderWidth,
      medallionScale,
      motifScale,
      knotDensity,
      abrash,
      wear,
      fringeLength,
      pileHeight,
    },
  }
}

export function exportRugPreset(params: RugParams): RugPresetV1 {
  const checked = validateRugParams(params)
  if (!checked.ok) throw new Error(checked.error)
  return { version: 1, params: checked.value }
}

export function importRugPreset(rawJson: string): { ok: true; value: RugPresetV1 } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return { ok: false, error: "Invalid JSON syntax." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Rug preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported rug preset version: ${String(obj.version)} (expected 1).` }
  }
  const checked = validateRugParams(obj.params)
  if (!checked.ok) return checked
  return { ok: true, value: { version: 1, params: checked.value } }
}

export const RUG_CONTROLS: readonly LabControl[] = [
  {
    key: "style",
    label: "Rug tradition / style",
    group: "Pattern & Structure",
    type: "select",
    options: RUG_STYLE_IDS.map((id) => ({ value: id, label: RUG_STYLE_DEFS[id].label })),
  },
  {
    key: "palette",
    label: "Dye palette",
    group: "Pattern & Structure",
    type: "select",
    options: RUG_PALETTE_IDS.map((id) => ({ value: id, label: RUG_PALETTES[id].label })),
  },
  {
    key: "motif",
    label: "Main border motif",
    group: "Pattern & Structure",
    type: "select",
    options: RUG_MOTIF_IDS.map((id) => ({ value: id, label: RUG_MOTIF_LABELS[id] })),
  },
  {
    key: "symmetry",
    label: "Symmetry folding",
    group: "Pattern & Structure",
    type: "select",
    options: [
      { value: 4, label: "4-fold (Medallion & Spandrels)" },
      { value: 2, label: "2-fold (Directional / Prayer Arch)" },
    ],
  },
  { key: "aspect", label: "Aspect ratio (L/W)", group: "Pattern & Structure", type: "range", min: 0.5, max: 3.5, step: 0.05, unit: "×" },
  { key: "borderWidth", label: "Border frame width", group: "Pattern & Structure", type: "range", min: 0.12, max: 0.38, step: 0.01, unit: "" },
  { key: "medallionScale", label: "Medallion & spandrel size", group: "Pattern & Structure", type: "range", min: 0.25, max: 1.6, step: 0.05, unit: "×" },
  { key: "motifScale", label: "Motif frequency", group: "Pattern & Structure", type: "range", min: 0.5, max: 2.0, step: 0.05, unit: "×" },
  { key: "knotDensity", label: "Knot grid fineness", group: "Weave & Aging", type: "range", min: 0.5, max: 2.0, step: 0.05, unit: "×" },
  { key: "abrash", label: "Abrash dye banding", group: "Weave & Aging", type: "range", min: 0.0, max: 1.0, step: 0.02, unit: "" },
  { key: "wear", label: "Threadbare wear & fade", group: "Weave & Aging", type: "range", min: 0.0, max: 1.0, step: 0.02, unit: "" },
  { key: "fringeLength", label: "Warp fringe length", group: "Weave & Aging", type: "range", min: 0.0, max: 0.08, step: 0.005, unit: "" },
  { key: "pileHeight", label: "Pile relief & normal", group: "Weave & Aging", type: "range", min: 0.1, max: 1.5, step: 0.05, unit: "×" },
  { key: "seed", label: "Rug pattern seed", group: "Seeds", type: "range", min: 1, max: 9999, step: 1, unit: "" },
  { key: "tuningSeed", label: "Tuning randomize seed", group: "Seeds", type: "range", min: 1, max: 9999, step: 1, unit: "" },
]

// --- Shared Math Helpers (CPU + WGSL parity) ---

function fract(x: number): number {
  return x - Math.floor(x)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const u = clamp(t, 0, 1)
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

function hash2(x: number, y: number): number {
  let qx = fract(x * 0.1031)
  let qy = fract(y * 0.103)
  const d = qx * (qy + 33.33) + qy * (qx + 33.33)
  qx += d
  qy += d
  return fract((qx + qy) * qx)
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uy
}

function fbm2(x: number, y: number): number {
  return noise2(x, y) * 0.55 + noise2(x * 2.07 + 5.3, y * 2.07 + 2.9) * 0.3 + noise2(x * 4.19 + 1.7, y * 4.19 + 8.3) * 0.15
}

/**
 * Evaluates a repeating border or field motif in local cell coordinates `p = (x, y)` in `[-0.5, 0.5]^2`:
 * returns `[primaryMask, secondaryAccentMask, outlineMask]`.
 */
export function evalRugMotifCpu(motifIndex: number, px: number, py: number, seedPhase: number): [number, number, number] {
  const ax = Math.abs(px)
  const ay = Math.abs(py)
  const r = Math.hypot(px, py)
  const ang = Math.atan2(py, px)

  if (motifIndex === 0) {
    // 0: 8-petal Persian lotus rosette + corner calyx leaves
    const petals = 0.28 + 0.085 * Math.cos(ang * 8 + seedPhase) + 0.03 * Math.cos(ang * 16)
    const outer = 1 - smoothstep(petals - 0.035, petals + 0.035, r)
    const inner = 1 - smoothstep(0.11, 0.15, r)
    const core = 1 - smoothstep(0.04, 0.065, r)
    const calyx =
      (1 - smoothstep(0.04, 0.075, Math.abs(ax - ay) - 0.06)) *
      smoothstep(0.24, 0.32, r) *
      (1 - smoothstep(0.42, 0.48, r))
    const outline = clamp(smoothstep(petals - 0.055, petals - 0.02, r) * outer + calyx * 0.5, 0, 1)
    return [clamp(outer + calyx, 0, 1), clamp(inner - core * 0.8 + calyx * 0.7, 0, 1), outline]
  }

  if (motifIndex === 1) {
    // 1: Boteh (Persian paisley droplet with hooked apex & internal floral heart)
    const bend = (py + 0.18) * 1.15
    const bx = px - 0.16 * bend * bend
    const by = py * 1.15 + 0.04
    const widthAtY = 0.27 * Math.sqrt(clamp(1 - clamp((by + 0.36) / 0.76, 0, 1), 0.02, 1)) * smoothstep(-0.42, -0.18, by)
    const dBody = Math.hypot(bx, Math.max(0, Math.abs(by) - 0.22) * 0.8) - widthAtY
    const body = 1 - smoothstep(-0.025, 0.025, dBody)
    const innerRing = (1 - smoothstep(-0.08, -0.04, dBody)) * body
    const floralDots = smoothstep(0.25, 0.75, Math.cos(bx * 26) * Math.cos(by * 26)) * (1 - innerRing) * body
    const outline = smoothstep(-0.05, -0.01, dBody) * body
    return [body, clamp(innerRing * 0.65 + floralDots * 0.75, 0, 1), outline]
  }

  if (motifIndex === 2) {
    // 2: Turkmen octagonal elephant-foot Gul with quartered interior & stepped latches
    const oct = Math.max(ax * 0.92 + ay * 0.38, ay * 0.92 + ax * 0.38, Math.max(ax, ay) * 0.88)
    const stepLatches = 0.035 * Math.cos(Math.floor(ax * 12) * 1.57) * Math.cos(Math.floor(ay * 12) * 1.57)
    const outer = 1 - smoothstep(0.34, 0.38, oct + stepLatches)
    const mid = 1 - smoothstep(0.21, 0.25, oct)
    const cross = 1 - smoothstep(0.032, 0.055, Math.min(ax, ay))
    const quarter = px * py > 0 ? 1 : 0.25
    const centerDiamond = 1 - smoothstep(0.09, 0.12, ax + ay)
    const accent = clamp((mid * quarter * (1 - cross) + centerDiamond) * outer, 0, 1)
    const outline = clamp(smoothstep(0.3, 0.35, oct + stepLatches) * outer + cross * outer, 0, 1)
    return [outer, accent, outline]
  }

  if (motifIndex === 3) {
    // 3: Herati (diamond lattice frame + central rosette + 4 curving acanthus "fish" leaves)
    const diamond = Math.abs(ax + ay - 0.36)
    const lattice = 1 - smoothstep(0.025, 0.055, diamond)
    const centerRosette = 1 - smoothstep(0.11 + 0.025 * Math.cos(ang * 6), 0.145 + 0.025 * Math.cos(ang * 6), r)
    const leafDist = Math.abs(Math.hypot(ax - 0.22, ay - 0.22) - 0.14)
    const fishLeaves = (1 - smoothstep(0.022, 0.05, leafDist)) * smoothstep(0.16, 0.22, Math.max(ax, ay))
    const primary = clamp(lattice + centerRosette + fishLeaves, 0, 1)
    const accent = clamp(centerRosette * (1 - smoothstep(0.04, 0.07, r)) + fishLeaves * 0.85, 0, 1)
    const outline = clamp(lattice * 0.85 + smoothstep(0.09, 0.13, r) * centerRosette, 0, 1)
    return [primary, accent, outline]
  }

  // 4: Continuous arabesque vine scroll with alternating palmettes
  const wave = Math.sin(px * Math.PI * 2) * 0.18
  const vine = 1 - smoothstep(0.025, 0.055, Math.abs(py - wave))
  const sideSign = Math.cos(px * Math.PI * 2) >= 0 ? 1 : -1
  const palmetteCenterY = wave + sideSign * 0.14
  const dp = Math.hypot((fract(px + 0.25) - 0.5) * 1.3, py - palmetteCenterY)
  const palmette = 1 - smoothstep(0.12, 0.16, dp - 0.03 * Math.cos(ang * 5))
  const bud = 1 - smoothstep(0.05, 0.08, dp)
  return [clamp(vine + palmette, 0, 1), clamp(bud + vine * 0.35, 0, 1), clamp(vine + smoothstep(0.1, 0.15, dp) * palmette, 0, 1)]
}

/**
 * Evaluates a single texel `(u, v)` in `[0, 1]^2` of a procedural rug on the CPU.
 * Returns `{ r, g, b, a }` in `[0..255]` where RGB are sRGB bytes and A is linear pile height / alpha `[0..255]`.
 */
export function evaluateRugTexelCpu(
  u: number,
  v: number,
  params: RugParams,
): { r: number; g: number; b: number; a: number } {
  const pal = RUG_PALETTES[params.palette]
  const styleIdx = RUG_STYLE_DEFS[params.style].index
  const motifIdx = resolveMotifIndex(params.motif, params.style, params.seed)
  const seedF = (params.seed % 997) * 0.173
  const aspect = clamp(params.aspect, 0.5, 3.5)
  const fringe = styleIdx === 4 ? 0 : clamp(params.fringeLength, 0, 0.08)

  // 1. Check short-end fringes (v < fringe or v > 1 - fringe)
  if (fringe > 0.002 && (v < fringe || v > 1 - fringe)) {
    const endDist = v < fringe ? (fringe - v) / fringe : (v - (1 - fringe)) / fringe
    const sideMargin = Math.min(u, 1 - u)
    if (sideMargin < 0.025) {
      return { r: 22, g: 18, b: 14, a: 18 }
    }
    const strandFreq = 92 * Math.sqrt(params.knotDensity)
    const strandWave = (noise2(u * strandFreq * 0.35 + seedF, endDist * 4.5) - 0.5) * 0.35
    const strandCoord = u * strandFreq + strandWave
    const strandId = Math.floor(strandCoord)
    const strandF = fract(strandCoord)
    const strandLen = 0.62 + 0.36 * hash2(strandId, seedF + (v < 0.5 ? 1.1 : 7.3))
    const inStrand = endDist < strandLen && Math.abs(strandF - 0.5) < 0.34 * (1 - endDist * 0.35)
    if (!inStrand) {
      // Dark floor gap between warp fringe tassels
      const shadowCol = pal.foundation.map((c) => c * 0.22) as [number, number, number]
      return {
        r: Math.round(clamp(shadowCol[0], 0, 1) * 255),
        g: Math.round(clamp(shadowCol[1], 0, 1) * 255),
        b: Math.round(clamp(shadowCol[2], 0, 1) * 255),
        a: 32,
      }
    }
    const twist = 0.86 + 0.22 * Math.sin(endDist * 38 + strandId * 1.7)
    const dirt = 1 - endDist * 0.28 * params.wear
    const fCol = pal.foundation.map((c) => clamp(c * 1.18 * twist * dirt, 0.04, 0.96)) as [number, number, number]
    return {
      r: Math.round(fCol[0] * 255),
      g: Math.round(fCol[1] * 255),
      b: Math.round(fCol[2] * 255),
      a: Math.round(clamp(0.45 * (1 - endDist * 0.4), 0.1, 1) * 255),
    }
  }

  // Remap v inside the woven carpet body [fringe .. 1 - fringe] -> [0 .. 1]
  const vBody = clamp((v - fringe) / Math.max(0.1, 1 - 2 * fringe), 0, 1)
  const uBody = clamp(u, 0, 1)

  // Knot-grid quantization with symmetric folding and slight hand-knotted row/column irregularity
  const knotsX = Math.round(180 * params.knotDensity)
  const knotsY = Math.round(180 * params.knotDensity * aspect)
  const symU = Math.abs(uBody - 0.5)
  const symV = params.symmetry === 4 ? Math.abs(vBody - 0.5) : vBody
  const jitterX = (noise2(symU * 18 + seedF, symV * 18) - 0.5) * 0.32
  const jitterY = (noise2(symU * 18 + 9.2, symV * 18 + seedF) - 0.5) * 0.32
  const ku = 0.5 + (uBody >= 0.5 ? 1 : -1) * ((Math.floor(symU * knotsX + jitterX) + 0.5) / knotsX)
  const kv =
    params.symmetry === 4
      ? 0.5 + (vBody >= 0.5 ? 1 : -1) * ((Math.floor(symV * knotsY + jitterY) + 0.5) / knotsY)
      : (Math.floor(vBody * knotsY + jitterY) + 0.5) / knotsY
  const knotCellU = fract(symU * knotsX + jitterX)
  const knotCellV = fract(symV * knotsY + jitterY)
  const knotBump = (1 - 0.45 * Math.hypot(knotCellU - 0.5, knotCellV - 0.5)) * (0.92 + 0.16 * hash2(Math.floor(symU * knotsX), Math.floor(symV * knotsY)))

  // Symmetric folded coordinates (4-fold or 2-fold)
  const su = Math.abs(ku - 0.5) * 2 // 0 at center, 1 at left/right edge
  const sv = params.symmetry === 4 ? Math.abs(kv - 0.5) * 2 : kv * 2 - 1 // 0..1 for 4-fold, -1..1 for 2-fold
  const absSv = Math.abs(kv - 0.5) * 2 // 0 at center, 1 at top/bottom edge

  // Aspect-corrected metric distances from center and from edges
  const dxEdge = (1 - su) * 0.5
  const dyEdge = (1 - absSv) * 0.5 * aspect
  const edgeDist = Math.min(dxEdge, dyEdge)
  const bw = clamp(params.borderWidth, 0.12, 0.38) * 0.5

  let col: [number, number, number] = [...pal.field]
  let pile = 0.82

  if (styleIdx === 4) {
    // --- Style 4: Braided Oval ---
    const rx = (ku - 0.5) * 2
    const ry = (kv - 0.5) * 2
    const ovalR = Math.hypot(rx, ry * (0.92 + 0.08 / Math.max(0.8, aspect)))
    if (ovalR > 0.985) {
      return { r: 24, g: 20, b: 16, a: 16 }
    }
    const braidFreq = 26 * params.motifScale
    const braidIdx = Math.floor(ovalR * braidFreq)
    const braidFrac = fract(ovalR * braidFreq)
    const ang = Math.atan2(ry * aspect, rx)
    const stitch = Math.sin(ang * (18 + braidIdx * 4) + (braidIdx & 1 ? 1 : -1) * braidFrac * 3.14)
    const bandChoice = (braidIdx + Math.floor(hash2(braidIdx, seedF) * 3)) % 5
    const bandBase =
      bandChoice === 0
        ? pal.field
        : bandChoice === 1
          ? pal.medallion
          : bandChoice === 2
            ? pal.borderMain
            : bandChoice === 3
              ? pal.borderGuard
              : pal.accent
    const groove = smoothstep(0.0, 0.18, Math.min(braidFrac, 1 - braidFrac))
    const shade = (0.76 + 0.24 * groove) * (0.9 + 0.12 * stitch)
    col = [bandBase[0] * shade, bandBase[1] * shade, bandBase[2] * shade]
    pile = 0.65 + 0.3 * groove
  } else if (styleIdx === 5) {
    // --- Style 5: 70s Shag & Moroccan Beni Ourain Trellis ---
    const isBorder = edgeDist < bw * 0.55
    col = [...pal.borderGuard]
    const tx = su * 3.2 * params.motifScale
    const ty = (kv - 0.5) * 3.2 * aspect * params.motifScale
    const warp = (fbm2(ku * 4 + seedF, kv * 4 * aspect) - 0.5) * 0.22
    const dLine = Math.min(Math.abs(fract(tx + ty + warp) - 0.5), Math.abs(fract(tx - ty + warp) - 0.5))
    const trellis = 1 - smoothstep(0.045, 0.095, dLine)
    const centerDiamond = 1 - smoothstep(0.28, 0.34, (su + absSv * 0.85) / Math.max(0.4, params.medallionScale))
    col = mix3(col, pal.field, trellis)
    col = mix3(col, pal.medallion, centerDiamond * (1 - trellis * 0.7))
    if (isBorder) {
      const bStripe = smoothstep(0.2, 0.8, Math.sin((edgeDist / Math.max(0.01, bw * 0.55)) * Math.PI * 3))
      col = mix3(pal.field, pal.accent, bStripe)
    }
    const tuftNoise = fbm2(uBody * 42 + seedF, vBody * 42 * aspect)
    col = [col[0] * (0.82 + 0.34 * tuftNoise), col[1] * (0.82 + 0.34 * tuftNoise), col[2] * (0.82 + 0.34 * tuftNoise)]
    pile = 0.55 + 0.45 * tuftNoise
  } else {
    // --- Styles 0, 1, 2, 3: Framed Border + Field + Medallion/Spandrel Architecture ---
    const outerSelvedge = bw * 0.12
    const outerGuardHi = bw * 0.3
    const mainBorderHi = bw * 0.78
    const innerGuardHi = bw * 0.95

    if (edgeDist < outerSelvedge) {
      // Dark overcast selvedge cord binding
      col = [pal.medallion[0] * 0.65, pal.medallion[1] * 0.65, pal.medallion[2] * 0.65]
      pile = 0.62
    } else if (edgeDist < outerGuardHi || (edgeDist >= mainBorderHi && edgeDist < innerGuardHi)) {
      // Minor guard border with reciprocal running-dog / meander / diamond ribbon
      const inOuter = edgeDist < outerGuardHi
      const gu = inOuter
        ? (edgeDist - outerSelvedge) / Math.max(0.005, outerGuardHi - outerSelvedge)
        : (edgeDist - mainBorderHi) / Math.max(0.005, innerGuardHi - mainBorderHi)
      const along = (dxEdge < dyEdge ? kv * aspect : ku) * 28 * params.motifScale
      const ribbon = Math.sin(along * Math.PI + (gu - 0.5) * 4.2) > 0 ? 1 : 0
      const frameLine = Math.min(gu, 1 - gu) < 0.16 ? 1 : 0
      col = mix3(pal.borderGuard, pal.medallion, ribbon * 0.75)
      if (frameLine) col = [...pal.accent]
      pile = 0.76
    } else if (edgeDist < mainBorderHi) {
      // Wide Main Border with repeating traditional motifs (rosette, boteh, gul, herati, vine_scroll)
      const mu = (edgeDist - outerGuardHi) / Math.max(0.01, mainBorderHi - outerGuardHi) - 0.5
      const bandWidth = mainBorderHi - outerGuardHi
      const alongCoord = dxEdge < dyEdge ? kv * aspect : ku
      const cellCount = Math.max(4, Math.round((1 / Math.max(0.04, bandWidth)) * 0.95 * params.motifScale))
      const cellPos = alongCoord * cellCount
      const cellIdx = Math.floor(cellPos)
      const mv = fract(cellPos) - 0.5
      // Alternate motif orientation or secondary floral bud on odd cells
      const flip = (cellIdx & 1) === 1 ? -1 : 1
      const [mPrim, mAcc, mOut] = evalRugMotifCpu(motifIdx, mv * flip, mu * 0.95, seedF + (cellIdx & 1) * 1.57)
      col = [...pal.borderMain]
      col = mix3(col, pal.borderGuard, mPrim)
      col = mix3(col, pal.accent, mAcc)
      col = mix3(col, pal.medallion, mOut * 0.65)
      pile = 0.8 + 0.12 * mPrim
    } else if (edgeDist < bw) {
      // Crisp inner field frame line
      col = [...pal.accent]
      pile = 0.74
    } else {
      // --- Interior Field (`edgeDist >= bw`) ---
      const fx = su / Math.max(0.1, 1 - 2 * bw) // 0 at center, 1 at inner border X
      const fy = (absSv * 0.5 * aspect) / Math.max(0.1, 0.5 * aspect - bw) // 0 at center, 1 at inner border Y
      const mScale = clamp(params.medallionScale, 0.25, 1.6)

      if (styleIdx === 1) {
        // Style 1: Turkmen Bokhara repeating octagonal Gul grid + secondary chemche diamonds
        col = [...pal.field]
        const cols = 2
        const rows = Math.max(2, Math.round(2 * aspect * params.motifScale))
        const gx = fract(fx * cols * 0.5) - 0.5
        const gy = fract(((kv - 0.5) * rows) / Math.max(0.5, aspect) + 0.5) - 0.5
        const [gPrim, gAcc, gOut] = evalRugMotifCpu(2, gx * 1.15, gy * 1.15, seedF)
        // Secondary cruciform chemche at cell corners
        const cx = fract(fx * cols * 0.5 + 0.5) - 0.5
        const cy = fract(((kv - 0.5) * rows) / Math.max(0.5, aspect)) - 0.5
        const chemche = 1 - smoothstep(0.14, 0.19, Math.abs(cx) + Math.abs(cy))
        col = mix3(col, pal.borderGuard, gPrim)
        col = mix3(col, pal.accent, gAcc)
        col = mix3(col, pal.medallion, clamp(gOut + chemche * 0.85, 0, 1))
        pile = 0.84 + 0.1 * gPrim
      } else if (styleIdx === 2) {
        // Style 2: Anatolian Kilim stepped geometric diamonds & latch hooks
        col = [...pal.field]
        const stepQuant = 24
        const qx = Math.floor(fx * stepQuant) / stepQuant
        const qy = Math.floor(fy * stepQuant) / stepQuant
        // Prayer arch (mihrab) when symmetry == 2
        const archShift = params.symmetry === 2 && sv < 0 ? Math.abs(sv) * 0.28 : 0
        const d1 = (qx + qy * 0.78 - archShift) / mScale
        const d2 = Math.abs(qx - (1 - qy) * 0.65)
        const hook = Math.sin(qx * 36) * Math.sin(qy * 36) > 0.2 ? 0.04 : 0
        if (d1 < 0.32 + hook) {
          col = d1 < 0.14 ? [...pal.accent] : [...pal.medallion]
        } else if (d1 < 0.62 + hook) {
          col = d1 < 0.48 ? [...pal.borderGuard] : [...pal.borderMain]
        } else if (d2 < 0.12) {
          col = [...pal.accent]
        }
        // Central ram's-horn / star motif inside each stepped diamond
        const [kPrim, kAcc] = evalRugMotifCpu(motifIdx, (fract(fx * 2.5) - 0.5), (fract(fy * 2.5) - 0.5), seedF)
        col = mix3(col, pal.borderGuard, kPrim * 0.55)
        col = mix3(col, pal.accent, kAcc * 0.7)
        pile = 0.68
      } else if (styleIdx === 3) {
        // Style 3: Art Deco stepped ziggurat spandrels & sunburst lines
        col = [...pal.field]
        const zigCorner = Math.max(Math.floor(fx * 8) / 8 + Math.floor(fy * 8) / 8 - 1.15, 0)
        const sunAng = Math.atan2(fy, fx)
        const sunRay = smoothstep(0.65, 0.92, Math.cos(sunAng * 12)) * smoothstep(0.18, 0.75, Math.hypot(fx, fy))
        const centerOct = Math.max(fx, fy, (fx + fy) * 0.72) / mScale
        if (zigCorner > 0.05) {
          col = zigCorner > 0.28 ? [...pal.accent] : [...pal.medallion]
        } else if (centerOct < 0.44) {
          col = centerOct < 0.36 ? [...pal.medallion] : [...pal.accent]
          if (centerOct < 0.18) col = [...pal.borderGuard]
        } else {
          col = mix3(col, pal.accent, sunRay * 0.48)
        }
        pile = 0.88
      } else {
        // Style 0: Classic Persian Medallion + Pendant Palmettes + Corner Spandrels + Herati Field Lattice
        col = [...pal.field]
        // Fine Herati / vine scroll field lattice
        const fieldFreq = 4.5 * params.motifScale
        const lcx = fract(fx * fieldFreq) - 0.5
        const lcy = fract(fy * fieldFreq) - 0.5
        const [fPrim, fAcc, fOut] = evalRugMotifCpu(3, lcx, lcy, seedF)
        col = mix3(col, pal.borderMain, fPrim * 0.46)
        col = mix3(col, pal.accent, fAcc * 0.58)
        col = mix3(col, pal.borderGuard, fOut * 0.34)

        // Quarter-medallion Corner Spandrels at (fx -> 1, fy -> 1)
        const cx = (1 - fx) / mScale
        const cy = (1 - fy) / mScale
        const cAng = Math.atan2(cy, cx)
        const cRad = Math.hypot(cx, cy) + 0.045 * Math.cos(cAng * 10)
        if (cRad < 0.54) {
          const spBorder = cRad > 0.47
          col = spBorder ? [...pal.accent] : [...pal.borderGuard]
          if (!spBorder) {
            col = mix3(col, pal.medallion, fPrim * 0.65)
            col = mix3(col, pal.field, fAcc * 0.55)
          }
        }

        // Central Scalloped Star / Lobed Medallion + Longitudinal Pendant Palmettes
        const mx = fx / mScale
        const my = (fy * 0.82) / mScale
        const mAng = Math.atan2(my, mx)
        const mRad = Math.hypot(mx, my)
        const lobes = 0.48 + 0.075 * Math.cos(mAng * 8) + 0.035 * Math.cos(mAng * 16)
        // Axial pendant along Y (top/bottom of medallion)
        const pendantY = Math.hypot(mx * 2.2, (my - 0.62) * 1.6)
        const inPendant = pendantY < 0.19 + 0.03 * Math.cos(Math.atan2(my - 0.62, mx) * 6)

        if (mRad < lobes || inPendant) {
          const inOuterRim = (mRad > lobes - 0.055 && !inPendant) || (inPendant && pendantY > 0.14)
          const inInnerStar = mRad < 0.24 + 0.04 * Math.cos(mAng * 8)
          const inCenterRosette = mRad < 0.095 + 0.018 * Math.cos(mAng * 8)
          if (inOuterRim) {
            col = [...pal.borderGuard]
          } else if (inCenterRosette) {
            col = [...pal.accent]
          } else if (inInnerStar) {
            col = mix3(pal.borderGuard, pal.field, fPrim * 0.7)
          } else {
            col = mix3(pal.medallion, pal.accent, fPrim * 0.55)
            col = mix3(col, pal.borderGuard, fAcc * 0.65)
          }
          pile = 0.88 + 0.08 * (inOuterRim ? -1 : 1)
        }
      }
    }
  }

  // 2. Horizontal Abrash (natural hand-spun dye-lot banding along weft kv)
  if (params.abrash > 0.005) {
    const abWave =
      (noise2(0.7, kv * 14 * aspect + seedF) - 0.5) * 0.55 +
      (noise2(2.3, kv * 36 * aspect + seedF * 1.7) - 0.5) * 0.45
    const abShift = 1 + abWave * 0.34 * params.abrash
    col = [col[0] * abShift, col[1] * (1 + abWave * 0.26 * params.abrash), col[2] * (1 + abWave * 0.18 * params.abrash)]
  }

  // 3. Knot-grid micro-texture modulation
  col = [col[0] * knotBump, col[1] * knotBump, col[2] * knotBump]

  // 4. Threadbare traffic wear & sun-fade patches exposing the pale warp/weft foundation grid
  if (params.wear > 0.005) {
    const wNoise = fbm2(uBody * 3.8 + seedF * 0.7, vBody * 3.8 * aspect + 4.1)
    const centerTraffic = Math.exp(-((uBody - 0.5) * (uBody - 0.5) * 3.5 + (vBody - 0.5) * (vBody - 0.5) * 2.5))
    const wearMask = smoothstep(0.48 - params.wear * 0.28, 0.78 - params.wear * 0.18, wNoise * 0.72 + centerTraffic * 0.38) * params.wear
    const foundationGrid =
      0.86 + 0.24 * Math.sin(uBody * knotsX * Math.PI) * Math.sin(vBody * knotsY * Math.PI)
    const wornCol: [number, number, number] = [
      pal.foundation[0] * foundationGrid,
      pal.foundation[1] * foundationGrid,
      pal.foundation[2] * foundationGrid,
    ]
    col = mix3(col, wornCol, wearMask * 0.78)
    pile *= 1 - wearMask * 0.52
  }

  // Soft 3D woven border edge bevel around the outer perimeter
  const edgeBevel = smoothstep(0.0, 0.018, edgeDist)
  col = [
    clamp(col[0] * (0.72 + 0.28 * edgeBevel), 0.01, 0.98),
    clamp(col[1] * (0.72 + 0.28 * edgeBevel), 0.01, 0.98),
    clamp(col[2] * (0.72 + 0.28 * edgeBevel), 0.01, 0.98),
  ]
  const finalAlpha = clamp(pile * clamp(params.pileHeight, 0.2, 1.5) * 0.78 * edgeBevel, 0.08, 1.0)

  return {
    r: Math.round(col[0] * 255),
    g: Math.round(col[1] * 255),
    b: Math.round(col[2] * 255),
    a: Math.round(finalAlpha * 255),
  }
}

/**
 * Bakes a single `width × height` RGBA8 rug image on the CPU.
 */
export function bakeRugRgbaCpu(params: RugParams, width = 256, height = width): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(width * height * 4))
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const px = evaluateRugTexelCpu(u, v, params)
      const idx = (y * width + x) * 4
      out[idx + 0] = px.r
      out[idx + 1] = px.g
      out[idx + 2] = px.b
      out[idx + 3] = px.a
    }
  }
  return out
}

/**
 * Bakes a rug texture and its full linear-light mipmap chain on the CPU.
 */
export function bakeRugWithMipsCpu(params: RugParams, size = 256): MipLevelData[] {
  const mip0 = bakeRugRgbaCpu(params, size, size)
  return buildLinearMipChain(mip0, size, size)
}

/**
 * Derives a tangent-space normal `(nx, ny, nz)` from the baked pile height in channel A.
 */
export function deriveRugPileNormalCpu(
  rgba: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  strength = 2.2,
): [number, number, number] {
  const xm = Math.max(0, x - 1)
  const xp = Math.min(width - 1, x + 1)
  const ym = Math.max(0, y - 1)
  const yp = Math.min(height - 1, y + 1)
  const hL = rgba[(y * width + xm) * 4 + 3]! / 255
  const hR = rgba[(y * width + xp) * 4 + 3]! / 255
  const hU = rgba[(ym * width + x) * 4 + 3]! / 255
  const hD = rgba[(yp * width + x) * 4 + 3]! / 255
  const dx = (hL - hR) * strength
  const dz = (hU - hD) * strength
  const inv = 1 / Math.hypot(dx, 1, dz)
  return [dx * inv, inv, dz * inv]
}

// --- High-Resolution GPU Compute Baker (1024-2048 px per rug + linear-light mip chain in < 0.5 ms) ---

export const RUG_ARRAY_SIZE = 1024
export const RUG_ARRAY_LAYERS = 8

export const RugBakeUniformsStruct = wgslStruct("RugBakeUniforms", {
  // x: size, y: styleIdx, z: motifIdx, w: symmetry
  meta: "vec4f",
  // x: aspect, y: borderWidth, z: medallionScale, w: motifScale
  shape: "vec4f",
  // x: knotDensity, y: abrash, z: wear, w: fringeLength
  weave: "vec4f",
  // x: pileHeight, y: seedF, z: reserved, w: reserved
  extra: "vec4f",
  field: "vec4f",
  medallion: "vec4f",
  borderMain: "vec4f",
  borderGuard: "vec4f",
  accent: "vec4f",
  foundation: "vec4f",
})

export function packRugBakeUniforms(
  params: RugParams,
  size: number,
  out: Float32Array<ArrayBuffer> = RugBakeUniformsStruct.createBuffer() as Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
  const pal = RUG_PALETTES[params.palette]
  const styleIdx = RUG_STYLE_DEFS[params.style].index
  const motifIdx = resolveMotifIndex(params.motif, params.style, params.seed)
  const seedF = (params.seed % 997) * 0.173
  return RugBakeUniformsStruct.pack(
    {
      meta: [size, styleIdx, motifIdx, params.symmetry],
      shape: [params.aspect, params.borderWidth, params.medallionScale, params.motifScale],
      weave: [params.knotDensity, params.abrash, params.wear, params.style === "braided_oval" ? 0 : params.fringeLength],
      extra: [params.pileHeight, seedF, 0, 0],
      field: [...pal.field, 1],
      medallion: [...pal.medallion, 1],
      borderMain: [...pal.borderMain, 1],
      borderGuard: [...pal.borderGuard, 1],
      accent: [...pal.accent, 1],
      foundation: [...pal.foundation, 1],
    },
    out,
  )
}

export const rugBakeComputeWgsl = /* wgsl */ `
${RugBakeUniformsStruct.wgsl}

@group(0) @binding(0) var<uniform> R: RugBakeUniforms;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;

fn rHash2(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}

fn rNoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = rHash2(i);
  let b = rHash2(i + vec2f(1.0, 0.0));
  let c = rHash2(i + vec2f(0.0, 1.0));
  let d = rHash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn rFbm2(p: vec2f) -> f32 {
  return rNoise2(p) * 0.55 + rNoise2(p * 2.07 + vec2f(5.3, 2.9)) * 0.30 + rNoise2(p * 4.19 + vec2f(1.7, 8.3)) * 0.15;
}

fn evalRugMotif(motifIdx: i32, px: f32, py: f32, seedPhase: f32) -> vec3f {
  let ax = abs(px);
  let ay = abs(py);
  let r = length(vec2f(px, py));
  let ang = atan2(py, px);

  if (motifIdx == 0) {
    let petals = 0.28 + 0.085 * cos(ang * 8.0 + seedPhase) + 0.03 * cos(ang * 16.0);
    let outer = 1.0 - smoothstep(petals - 0.035, petals + 0.035, r);
    let inner = 1.0 - smoothstep(0.11, 0.15, r);
    let core = 1.0 - smoothstep(0.04, 0.065, r);
    let calyx = (1.0 - smoothstep(0.04, 0.075, abs(ax - ay) - 0.06)) * smoothstep(0.24, 0.32, r) * (1.0 - smoothstep(0.42, 0.48, r));
    let outline = clamp(smoothstep(petals - 0.055, petals - 0.02, r) * outer + calyx * 0.5, 0.0, 1.0);
    return vec3f(clamp(outer + calyx, 0.0, 1.0), clamp(inner - core * 0.8 + calyx * 0.7, 0.0, 1.0), outline);
  }
  if (motifIdx == 1) {
    let bend = (py + 0.18) * 1.15;
    let bx = px - 0.16 * bend * bend;
    let by = py * 1.15 + 0.04;
    let widthAtY = 0.27 * sqrt(clamp(1.0 - clamp((by + 0.36) / 0.76, 0.0, 1.0), 0.02, 1.0)) * smoothstep(-0.42, -0.18, by);
    let dBody = length(vec2f(bx, max(0.0, abs(by) - 0.22) * 0.8)) - widthAtY;
    let body = 1.0 - smoothstep(-0.025, 0.025, dBody);
    let innerRing = (1.0 - smoothstep(-0.08, -0.04, dBody)) * body;
    let floralDots = smoothstep(0.25, 0.75, cos(bx * 26.0) * cos(by * 26.0)) * (1.0 - innerRing) * body;
    let outline = smoothstep(-0.05, -0.01, dBody) * body;
    return vec3f(body, clamp(innerRing * 0.65 + floralDots * 0.75, 0.0, 1.0), outline);
  }
  if (motifIdx == 2) {
    let oct = max(max(ax * 0.92 + ay * 0.38, ay * 0.92 + ax * 0.38), max(ax, ay) * 0.88);
    let stepLatches = 0.035 * cos(floor(ax * 12.0) * 1.57) * cos(floor(ay * 12.0) * 1.57);
    let outer = 1.0 - smoothstep(0.34, 0.38, oct + stepLatches);
    let mid = 1.0 - smoothstep(0.21, 0.25, oct);
    let cross = 1.0 - smoothstep(0.032, 0.055, min(ax, ay));
    let quarter = select(0.25, 1.0, px * py > 0.0);
    let centerDiamond = 1.0 - smoothstep(0.09, 0.12, ax + ay);
    let accent = clamp((mid * quarter * (1.0 - cross) + centerDiamond) * outer, 0.0, 1.0);
    let outline = clamp(smoothstep(0.30, 0.35, oct + stepLatches) * outer + cross * outer, 0.0, 1.0);
    return vec3f(outer, accent, outline);
  }
  if (motifIdx == 3) {
    let diamond = abs(ax + ay - 0.36);
    let lattice = 1.0 - smoothstep(0.025, 0.055, diamond);
    let centerRosette = 1.0 - smoothstep(0.11 + 0.025 * cos(ang * 6.0), 0.145 + 0.025 * cos(ang * 6.0), r);
    let leafDist = abs(length(vec2f(ax - 0.22, ay - 0.22)) - 0.14);
    let fishLeaves = (1.0 - smoothstep(0.022, 0.05, leafDist)) * smoothstep(0.16, 0.22, max(ax, ay));
    let primary = clamp(lattice + centerRosette + fishLeaves, 0.0, 1.0);
    let accent = clamp(centerRosette * (1.0 - smoothstep(0.04, 0.07, r)) + fishLeaves * 0.85, 0.0, 1.0);
    let outline = clamp(lattice * 0.85 + smoothstep(0.09, 0.13, r) * centerRosette, 0.0, 1.0);
    return vec3f(primary, accent, outline);
  }
  let wave = sin(px * 6.2831853) * 0.18;
  let vine = 1.0 - smoothstep(0.025, 0.055, abs(py - wave));
  let sideSign = select(-1.0, 1.0, cos(px * 6.2831853) >= 0.0);
  let palmetteCenterY = wave + sideSign * 0.14;
  let dp = length(vec2f((fract(px + 0.25) - 0.5) * 1.3, py - palmetteCenterY));
  let palmette = 1.0 - smoothstep(0.12, 0.16, dp - 0.03 * cos(ang * 5.0));
  let bud = 1.0 - smoothstep(0.05, 0.08, dp);
  return vec3f(clamp(vine + palmette, 0.0, 1.0), clamp(bud + vine * 0.35, 0.0, 1.0), clamp(vine + smoothstep(0.10, 0.15, dp) * palmette, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = u32(R.meta.x);
  if (gid.x >= size || gid.y >= size) { return; }
  let u = (f32(gid.x) + 0.5) / R.meta.x;
  let v = (f32(gid.y) + 0.5) / R.meta.x;

  let styleIdx = i32(round(R.meta.y));
  let motifIdx = i32(round(R.meta.z));
  let symmetry = i32(round(R.meta.w));
  let aspect = clamp(R.shape.x, 0.5, 3.5);
  let borderWidth = R.shape.y;
  let medallionScale = R.shape.z;
  let motifScale = R.shape.w;
  let knotDensity = R.weave.x;
  let abrash = R.weave.y;
  let wear = R.weave.z;
  let fringe = R.weave.w;
  let pileHeight = R.extra.x;
  let seedF = R.extra.y;

  let palField = R.field.rgb;
  let palMed = R.medallion.rgb;
  let palMain = R.borderMain.rgb;
  let palGuard = R.borderGuard.rgb;
  let palAcc = R.accent.rgb;
  let palFound = R.foundation.rgb;

  if (fringe > 0.002 && (v < fringe || v > 1.0 - fringe)) {
    let endDist = select((v - (1.0 - fringe)) / fringe, (fringe - v) / fringe, v < fringe);
    if (min(u, 1.0 - u) < 0.025) {
      textureStore(outTex, vec2i(gid.xy), vec4f(0.086, 0.07, 0.055, 0.07));
      return;
    }
    let strandFreq = 92.0 * sqrt(knotDensity);
    let strandWave = (rNoise2(vec2f(u * strandFreq * 0.35 + seedF, endDist * 4.5)) - 0.5) * 0.35;
    let strandCoord = u * strandFreq + strandWave;
    let strandId = floor(strandCoord);
    let strandF = fract(strandCoord);
    let strandLen = 0.62 + 0.36 * rHash2(vec2f(strandId, seedF + select(7.3, 1.1, v < 0.5)));
    let inStrand = endDist < strandLen && abs(strandF - 0.5) < 0.34 * (1.0 - endDist * 0.35);
    if (!inStrand) {
      textureStore(outTex, vec2i(gid.xy), vec4f(palFound * 0.22, 0.125));
      return;
    }
    let twist = 0.86 + 0.22 * sin(endDist * 38.0 + strandId * 1.7);
    let dirt = 1.0 - endDist * 0.28 * wear;
    let fCol = clamp(palFound * 1.18 * twist * dirt, vec3f(0.04), vec3f(0.96));
    textureStore(outTex, vec2i(gid.xy), vec4f(fCol, clamp(0.45 * (1.0 - endDist * 0.4), 0.1, 1.0)));
    return;
  }

  let vBody = clamp((v - fringe) / max(0.1, 1.0 - 2.0 * fringe), 0.0, 1.0);
  let uBody = clamp(u, 0.0, 1.0);

  let knotsX = round(180.0 * knotDensity);
  let knotsY = round(180.0 * knotDensity * aspect);
  let symU = abs(uBody - 0.5);
  let symV = select(vBody, abs(vBody - 0.5), symmetry == 4);
  let jitterX = (rNoise2(vec2f(symU * 18.0 + seedF, symV * 18.0)) - 0.5) * 0.32;
  let jitterY = (rNoise2(vec2f(symU * 18.0 + 9.2, symV * 18.0 + seedF)) - 0.5) * 0.32;
  let ku = 0.5 + select(-1.0, 1.0, uBody >= 0.5) * ((floor(symU * knotsX + jitterX) + 0.5) / knotsX);
  let kv = select(
    (floor(vBody * knotsY + jitterY) + 0.5) / knotsY,
    0.5 + select(-1.0, 1.0, vBody >= 0.5) * ((floor(symV * knotsY + jitterY) + 0.5) / knotsY),
    symmetry == 4
  );
  let knotCell = vec2f(fract(symU * knotsX + jitterX), fract(symV * knotsY + jitterY));
  let knotBump = (1.0 - 0.45 * length(knotCell - 0.5)) * (0.92 + 0.16 * rHash2(vec2f(floor(symU * knotsX), floor(symV * knotsY))));

  let su = abs(ku - 0.5) * 2.0;
  let sv = select(kv * 2.0 - 1.0, abs(kv - 0.5) * 2.0, symmetry == 4);
  let absSv = abs(kv - 0.5) * 2.0;

  let dxEdge = (1.0 - su) * 0.5;
  let dyEdge = (1.0 - absSv) * 0.5 * aspect;
  let edgeDist = min(dxEdge, dyEdge);
  let bw = clamp(borderWidth, 0.12, 0.38) * 0.5;

  var col = palField;
  var pile = 0.82;

  if (styleIdx == 4) {
    let rx = (ku - 0.5) * 2.0;
    let ry = (kv - 0.5) * 2.0;
    let ovalR = length(vec2f(rx, ry * (0.92 + 0.08 / max(0.8, aspect))));
    if (ovalR > 0.985) {
      textureStore(outTex, vec2i(gid.xy), vec4f(0.09, 0.078, 0.062, 0.06));
      return;
    }
    let braidFreq = 26.0 * motifScale;
    let braidIdx = floor(ovalR * braidFreq);
    let braidFrac = fract(ovalR * braidFreq);
    let ang = atan2(ry * aspect, rx);
    let stitchDir = select(-1.0, 1.0, (i32(braidIdx) & 1) == 1);
    let stitch = sin(ang * (18.0 + braidIdx * 4.0) + stitchDir * braidFrac * 3.14159);
    let bandChoice = (i32(braidIdx) + i32(floor(rHash2(vec2f(braidIdx, seedF)) * 3.0))) % 5;
    var bandBase = palField;
    if (bandChoice == 1) { bandBase = palMed; }
    else if (bandChoice == 2) { bandBase = palMain; }
    else if (bandChoice == 3) { bandBase = palGuard; }
    else if (bandChoice == 4) { bandBase = palAcc; }
    let groove = smoothstep(0.0, 0.18, min(braidFrac, 1.0 - braidFrac));
    let shade = (0.76 + 0.24 * groove) * (0.90 + 0.12 * stitch);
    col = bandBase * shade;
    pile = 0.65 + 0.30 * groove;
  } else if (styleIdx == 5) {
    let isBorder = edgeDist < bw * 0.55;
    col = palGuard;
    let tx = su * 3.2 * motifScale;
    let ty = (kv - 0.5) * 3.2 * aspect * motifScale;
    let warp = (rFbm2(vec2f(ku * 4.0 + seedF, kv * 4.0 * aspect)) - 0.5) * 0.22;
    let dLine = min(abs(fract(tx + ty + warp) - 0.5), abs(fract(tx - ty + warp) - 0.5));
    let trellis = 1.0 - smoothstep(0.045, 0.095, dLine);
    let centerDiamond = 1.0 - smoothstep(0.28, 0.34, (su + absSv * 0.85) / max(0.4, medallionScale));
    col = mix(col, palField, trellis);
    col = mix(col, palMed, centerDiamond * (1.0 - trellis * 0.7));
    if (isBorder) {
      let bStripe = smoothstep(0.2, 0.8, sin((edgeDist / max(0.01, bw * 0.55)) * 3.14159 * 3.0));
      col = mix(palField, palAcc, bStripe);
    }
    let tuftNoise = rFbm2(vec2f(uBody * 42.0 + seedF, vBody * 42.0 * aspect));
    col *= 0.82 + 0.34 * tuftNoise;
    pile = 0.55 + 0.45 * tuftNoise;
  } else {
    let outerSelvedge = bw * 0.12;
    let outerGuardHi = bw * 0.30;
    let mainBorderHi = bw * 0.78;
    let innerGuardHi = bw * 0.95;

    if (edgeDist < outerSelvedge) {
      col = palMed * 0.65;
      pile = 0.62;
    } else if (edgeDist < outerGuardHi || (edgeDist >= mainBorderHi && edgeDist < innerGuardHi)) {
      let inOuter = edgeDist < outerGuardHi;
      let gu = select(
        (edgeDist - mainBorderHi) / max(0.005, innerGuardHi - mainBorderHi),
        (edgeDist - outerSelvedge) / max(0.005, outerGuardHi - outerSelvedge),
        inOuter
      );
      let along = select(ku, kv * aspect, dxEdge < dyEdge) * 28.0 * motifScale;
      let ribbon = select(0.0, 1.0, sin(along * 3.14159 + (gu - 0.5) * 4.2) > 0.0);
      col = mix(palGuard, palMed, ribbon * 0.75);
      if (min(gu, 1.0 - gu) < 0.16) { col = palAcc; }
      pile = 0.76;
    } else if (edgeDist < mainBorderHi) {
      let mu = (edgeDist - outerGuardHi) / max(0.01, mainBorderHi - outerGuardHi) - 0.5;
      let bandWidth = mainBorderHi - outerGuardHi;
      let alongCoord = select(ku, kv * aspect, dxEdge < dyEdge);
      let cellCount = max(4.0, round((1.0 / max(0.04, bandWidth)) * 0.95 * motifScale));
      let cellPos = alongCoord * cellCount;
      let cellIdx = i32(floor(cellPos));
      let mv = fract(cellPos) - 0.5;
      let flip = select(1.0, -1.0, (cellIdx & 1) == 1);
      let m = evalRugMotif(motifIdx, mv * flip, mu * 0.95, seedF + f32(cellIdx & 1) * 1.57);
      col = palMain;
      col = mix(col, palGuard, m.x);
      col = mix(col, palAcc, m.y);
      col = mix(col, palMed, m.z * 0.65);
      pile = 0.80 + 0.12 * m.x;
    } else if (edgeDist < bw) {
      col = palAcc;
      pile = 0.74;
    } else {
      let fx = su / max(0.1, 1.0 - 2.0 * bw);
      let fy = (absSv * 0.5 * aspect) / max(0.1, 0.5 * aspect - bw);
      let mScale = clamp(medallionScale, 0.25, 1.6);

      if (styleIdx == 1) {
        col = palField;
        let rows = max(2.0, round(2.0 * aspect * motifScale));
        let gx = fract(fx) - 0.5;
        let gy = fract(((kv - 0.5) * rows) / max(0.5, aspect) + 0.5) - 0.5;
        let g = evalRugMotif(2, gx * 1.15, gy * 1.15, seedF);
        let cx = fract(fx + 0.5) - 0.5;
        let cy = fract(((kv - 0.5) * rows) / max(0.5, aspect)) - 0.5;
        let chemche = 1.0 - smoothstep(0.14, 0.19, abs(cx) + abs(cy));
        col = mix(col, palGuard, g.x);
        col = mix(col, palAcc, g.y);
        col = mix(col, palMed, clamp(g.z + chemche * 0.85, 0.0, 1.0));
        pile = 0.84 + 0.10 * g.x;
      } else if (styleIdx == 2) {
        col = palField;
        let qx = floor(fx * 24.0) / 24.0;
        let qy = floor(fy * 24.0) / 24.0;
        let archShift = select(0.0, abs(sv) * 0.28, symmetry == 2 && sv < 0.0);
        let d1 = (qx + qy * 0.78 - archShift) / mScale;
        let d2 = abs(qx - (1.0 - qy) * 0.65);
        let hook = select(0.0, 0.04, sin(qx * 36.0) * sin(qy * 36.0) > 0.2);
        if (d1 < 0.32 + hook) {
          col = select(palMed, palAcc, d1 < 0.14);
        } else if (d1 < 0.62 + hook) {
          col = select(palMain, palGuard, d1 < 0.48);
        } else if (d2 < 0.12) {
          col = palAcc;
        }
        let k = evalRugMotif(motifIdx, fract(fx * 2.5) - 0.5, fract(fy * 2.5) - 0.5, seedF);
        col = mix(col, palGuard, k.x * 0.55);
        col = mix(col, palAcc, k.y * 0.70);
        pile = 0.68;
      } else if (styleIdx == 3) {
        col = palField;
        let zigCorner = max(floor(fx * 8.0) / 8.0 + floor(fy * 8.0) / 8.0 - 1.15, 0.0);
        let sunAng = atan2(fy, fx);
        let sunRay = smoothstep(0.65, 0.92, cos(sunAng * 12.0)) * smoothstep(0.18, 0.75, length(vec2f(fx, fy)));
        let centerOct = max(max(fx, fy), (fx + fy) * 0.72) / mScale;
        if (zigCorner > 0.05) {
          col = select(palMed, palAcc, zigCorner > 0.28);
        } else if (centerOct < 0.44) {
          col = select(palAcc, palMed, centerOct < 0.36);
          if (centerOct < 0.18) { col = palGuard; }
        } else {
          col = mix(col, palAcc, sunRay * 0.48);
        }
        pile = 0.88;
      } else {
        col = palField;
        let fieldFreq = 4.5 * motifScale;
        let f = evalRugMotif(3, fract(fx * fieldFreq) - 0.5, fract(fy * fieldFreq) - 0.5, seedF);
        col = mix(col, palMain, f.x * 0.46);
        col = mix(col, palAcc, f.y * 0.58);
        col = mix(col, palGuard, f.z * 0.34);

        let cx = (1.0 - fx) / mScale;
        let cy = (1.0 - fy) / mScale;
        let cAng = atan2(cy, cx);
        let cRad = length(vec2f(cx, cy)) + 0.045 * cos(cAng * 10.0);
        if (cRad < 0.54) {
          let spBorder = cRad > 0.47;
          col = select(palGuard, palAcc, spBorder);
          if (!spBorder) {
            col = mix(col, palMed, f.x * 0.65);
            col = mix(col, palField, f.y * 0.55);
          }
        }

        let mx = fx / mScale;
        let my = (fy * 0.82) / mScale;
        let mAng = atan2(my, mx);
        let mRad = length(vec2f(mx, my));
        let lobes = 0.48 + 0.075 * cos(mAng * 8.0) + 0.035 * cos(mAng * 16.0);
        let pendantY = length(vec2f(mx * 2.2, (my - 0.62) * 1.6));
        let inPendant = pendantY < 0.19 + 0.03 * cos(atan2(my - 0.62, mx) * 6.0);

        if (mRad < lobes || inPendant) {
          let inOuterRim = (mRad > lobes - 0.055 && !inPendant) || (inPendant && pendantY > 0.14);
          let inInnerStar = mRad < 0.24 + 0.04 * cos(mAng * 8.0);
          let inCenterRosette = mRad < 0.095 + 0.018 * cos(mAng * 8.0);
          if (inOuterRim) {
            col = palGuard;
          } else if (inCenterRosette) {
            col = palAcc;
          } else if (inInnerStar) {
            col = mix(palGuard, palField, f.x * 0.70);
          } else {
            col = mix(palMed, palAcc, f.x * 0.55);
            col = mix(col, palGuard, f.y * 0.65);
          }
          pile = 0.88 + 0.08 * select(1.0, -1.0, inOuterRim);
        }
      }
    }
  }

  if (abrash > 0.005) {
    let abWave =
      (rNoise2(vec2f(0.7, kv * 14.0 * aspect + seedF)) - 0.5) * 0.55 +
      (rNoise2(vec2f(2.3, kv * 36.0 * aspect + seedF * 1.7)) - 0.5) * 0.45;
    col *= vec3f(1.0 + abWave * 0.34 * abrash, 1.0 + abWave * 0.26 * abrash, 1.0 + abWave * 0.18 * abrash);
  }

  col *= knotBump;

  if (wear > 0.005) {
    let wNoise = rFbm2(vec2f(uBody * 3.8 + seedF * 0.7, vBody * 3.8 * aspect + 4.1));
    let centerTraffic = exp(-((uBody - 0.5) * (uBody - 0.5) * 3.5 + (vBody - 0.5) * (vBody - 0.5) * 2.5));
    let wearMask = smoothstep(0.48 - wear * 0.28, 0.78 - wear * 0.18, wNoise * 0.72 + centerTraffic * 0.38) * wear;
    let foundationGrid = 0.86 + 0.24 * sin(uBody * knotsX * 3.14159) * sin(vBody * knotsY * 3.14159);
    col = mix(col, palFound * foundationGrid, wearMask * 0.78);
    pile *= 1.0 - wearMask * 0.52;
  }

  let edgeBevel = smoothstep(0.0, 0.018, edgeDist);
  col = clamp(col * (0.72 + 0.28 * edgeBevel), vec3f(0.01), vec3f(0.98));
  let finalAlpha = clamp(pile * clamp(pileHeight, 0.2, 1.5) * 0.78 * edgeBevel, 0.08, 1.0);
  textureStore(outTex, vec2i(gid.xy), vec4f(col, finalAlpha));
}
`

const rugMipDownsampleWgsl = /* wgsl */ `
@group(0) @binding(0) var srcMip: texture_2d<f32>;
@group(0) @binding(1) var dstMip: texture_storage_2d<rgba8unorm, write>;

fn srgbToLin(c: vec3f) -> vec3f {
  return pow(max(c, vec3f(0.0)), vec3f(2.2));
}

fn linToSrgb(c: vec3f) -> vec3f {
  return pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dstDim = textureDimensions(dstMip);
  if (gid.x >= dstDim.x || gid.y >= dstDim.y) { return; }
  let p = vec2i(gid.xy) * 2;
  let c00 = textureLoad(srcMip, p, 0);
  let c10 = textureLoad(srcMip, p + vec2i(1, 0), 0);
  let c01 = textureLoad(srcMip, p + vec2i(0, 1), 0);
  let c11 = textureLoad(srcMip, p + vec2i(1, 1), 0);
  let avgLin = 0.25 * (srgbToLin(c00.rgb) + srgbToLin(c10.rgb) + srgbToLin(c01.rgb) + srgbToLin(c11.rgb));
  let avgA = 0.25 * (c00.a + c10.a + c01.a + c11.a);
  textureStore(dstMip, vec2i(gid.xy), vec4f(linToSrgb(avgLin), avgA));
}
`

/**
 * Creates a crisp anisotropic sampler (`maxAnisotropy: 8`) for top-down and 3/4 oblique rug sampling.
 */
export function createRugSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    label: "rug-anisotropic-sampler",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    maxAnisotropy: 8,
  })
}

/**
 * GPU Compute Rug Baker:
 * Owns a `size × size × layers` (`1024×1024×8` default, or `2048×2048` in Lab) `rgba8unorm` texture with
 * `viewFormats: ["rgba8unorm-srgb"]` and a full linear-light mip chain (`11` or `12` levels).
 * Bakes any layer or all 8 layers on the GPU in < 0.5 ms with zero main-thread hitch.
 */
export class RugGpuBaker {
  readonly texture: GPUTexture
  readonly srgbArrayView: GPUTextureView
  readonly mipLevelCount: number
  private readonly bakePipe: GPUComputePipeline
  private readonly mipPipe: GPUComputePipeline
  private readonly bakeLayout: GPUBindGroupLayout
  private readonly mipLayout: GPUBindGroupLayout
  private readonly uniformBuf: GPUBuffer
  private readonly uniformData = RugBakeUniformsStruct.createBuffer() as Float32Array<ArrayBuffer>
  private readonly layerSignatures: string[] = []

  constructor(
    private readonly device: GPUDevice,
    readonly size = RUG_ARRAY_SIZE,
    readonly layers = RUG_ARRAY_LAYERS,
  ) {
    this.mipLevelCount = Math.floor(Math.log2(size)) + 1
    this.texture = device.createTexture({
      label: `procedural-rug-array-${size}x${layers}`,
      size: [size, size, layers],
      mipLevelCount: this.mipLevelCount,
      format: "rgba8unorm",
      viewFormats: ["rgba8unorm-srgb"],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.srgbArrayView = this.texture.createView({
      label: "procedural-rug-srgb-array-view",
      format: "rgba8unorm-srgb",
      dimension: "2d-array",
      arrayLayerCount: layers,
    })
    this.uniformBuf = device.createBuffer({
      size: RugBakeUniformsStruct.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.bakeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d" } },
      ],
    })
    this.mipLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d" } },
      ],
    })

    this.bakePipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bakeLayout] }),
      compute: {
        module: device.createShaderModule({ code: rugBakeComputeWgsl, label: "rug-bake-compute" }),
        entryPoint: "main",
      },
    })
    this.mipPipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mipLayout] }),
      compute: {
        module: device.createShaderModule({ code: rugMipDownsampleWgsl, label: "rug-mip-downsample" }),
        entryPoint: "main",
      },
    })
  }

  /**
   * Bakes one rug layer (`0 .. layers-1`) and generates all its linear-light mip levels on the GPU.
   * Skips baking if the layer already holds the identical `RugParams` signature.
   */
  bakeLayer(layer: number, params: RugParams): boolean {
    if (layer < 0 || layer >= this.layers) return false
    const sig = JSON.stringify(params)
    if (this.layerSignatures[layer] === sig) return false
    this.layerSignatures[layer] = sig

    packRugBakeUniforms(params, this.size, this.uniformData)
    this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformData)

    const enc = this.device.createCommandEncoder({ label: `bake-rug-layer-${layer}` })
    const mip0View = this.texture.createView({
      format: "rgba8unorm",
      dimension: "2d",
      baseArrayLayer: layer,
      arrayLayerCount: 1,
      baseMipLevel: 0,
      mipLevelCount: 1,
    })
    const bakeGroup = this.device.createBindGroup({
      layout: this.bakeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: mip0View },
      ],
    })
    const pass0 = enc.beginComputePass()
    pass0.setPipeline(this.bakePipe)
    pass0.setBindGroup(0, bakeGroup)
    pass0.dispatchWorkgroups(Math.ceil(this.size / 8), Math.ceil(this.size / 8))
    pass0.end()

    for (let level = 1; level < this.mipLevelCount; level++) {
      const dim = Math.max(1, this.size >> level)
      const srcView = this.texture.createView({
        format: "rgba8unorm",
        dimension: "2d",
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      })
      const dstView = this.texture.createView({
        format: "rgba8unorm",
        dimension: "2d",
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: level,
        mipLevelCount: 1,
      })
      const mipGroup = this.device.createBindGroup({
        layout: this.mipLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: dstView },
        ],
      })
      const mp = enc.beginComputePass()
      mp.setPipeline(this.mipPipe)
      mp.setBindGroup(0, mipGroup)
      mp.dispatchWorkgroups(Math.ceil(dim / 8), Math.ceil(dim / 8))
      mp.end()
    }

    this.device.queue.submit([enc.finish()])
    return true
  }

  /**
   * Bakes all 8 procedural rug layers for a given `houseSeed` so every room & building archetype
   * can index into `rugTexArray` with zero load hitch.
   */
  bakeSeededHouseSet(houseSeed: number, overrideSlot0?: RugParams): void {
    const archetypes = ["house", "house", "house", "ranch", "cottage", "police", "church", "clinic"] as const
    for (let i = 0; i < this.layers; i++) {
      const recipe = i === 0 && overrideSlot0 ? overrideSlot0 : seededRugParamsForSlot(houseSeed, i, archetypes[i] ?? "house")
      this.bakeLayer(i, recipe)
    }
  }

  destroy(): void {
    this.texture.destroy()
    this.uniformBuf.destroy()
  }
}

export { srgbByteToLinear, linearToSrgbByte }
