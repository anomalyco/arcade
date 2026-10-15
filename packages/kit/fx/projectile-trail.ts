import type { Particles, ParticleSpec } from "./particles"

/** What a trailing or popping particle queues during `Particles.update`. */
export const TrailBirth = { puff: 0, head: 1, splash: 2, pop: 3 } as const

const spec: ParticleSpec = {
  kind: "soft",
  life: 1,
  size: 0.1,
  growth: 0,
  gravity: 0,
  drag: 0,
  bounce: 0,
  r: 1,
  g: 1,
  b: 1,
  alpha: 1,
  temperature: 0,
  turbulence: 0,
  ease: 1,
  trail: 0,
  pop: 0,
}

function set(kind: ParticleSpec["kind"], life: number, size: number, growth: number, gravity: number, drag: number, bounce: number, r: number, g: number, b: number, alpha: number, temperature = 0, turbulence = 0, ease = 1): ParticleSpec {
  spec.kind = kind
  spec.life = life
  spec.size = size
  spec.growth = growth
  spec.gravity = gravity
  spec.drag = drag
  spec.bounce = bounce
  spec.r = r
  spec.g = g
  spec.b = b
  spec.alpha = alpha
  spec.temperature = temperature
  spec.turbulence = turbulence
  spec.ease = ease
  return spec
}

/**
 * One birth from a projectile fragment (`ParticleSpec.trail` > 0) or a secondary pop (`ParticleSpec.pop` > 0).
 * `scale` is the trail or pop scale in metres; `strength` (1 → 0) is how hot the fragment still is.
 */
export function emitTrailBirth(
  pool: Particles,
  type: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  scale: number,
  strength: number,
  random: () => number,
): void {
  if (type === TrailBirth.puff) {
    // Soot from burning debris: dark and dense while hot, thinner, paler and smaller as the fragment cools.
    const shade = 0.035 + 0.13 * (1 - strength)
    set(
      "soft",
      (2.2 + random() * 1.4) * (0.5 + 0.5 * strength),
      0.5 * scale * (0.45 + 0.55 * strength),
      0.5 * scale,
      -0.8,
      0.55,
      0,
      shade * 0.94,
      shade * 0.97,
      shade,
      0.8 * (0.3 + 0.7 * strength),
    )
    pool.spawn(
      spec,
      x,
      y,
      z,
      pool.windX + vx * 0.06 + (random() - 0.5) * 0.35 * scale,
      vy * 0.04 + random() * 0.25 * scale,
      pool.windZ + vz * 0.06 + (random() - 0.5) * 0.35 * scale,
      random() * 6.283,
    )
    return
  }
  if (type === TrailBirth.head) {
    set("spark", 0.12 + random() * 0.14, 0.16 * scale * (0.45 + 0.55 * strength), -0.3 * scale, 0, 3, 0, 1, 0.72, 0.3, 1, 0.35 + 1.15 * strength)
    pool.spawn(spec, x, y, z, vx * 0.12, vy * 0.12, vz * 0.12, random() * 6.283)
    return
  }
  if (type === TrailBirth.splash) {
    spawnWaterSplash(pool, x, y, z, Math.max(0.12, scale * 0.16), random, { height: 0.55, mist: 2, crown: 0 })
    return
  }
  if (type === TrailBirth.pop) spawnSecondaryPop(pool, x, y, z, vx, vy, vz, scale, random)
}

/** A small fireball burst `scale` metres across: three billows, a handful of sparks and a puff of soot. */
export function spawnSecondaryPop(pool: Particles, x: number, y: number, z: number, vx: number, vy: number, vz: number, scale: number, random: () => number): void {
  for (let i = 0; i < 3; i++) {
    const a = random() * 6.283
    const life = 0.38 + random() * 0.22
    set("fireball", life, (0.42 + random() * 0.2) * scale, (1.05 * scale) / life, -3.6, 5.8, 0, 1, 1, 1, 0.94, 1.2 + random() * 0.35, 0.9, 2.7)
    pool.spawn(spec, x + Math.cos(a) * 0.1 * scale, y + 0.1 * scale, z + Math.sin(a) * 0.1 * scale, vx * 0.2 + Math.cos(a) * 1.3 * scale, vy * 0.2 + (0.8 + random() * 1.2) * scale, vz * 0.2 + Math.sin(a) * 1.3 * scale, random() * 6.283)
  }
  const velScale = Math.sqrt(scale)
  for (let i = 0; i < 8; i++) {
    const a = random() * 6.283
    const speed = (4 + random() * 7) * velScale
    set("spark", 0.3 + random() * 0.6, 0.035 * Math.max(1, scale), -0.018, 13.5, 0.82, 0.52, 1, 0.72, 0.28, 1, 1.0 + random() * 0.35)
    pool.spawn(spec, x, y, z, Math.cos(a) * speed, (1.5 + random() * 6) * velScale, Math.sin(a) * speed, random() * 6.283)
  }
  set("soft", 2.2 + random(), 0.5 * scale, 0.7 * scale, -0.9, 0.7, 0, 0.09, 0.085, 0.08, 0.5)
  pool.spawn(spec, x, y + 0.3 * scale, z, pool.windX, 0.4 * scale, pool.windZ, random() * 6.283)
}

export type WaterSplashOptions = {
  /** Column launch speed multiplier (1: a ~35 m column at size 1; bombs use ~2). */
  height?: number
  /** Soft mist billows in the column (default 8). */
  mist?: number
  /** Crown droplets thrown outward (default 14). */
  crown?: number
  /** Base-surge mist rolling out over the water (default 0). */
  surge?: number
}

/**
 * Something hitting the water at (x, y, z), y on the surface: velocity-stretched droplets up a column, a crown of
 * droplets thrown outward, soft white mist and optionally a base surge. `size` 1 is a ~10 m wide splash.
 * Replaces the faceted white spray chunks that read as ice.
 */
export function spawnWaterSplash(pool: Particles, x: number, y: number, z: number, size: number, random: () => number, options: WaterSplashOptions = {}): void {
  const height = options.height ?? 1
  const column = Math.max(4, Math.round(22 * Math.sqrt(Math.min(2.5, size))))
  for (let i = 0; i < column; i++) {
    const a = random() * 6.283
    const r = random() * 2.2 * size
    const out = (0.6 + random() * 2.4) * size
    set("water", 1.6 + random() * 1.3 * Math.sqrt(height), (0.24 + random() * 0.24) * size, 0, 9.81, 0.35, 0, 0.84, 0.9, 0.95, 0.9)
    pool.spawn(spec, x + Math.cos(a) * r, y + 0.2, z + Math.sin(a) * r, Math.cos(a) * out, (14 + random() * 16) * Math.sqrt(size) * height, Math.sin(a) * out, random() * 6.283)
  }
  const crown = options.crown ?? 14
  for (let i = 0; i < crown; i++) {
    const a = ((i + random() * 0.6) / Math.max(1, crown)) * 6.283
    const out = (7 + random() * 9) * Math.sqrt(size)
    set("water", 1.1 + random() * 0.8, (0.16 + random() * 0.14) * size, 0, 9.81, 0.45, 0, 0.86, 0.91, 0.96, 0.78)
    pool.spawn(spec, x + Math.cos(a) * 2 * size, y + 0.2, z + Math.sin(a) * 2 * size, Math.cos(a) * out, (7 + random() * 9) * Math.sqrt(size) * Math.min(1.4, height), Math.sin(a) * out, random() * 6.283)
  }
  const mist = options.mist ?? 6
  for (let i = 0; i < mist; i++) {
    const a = random() * 6.283
    const life = 2.2 + random() * 1.4
    set("soft", life, (2.2 + random() * 1.2) * size, (3.2 + random()) * size / life, 5.5, 0.9, 0, 0.9, 0.93, 0.96, 0.16)
    pool.spawn(spec, x + Math.cos(a) * size, y + 0.6 * size, z + Math.sin(a) * size, pool.windX + Math.cos(a) * size, (6 + random() * 12) * Math.sqrt(size) * height, pool.windZ + Math.sin(a) * size, random() * 6.283)
  }
  const surge = options.surge ?? 0
  for (let i = 0; i < surge; i++) {
    const a = (i / Math.max(1, surge)) * 6.283
    const life = 3 + random()
    set("soft", life, 1.6 * size, (2.6 * size) / life, -0.15, 1.2, 0, 0.9, 0.93, 0.96, 0.4)
    pool.spawn(spec, x + Math.cos(a) * 3 * size, y + 0.8 * size, z + Math.sin(a) * 3 * size, Math.cos(a) * (6 + random() * 4) * size, 0.3, Math.sin(a) * (6 + random() * 4) * size, random() * 6.283)
  }
}
