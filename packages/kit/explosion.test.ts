import { expect, test } from "bun:test"
import {
  applyExplosionSmokeLive,
  computeExplosionLod,
  EXPLOSION_PRESET_IDS,
  EXPLOSION_PRESETS,
  explosionDefaults,
  explosionFlashLight,
  explosionRanges,
  explosionSettings,
  resolveExplosionSettings,
  spawnExplosion,
  type ExplosionNumericKey,
} from "./fx/explosion"
import { Particles, PARTICLE_STRIDE } from "./fx/particles"
import { SmokeVolumes, VOLUMES } from "./fx/volume"

function seededRng(seed = 7) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    return (seed >>> 0) / 4294967296
  }
}

test("explosionSettings clamps numeric ranges and preserves scorch toggle", () => {
  const clamped = explosionSettings({
    fireballSize: 99,
    fireballDuration: -2,
    smokeColorShift: 1.8,
    sparkCount: -10,
    scorch: false,
  })
  expect(clamped.fireballSize).toBe(explosionRanges.fireballSize[1])
  expect(clamped.fireballDuration).toBe(explosionRanges.fireballDuration[0])
  expect(clamped.smokeColorShift).toBe(explosionRanges.smokeColorShift[1])
  expect(clamped.sparkCount).toBe(explosionRanges.sparkCount[0])
  expect(clamped.scorch).toBe(false)

  for (const key of Object.keys(explosionRanges) as ExplosionNumericKey[]) {
    const [min, max] = explosionRanges[key]
    expect(explosionDefaults[key]).toBeGreaterThanOrEqual(min)
    expect(explosionDefaults[key]).toBeLessThanOrEqual(max)
  }
})

test("all seven typed explosion presets are within valid bounds and resolve macro parameters", () => {
  expect(EXPLOSION_PRESET_IDS).toEqual(["grenade", "propane", "car", "barrel", "missile", "ship", "pop"])
  for (const id of EXPLOSION_PRESET_IDS) {
    const preset = EXPLOSION_PRESETS[id]
    expect(preset.id).toBe(id)
    for (const key of Object.keys(explosionRanges) as ExplosionNumericKey[]) {
      const [min, max] = explosionRanges[key]
      expect(preset.settings[key]).toBeGreaterThanOrEqual(min)
      expect(preset.settings[key]).toBeLessThanOrEqual(max)
    }
  }
  expect(EXPLOSION_PRESETS.missile.settings.scorch).toBe(false)
  expect(EXPLOSION_PRESETS.car.settings.fireballSize).toBeGreaterThan(EXPLOSION_PRESETS.grenade.settings.fireballSize)
  expect(EXPLOSION_PRESETS.ship.settings.smokeAmount).toBeGreaterThan(EXPLOSION_PRESETS.propane.settings.smokeAmount)
  expect(EXPLOSION_PRESETS.pop.settings.fireballSize).toBeLessThan(EXPLOSION_PRESETS.grenade.settings.fireballSize)

  const custom = resolveExplosionSettings({
    preset: "propane",
    size: 1.2,
    energy: 1.1,
    fuel: 1.15,
    smoke: 0.8,
    debris: 1.5,
    scorch: false,
    flash: 0.9,
    shockwave: 1.1,
  })
  expect(custom.scorch).toBe(false)
  expect(custom.fireballSize).toBeGreaterThan(EXPLOSION_PRESETS.propane.settings.fireballSize)
  expect(custom.debrisCount).toBe(Math.round(EXPLOSION_PRESETS.propane.settings.debrisCount * 1.5))
})

test("spawnExplosion emits scorch, shock rings, fireball billows, sparks, debris, and soot volume deterministically", () => {
  const p1 = new Particles()
  const v1 = new SmokeVolumes()
  v1.reset([], 7)
  spawnExplosion(p1, v1, -1, 0, 0, explosionDefaults, seededRng(7))

  const p2 = new Particles()
  const v2 = new SmokeVolumes()
  v2.reset([], 7)
  spawnExplosion(p2, v2, -1, 0, 0, explosionDefaults, seededRng(7))

  expect(p1.count).toBeGreaterThan(80)
  expect(p1.count).toBe(p2.count)
  expect(p1.data.subarray(0, p1.count * PARTICLE_STRIDE)).toEqual(p2.data.subarray(0, p2.count * PARTICLE_STRIDE))
  expect(v1.count).toBe(1)
  expect(v1.colorShift).toBeCloseTo(explosionDefaults.smokeColorShift, 5)
  expect(v1.coreGlow).toBeGreaterThan(1)

  // Verify kinds present: 6 (scorch), 5 (shock), 7 (fireball), 1 (spark), 2 (debris)
  const kinds = new Set<number>()
  for (let i = 0; i < p1.count; i++) {
    kinds.add(p1.data[i * PARTICLE_STRIDE + 16]!)
  }
  expect(kinds.has(6)).toBe(true)
  expect(kinds.has(5)).toBe(true)
  expect(kinds.has(7)).toBe(true)
  expect(kinds.has(1)).toBe(true)
  expect(kinds.has(2)).toBe(true)

  // Airburst omits ground scorch and ground smoke volume
  const pAir = new Particles()
  const vAir = new SmokeVolumes()
  vAir.reset([], 7)
  spawnExplosion(pAir, vAir, 0, 80, 0, EXPLOSION_PRESETS.missile.settings, seededRng(7), 4, 1, { airburst: true })
  expect(vAir.count).toBe(0)
  const airKinds = new Set<number>()
  for (let i = 0; i < pAir.count; i++) airKinds.add(pAir.data[i * PARTICLE_STRIDE + 16]!)
  expect(airKinds.has(6)).toBe(false)
  expect(airKinds.has(5)).toBe(true)
  expect(airKinds.has(7)).toBe(true)

  // Advance simulation and verify ease-out expansion & finite instance preparation
  for (let f = 0; f < 60; f++) {
    p1.update(1 / 60)
    v1.update(1 / 60)
  }
  p1.prepare()
  expect(p1.instances.subarray(0, p1.count * 16).every(Number.isFinite)).toBe(true)
  expect(v1.density.every(Number.isFinite)).toBe(true)
})

test("explosionFlashLight peaks at detonation and decays to null after fireball settles", () => {
  const f0 = explosionFlashLight(0, 0, 0, 0.02, explosionDefaults)
  const fMid = explosionFlashLight(0, 0, 0, 0.25, explosionDefaults)
  const fLate = explosionFlashLight(0, 0, 0, 1.5, explosionDefaults)
  const fOff = explosionFlashLight(0, 0, 0, 0.02, { ...explosionDefaults, flashIntensity: 0 })

  expect(f0).not.toBeNull()
  expect(fMid).not.toBeNull()
  expect(f0!.power).toBeGreaterThan(fMid!.power)
  expect(fLate).toBeNull()
  expect(fOff).toBeNull()

  const v = new SmokeVolumes()
  applyExplosionSmokeLive(v, { ...explosionDefaults, smokeRise: 1.1, smokeColorShift: 0.9 })
  expect(v.settings.rise).toBeCloseTo(1.1, 5)
  expect(v.colorShift).toBeCloseTo(0.9, 5)
})

test("computeExplosionLod and SmokeVolumes cap concurrent load and coalesce nearby blasts", () => {
  const lod0 = computeExplosionLod(0, 10, 24)
  const lodDist = computeExplosionLod(0, 60, 24)
  const lodCrowd = computeExplosionLod(650, 10, 24)

  expect(lod0.tier).toBe(0)
  expect(lod0.countScale).toBe(1)
  expect(lodDist.countScale).toBeLessThan(0.6)
  expect(lodCrowd.countScale).toBeLessThan(0.6)
  expect(lodCrowd.sizeCompensation).toBeGreaterThan(1.05)

  // Grenade spam at the same spot coalesces into 1 volume slot; 6 widely spaced blasts cap at VOLUMES (4)
  const p = new Particles()
  const v = new SmokeVolumes()
  v.reset([], 7)
  for (let i = 0; i < 4; i++) {
    spawnExplosion(p, v, 0 + i * 0.8, 0, 0, EXPLOSION_PRESETS.grenade.settings, seededRng(7 + i))
  }
  expect(v.count).toBe(1)

  for (let i = 0; i < 6; i++) {
    spawnExplosion(p, v, i * 12, 0, 0, EXPLOSION_PRESETS.grenade.settings, seededRng(20 + i))
    v.update(1 / 60)
  }
  expect(v.count).toBeLessThanOrEqual(VOLUMES)
  expect(p.count).toBeLessThan(800)
})

const countKind = (p: Particles, kind: number) => {
  let n = 0
  for (let i = 0; i < p.count; i++) if (p.data[i * PARTICLE_STRIDE + 16] === kind) n++
  return n
}
const countTrailing = (p: Particles) => {
  let n = 0
  for (let i = 0; i < p.count; i++) if (p.data[i * PARTICLE_STRIDE + 22]! > 0) n++
  return n
}

test("ship hits throw burning fragments that lay their own smoke trails, pop, and splash into water", () => {
  const p = new Particles()
  p.water = 0
  spawnExplosion(p, null, 0, 28, 0, EXPLOSION_PRESETS.ship.settings, seededRng(3), 5, 1, { distanceToEye: 150, referenceDist: 160 })
  expect(countTrailing(p)).toBe(EXPLOSION_PRESETS.ship.settings.fragmentCount)
  const soft0 = countKind(p, 0)
  let fireballsAfterPops = 0
  for (let f = 0; f < 60; f++) {
    p.update(1 / 60, [], () => -1e9)
    if (f === 40) fireballsAfterPops = countKind(p, 7)
  }
  expect(countKind(p, 0)).toBeGreaterThan(soft0 + 150)
  expect(fireballsAfterPops).toBeGreaterThan(0)
  for (let f = 0; f < 180; f++) p.update(1 / 60, [], () => -1e9)
  expect(countTrailing(p)).toBeLessThan(EXPLOSION_PRESETS.ship.settings.fragmentCount)
  expect(countKind(p, 3)).toBeGreaterThan(0)
})

test("small blasts keep no trailing fragments and the pool never overflows its trail budget", () => {
  for (const id of ["grenade", "pop"] as const) {
    const p = new Particles()
    spawnExplosion(p, null, 0, 0, 0, EXPLOSION_PRESETS[id].settings, seededRng(5))
    expect(countTrailing(p)).toBe(0)
  }
  const p = new Particles()
  p.water = 0
  for (let i = 0; i < 6; i++) spawnExplosion(p, null, i * 20, 28, 0, EXPLOSION_PRESETS.ship.settings, seededRng(i + 1), 5, 1, { referenceDist: 160 })
  for (let f = 0; f < 240; f++) p.update(1 / 60, [], () => -1e9)
  expect(p.count).toBeLessThanOrEqual(2048)
})
