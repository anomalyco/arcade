import type { Particles, ParticleSpec } from "./particles"
import type { SmokeVolumes } from "./volume"

/** Canonical explosion parameters shared by the Lab and game adapters.
 * Spawn-time controls are marked with `retrigger` in their unit metadata;
 * live shader controls (`smokeColorShift`, `smokeRise`, `smokeTurbulence`, `flashIntensity`) update in place.
 */
export const explosionDefaults = {
  fireballSize: 1.25,
  fireballDuration: 0.58,
  fireballTemp: 1.25,
  smokeAmount: 1.05,
  smokeDarkness: 0.72,
  smokeColorShift: 0.84,
  smokeRise: 1.02,
  smokeSpreadSpeed: 0.95,
  smokeTurbulence: 0.92,
  smokeLinger: 3.5,
  sparkCount: 56,
  debrisCount: 22,
  flashIntensity: 6.5,
  shockRing: 1.0,
  fragmentCount: 0,
  secondaryPops: 0,
  scorch: true,
}

export type ExplosionSettings = typeof explosionDefaults
export type ExplosionNumericKey = Exclude<keyof ExplosionSettings, "scorch">

export const explosionRanges: Record<
  ExplosionNumericKey,
  readonly [min: number, max: number, step: number, unit: string, group: string, label: string]
> = {
  fireballSize: [0.4, 2.5, 0.05, "m · retrigger", "Fireball", "Fireball size"],
  fireballDuration: [0.2, 1.4, 0.05, "s · retrigger", "Fireball", "Fireball duration"],
  fireballTemp: [0.5, 2.0, 0.05, "× · retrigger", "Fireball", "Fireball temperature"],
  smokeAmount: [0, 2.0, 0.05, "× · retrigger", "Explosion Smoke", "Smoke amount"],
  smokeDarkness: [0.1, 1.0, 0.05, "· retrigger", "Explosion Smoke", "Smoke darkness"],
  smokeColorShift: [0, 1.0, 0.05, "", "Explosion Smoke", "Colour shift"],
  smokeRise: [0.1, 1.6, 0.05, "m/s", "Explosion Smoke", "Rise speed"],
  smokeSpreadSpeed: [0.3, 2.5, 0.05, "× · retrigger", "Explosion Smoke", "Spread speed"],
  smokeTurbulence: [0.1, 1.4, 0.05, "×", "Explosion Smoke", "Turbulence"],
  smokeLinger: [0.8, 8.0, 0.1, "s · retrigger", "Explosion Smoke", "Smoke linger"],
  sparkCount: [0, 140, 1, "· retrigger", "Blast & Debris", "Sparks count"],
  debrisCount: [0, 60, 1, "· retrigger", "Blast & Debris", "Debris count"],
  flashIntensity: [0, 12, 0.2, "×", "Blast & Debris", "Flash intensity"],
  shockRing: [0, 2.0, 0.05, "× · retrigger", "Blast & Debris", "Shockwave ring"],
  fragmentCount: [0, 24, 1, "· retrigger", "Blast & Debris", "Trailing fragments"],
  secondaryPops: [0, 6, 1, "· retrigger", "Blast & Debris", "Secondary pops"],
}

export const EXPLOSION_PRESET_IDS = ["grenade", "propane", "car", "barrel", "missile", "ship", "pop"] as const
export type ExplosionPresetId = (typeof EXPLOSION_PRESET_IDS)[number]

/** High-level physical recipe axes mapped onto `ExplosionSettings`. */
export type ExplosionParams = {
  preset?: ExplosionPresetId
  /** Scales fireball radius (`fireballSize`). */
  size?: number
  /** Scales blackbody core temperature (`fireballTemp`). */
  energy?: number
  /** Scales fireball burn duration (`fireballDuration`). */
  fuel?: number
  /** Scales volumetric soot plume density (`smokeAmount`). */
  smoke?: number
  /** Scales shrapnel & spark counts (`debrisCount`, `sparkCount`). */
  debris?: number
  /** Enables or disables ground scorch decal (`scorch`). */
  scorch?: boolean
  /** Scales scene illumination flash (`flashIntensity`). */
  flash?: number
  /** Scales supersonic blast ring (`shockRing`). */
  shockwave?: number
}

export function explosionSettings(input: Partial<ExplosionSettings> = {}): ExplosionSettings {
  const out = { ...explosionDefaults }
  for (const key of Object.keys(explosionRanges) as ExplosionNumericKey[]) {
    const val = input[key]
    const [min, max] = explosionRanges[key]
    if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = Math.max(min, Math.min(max, val))
    }
  }
  if (typeof input.scorch === "boolean") out.scorch = input.scorch
  return out
}

export const EXPLOSION_PRESETS: Readonly<
  Record<ExplosionPresetId, { readonly id: ExplosionPresetId; readonly label: string; readonly settings: ExplosionSettings }>
> = {
  grenade: {
    id: "grenade",
    label: "Frag grenade",
    settings: explosionSettings(explosionDefaults),
  },
  propane: {
    id: "propane",
    label: "Propane tank",
    settings: explosionSettings({
      fireballSize: 1.4,
      fireballDuration: 0.68,
      fireballTemp: 1.4,
      smokeAmount: 1.15,
      smokeDarkness: 0.76,
      smokeColorShift: 0.82,
      smokeRise: 1.2,
      smokeSpreadSpeed: 1.05,
      smokeTurbulence: 0.96,
      smokeLinger: 3.8,
      sparkCount: 52,
      debrisCount: 20,
      flashIntensity: 7.6,
      shockRing: 1.15,
      fragmentCount: 2,
      secondaryPops: 0,
      scorch: true,
    }),
  },
  car: {
    id: "car",
    label: "Car / fuel",
    settings: explosionSettings({
      fireballSize: 1.75,
      fireballDuration: 0.82,
      fireballTemp: 1.36,
      smokeAmount: 1.55,
      smokeDarkness: 0.88,
      smokeColorShift: 0.74,
      smokeRise: 1.15,
      smokeSpreadSpeed: 1.15,
      smokeTurbulence: 1.08,
      smokeLinger: 4.8,
      sparkCount: 78,
      debrisCount: 36,
      flashIntensity: 9.2,
      shockRing: 1.35,
      fragmentCount: 4,
      secondaryPops: 1,
      scorch: true,
    }),
  },
  barrel: {
    id: "barrel",
    label: "Fuel barrel",
    settings: explosionSettings({
      fireballSize: 1.52,
      fireballDuration: 0.72,
      fireballTemp: 1.3,
      smokeAmount: 1.38,
      smokeDarkness: 0.84,
      smokeColorShift: 0.76,
      smokeRise: 1.1,
      smokeSpreadSpeed: 1.02,
      smokeTurbulence: 1.02,
      smokeLinger: 4.2,
      sparkCount: 54,
      debrisCount: 26,
      flashIntensity: 7.8,
      shockRing: 1.2,
      fragmentCount: 3,
      secondaryPops: 1,
      scorch: true,
    }),
  },
  missile: {
    id: "missile",
    label: "Missile airburst",
    settings: explosionSettings({
      fireballSize: 1.35,
      fireballDuration: 0.52,
      fireballTemp: 1.55,
      smokeAmount: 0.95,
      smokeDarkness: 0.64,
      smokeColorShift: 0.88,
      smokeRise: 0.85,
      smokeSpreadSpeed: 1.42,
      smokeTurbulence: 1.05,
      smokeLinger: 2.6,
      sparkCount: 84,
      debrisCount: 28,
      flashIntensity: 8.0,
      shockRing: 1.25,
      fragmentCount: 6,
      secondaryPops: 0,
      scorch: false,
    }),
  },
  ship: {
    id: "ship",
    label: "Ship / hull hit",
    settings: explosionSettings({
      fireballSize: 1.95,
      fireballDuration: 1.0,
      fireballTemp: 1.42,
      smokeAmount: 1.75,
      smokeDarkness: 0.92,
      smokeColorShift: 0.7,
      smokeRise: 1.4,
      smokeSpreadSpeed: 1.18,
      smokeTurbulence: 1.12,
      smokeLinger: 7.0,
      sparkCount: 96,
      debrisCount: 40,
      flashIntensity: 10.0,
      shockRing: 1.45,
      fragmentCount: 16,
      secondaryPops: 3,
      scorch: true,
    }),
  },
  pop: {
    id: "pop",
    label: "Small pop",
    settings: explosionSettings({
      fireballSize: 0.72,
      fireballDuration: 0.36,
      fireballTemp: 1.18,
      smokeAmount: 0.58,
      smokeDarkness: 0.56,
      smokeColorShift: 0.9,
      smokeRise: 0.88,
      smokeSpreadSpeed: 1.32,
      smokeTurbulence: 0.78,
      smokeLinger: 2.0,
      sparkCount: 34,
      debrisCount: 12,
      flashIntensity: 4.2,
      shockRing: 0.68,
      scorch: true,
    }),
  },
}

export const explosionPresetOptions: readonly { value: ExplosionPresetId; label: string }[] = EXPLOSION_PRESET_IDS.map(
  id => ({ value: id, label: EXPLOSION_PRESETS[id].label }),
)

export function isExplosionPresetId(value: unknown): value is ExplosionPresetId {
  return typeof value === "string" && (EXPLOSION_PRESET_IDS as readonly string[]).includes(value)
}

export function resolveExplosionSettings(
  presetOrInput: ExplosionPresetId | (Partial<ExplosionSettings> & ExplosionParams) = "grenade",
  overrides?: Partial<ExplosionSettings> & ExplosionParams,
): ExplosionSettings {
  const basePreset: ExplosionPresetId =
    typeof presetOrInput === "string"
      ? isExplosionPresetId(presetOrInput)
        ? presetOrInput
        : "grenade"
      : isExplosionPresetId(presetOrInput.preset)
        ? presetOrInput.preset
        : "grenade"
  const base = { ...EXPLOSION_PRESETS[basePreset].settings }
  const merged = typeof presetOrInput === "string" ? (overrides ?? {}) : { ...presetOrInput, ...overrides }
  for (const key of Object.keys(explosionRanges) as ExplosionNumericKey[]) {
    if (typeof merged[key] === "number" && Number.isFinite(merged[key])) {
      base[key] = merged[key]!
    }
  }
  if (typeof merged.size === "number" && Number.isFinite(merged.size)) base.fireballSize *= merged.size
  if (typeof merged.energy === "number" && Number.isFinite(merged.energy)) base.fireballTemp *= merged.energy
  if (typeof merged.fuel === "number" && Number.isFinite(merged.fuel)) base.fireballDuration *= merged.fuel
  if (typeof merged.smoke === "number" && Number.isFinite(merged.smoke)) base.smokeAmount *= merged.smoke
  if (typeof merged.debris === "number" && Number.isFinite(merged.debris)) {
    base.debrisCount = Math.round(base.debrisCount * merged.debris)
    base.sparkCount = Math.round(base.sparkCount * merged.debris)
    base.fragmentCount = Math.round(base.fragmentCount * merged.debris)
  }
  if (typeof merged.flash === "number" && Number.isFinite(merged.flash)) base.flashIntensity *= merged.flash
  if (typeof merged.shockwave === "number" && Number.isFinite(merged.shockwave)) base.shockRing *= merged.shockwave
  if (typeof merged.scorch === "boolean") base.scorch = merged.scorch
  return explosionSettings(base)
}

export function applyExplosionSmokeLive(
  volume: SmokeVolumes,
  settings: Readonly<ExplosionSettings>,
  densityScale = 1,
): void {
  volume.colorShift = settings.smokeColorShift
  volume.coreGlow = settings.fireballTemp * Math.min(1.6, Math.max(0.2, settings.smokeAmount))
  volume.settings.rise = settings.smokeRise
  volume.settings.turbulence = Math.min(1, settings.smokeTurbulence)
  volume.settings.height = Math.max(3.1, Math.min(6.2, 3.35 + settings.fireballSize * 0.58 + settings.smokeRise * 0.65))
  volume.settings.extinction = Math.max(0.8, Math.min(4.8, 2.55 * Math.max(0.25, settings.smokeAmount) * densityScale))
}

export type ExplosionSpawnOptions = {
  scale?: number
  densityScale?: number
  vx?: number
  vy?: number
  vz?: number
  aim?: number
  cone?: number
  airburst?: boolean
  /** Optional distance from camera/focus (m) for distance-based LOD simplification. */
  distanceToEye?: number
  /** Reference full-detail distance (m, default 24m for top-down games, 160m for Carrier). */
  referenceDist?: number
}

export type ExplosionLodInfo = {
  tier: 0 | 1 | 2
  countScale: number
  lifeScale: number
  sizeCompensation: number
}

/** Computes deterministic LOD & concurrent-load scaling so simultaneous blasts and distant bursts stay inside 60 Hz budgets. */
export function computeExplosionLod(
  activeParticles: number,
  distanceToEye = 0,
  referenceDist = 24,
): ExplosionLodInfo {
  const ref = Math.max(4, referenceDist)
  const uDist = Math.max(0, (distanceToEye - ref) / ref)
  const distFactor = Math.max(0.28, Math.min(1.0, 1 / (1 + uDist * 0.85)))
  const loadFactor =
    activeParticles <= 70
      ? 1.0
      : Math.max(0.22, Math.min(1.0, 1.0 - ((activeParticles - 70) / 480) * 0.78))
  const countScale = Math.max(0.22, Math.min(1.0, distFactor * loadFactor))
  const tier: 0 | 1 | 2 = countScale >= 0.78 ? 0 : countScale >= 0.45 ? 1 : 2
  const lifeScale = Math.max(0.65, Math.min(1.0, 0.65 + 0.35 * countScale))
  const sizeCompensation = countScale >= 0.99 ? 1.0 : Math.min(1.36, 1 / Math.pow(countScale, 0.22))
  return { tier, countScale, lifeScale, sizeCompensation }
}

const reusableSpec: ParticleSpec = {
  kind: "fireball",
  life: 0.6,
  size: 0.5,
  growth: 1.5,
  gravity: -3,
  drag: 5.5,
  bounce: 0,
  r: 1,
  g: 1,
  b: 1,
  alpha: 1,
  temperature: 1.2,
  turbulence: 0.8,
  ease: 2.8,
}

const fragmentSpec: ParticleSpec = { ...reusableSpec, kind: "debris", trail: 0, pop: 0 }

/** Spawns a multi-phase explosion: ground scorch, supersonic shock/dust ring,
 * temperature-driven blackbody fireball billows that crust into dark soot,
 * buoyant volumetric smoke plume, ballistic sparks, 3D lit debris chunks, and for
 * the bigger hits burning fragments that arc out on their own smoke trails and
 * delayed secondary pops (`fx/projectile-trail.ts`).
 */
export function spawnExplosion(
  particles: Particles,
  volume: SmokeVolumes | null,
  x: number,
  y: number,
  z: number,
  settings: Readonly<ExplosionSettings>,
  random: () => number,
  scale = 1,
  densityScale = 1,
  options?: ExplosionSpawnOptions,
): void {
  const effScale = options?.scale ?? scale
  const effDensity = options?.densityScale ?? densityScale
  const lod = computeExplosionLod(particles.count, options?.distanceToEye ?? 0, options?.referenceDist ?? 24)
  const fbSize = Math.max(0.25, settings.fireballSize * effScale)
  const fbDur = Math.max(0.15, settings.fireballDuration * lod.lifeScale)
  const fbTemp = Math.max(0.3, settings.fireballTemp)
  const smokeAmt = Math.max(0, settings.smokeAmount * effDensity)
  const airburst = Boolean(options?.airburst)
  const bvx = options?.vx ?? 0
  const bvy = options?.vy ?? 0
  const bvz = options?.vz ?? 0
  const hasCone = typeof options?.aim === "number" && typeof options?.cone === "number"
  const coneAim = options?.aim ?? 0
  const coneHalf = options?.cone ?? Math.PI
  const sampleAngle = (fallback: number) =>
    hasCone ? coneAim + (random() - 0.5) * 2 * coneHalf : fallback

  if (volume) {
    applyExplosionSmokeLive(volume, settings, effDensity)
    if (smokeAmt > 0.02 && !airburst && (options?.distanceToEye ?? 0) < (options?.referenceDist ?? 24) * 2.5) {
      const smokeRadius = Math.max(
        1.6,
        Math.min(7.5, (2.15 + fbSize * 0.88) * (0.68 + 0.32 * settings.smokeSpreadSpeed)),
      )
      const growthTime = Math.max(0.2, Math.min(1.5, (0.44 * fbSize) / Math.max(0.25, settings.smokeSpreadSpeed)))
      const totalLife = Math.max(0.9, (fbDur * 0.65 + settings.smokeLinger) * lod.lifeScale)
      volume.spawn(x, z, smokeRadius, totalLife, Math.min(2.0, smokeAmt * 1.05), settings.smokeDarkness, growthTime)
    }
  }

  // 1. Ground scorch mark (drawn first on the ground plane beneath the plume)
  if (settings.scorch && !airburst) {
    Object.assign(reusableSpec, {
      kind: "scorch",
      life: Math.max(2.2, (settings.smokeLinger + 1.2) * lod.lifeScale),
      size: 1.65 * fbSize,
      growth: 0.14 * fbSize,
      gravity: 0,
      drag: 10,
      bounce: 0,
      r: 0.042,
      g: 0.038,
      b: 0.035,
      alpha: 0.88,
      temperature: 0,
      turbulence: 0,
      ease: 2.0,
    })
    particles.spawn(reusableSpec, x, y + 0.026, z, 0, 0, 0, random() * 6.283)
  }

  // 2. Supersonic shockwave & boundary-layer dust ring
  if (settings.shockRing > 0.02) {
    const ringScale = settings.shockRing * (airburst ? fbSize * 0.85 : Math.sqrt(fbSize))
    Object.assign(reusableSpec, {
      kind: "shock",
      life: 0.42 * lod.lifeScale,
      size: 0.52 * fbSize,
      growth: 8.6 * ringScale,
      gravity: 0,
      drag: 8,
      bounce: 0,
      r: 0.64,
      g: 0.58,
      b: 0.5,
      alpha: Math.min(1, 0.82 * settings.shockRing),
      temperature: airburst ? 1 : 0,
      turbulence: 0,
      ease: 2.5,
    })
    particles.spawn(reusableSpec, x, airburst ? y : y + 0.035, z, bvx * 0.3, bvy * 0.3, bvz * 0.3, random() * 6.283)

    if (lod.tier < 2) {
      Object.assign(reusableSpec, {
        kind: "shock",
        life: 0.68 * lod.lifeScale,
        size: 0.42 * fbSize,
        growth: 4.5 * ringScale,
        gravity: 0,
        drag: 8,
        bounce: 0,
        r: 0.48,
        g: 0.44,
        b: 0.39,
        alpha: Math.min(1, 0.54 * settings.shockRing),
        temperature: airburst ? 1 : 0,
        turbulence: 0,
        ease: 2.1,
      })
      particles.spawn(reusableSpec, x, airburst ? y : y + 0.038, z, bvx * 0.3, bvy * 0.3, bvz * 0.3, random() * 6.283)
    }
  }

  // 3. Turbulent blackbody fireball billows (3 tiers: outer soot-crusting ring, main incandescent dome, superheated core + crown)
  const billowSizeComp = fbSize * lod.sizeCompensation
  const outerCount = Math.max(5, Math.round(14 * lod.countScale))
  for (let i = 0; i < outerCount; i++) {
    const a = sampleAngle(((i + (random() - 0.5) * 0.55) / outerCount) * Math.PI * 2)
    const r0 = (0.12 + random() * 0.18) * fbSize
    const speed = (1.7 + random() * 2.3) * fbSize
    const vy = airburst ? (random() - 0.38) * 3.8 * fbSize : (1.8 + random() * 2.8) * fbSize
    const life = fbDur * (1.05 + random() * 0.52)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.42 + random() * 0.2) * billowSizeComp,
      growth: ((0.95 + random() * 0.38) * billowSizeComp) / life,
      gravity: -3.6 * (0.7 + settings.smokeRise * 0.55),
      drag: 5.8,
      bounce: 0,
      r: 1,
      g: 1,
      b: 1,
      alpha: 0.94,
      temperature: fbTemp * (0.72 + random() * 0.26),
      turbulence: 0.72 + settings.smokeTurbulence * 0.42,
      ease: 2.6,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * r0,
      y + (airburst ? (random() - 0.5) * 0.45 * fbSize : 0.36 + random() * 0.38 * fbSize),
      z + Math.sin(a) * r0,
      bvx + Math.cos(a) * speed,
      bvy + vy,
      bvz + Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  const domeCount = Math.max(4, Math.round(12 * lod.countScale))
  for (let i = 0; i < domeCount; i++) {
    const a = sampleAngle(((i + 0.5 + (random() - 0.5) * 0.5) / domeCount) * Math.PI * 2)
    const r0 = (0.06 + random() * 0.14) * fbSize
    const speed = (1.0 + random() * 1.7) * fbSize
    const vy = airburst ? (random() - 0.32) * 3.2 * fbSize : (2.6 + random() * 3.6) * fbSize
    const life = fbDur * (0.84 + random() * 0.36)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.46 + random() * 0.22) * billowSizeComp,
      growth: ((1.05 + random() * 0.36) * billowSizeComp) / life,
      gravity: -4.4 * (0.7 + settings.smokeRise * 0.55),
      drag: 6.0,
      bounce: 0,
      r: 1,
      g: 1,
      b: 1,
      alpha: 0.96,
      temperature: fbTemp * (1.06 + random() * 0.32),
      turbulence: 0.62 + settings.smokeTurbulence * 0.38,
      ease: 2.8,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * r0,
      y + (airburst ? (random() - 0.45) * 0.4 * fbSize : 0.48 + random() * 0.48 * fbSize),
      z + Math.sin(a) * r0,
      bvx + Math.cos(a) * speed,
      bvy + vy,
      bvz + Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  const coreCount = lod.tier === 2 ? 2 : 3
  for (let i = 0; i < coreCount; i++) {
    const a = sampleAngle((i / coreCount) * Math.PI * 2 + random() * 0.6)
    const life = fbDur * (0.46 + random() * 0.16)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.68 + random() * 0.18) * billowSizeComp,
      growth: (1.18 * billowSizeComp) / life,
      gravity: -3.4,
      drag: 6.5,
      bounce: 0,
      r: 1,
      g: 1,
      b: 1,
      alpha: 0.98,
      temperature: fbTemp * (1.48 + random() * 0.22),
      turbulence: 0.52 + settings.smokeTurbulence * 0.3,
      ease: 3.1,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * 0.06 * fbSize,
      y + (airburst ? (i - 1) * 0.14 * fbSize : (0.62 + i * 0.18) * fbSize),
      z + Math.sin(a) * 0.06 * fbSize,
      bvx + Math.cos(a) * 0.65 * fbSize,
      bvy + (airburst ? (i - 1) * 0.85 * fbSize : (2.0 + i * 0.85) * fbSize),
      bvz + Math.sin(a) * 0.65 * fbSize,
      random() * 6.283,
    )
  }

  // Anterior soot-crusting crown billows that roll over the hot core
  const crownCount = Math.max(2, Math.round(6 * lod.countScale))
  for (let i = 0; i < crownCount; i++) {
    const a = sampleAngle((i / crownCount) * Math.PI * 2 + 0.35 + (random() - 0.5) * 0.35)
    const life = fbDur * (1.32 + random() * 0.65)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.44 + random() * 0.2) * billowSizeComp,
      growth: (1.08 * billowSizeComp) / life,
      gravity: -4.6 * (0.75 + settings.smokeRise * 0.5),
      drag: 5.6,
      bounce: 0,
      r: 1,
      g: 1,
      b: 1,
      alpha: 0.92,
      temperature: fbTemp * (0.58 + random() * 0.26),
      turbulence: 0.86 + settings.smokeTurbulence * 0.42,
      ease: 2.7,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * 0.18 * fbSize,
      y + (airburst ? (random() - 0.3) * 0.5 * fbSize : (0.68 + random() * 0.42) * fbSize),
      z + Math.sin(a) * 0.18 * fbSize,
      bvx + Math.cos(a) * 1.45 * fbSize,
      bvy + (airburst ? (random() - 0.2) * 3.0 * fbSize : (2.8 + random() * 2.2) * fbSize),
      bvz + Math.sin(a) * 1.45 * fbSize,
      random() * 6.283,
    )
  }

  // 4. High-speed ballistic sparks with blackbody cooling and floor/wall restitution
  const sparks = Math.max(0, Math.round(settings.sparkCount * lod.countScale))
  const velScale = airburst ? Math.max(1, fbSize * 0.82) : Math.sqrt(fbSize)
  for (let i = 0; i < sparks; i++) {
    const a = sampleAngle(((i + random() * 0.85) / Math.max(1, sparks)) * Math.PI * 2)
    const speed = (6.5 + random() * 13.5) * velScale
    const vy = airburst ? (random() - 0.42) * 14.0 * velScale : (2.8 + random() * 9.2) * velScale
    Object.assign(reusableSpec, {
      kind: "spark",
      life: (0.42 + random() * 1.15) * lod.lifeScale,
      size: (0.046 + random() * 0.036) * Math.max(1, effScale * 0.65),
      growth: -0.018,
      gravity: 13.5,
      drag: 0.82,
      bounce: 0.52,
      r: 1,
      g: 0.72,
      b: 0.28,
      alpha: 1,
      temperature: (0.95 + random() * 0.45) * Math.min(1.5, fbTemp),
      turbulence: 0,
      ease: 1,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * 0.15,
      y + (airburst ? 0 : 0.35 + random() * 0.35),
      z + Math.sin(a) * 0.15,
      bvx + Math.cos(a) * speed,
      bvy + vy,
      bvz + Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  // 5. Tumbling 3D lit shrapnel / debris splinters with gravity and floor bounces
  const debris = Math.max(0, Math.round(settings.debrisCount * lod.countScale))
  for (let i = 0; i < debris; i++) {
    const a = sampleAngle(((i + random() * 0.85) / Math.max(1, debris)) * Math.PI * 2)
    const speed = (3.4 + random() * 7.8) * velScale
    const vy = airburst ? (random() - 0.38) * 11.0 * velScale : (3.6 + random() * 7.6) * velScale
    const shade = 0.09 + random() * 0.13
    const warm = random() * 0.04
    Object.assign(reusableSpec, {
      kind: "debris",
      life: (1.8 + random() * 2.4) * lod.lifeScale,
      size: (0.032 + random() * 0.036) * velScale * Math.max(1, effScale * 0.55),
      growth: 0,
      gravity: 14.2,
      drag: 0.32,
      bounce: 0.38,
      r: shade + warm,
      g: shade * 0.92 + warm * 0.4,
      b: shade * 0.84,
      alpha: 1,
      temperature: 0,
      turbulence: 1,
      ease: 1,
    })
    particles.spawn(
      reusableSpec,
      x + Math.cos(a) * 0.22,
      y + (airburst ? 0 : 0.24 + random() * 0.3),
      z + Math.sin(a) * 0.22,
      bvx + Math.cos(a) * speed,
      bvy + vy,
      bvz + Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  // 6. Burning fragments thrown out on ballistic arcs, each laying its own thinning smoke trail with a hot spark at
  //    its head; over water (`Particles.water`) they splash in. Count, size and life vary per fragment.
  const fragments = Math.max(0, Math.round(settings.fragmentCount * lod.countScale))
  const trailScale = 0.3 * fbSize
  for (let i = 0; i < fragments; i++) {
    const a = sampleAngle(((i + random() * 0.8) / Math.max(1, fragments)) * Math.PI * 2)
    const elevation = airburst ? (random() - 0.4) * 1.4 : 0.22 + random() * 0.66
    const speed = (7 + random() * 9) * velScale
    const horizontal = Math.cos(elevation) * speed
    const shade = 0.06 + random() * 0.1
    Object.assign(fragmentSpec, {
      kind: "debris",
      life: (2.0 + random() * 2.2) * lod.lifeScale,
      size: (0.05 + random() * 0.08) * velScale * Math.max(1, effScale * 0.55),
      growth: 0,
      gravity: 14.2,
      drag: 0.12,
      bounce: 0.3,
      r: shade + 0.02,
      g: shade * 0.94,
      b: shade * 0.88,
      alpha: 1,
      temperature: 0,
      turbulence: 1,
      ease: 1,
      trail: trailScale * (0.65 + random() * 0.7),
      pop: 0,
    })
    particles.spawn(
      fragmentSpec,
      x + Math.cos(a) * 0.2 * fbSize,
      y + (airburst ? 0 : 0.35 * fbSize),
      z + Math.sin(a) * 0.2 * fbSize,
      bvx + Math.cos(a) * horizontal,
      bvy + Math.sin(elevation) * speed,
      bvz + Math.sin(a) * horizontal,
      random() * 6.283,
    )
  }

  // 7. Secondary pops: fuel and ammunition cooking off a beat later around the blast.
  const pops = lod.tier === 2 ? Math.min(1, settings.secondaryPops) : Math.round(settings.secondaryPops)
  for (let i = 0; i < pops; i++) {
    const a = random() * Math.PI * 2
    const out = (0.9 + random() * 1.6) * fbSize
    Object.assign(fragmentSpec, {
      kind: "soft",
      life: 0.32 + i * 0.34 + random() * 0.18,
      size: 0.01,
      growth: 0,
      gravity: 2,
      drag: 2.2,
      bounce: 0,
      r: 0,
      g: 0,
      b: 0,
      alpha: 0,
      temperature: 0,
      turbulence: 0,
      ease: 1,
      trail: 0,
      pop: 0.42 * fbSize,
    })
    particles.spawn(
      fragmentSpec,
      x + Math.cos(a) * 0.3 * fbSize,
      y + (airburst ? 0 : 0.5 * fbSize),
      z + Math.sin(a) * 0.3 * fbSize,
      bvx + Math.cos(a) * out,
      bvy + (airburst ? (random() - 0.5) * 2 : 0.8 + random() * 1.8) * fbSize,
      bvz + Math.sin(a) * out,
      random() * 6.283,
    )
  }
}

export function explosionFlashLight(
  x: number,
  y: number,
  z: number,
  age: number,
  settings: Readonly<ExplosionSettings>,
): { x: number; y: number; z: number; radius: number; r: number; g: number; b: number; power: number; cone: number } | null {
  if (settings.flashIntensity <= 0.01 || age < 0) return null
  const fbDur = Math.max(0.15, settings.fireballDuration)
  const maxAge = fbDur * 1.55
  if (age >= maxAge) return null
  const spike = Math.exp(-age * 18)
  const sustain = Math.pow(Math.max(0, 1 - age / maxAge), 1.85) * (0.86 + 0.14 * Math.sin(age * 41))
  const power = settings.flashIntensity * (spike * 1.65 + sustain * 0.85) * Math.min(1.5, settings.fireballTemp)
  if (power < 0.02) return null
  const mixWhite = spike / Math.max(0.001, spike + sustain)
  return {
    x,
    y: y + 1.25 + Math.min(1.2, age * 1.6),
    z,
    radius: Math.max(8, (11 + spike * 5) * Math.sqrt(settings.fireballSize)),
    r: 1.25 + 0.25 * mixWhite,
    g: 0.42 + 0.52 * mixWhite,
    b: 0.06 + 0.48 * mixWhite,
    power,
    cone: -3,
  }
}
