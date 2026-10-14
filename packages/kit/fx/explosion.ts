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
  smokeLinger: [0.8, 6.0, 0.1, "s · retrigger", "Explosion Smoke", "Smoke linger"],
  sparkCount: [0, 140, 1, "· retrigger", "Blast & Debris", "Sparks count"],
  debrisCount: [0, 60, 1, "· retrigger", "Blast & Debris", "Debris count"],
  flashIntensity: [0, 12, 0.2, "×", "Blast & Debris", "Flash intensity"],
  shockRing: [0, 2.0, 0.05, "× · retrigger", "Blast & Debris", "Shockwave ring"],
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

export function applyExplosionSmokeLive(volume: SmokeVolumes, settings: Readonly<ExplosionSettings>, densityScale = 1): void {
  volume.colorShift = settings.smokeColorShift
  volume.coreGlow = settings.fireballTemp * Math.min(1.6, Math.max(0.2, settings.smokeAmount))
  volume.settings.rise = settings.smokeRise
  volume.settings.turbulence = Math.min(1, settings.smokeTurbulence)
  volume.settings.height = Math.max(3.1, Math.min(5.2, 3.35 + settings.fireballSize * 0.58 + settings.smokeRise * 0.65))
  volume.settings.extinction = Math.max(0.8, Math.min(4.8, 2.55 * Math.max(0.25, settings.smokeAmount) * densityScale))
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

/** Spawns a multi-phase explosion: ground scorch, supersonic shock/dust ring,
 * temperature-driven blackbody fireball billows that crust into dark soot,
 * buoyant volumetric smoke plume, ballistic sparks, and 3D lit debris chunks.
 */
export function spawnExplosion(
  particles: Particles,
  volume: SmokeVolumes,
  x: number,
  y: number,
  z: number,
  settings: Readonly<ExplosionSettings>,
  random: () => number,
  scale = 1,
  densityScale = 1,
): void {
  const fbSize = Math.max(0.25, settings.fireballSize * scale)
  const fbDur = Math.max(0.15, settings.fireballDuration)
  const fbTemp = Math.max(0.3, settings.fireballTemp)
  const smokeAmt = Math.max(0, settings.smokeAmount * densityScale)

  applyExplosionSmokeLive(volume, settings, densityScale)
  if (smokeAmt > 0.02) {
    const smokeRadius = Math.max(1.6, Math.min(7.5, (2.15 + fbSize * 0.88) * (0.68 + 0.32 * settings.smokeSpreadSpeed)))
    const growthTime = Math.max(0.2, Math.min(1.5, (0.44 * fbSize) / Math.max(0.25, settings.smokeSpreadSpeed)))
    const totalLife = Math.max(0.9, fbDur * 0.65 + settings.smokeLinger)
    volume.spawn(x, z, smokeRadius, totalLife, Math.min(2.0, smokeAmt * 1.05), settings.smokeDarkness, growthTime)
  }

  // 1. Ground scorch mark (drawn first on the ground plane beneath the plume)
  if (settings.scorch) {
    Object.assign(reusableSpec, {
      kind: "scorch",
      life: Math.max(2.2, settings.smokeLinger + 1.2),
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

  // 2. Supersonic ground shockwave & boundary-layer dust ring
  if (settings.shockRing > 0.02) {
    const ringScale = settings.shockRing * Math.sqrt(fbSize)
    Object.assign(reusableSpec, {
      kind: "shock",
      life: 0.42,
      size: 0.52 * fbSize,
      growth: 8.6 * ringScale,
      gravity: 0,
      drag: 8,
      bounce: 0,
      r: 0.64,
      g: 0.58,
      b: 0.50,
      alpha: Math.min(1, 0.82 * settings.shockRing),
      temperature: 0,
      turbulence: 0,
      ease: 2.5,
    })
    particles.spawn(reusableSpec, x, y + 0.035, z, 0, 0, 0, random() * 6.283)

    Object.assign(reusableSpec, {
      kind: "shock",
      life: 0.68,
      size: 0.42 * fbSize,
      growth: 4.5 * ringScale,
      gravity: 0,
      drag: 8,
      bounce: 0,
      r: 0.48,
      g: 0.44,
      b: 0.39,
      alpha: Math.min(1, 0.54 * settings.shockRing),
      temperature: 0,
      turbulence: 0,
      ease: 2.1,
    })
    particles.spawn(reusableSpec, x, y + 0.038, z, 0, 0, 0, random() * 6.283)
  }

  // 3. Turbulent blackbody fireball billows (3 tiers: outer soot-crusting ring, main incandescent dome, superheated core + crown)
  const outerCount = 14
  for (let i = 0; i < outerCount; i++) {
    const a = ((i + (random() - 0.5) * 0.55) / outerCount) * Math.PI * 2
    const r0 = (0.12 + random() * 0.18) * fbSize
    const speed = (1.7 + random() * 2.3) * fbSize
    const vy = (1.8 + random() * 2.8) * fbSize
    const life = fbDur * (1.05 + random() * 0.52)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.42 + random() * 0.20) * fbSize,
      growth: ((0.95 + random() * 0.38) * fbSize) / life,
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
      y + 0.36 + random() * 0.38 * fbSize,
      z + Math.sin(a) * r0,
      Math.cos(a) * speed,
      vy,
      Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  const domeCount = 12
  for (let i = 0; i < domeCount; i++) {
    const a = ((i + 0.5 + (random() - 0.5) * 0.5) / domeCount) * Math.PI * 2
    const r0 = (0.06 + random() * 0.14) * fbSize
    const speed = (1.0 + random() * 1.7) * fbSize
    const vy = (2.6 + random() * 3.6) * fbSize
    const life = fbDur * (0.84 + random() * 0.36)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.46 + random() * 0.22) * fbSize,
      growth: ((1.05 + random() * 0.36) * fbSize) / life,
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
      y + 0.48 + random() * 0.48 * fbSize,
      z + Math.sin(a) * r0,
      Math.cos(a) * speed,
      vy,
      Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + random() * 0.6
    const life = fbDur * (0.46 + random() * 0.16)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.68 + random() * 0.18) * fbSize,
      growth: (1.18 * fbSize) / life,
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
      y + (0.62 + i * 0.18) * fbSize,
      z + Math.sin(a) * 0.06 * fbSize,
      Math.cos(a) * 0.65 * fbSize,
      (2.0 + i * 0.85) * fbSize,
      Math.sin(a) * 0.65 * fbSize,
      random() * 6.283,
    )
  }

  // Anterior soot-crusting crown billows that roll over the hot core
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35 + (random() - 0.5) * 0.35
    const life = fbDur * (1.32 + random() * 0.65)
    Object.assign(reusableSpec, {
      kind: "fireball",
      life,
      size: (0.44 + random() * 0.20) * fbSize,
      growth: (1.08 * fbSize) / life,
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
      y + (0.68 + random() * 0.42) * fbSize,
      z + Math.sin(a) * 0.18 * fbSize,
      Math.cos(a) * 1.45 * fbSize,
      (2.8 + random() * 2.2) * fbSize,
      Math.sin(a) * 1.45 * fbSize,
      random() * 6.283,
    )
  }

  // 4. High-speed ballistic sparks with blackbody cooling and floor/wall restitution
  const sparks = Math.max(0, Math.round(settings.sparkCount))
  const velScale = Math.sqrt(fbSize)
  for (let i = 0; i < sparks; i++) {
    const a = ((i + random() * 0.85) / Math.max(1, sparks)) * Math.PI * 2
    const speed = (6.5 + random() * 13.5) * velScale
    const vy = (2.8 + random() * 9.2) * velScale
    Object.assign(reusableSpec, {
      kind: "spark",
      life: 0.42 + random() * 1.15,
      size: 0.046 + random() * 0.036,
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
      y + 0.35 + random() * 0.35,
      z + Math.sin(a) * 0.15,
      Math.cos(a) * speed,
      vy,
      Math.sin(a) * speed,
      random() * 6.283,
    )
  }

  // 5. Tumbling 3D lit shrapnel / debris splinters with gravity and floor bounces
  const debris = Math.max(0, Math.round(settings.debrisCount))
  for (let i = 0; i < debris; i++) {
    const a = ((i + random() * 0.85) / Math.max(1, debris)) * Math.PI * 2
    const speed = (3.4 + random() * 7.8) * velScale
    const vy = (3.6 + random() * 7.6) * velScale
    const shade = 0.09 + random() * 0.13
    const warm = random() * 0.04
    Object.assign(reusableSpec, {
      kind: "debris",
      life: 1.8 + random() * 2.4,
      size: (0.032 + random() * 0.036) * velScale,
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
      y + 0.24 + random() * 0.3,
      z + Math.sin(a) * 0.22,
      Math.cos(a) * speed,
      vy,
      Math.sin(a) * speed,
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
