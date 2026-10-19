import type { AIAgent } from "@arcade/kit/sim/ai"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import type { BonePose } from "@arcade/kit/human-pose"
import type { StoreState } from "@arcade/kit/sim/ledger"
import {
  blastAge,
  BURN_RING,
  burnZombie,
  burning,
  CRACK_BEAT,
  CRACK_RING,
  crackerAt,
  crackerPops,
  dynamiteAt,
  DYN_RING,
  FIRE_RING,
  fireHash,
  fireLit,
  lifeAge,
  ringId,
} from "../../shared/fire/fire"
import { reachFrom } from "../../shared/fire/runtime"
import type { SessionView } from "../../shared/session"
import type { OutbreakFireSettings } from "./settings"

/**
 * Fire, drawn. Every particle is analytic: a seeded phase on the clock, never a simulated birth, so it costs no
 * allocation, holds still under any frame rate and looks the same on every client. Flames are additive (they are
 * light); smoke goes in the alpha list (it occludes). Shapes are soft and a few tens of centimetres across at least,
 * so nothing glitters at gameplay zoom (`docs/outbreak-art-direction.md`).
 *
 * Colour follows a blackbody ramp by age: white-yellow where fuel is hottest, orange, then a deep red at the tips,
 * and soot above. The stream is a liquid jet: fast and thin from the nozzle, slowing and billowing where it comes
 * down (Alien Swarm's and Teleglitch's top-down flamers read by that lengthening cone and the fire it leaves).
 */

export type FireSurvivor = { id: string; x: number; y: number; aim: number }

export type FireFrame = {
  view: SessionView
  /** Every survivor in the room as drawn (the local one predicted). */
  survivors: readonly FireSurvivor[]
  support: (x: number, z: number) => number
  look: OutbreakFireSettings
  /** The rig's bones for a zombie, when it is drawn this frame. */
  bones?: (id: number) => BonePose | undefined
}

type Push = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind?: number, rot?: number, stretch?: number) => void

const fract = (v: number) => v - Math.floor(v)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Blackbody-ish ramp: 0 hottest (white-yellow) .. 1 coolest (deep red). */
export function flameColour(u: number): [number, number, number] {
  if (u < 0.18) {
    const k = u / 0.18
    return [1, 0.93 - 0.25 * k, 0.68 - 0.42 * k]
  }
  if (u < 0.6) {
    const k = (u - 0.18) / 0.42
    return [1, 0.68 - 0.28 * k, 0.26 - 0.16 * k]
  }
  const k = Math.min(1, (u - 0.6) / 0.4)
  return [1 - 0.22 * k, 0.4 - 0.24 * k, 0.1 - 0.06 * k]
}

/** The flicker every flame and its light share: smooth, band-limited (a few Hz), never a per-frame random. */
export const flicker = (time: number, seed: number) => 0.84 + 0.1 * Math.sin(time * 9.1 + seed) + 0.06 * Math.sin(time * 17.3 + seed * 1.7)

function writer(sprites: Float32Array, count: { n: number }): Push {
  const max = Math.floor(sprites.length / SPRITE_FLOATS)
  return (x, y, z, size, r, g, b, a, kind = 0, rot = 0, stretch = 1) => {
    if (count.n >= max || a <= 0.003 || size <= 0) return
    const o = count.n++ * SPRITE_FLOATS
    sprites[o] = x
    sprites[o + 1] = y
    sprites[o + 2] = z
    sprites[o + 3] = size
    sprites[o + 4] = r
    sprites[o + 5] = g
    sprites[o + 6] = b
    sprites[o + 7] = a
    sprites[o + 8] = kind
    sprites[o + 9] = rot
    sprites[o + 10] = stretch
    sprites[o + 11] = 0
  }
}

const RANGE = 34

const near = (view: SessionView, x: number, y: number) => Math.abs(x - view.player.x) < RANGE && Math.abs(y - view.player.y) < RANGE

function* ring(view: SessionView, prefix: string, size: number): Generator<StoreState> {
  for (let k = 0; k < size; k++) {
    const st = view.progression.ledger.store(ringId(prefix, k))
    if (st) yield st
  }
}

/** Each survivor spraying now: where from, which way, how far the stream reaches, and since when. */
export function sprayers(frame: FireFrame): { s: FireSurvivor; reach: number; since: number }[] {
  const out: { s: FireSurvivor; reach: number; since: number }[] = []
  const { view } = frame
  for (const s of frame.survivors) {
    const st = view.progression.ledger.store(`flamer:${s.id}`)
    if (!st?.counts.on || !near(view, s.x, s.y)) continue
    out.push({ s, reach: reachFrom(view.town, s.x, s.y, s.aim, frame.look.flameRange), since: (st.counts.t ?? 0) / 10 })
  }
  return out
}

/** The nozzle of a held flamethrower: in front of the right hip, a hand's height up. */
export function nozzle(s: FireSurvivor, g: number): { x: number; y: number; z: number } {
  const dx = Math.cos(s.aim)
  const dy = Math.sin(s.aim)
  return { x: s.x + dx * 0.62 - dy * 0.16, y: g + 0.98, z: s.y + dy * 0.62 + dx * 0.16 }
}

const BURN_BONES = ["torso", "head", "pelvis", "left.upperArm", "right.upperArm", "left.foreArm", "right.foreArm", "left.thigh", "right.thigh"] as const

/** The zombies by id, for the frame. */
function agentMap(view: SessionView): Map<number, AIAgent> {
  const m = new Map<number, AIAgent>()
  for (const a of view.zombies) m.set(a.id, a)
  return m
}

/** How strongly a burn store's zombie burns at `time`: catching, full, then guttering in its last second. */
function burnLevel(st: StoreState, time: number): number {
  const t = (st.counts.t ?? 0) / 10
  const until = (st.counts.until ?? 0) / 10
  return smooth(0, 0.35, time - t) * clamp01((until - time) / 1.2)
}

/**
 * Additive flame sprites: the stream, burning figures, fire on the ground, fuses and blasts, firecracker pops and the
 * flare gun's streak. Returns the new count.
 */
export function fireAddSprites(frame: FireFrame, sprites: Float32Array, start: number): number {
  const count = { n: start }
  const push = writer(sprites, count)
  const { view, look, support } = frame
  const time = view.time
  const bright = look.flameBrightness
  const dens = Math.max(0.2, look.flameDensity)
  const embers = look.fireEmbers

  // ── The stream ──
  const tan = Math.tan((look.flameCone * Math.PI) / 180)
  for (const { s, reach, since } of sprayers(frame)) {
    const g = support(s.x, s.y)
    const n0 = nozzle(s, g)
    const dx = Math.cos(s.aim)
    const dy = Math.sin(s.aim)
    const seed = s.id.length * 13 + s.id.charCodeAt(s.id.length - 1)
    const grow = smooth(0, 0.18, time - since)
    const len = reach * (0.25 + 0.75 * grow)
    const N = Math.round(46 * dens)
    for (let i = 0; i < N; i++) {
      const rate = 2.2 + fireHash(i, seed) * 0.9
      const ph = time * rate + i / N
      const cycle = Math.floor(ph)
      const u = ph - cycle
      // Only fuel let go since the trigger went down.
      if (time - u / rate < since - 0.02) continue
      const lat = (fireHash(i * 131 + cycle, seed + 3) - 0.5) * 2
      const ver = fireHash(i * 71 + cycle, seed + 5) - 0.5
      const dist = len * (1 - Math.pow(1 - u, 1.7))
      const spread = tan * dist * 0.9
      const x = n0.x + dx * dist - dy * lat * spread
      const z = n0.z + dy * dist + dx * lat * spread
      const gy = support(x, z)
      const sink = (n0.y - gy - 0.25) * u * u
      const billow = 0.7 * smooth(0.55, 1, u) * u
      const y = n0.y - sink + ver * spread * 0.5 + billow
      const [r, gg, b] = flameColour(Math.min(1, u * 1.05 + 0.08 * fireHash(i, cycle)))
      const size = 0.08 + 0.62 * Math.pow(u, 0.85) + 0.3 * smooth(0.6, 1, u)
      const a = bright * smooth(0, 0.05, u) * (1 - smooth(0.7, 1, u)) * (0.32 + 0.3 * (1 - u))
      push(x, y, z, size, r, gg, b, a)
    }
    // The hot core: a tight bright jet through the first third.
    const C = Math.round(12 * dens)
    for (let i = 0; i < C; i++) {
      const u = fract(time * 4.3 + i / C)
      const dist = len * 0.42 * u
      const w = (fireHash(i, Math.floor(time * 4.3 + i / C)) - 0.5) * 0.12 * u
      push(n0.x + dx * dist - dy * w, n0.y - 0.05 * u, n0.z + dy * dist + dx * w, 0.07 + 0.14 * u, 1, 0.9, 0.7, bright * 0.55 * (1 - u * 0.6))
    }
    // Where it comes down: a low glow on the ground under the fire.
    const ex = n0.x + dx * len * 0.82
    const ez = n0.z + dy * len * 0.82
    push(ex, support(ex, ez) + 0.03, ez, 1.1 + 0.4 * len * tan, 1, 0.42, 0.12, 0.08 * bright * flicker(time, seed))
    // Embers spun up off the end.
    const E = Math.round(9 * embers)
    for (let i = 0; i < E; i++) {
      const u = fract(time * 0.7 + fireHash(i, seed + 9))
      const ang = time * 2.3 + i * 2.1
      const r = 0.25 + 0.5 * u
      push(ex + Math.cos(ang) * r, support(ex, ez) + 0.5 + u * 2.4, ez + Math.sin(ang) * r, 0.045 + 0.02 * (1 - u), 1, 0.55, 0.15, 0.7 * (1 - u) * (u > 0.04 ? 1 : u / 0.04))
    }
  }

  // ── A held flamethrower's pilot light (the local survivor, when not spraying) ──
  const me = frame.survivors.find((x) => x.id === view.actorId)
  if (me && view.progression.selected(view.actorId)?.item === "flamethrower" && !view.progression.ledger.store(`flamer:${me.id}`)?.counts.on) {
    const n0 = nozzle(me, support(me.x, me.y))
    const k = flicker(time, 3)
    push(n0.x, n0.y + 0.01, n0.z, 0.07 * k, 0.45, 0.62, 1, 0.55 * bright)
    push(n0.x, n0.y + 0.05, n0.z, 0.05 * k, 1, 0.7, 0.35, 0.45 * bright)
  }

  // ── Burning figures ──
  const agents = agentMap(view)
  for (const st of ring(view, "burn", BURN_RING)) {
    const z = agents.get(burnZombie(st))
    if (!z || !near(view, z.x, z.y)) continue
    if (burning(st, time)) {
      const lvl = burnLevel(st, time) * bright
      const bones = frame.bones?.(z.id)
      const g = support(z.x, z.y)
      const seed = z.id * 7
      let b = 0
      for (const name of BURN_BONES) {
        const f = bones?.[name]
        const px = f ? f.p[0] : z.x
        const py = f ? f.p[1] : g + 0.4 + b * 0.12
        const pz = f ? f.p[2] : z.y
        const K = Math.max(1, Math.round((name === "torso" ? 4 : name === "head" || name === "pelvis" ? 2 : 1.5) * dens))
        for (let j = 0; j < K; j++) {
          const h = fireHash(seed + b * 31, j)
          const u = fract(time * (1.7 + h * 0.9) + h)
          const sway = Math.sin(time * 5 + h * 9) * 0.06 * u
          const ox = (fireHash(seed + b, j + 7) - 0.5) * 0.16
          const oz = (fireHash(seed + b, j + 11) - 0.5) * 0.16
          const [r, gg, bb] = flameColour(0.1 + u * 0.85)
          push(px + ox + sway, py + 0.04 + u * (name === "torso" || name === "head" ? 0.55 : 0.35), pz + oz, 0.1 + 0.2 * (1 - u * 0.7), r, gg, bb, 0.5 * lvl * Math.pow(1 - u, 1.2))
        }
        b++
      }
      // The hot heart of it, low in the chest.
      const torso = bones?.torso
      push(torso ? torso.p[0] : z.x, torso ? torso.p[1] : g + 1.1, torso ? torso.p[2] : z.y, 0.32, 1, 0.75, 0.38, 0.32 * lvl * flicker(time, seed))
      const E = Math.round(3 * embers)
      for (let i = 0; i < E; i++) {
        const u = fract(time * 0.6 + fireHash(seed, i + 40))
        const ang = time * 2.7 + i * 2.4 + seed
        push(z.x + Math.cos(ang) * 0.3 * u, g + 1.4 + u * 2, z.y + Math.sin(ang) * 0.3 * u, 0.04, 1, 0.5, 0.14, 0.6 * (1 - u) * lvl)
      }
    } else if (st.counts.dead) {
      // A charred body smoulders a while: a dull red glow that fades.
      const age = time - (st.counts.dead ?? 0) / 10
      if (age < 0 || age > 14) continue
      const k = (1 - age / 14) * bright
      const g = support(z.x, z.y)
      push(z.x, g + 0.12, z.y, 0.32, 0.9, 0.22, 0.05, 0.22 * k * (0.75 + 0.25 * Math.sin(time * 2.1 + z.id)))
      push(z.x + 0.25, g + 0.1, z.y - 0.15, 0.2, 1, 0.35, 0.08, 0.14 * k * (0.75 + 0.25 * Math.sin(time * 1.6 + z.id * 3)))
    }
  }

  // ── Fire on the ground ──
  for (const st of ring(view, "fire", FIRE_RING)) {
    if (!fireLit(st, time) || !near(view, st.at!.x, st.at!.y)) continue
    const { x, y } = st.at!
    const r = (st.counts.r ?? 0) / 100
    const t0 = (st.counts.t ?? 0) / 10
    const age = lifeAge(st, time)
    const lvl = smooth(0, 0.12, time - t0) * (1 - smooth(0.65, 1, age)) * bright
    const seed = Math.round(x * 31 + y * 17)
    const M = Math.max(3, Math.min(40, Math.round(r * r * 7 * dens)))
    const tall = 0.35 + r * 0.22
    for (let i = 0; i < M; i++) {
      const h = fireHash(seed, i)
      const rr = Math.sqrt(fireHash(seed + 1, i)) * r * 0.85
      const ang = fireHash(seed + 2, i) * Math.PI * 2
      const fx = x + Math.cos(ang) * rr
      const fz = y + Math.sin(ang) * rr
      const u = fract(time * (1.5 + h) + h)
      const edge = 1 - 0.5 * (rr / Math.max(0.1, r))
      const [cr, cg, cb] = flameColour(0.12 + u * 0.85)
      push(fx + Math.sin(time * 4 + h * 7) * 0.05 * u, support(fx, fz) + 0.05 + u * tall * edge, fz, (0.16 + 0.24 * (1 - u)) * (0.7 + 0.3 * edge), cr, cg, cb, 0.42 * lvl * Math.pow(1 - u, 1.1))
    }
    // A molotov's whoosh as it bursts.
    if (st.counts.src === 1 && time - t0 < 0.4) {
      const k = (time - t0) / 0.4
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2
        push(x + Math.cos(ang) * r * 0.7 * k, support(x, y) + 0.3 + k * 0.8, y + Math.sin(ang) * r * 0.7 * k, 0.6 + k * 0.6, 1, 0.6, 0.2, 0.5 * (1 - k) * bright)
      }
    }
    push(x, support(x, y) + 0.03, y, r * 1.5 + 0.4, 1, 0.42, 0.12, 0.1 * lvl * flicker(time, seed))
    if (embers > 0 && r > 1) {
      for (let i = 0; i < Math.round(4 * embers); i++) {
        const u = fract(time * 0.55 + fireHash(seed, i + 60))
        const ang = time * 1.9 + i * 1.7
        push(x + Math.cos(ang) * r * 0.5 * u, support(x, y) + 0.4 + u * 2.6, y + Math.sin(ang) * r * 0.5 * u, 0.045, 1, 0.5, 0.14, 0.65 * (1 - u) * lvl)
      }
    }
  }

  // ── Dynamite: the fuse, then the blast ──
  for (const st of ring(view, "dyn", DYN_RING)) {
    if (!st.counts.t || !st.at || !near(view, st.at.x, st.at.y)) continue
    const age = blastAge(st, time)
    if (age < 0) {
      const p = dynamiteAt(st, time)
      const g = support(p.x, p.y)
      const k = flicker(time * 2.5, st.counts.t)
      push(p.x, g + p.h + 0.08, p.y, 0.09 * k, 1, 0.92, 0.7, 0.9 * bright)
      push(p.x, g + p.h + 0.08, p.y, 0.26, 1, 0.55, 0.15, 0.25 * bright * k)
      for (let i = 0; i < 6; i++) {
        const u = fract(time * 5.5 + i / 6)
        const ang = fireHash(st.counts.t, i + Math.floor(time * 5.5 + i / 6) * 7) * Math.PI * 2
        push(p.x + Math.cos(ang) * 0.3 * u, g + p.h + 0.08 + 0.25 * u - 0.3 * u * u, p.y + Math.sin(ang) * 0.3 * u, 0.025, 1, 0.75, 0.3, 0.9 * (1 - u))
      }
      continue
    }
    if (age > 3) continue
    const { x, y } = st.at
    const g = support(x, y)
    const R = look.dynRadius
    const seed = st.counts.t
    // The flash: a white ball, gone in a blink.
    if (age < 0.16) push(x, g + 1, y, R * 1.3 * (0.6 + age * 3), 1, 0.92, 0.78, (1 - age / 0.16) * 1.1 * look.blastFlash)
    // The fireball: billows thrown out and up, cooling from white through orange to red and out.
    for (let i = 0; i < 16; i++) {
      const h = fireHash(seed, i)
      const ang = h * Math.PI * 2
      const k = 1 - Math.pow(1 - Math.min(1, age / 0.55), 2.2)
      const out = R * (0.15 + 0.4 * fireHash(seed, i + 20)) * k
      const u = clamp01(age / (0.7 + 0.5 * fireHash(seed, i + 40)))
      const [r, gg, b] = flameColour(Math.min(1, u * 1.1))
      push(x + Math.cos(ang) * out, g + 0.4 + age * (1.1 + h) + out * 0.2, y + Math.sin(ang) * out, (0.7 + 1.3 * k) * (0.7 + 0.5 * h), r, gg, b, 0.55 * bright * (1 - smooth(0.4, 1, u)))
    }
    // The shock ring along the ground.
    if (age < 0.4) push(x, g + 0.05, y, R * 1.25 * smooth(0, 0.4, age), 1, 0.75, 0.5, 0.45 * (1 - age / 0.4), 2, 0, 0.12)
    // Burning bits on their arcs.
    for (let i = 0; i < 26; i++) {
      const life = 0.8 + fireHash(seed, i + 70) * 0.9
      if (age > life) continue
      const ang = fireHash(seed, i + 90) * Math.PI * 2
      const sp = 3 + fireHash(seed, i + 110) * 6
      const up = 2 + fireHash(seed, i + 130) * 5
      const px = x + Math.cos(ang) * sp * age
      const pz = y + Math.sin(ang) * sp * age
      const py = Math.max(support(px, pz) + 0.03, g + 0.3 + up * age - 4.9 * age * age)
      push(px, py, pz, 0.05, 1, 0.6, 0.2, 0.9 * (1 - age / life) * bright)
    }
  }

  // ── Firecrackers: the string glowing where it has got to, a flash and sparks on each pop ──
  for (const st of ring(view, "crack", CRACK_RING)) {
    if (!fireLit(st, time) || !near(view, st.at!.x, st.at!.y)) continue
    const at = crackerAt(st, time)
    const g = support(at.x, at.y)
    push(at.x, g + 0.05, at.y, 0.1, 1, 0.3, 0.12, 0.35 * bright * flicker(time * 3, st.counts.t ?? 0))
    const since = time - (st.counts.t ?? 0) / 10
    const beat = Math.floor(since / CRACK_BEAT)
    for (let b = beat; b >= Math.max(0, beat - 1); b--) {
      if (!crackerPops(st.counts.t ?? 0, b)) continue
      const age = since - b * CRACK_BEAT
      if (age > 0.22) continue
      const k = 1 - age / 0.22
      push(at.x, g + 0.18, at.y, 0.45 * (0.5 + 0.5 * k), 1, 0.9, 0.7, 0.9 * k * k * bright)
      for (let i = 0; i < 7; i++) {
        const ang = fireHash(b, i + (st.counts.t ?? 0)) * Math.PI * 2
        const d = 0.25 + age * 3.2
        push(at.x + Math.cos(ang) * d, g + 0.12 + age * 1.5 - age * age * 6, at.y + Math.sin(ang) * d, 0.03, 1, 0.8, 0.4, k * bright)
      }
    }
  }

  // ── The flare gun's streak ──
  for (const st of view.progression.ledger.stores.values()) {
    if (!st.id.startsWith("flare:") || !st.counts.gun || !st.at) continue
    const age = time - (st.counts.t ?? 0) / 10
    if (age < 0 || age > 0.3 || !near(view, st.at.x, st.at.y)) continue
    const fx = (st.counts.fx ?? 0) / 100
    const fy = (st.counts.fy ?? 0) / 100
    const k = 1 - age / 0.3
    for (let i = 0; i < 12; i++) {
      const u = i / 11
      const px = st.at.x + fx * (1 - u)
      const pz = st.at.y + fy * (1 - u)
      push(px, support(px, pz) + 1 - 0.7 * u, pz, 0.12 + 0.06 * u, 1, 0.18 + 0.5 * u * k, 0.08, 0.5 * k * (0.4 + 0.6 * u) * bright)
    }
  }
  return count.n
}

/**
 * Smoke, in the alpha list: dark soot rising off the stream's end, burning figures and fires, and a blast's plume. Seen
 * mostly against the fire's own light, as smoke is at night.
 */
export function fireAlphaSprites(frame: FireFrame, sprites: Float32Array, start: number): number {
  const count = { n: start }
  const push = writer(sprites, count)
  const { view, look, support } = frame
  const time = view.time
  const amt = look.fireSmoke
  if (amt <= 0) return start
  const puff = (x: number, z: number, g: number, i: number, seed: number, rate: number, rise: number, size: number, a: number) => {
    const u = fract(time * rate + fireHash(seed, i))
    const drift = Math.sin(time * 0.7 + i * 1.3 + seed) * 0.35 * u
    // Premultiplied soot: warm brown low down where the fire lights it, grey higher.
    const c = 0.05 + 0.03 * u
    const al = a * amt * smooth(0, 0.15, u) * (1 - u)
    push(x + drift + u * 0.4, g + 0.6 + u * rise, z - u * 0.25, size * (0.35 + 0.9 * u), (c + 0.04 * (1 - u)) * al, c * al, (c - 0.01) * al, al, 0)
  }
  for (const { s, reach, since } of sprayers(frame)) {
    const g = support(s.x, s.y)
    const n0 = nozzle(s, g)
    const len = reach * (0.25 + 0.75 * smooth(0, 0.18, time - since))
    const ex = n0.x + Math.cos(s.aim) * len * 0.85
    const ez = n0.z + Math.sin(s.aim) * len * 0.85
    for (let i = 0; i < 8; i++) puff(ex, ez, support(ex, ez), i, 11, 0.45, 2.6, 1.6, 0.26)
  }
  const agents = agentMap(view)
  for (const st of ring(view, "burn", BURN_RING)) {
    const z = agents.get(burnZombie(st))
    if (!z || !near(view, z.x, z.y)) continue
    const g = support(z.x, z.y)
    if (burning(st, time)) {
      for (let i = 0; i < 4; i++) puff(z.x, z.y, g + 0.9, i, z.id, 0.5, 2.2, 1.1, 0.24 * burnLevel(st, time))
    } else if (st.counts.dead) {
      const age = time - (st.counts.dead ?? 0) / 10
      if (age >= 0 && age < 20) for (let i = 0; i < 2; i++) puff(z.x, z.y, g, i, z.id + 5, 0.3, 1.8, 0.8, 0.16 * (1 - age / 20))
    }
  }
  for (const st of ring(view, "fire", FIRE_RING)) {
    if (!fireLit(st, time) || !near(view, st.at!.x, st.at!.y)) continue
    const r = (st.counts.r ?? 0) / 100
    const n = r > 1 ? 5 : 1
    const fade = 1 - smooth(0.6, 1, lifeAge(st, time))
    for (let i = 0; i < n; i++) puff(st.at!.x, st.at!.y, support(st.at!.x, st.at!.y), i, Math.round(st.at!.x * 7), 0.35, 2.4 + r, 0.8 + r * 0.6, 0.2 * fade)
  }
  for (const st of ring(view, "dyn", DYN_RING)) {
    const age = st.at ? blastAge(st, time) : -1
    if (age < 0.05 || age > 6) continue
    const { x, y } = st.at!
    const g = support(x, y)
    const fade = 1 - age / 6
    for (let i = 0; i < 12; i++) {
      const ang = fireHash(st.counts.t ?? 0, i + 200) * Math.PI * 2
      const out = look.dynRadius * 0.45 * (1 - Math.exp(-age * 2.2)) * (0.5 + fireHash(st.counts.t ?? 0, i + 220))
      const al = 0.34 * amt * fade * smooth(0.05, 0.4, age)
      const c = 0.045
      push(x + Math.cos(ang) * out, g + 0.8 + age * (0.9 + fireHash(st.counts.t ?? 0, i + 240)), y + Math.sin(ang) * out, 1.2 + age * 0.9, c * al, c * al, c * al, al)
    }
  }
  for (const st of ring(view, "crack", CRACK_RING)) {
    if (!st.at || !st.counts.t) continue
    const since = time - (st.counts.t ?? 0) / 10
    const end = ((st.counts.until ?? 0) - (st.counts.t ?? 0)) / 10
    if (since < 0 || since > end + 2) continue
    for (let i = 0; i < 4; i++) {
      const at = crackerAt(st, Math.min(time, (st.counts.t ?? 0) / 10 + end) - i * 0.4)
      puff(at.x, at.y, support(at.x, at.y) - 0.4, i, st.counts.t ?? 0, 0.6, 1.2, 0.5, 0.18 * clamp01((end + 2 - since) / 2))
    }
  }
  return count.n
}

/** Fire's light: the stream, burning figures, fires on the ground, fuses, blasts and pops. Returns how many it pushed. */
export function fireLights(frame: FireFrame, push: (x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number) => void): number {
  const { view, look, support } = frame
  const time = view.time
  const P = look.fireLight
  const R = look.fireLightRadius
  if (P <= 0) return 0
  const warm = [1, 0.5, 0.17] as const
  let n = 0
  const add = (x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number) => {
    if (power <= 0.01) return
    push(x, h, z, r, c, power)
    n++
  }
  for (const { s, reach, since } of sprayers(frame)) {
    const g = support(s.x, s.y)
    const len = reach * (0.25 + 0.75 * smooth(0, 0.18, time - since))
    const k = flicker(time, s.id.length)
    const dx = Math.cos(s.aim)
    const dy = Math.sin(s.aim)
    add(s.x + dx * len * 0.35, g + 1.1, s.y + dy * len * 0.35, R * 0.85, [1, 0.62, 0.3], 1.25 * P * k)
    add(s.x + dx * len * 0.85, g + 0.8, s.y + dy * len * 0.85, R, warm, 1.45 * P * flicker(time, s.id.length + 5))
  }
  const agents = agentMap(view)
  for (const st of ring(view, "burn", BURN_RING)) {
    if (!burning(st, time)) continue
    const z = agents.get(burnZombie(st))
    if (!z || !near(view, z.x, z.y)) continue
    add(z.x, support(z.x, z.y) + 1.25, z.y, R * 0.75, warm, 0.95 * P * burnLevel(st, time) * flicker(time, z.id))
  }
  for (const st of ring(view, "fire", FIRE_RING)) {
    if (!fireLit(st, time) || !near(view, st.at!.x, st.at!.y)) continue
    const r = (st.counts.r ?? 0) / 100
    const lvl = 1 - smooth(0.65, 1, lifeAge(st, time))
    add(st.at!.x, support(st.at!.x, st.at!.y) + 0.5 + r * 0.2, st.at!.y, R * (0.45 + 0.25 * r), warm, (0.35 + 0.35 * r) * P * lvl * flicker(time, Math.round(st.at!.x * 10)))
  }
  for (const st of ring(view, "dyn", DYN_RING)) {
    if (!st.counts.t || !st.at) continue
    const age = blastAge(st, time)
    if (age < 0) {
      const p = dynamiteAt(st, time)
      add(p.x, support(p.x, p.y) + p.h + 0.3, p.y, 2.4, [1, 0.6, 0.25], 0.3 * P * flicker(time * 2.5, st.counts.t))
    } else if (age < 1.2) {
      const g = support(st.at.x, st.at.y)
      if (age < 0.14) add(st.at.x, g + 2.2, st.at.y, look.dynRadius * 3.2, [1, 0.88, 0.7], 7 * look.blastFlash * (1 - age / 0.14))
      add(st.at.x, g + 1.4, st.at.y, look.dynRadius * 2, warm, 2.8 * P * Math.pow(1 - age / 1.2, 2))
    }
  }
  for (const st of ring(view, "crack", CRACK_RING)) {
    if (!fireLit(st, time)) continue
    const since = time - (st.counts.t ?? 0) / 10
    const beat = Math.floor(since / CRACK_BEAT)
    const age = since - beat * CRACK_BEAT
    if (!crackerPops(st.counts.t ?? 0, beat) || age > 0.1) continue
    const at = crackerAt(st, time)
    add(at.x, support(at.x, at.y) + 0.4, at.y, 3.6, [1, 0.82, 0.55], 1.1 * P * (1 - age / 0.1))
  }
  return n
}

/** How charred a zombie looks (0 untouched .. 1 black), from its burn store; for the crowd renderer's shade. */
export function charOf(view: SessionView, look: OutbreakFireSettings): Map<number, number> {
  const out = new Map<number, number>()
  if (look.fireChar <= 0) return out
  const time = view.time
  for (const st of ring(view, "burn", BURN_RING)) {
    const id = burnZombie(st)
    if (id < 0) continue
    const t = (st.counts.t ?? 0) / 10
    const c = st.counts.dead ? 1 : Math.min(0.75, (Math.min(time, (st.counts.until ?? 0) / 10) - t) / Math.max(0.5, look.burnSeconds))
    out.set(id, Math.max(out.get(id) ?? 0, clamp01(c) * look.fireChar))
  }
  return out
}
