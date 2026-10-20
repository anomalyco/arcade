import { blocked, SFX_BY_ID, type SfxSurface, type ZombieStep } from "@arcade/kit/audio"
import type { Rect } from "@arcade/kit/sim/geom"
import { chooseVignettes, vignetteScene } from "../../shared/discovery/vignettes"
import { BARE_ROOMS, TILED_ROOMS } from "../../shared/houses/style"
import { EXTERIOR_VEHICLE_COLLIDERS, frontageEnd, inBuildingFootprint, sightRects, SIZE, type Building, type Town } from "../../shared/map"
import { placeAmbientBlood } from "../blood/placement"
import { DEFAULT_BLOOD_SETTINGS } from "../blood/settings"
import { currentBloodStains } from "../blood/stains"
import { isResidential, planInterior } from "../interiors/plan"
import type { SoundEvent } from "./types"

/** All floor and ground surfaces a character can step on in Outbreak. */
export const FOOT_SURFACES = [
  "concrete",
  "grass",
  "wood",
  "tile",
  "carpet",
  "gravel",
  "dirt",
  "puddle",
  "metal",
  "glass",
  "blood",
] as const

export type FootSurface = (typeof FOOT_SURFACES)[number]

/** Optional live world overlays (broken bottle glass stores, spreading fight blood pools) on top of static Town geometry. */
export type SurfaceExtras = {
  readonly glass?: readonly { readonly x: number; readonly y: number }[]
  readonly blood?: readonly { readonly x: number; readonly y: number; readonly r?: number }[]
  /** When true, also includes seeded vignette glass and ambient blood pools from `town`. */
  readonly includeSeededHazards?: boolean
}

/** Cast-iron manhole centres per 96 m macro-block (`src/ground.ts`). */
export const MANHOLES: readonly (readonly [number, number])[] = [
  [33.45, 43.85],
  [43.85, 43.95],
  [44.20, 29.60],
  [56.80, 43.75],
]

/** Storm drain curb grates per 96 m macro-block (`src/ground.ts`): [x, z, halfW, halfD]. */
export const STORM_DRAINS: readonly (readonly [number, number, number, number])[] = [
  [24.65, 40.12, 0.48, 0.22],
  [33.80, 40.12, 0.48, 0.22],
  [31.35, 47.88, 0.48, 0.22],
  [59.00, 47.88, 0.48, 0.22],
  [48.10, 31.00, 0.22, 0.48],
  [39.88, 63.00, 0.22, 0.48],
]

/** Wet street potholes with standing puddle water per 96 m macro-block (`src/ground.ts`): [x, z, scale]. */
const STREET_PUDDLES: readonly (readonly [number, number, number])[] = [
  [25.60, 42.15, 0.95],
  [32.45, 45.20, 1.05],
  [27.40, 46.45, 0.88],
  [36.10, 41.65, 0.85],
  [21.40, 45.30, 1.00],
  [43.40, 36.20, 0.95],
  [52.60, 44.60, 1.05],
  [16.20, 42.90, 0.96],
  [64.50, 45.10, 1.02],
]

const TILED_ARCHETYPES = new Set(["pharmacy", "grocery", "diner", "clinic", "police"])

type TownHazards = {
  glass: { x: number; y: number }[]
  blood: { x: number; y: number; r: number }[]
}

const hazardCache = new WeakMap<Town, TownHazards>()

function townHazards(town: Town): TownHazards {
  let hit = hazardCache.get(town)
  if (hit) return hit
  const glass: { x: number; y: number }[] = []
  for (const v of chooseVignettes(town)) {
    const scene = vignetteScene(town, v.kind, v.target)
    if (scene) for (const g of scene.glass) glass.push(g)
  }
  const blood: { x: number; y: number; r: number }[] = []
  for (const stamp of placeAmbientBlood(town, DEFAULT_BLOOD_SETTINGS)) {
    if (stamp.kind === "pool" && !stamp.wall) blood.push({ x: stamp.x, y: stamp.z, r: 0.52 * stamp.scale })
  }
  hit = { glass, blood }
  hazardCache.set(town, hit)
  return hit
}

const foldBlock = (v: number): number => ((v % SIZE) + SIZE) % SIZE

function interiorSurface(building: Building, town: Town, x: number, y: number): FootSurface {
  const plan = planInterior(building, town.houseSeed)
  for (const rug of plan.rugs) {
    const [rx0, rz0, rx1, rz1] = rug.rect
    if (x >= rx0 && x <= rx1 && y >= rz0 && y <= rz1) return "carpet"
  }
  const arch = building.archetype ?? building.kind
  const room = building.style?.rooms.find((r) => x >= r.rect[0] && x <= r.rect[2] && y >= r.rect[1] && y <= r.rect[3])
  if (room) return TILED_ROOMS.has(room.type) ? "tile" : BARE_ROOMS.has(room.type) ? "concrete" : "wood"
  if (isResidential(building)) {
    if (building.kind === "house") {
      const [bx0, bz0, bx1, bz1] = building.rect
      // South-east tiled kitchen (`src/interiors/wgsl.ts:287`) and stepped north-east washroom wing (`shared/map.ts:57`).
      const inKitchen = x > bx1 - 6.08 && x < bx1 - 0.05 && y > bz0 + 5.68 && y < bz1 - 0.05
      const inBathWing = !building.footprint && x >= bx0 + 9.5 && y >= bz0 + 1.5 && y < bz0 + 5.5
      if (inKitchen || inBathWing) return "tile"
    }
    return "wood"
  }
  if (TILED_ARCHETYPES.has(arch) || plan.theme === "station") return "tile"
  if (arch === "warehouse") return "metal"
  if (arch === "church") return "wood"
  return "concrete"
}

/**
 * Pure material resolver for any `(x, y)` world coordinate.
 * Mirrors the ground shader (`ground.ts`), lot geometry (`level.ts`, `yard.ts`, `architecture.ts`),
 * interior floors and rugs (`interiors/plan.ts`, `interiors/wgsl.ts`), broken glass (`discovery/vignettes.ts`
 * and live `glass:` stores), and blood pools (`blood/placement.ts` and live fight stains).
 */
export function surfaceAt(town: Town, x: number, y: number, extra?: SurfaceExtras): FootSurface {
  if (extra?.glass) {
    for (const g of extra.glass) if (Math.hypot(x - g.x, y - g.y) <= 0.65) return "glass"
  }
  if (extra?.blood) {
    for (const b of extra.blood) if (Math.hypot(x - b.x, y - b.y) <= (b.r ?? 0.55)) return "blood"
  }
  if (currentBloodStains()?.poolUnder(x, y)) return "blood"
  if (extra?.includeSeededHazards) {
    const seeded = townHazards(town)
    for (const g of seeded.glass) if (Math.hypot(x - g.x, y - g.y) <= 0.55) return "glass"
    for (const b of seeded.blood) if (Math.hypot(x - b.x, y - b.y) <= b.r) return "blood"
  }

  const building = town.buildings.find((b) => inBuildingFootprint(b, x, y))
  if (building) return interiorSurface(building, town, x, y)

  for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) {
    if (x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3]) return "metal"
  }

  const bx = foldBlock(x)
  const by = foldBlock(y)
  for (const [mx, my] of MANHOLES) {
    if (Math.hypot(bx - mx, by - my) <= 0.48) return "metal"
  }
  for (const [dx, dy, hw, hd] of STORM_DRAINS) {
    if (Math.abs(bx - dx) <= hw && Math.abs(by - dy) <= hd) return "metal"
  }
  for (const [px, py, sc] of STREET_PUDDLES) {
    if (Math.hypot(bx - px, by - py) <= 0.65 * sc) return "puddle"
  }

  for (const b of town.buildings) {
    const [x0, y0, , y1] = b.rect
    const walkEnd = frontageEnd(b) + 2
    if (b.kind === "house") {
      // Raised wooden front porch deck (`level.ts:269`, `architecture.ts:198`) and NW garden shed (`architecture.ts:159`).
      if (x >= x0 + 4.46 && x <= x0 + 7.04 && y >= y1 && y <= y1 + 1.28) return "wood"
      if (x >= x0 - 2.85 && x <= x0 - 1.15 && y >= y0 + 0.55 && y <= y0 + 2.25) return "wood"
    }
    // Gravel driveway west of the building (`level.ts:271`, `yard.ts:126`), excluding the concrete curb-cut ramp (`39.75..40`).
    if (x >= x0 - 3.0 && x <= x0 - 0.35 && y >= y0 && y <= walkEnd && !(by >= 39.75 && by <= 40.0)) return "gravel"
    // Front concrete walkway from the porch steps to the sidewalk (`level.ts:270`).
    if (x > x0 + 4.4 && x < x0 + 7.0 && y > y1 && y < walkEnd) return "concrete"
  }

  const bandX = bx >= 37.9 && bx <= 50.1
  const bandY = by >= 37.9 && by <= 50.1
  if (bandX || bandY) {
    // Curb-verge dirt and moss strip (`ground.ts:272`, `level.ts:247`) between sidewalk slabs and street curb.
    const inVergeY = (by > 39.28 && by < 39.78) || (by > 48.22 && by < 48.72)
    const inVergeX = (bx > 39.28 && bx < 39.78) || (bx > 48.22 && bx < 48.72)
    if ((inVergeY && !bandX) || (inVergeX && !bandY)) return "dirt"
    return "concrete"
  }

  for (const p of town.props) {
    if (p.kind === "tree" && Math.hypot(x - p.x, y - p.y) <= 0.72) return "dirt"
  }

  return "grass"
}

export type SurfaceStepProfile = {
  /** Base library surface (`concrete`, `grass`, `wood`) when no dedicated `foot.<surface>.*` sample is present. */
  readonly baseSurface: SfxSurface
  /** Optional override cue id when no `foot.<surface>.*` sample exists in the library. */
  readonly fallbackCue?: { readonly walk: string; readonly run: string }
  /** Natural surface loudness multiplier relative to a standard step. */
  readonly gain: number
  /** Playback rate (pitch/duration) multiplier for this surface. */
  readonly rate: number
  /** Optional low-pass filter cutoff (Hz) for softer/padded surfaces. */
  readonly cutoffHz?: number
}

/**
 * Acoustic character of each surface:
 * - `carpet` is hushed and low-passed (soft woven rug pile)
 * - `grass` and `dirt` are soft and earthy
 * - `wood` is warm and hollow
 * - `concrete` is controlled and gritty (tamed from the raw transient peak)
 * - `tile` is crisp and slightly higher-pitched (ceramic/linoleum click)
 * - `gravel` is crunchy and bright
 * - `puddle` and `blood` are wet and squelchy
 * - `metal` rings off manhole covers, storm grates and car roofs
 * - `glass` crunches sharply underfoot to warn of noise
 */
export const SURFACE_STEP_PROFILES: Readonly<Record<FootSurface, SurfaceStepProfile>> = {
  concrete: { baseSurface: "concrete", gain: 0.62, rate: 1.0, cutoffHz: 5200 },
  grass: { baseSurface: "grass", gain: 0.68, rate: 1.0, cutoffHz: 4200 },
  wood: { baseSurface: "wood", gain: 0.72, rate: 1.0, cutoffHz: 4800 },
  tile: { baseSurface: "concrete", fallbackCue: { walk: "foot.tile.walk", run: "foot.tile.walk" }, gain: 0.74, rate: 1.08, cutoffHz: 7800 },
  carpet: { baseSurface: "grass", gain: 0.42, rate: 0.88, cutoffHz: 1550 },
  gravel: { baseSurface: "grass", fallbackCue: { walk: "foot.gravel.walk", run: "foot.gravel.walk" }, gain: 0.82, rate: 1.06, cutoffHz: 6800 },
  dirt: { baseSurface: "grass", gain: 0.64, rate: 0.88, cutoffHz: 2600 },
  puddle: { baseSurface: "grass", fallbackCue: { walk: "foot.puddle.walk", run: "foot.puddle.walk" }, gain: 0.85, rate: 1.08, cutoffHz: 5800 },
  metal: { baseSurface: "concrete", fallbackCue: { walk: "impact.bullet.metal", run: "impact.bullet.metal" }, gain: 0.52, rate: 1.16, cutoffHz: 4600 },
  glass: { baseSurface: "concrete", fallbackCue: { walk: "foot.glass.step", run: "foot.glass.step" }, gain: 0.68, rate: 1.04, cutoffHz: 7400 },
  blood: { baseSurface: "grass", fallbackCue: { walk: "foot.puddle.walk", run: "foot.puddle.walk" }, gain: 0.56, rate: 0.84, cutoffHz: 2200 },
}

/** Movement mode from planar speed (m/s): matches Outbreak's crouch (1.9), walk (3.4) and sprint (5.6) speeds. */
export function stepMovementMode(speed: number, crouching = false): "idle" | "crouch" | "walk" | "run" {
  if (speed < 0.25) return "idle"
  if (crouching || speed <= 2.35) return "crouch"
  if (speed > 4.4) return "run"
  return "walk"
}

/**
 * Builds a material- and gait-aware survivor footstep event at `(x, y)`.
 * Loudness scales with gameplay noise radius:
 * - `idle` (< 0.25 m/s, stationary pivot): silent (`null`)
 * - `crouch` (1.2 m noise radius): very quiet (~0.22×), hushed low-pass, steps carefully over broken glass
 * - `walk` (4.0 m noise radius): subtle (~0.52×)
 * - `run` (12.0 m noise radius): full sprint step (0.85–1.0×)
 */
export function footstepEvent(
  town: Town,
  x: number,
  y: number,
  speed: number,
  opts?: { local?: boolean; crouching?: boolean; extra?: SurfaceExtras; surfaceScale?: number | ((surface: FootSurface) => number); selfScale?: number },
): { event: SoundEvent; surface: FootSurface; mode: "crouch" | "walk" | "run" } | null {
  const mode = stepMovementMode(speed, opts?.crouching)
  if (mode === "idle") return null

  let surface = surfaceAt(town, x, y, opts?.extra)
  // Crouching survivors step carefully over broken glass (`shared/discovery/field-verbs.ts:366`).
  if (mode === "crouch" && surface === "glass") {
    surface = surfaceAt(town, x, y)
  }

  const gait: "walk" | "run" = mode === "run" ? "run" : "walk"
  const profile = SURFACE_STEP_PROFILES[surface]
  const directId = `foot.${surface}.${gait}`
  const hasDirect = SFX_BY_ID.has(directId)
  const id = hasDirect ? directId : profile.fallbackCue ? profile.fallbackCue[gait] : `foot.${profile.baseSurface}.${gait}`

  const modeGain =
    mode === "crouch"
      ? 0.22 * Math.max(0.55, Math.min(1, speed / 1.9))
      : mode === "walk"
        ? 0.46 + 0.14 * Math.max(0, Math.min(1, (speed - 2.35) / 2.05))
        : 0.85 + 0.15 * Math.max(0, Math.min(1, (speed - 4.4) / 1.4))

  // The local survivor's boots are 0.2 m from the listener (inside refDistance), so attenuate self-steps to sit below combat/vocals.
  const selfScale = opts?.local ? 0.62 * (opts?.selfScale ?? 1.0) : 1.0
  const surfScale = typeof opts?.surfaceScale === "function" ? opts.surfaceScale(surface) : (opts?.surfaceScale ?? 1.0)
  const gain = Number((profile.gain * modeGain * selfScale * surfScale).toFixed(3))
  const baseRate = hasDirect ? 1.0 : profile.rate
  const rate = Number((baseRate * (mode === "crouch" ? 0.92 : mode === "run" ? 1.04 : 1.0)).toFixed(3))
  const cutoffHz = mode === "crouch" ? Math.min(1850, profile.cutoffHz ?? 1850) : profile.cutoffHz

  return {
    surface,
    mode,
    event: {
      id,
      x,
      y,
      gain,
      ...(rate !== 1 ? { rate } : {}),
      ...(cutoffHz !== undefined ? { cutoffHz } : {}),
      source: "foot",
    },
  }
}

/**
 * Material-aware zombie or Brute footstep event at `(x, y)`.
 * Uses `zombie.foot.<kind>.<baseSurface>` for standard surfaces and surface-specific cues/filters for puddles,
 * broken glass, blood pools, grates/manholes, gravel, tile and carpet.
 */
export function zombieStepEvent(
  surface: FootSurface,
  kind: ZombieStep | "brute",
  x: number,
  y: number,
  speed: number,
  rng: () => number = () => 0.5,
): SoundEvent {
  const profile = SURFACE_STEP_PROFILES[surface]
  if (kind === "brute") {
    const directId = `foot.${surface}.run`
    const id =
      surface === "puddle" || surface === "glass" || surface === "metal" || surface === "gravel"
        ? SFX_BY_ID.has(directId)
          ? directId
          : profile.fallbackCue?.run ?? `zombie.foot.step.${profile.baseSurface}`
        : `zombie.foot.step.${profile.baseSurface}`
    return {
      id,
      x,
      y,
      gain: Number((0.95 * Math.max(0.65, profile.gain)).toFixed(3)),
      rate: Number((0.68 + rng() * 0.06).toFixed(3)),
      cutoffHz: Math.min(2400, profile.cutoffHz ?? 2400),
      source: "zombie",
    }
  }

  if (surface === "puddle" || surface === "glass" || surface === "blood" || surface === "metal" || surface === "gravel") {
    const directId = `foot.${surface}.walk`
    const id = SFX_BY_ID.has(directId) ? directId : profile.fallbackCue?.walk ?? `zombie.foot.${kind}.${profile.baseSurface}`
    const baseGain = kind === "drag" ? 0.68 : 0.58 + 0.22 * Math.min(1, speed / 1.6)
    return {
      id,
      x,
      y,
      gain: Number((baseGain * profile.gain).toFixed(3)),
      rate: Number(((SFX_BY_ID.has(directId) ? 0.92 : profile.rate * 0.92) * (kind === "drag" ? 0.86 : 1)).toFixed(3)),
      ...(profile.cutoffHz ? { cutoffHz: profile.cutoffHz } : {}),
      source: "zombie",
    }
  }

  const baseGain = kind === "drag" ? 0.72 : 0.62 + 0.22 * Math.min(1, speed / 1.6)
  const surfScale = surface === "carpet" ? 0.55 : surface === "tile" ? 0.95 : surface === "dirt" ? 0.85 : 0.88
  const rate = surface === "tile" ? 1.14 : surface === "carpet" ? 0.88 : surface === "dirt" ? 0.9 : 1
  return {
    id: `zombie.foot.${kind}.${profile.baseSurface}`,
    x,
    y,
    gain: Number((baseGain * surfScale).toFixed(3)),
    ...(rate !== 1 ? { rate } : {}),
    ...(profile.cutoffHz ? { cutoffHz: profile.cutoffHz } : {}),
    source: "zombie",
  }
}

export function indoors(town: Town, x: number, y: number): boolean {
  return town.buildings.some((b) => inBuildingFootprint(b, x, y))
}

const box = (r: Rect) => ({ x0: r[0], z0: r[1], x1: r[2], z1: r[3] })

/**
 * Sound occlusion from the same geometry that blocks sight: each wall or closed door between listener and source adds
 * 0.6, each window pane 0.25, capped at 1. `strength` scales it (the Lab's Occlusion control).
 */
export class SoundOcclusion {
  private solid: ReturnType<typeof box>[] = []
  private panes: ReturnType<typeof box>[] = []
  private revision = -1
  strength = 1

  sync(town: Town, revision: number): void {
    if (revision === this.revision) return
    this.revision = revision
    this.solid = sightRects(town).map(box)
    this.panes = town.barriers.filter((b) => b.kind === "window").map((b) => box(b.rect))
  }

  query = (lx: number, lz: number, sx: number, sz: number): number => {
    if (this.strength <= 0) return 0
    let amount = 0
    for (const b of this.solid) if (blocked(lx, lz, sx, sz, b) && (amount += 0.6) >= 1) return this.strength
    for (const b of this.panes) if (blocked(lx, lz, sx, sz, b) && (amount += 0.25) >= 1) return this.strength
    return Math.min(1, amount) * this.strength
  }
}
