import type { Lamp } from "../../shared/map"
import { putSprite, smoothstep } from "./light-probe"

/**
 * Moths and flies: small swarms whose flight is a pure function of time and a seeded phase (no state, nothing
 * allocated per frame), drawn as renderer sprites so they sit in the TAA reactive mask. Moths circle the lit fixtures
 * and take their glow from the lamp itself, so they are there exactly while a lamp is on and fade with a dying one.
 * Flies are dark specks over bodies and bins, seen by day in sight and at night only where a torch finds them.
 */

export type MothLamp = { lamp: number; x: number; y: number; z: number; n: number; seed: number; tint: readonly [number, number, number] }
export type FlySite = { key: string; /** Ledger store of the body (empty for bins). */ store: string; x: number; y: number; z: number; n: number; seed: number; spread: number }

/** Most moths around one fixture, and most flies over one site. */
export const MOTHS_PER_LAMP = 7
export const FLIES_PER_SITE = 9

const fract = (v: number) => v - Math.floor(v)
const r01 = (seed: number, i: number) => fract(Math.sin(seed * 0.000123 + i * 12.9898 + seed * 78.233) * 43758.5453)

/** Where on a lamp the moths gather (just under the fixture the light comes from) and how many, by kind. */
export function mothLamps(lamps: readonly Lamp[], townSeed: number, density: number): MothLamp[] {
  const out: MothLamp[] = []
  if (density <= 0) return out
  for (let i = 0; i < lamps.length; i++) {
    const l = lamps[i]!
    if (l.kind === "room") continue
    const seed = (Math.imul(townSeed | 0, 0x9e3779b1) ^ Math.imul(Math.round(l.x * 10), 0x85ebca6b) ^ Math.imul(Math.round(l.y * 10), 0xc2b2ae35)) >>> 0
    const base = l.kind === "street" ? 4 + r01(seed, 1) * 3 : l.kind === "porch" ? 3 + r01(seed, 1) * 2.5 : 1 + r01(seed, 1) * 2.2
    const n = Math.min(MOTHS_PER_LAMP, Math.round(base * density))
    if (n <= 0) continue
    // The bulbs the level and the streamer build (absolute heights, like the lights): the street head out on its arm,
    // the porch bulb under the canopy, a lit window's pane.
    const tint = l.kind === "street" ? ([1, 0.62, 0.3] as const) : ([1, 0.74, 0.46] as const)
    if (l.kind === "street") out.push({ lamp: i, x: l.x + 0.55, y: 3.42, z: l.y, n, seed, tint })
    else if (l.kind === "porch") out.push({ lamp: i, x: l.x, y: 2.16, z: l.y - 0.22, n, seed, tint })
    else out.push({ lamp: i, x: l.x, y: 1.5, z: l.y + 0.24, n, seed, tint })
  }
  return out
}

/**
 * Additive moth sprites for every lamp in `view` whose fixture is lit (`lampPower` per town lamp, the frame lighting's
 * fixture brightness). Each moth loops the bulb on its own radius and speed, darts in and out, and turns back now and
 * then; it is brightest close to the bulb. Returns the new sprite count.
 */
export function writeMoths(lamps: readonly MothLamp[], lampPower: Float32Array, time: number, view: readonly [number, number, number, number], sprites: Float32Array, n: number, gain: number): number {
  const [x0, z0, x1, z1] = view
  for (const m of lamps) {
    if (m.x < x0 - 1 || m.x > x1 + 1 || m.z < z0 - 1 || m.z > z1 + 1) continue
    const lit = smoothstep(0.04, 0.5, lampPower[m.lamp] ?? 0)
    if (lit <= 0.01) continue
    for (let i = 0; i < m.n; i++) {
      const a = r01(m.seed, i * 7 + 2)
      const b = r01(m.seed, i * 7 + 3)
      const c = r01(m.seed, i * 7 + 4)
      const dir = r01(m.seed, i * 7 + 5) < 0.5 ? -1 : 1
      const w = (2.2 + a * 3.2) * dir
      // Turn-backs: the angle swings with a slow sine on top of the steady loop.
      const theta = a * 6.283 + w * time + 1.6 * Math.sin(time * (0.7 + b) + c * 9)
      const rad = (m.n > 3 ? 0.18 + b * 0.42 : 0.12 + b * 0.3) * (0.75 + 0.35 * Math.sin(time * (2.3 + c * 2) + a * 11))
      const x = m.x + Math.cos(theta) * rad
      const z = m.z + Math.sin(theta) * rad * 0.8
      const y = m.y + (c - 0.5) * 0.36 + 0.12 * Math.sin(time * (3.1 + a * 2.5) + b * 7)
      const near = 1 / (1 + (rad / 0.35) ** 2)
      // Wings catch the light as they turn: a smooth swell, never a frame-to-frame strobe.
      const wing = 0.72 + 0.28 * Math.sin(time * (5 + b * 4) + c * 20)
      const k = lit * near * wing * gain * 0.55
      // rgb carries the brightness and alpha stays low, so the sprite barely touches the colour mask in hdr.a.
      n = putSprite(sprites, n, x, y, z, 0.055, (m.tint[0] * k) / 0.25, (m.tint[1] * k) / 0.25, (m.tint[2] * k) / 0.25, 0.25)
    }
  }
  return n
}

/**
 * Alpha sprites for the flies over each site in `view`: tight, jittery loops that dip and climb. `light(x, z)` is how
 * well the site is lit for the eye (daylight in sight, a torch, a lamp); unlit sites draw nothing.
 */
export function writeFlies(sites: readonly FlySite[], light: (s: FlySite) => number, time: number, view: readonly [number, number, number, number], sprites: Float32Array, n: number): number {
  const [x0, z0, x1, z1] = view
  for (const s of sites) {
    if (s.x < x0 - 1 || s.x > x1 + 1 || s.z < z0 - 1 || s.z > z1 + 1) continue
    const lit = light(s)
    if (lit <= 0.02) continue
    for (let i = 0; i < s.n; i++) {
      const a = r01(s.seed, i * 5 + 1)
      const b = r01(s.seed, i * 5 + 2)
      const c = r01(s.seed, i * 5 + 3)
      const t = time * (1.4 + a * 1.2)
      const x = s.x + s.spread * (Math.sin(t * 3.1 + a * 20) * 0.6 + Math.sin(t * 7.3 + b * 13) * 0.25)
      const z = s.z + s.spread * (Math.cos(t * 2.7 + b * 17) * 0.6 + Math.sin(t * 6.1 + c * 9) * 0.25)
      const y = s.y + 0.12 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.9 + c * 31)) * (0.4 + 0.6 * a)
      n = putSprite(sprites, n, x, y, z, 0.034, 0.012, 0.011, 0.01, Math.min(0.85, lit * 0.9))
    }
  }
  return n
}

