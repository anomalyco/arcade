import { BOW_Z, DECK_X0, DECK_X1, DECK_Y, STERN_Z } from "../../shared/carrier-spec"
import { type Archipelago, terrainHeight } from "../../shared/islands"
import { type Quat, type ShipPoseLike, quatRotate, shipQuat, shipToWorld, worldToShip } from "../../shared/plane"
import { type Sea, seaHeight } from "../../shared/sea"
import type { VehicleKind } from "../../shared/vehicles"
import { ExplosionFx, type MeshRef, type PuffSpec } from "./explosion-fx"
import { type ChunkPart, type JetChunk, jetChunks } from "./jet-chunks"
import type { Rgb } from "./mesh"
import type { PlaneModels } from "./plane-glb"
import type { PlaneDrawPose } from "./plane-pass"
import type { Renderer } from "./renderer"

// Jet kills, crashes and other big bursts (src/render/explosion-fx.ts draws them). Everything here is presentation:
// each effect is a pure function of its event (where, how fast, which way the jet faced) and a seed (the player id and
// sortie), so every client sees the same breakup without any extra messages.
//
// - Mid-air kill (`airKill`): a 1-2 frame flash, a faceted fireball that swells fast then cools and rolls into thick
//   dark smoke drifting downwind for 6-10 s, sparks and shards with drag, and the jet coming apart: a seeded few of its
//   own pieces (jet-chunks.ts: canopy, wingtips, fins, stabilisers, sometimes a wing or the nose) tumble away with the
//   jet's momentum plus a kick, burning and trailing smoke; the rest stays on the burning wreck (`drawWreck`), which
//   falls trailing a thick smoke column until it hits (`wreckImpact`).
// - Crash (`crash`) and wreck impacts: into the sea a white spray column and crown, mist, a foam ring drawn into the
//   ocean's wake field, steam if it burned, and a few pieces bobbing on the swell before they sink; onto land or a deck a
//   fireball, scattered pieces that bounce and skid and keep burning (on a deck they ride the ship), a scorch, dust or
//   smoke and a smoke column.
// - `blast` (bombs, anything big) and `boatKill` (a small craft blown apart on the water) share the same parts.
// Fireballs light their surroundings with a glow and a light pool on the surface under them; nearby bursts owe the
// camera some trauma (`takeTrauma`).

type V3 = [number, number, number]

/** What the explosions collide pieces with. Ships need their id (deck pieces ride them). */
export type BlastWorld = { sea: Sea | null; arch: Archipelago | null; ships?: readonly (ShipPoseLike & { id?: number; u?: number; v?: number })[] }

export type BlastSurface = "air" | "sea" | "land" | "ship"

/** A jet's state at the moment it is destroyed. */
export type JetState = { x: number; y: number; z: number; vx: number; vy: number; vz: number; qx: number; qy: number; qz: number; qw: number }

/** What src/weapons/weapons.ts calls when a jet is shot down and when its falling wreck hits something. */
export type JetBreakup = {
  /** Jet `id` shot down mid-air; true when drawn here (the generic explosion is then skipped). */
  airKill(id: number, kind: VehicleKind, j: JetState): boolean
  /** Its falling wreck struck `hit`; true when drawn here. */
  wreckHit(id: number, hit: "sea" | "land" | "ship", x: number, y: number, z: number, vx: number, vy: number, vz: number): boolean
  /** A seeded random stream for jet `id`'s current sortie (the wreck's tumble). */
  random(id: number): () => number
}

import { mulberry32 as seeded } from "../../shared/rng"
export { seeded }

/** Hash of a few integers into a seed. */
export function seedOf(...k: number[]): number {
  let h = 0x811c9dc5
  for (const v of k) {
    h = Math.imul(h ^ (v | 0), 0x01000193)
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  }
  return (h ^ (h >>> 15)) >>> 0
}

const MAX_PIECES = 320
const MAX_LIGHTS = 10
const MAX_SCORCH = 24
const MAX_FOAM = 16
const G = 9.81

const enum S {
  Dead,
  Fly,
  Float,
  Rest,
  Deck,
  Sink,
  Wreck,
}

/** A jet chunk or a shard. Pooled: allocated once, reused. */
type Piece = {
  state: S
  mesh: MeshRef
  /** Collision radius (m) and scale (shards; 1 for chunks). */
  rad: number
  sx: number
  sy: number
  sz: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  q: Quat
  /** World spin axis and rate (rad/s). */
  ax: number
  ay: number
  az: number
  spin: number
  drag: number
  age: number
  life: number
  /** Fire left (s), flame size (m), smoke puff size (m; 0: none). */
  burn: number
  fire: number
  smoke: number
  char: number
  ember: number
  accent: Rgb
  seed: number
  rs: number
  /** Floats when it reaches the sea (else sinks), and for how long. */
  floats: boolean
  floatT: number
  sub: number
  /** Distance since the last trail puff, the last puff time, and where the smoke trail was last laid. */
  trail: number
  puffT: number
  tx: number
  ty: number
  tz: number
  tt: number
  laid: boolean
  /** Deck: ship id and ship-local pose and velocity. */
  ship: number
  lx: number
  ly: number
  lz: number
  lvx: number
  lvy: number
  lvz: number
  lq: Quat
  /** On a wreck: its id, offset from the jet's centre in the body frame, and when the wreck pose last came. */
  wreck: number
  ox: number
  oy: number
  oz: number
  seen: number
  /** Splashed already (one splash per piece). */
  wet: boolean
}

type Light = { live: boolean; x: number; y: number; z: number; age: number; life: number; radius: number; k: number; ground: number; gx: number; gy: number; gz: number }
type Scorch = { live: boolean; x: number; y: number; z: number; nx: number; ny: number; nz: number; r: number; age: number; life: number; ship: number; lx: number; ly: number; lz: number; seed: number }
type Foam = { live: boolean; x: number; z: number; age: number; life: number; size: number }

const qt: Quat = [0, 0, 0, 1]
const qs: Quat = [0, 0, 0, 1]
const vt: V3 = [0, 0, 0]
const vu: V3 = [0, 0, 0]
const vs: V3 = [0, 0, 0]

function quatMulInto(a: Quat, b: Quat, out: Quat): Quat {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1]
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0]
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3]
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  out[0] = x
  out[1] = y
  out[2] = z
  out[3] = w
  return out
}

function axisAngle(x: number, y: number, z: number, a: number, out: Quat): Quat {
  const s = Math.sin(a / 2)
  out[0] = x * s
  out[1] = y * s
  out[2] = z * s
  out[3] = Math.cos(a / 2)
  return out
}

function normalizeQ(q: Quat): void {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  q[0] /= l
  q[1] /= l
  q[2] /= l
  q[3] /= l
}

const SMOKE: Rgb = [0.1, 0.095, 0.09]
const SMOKE_GREY: Rgb = [0.2, 0.19, 0.185]
/** What dark smoke pales to as it spreads out. */
const SMOKE_PALE: Rgb = [0.34, 0.33, 0.32]
const STEAM: Rgb = [0.78, 0.8, 0.82]
const SPRAY: Rgb = [0.93, 0.96, 0.99]
const DUST: Rgb = [0.5, 0.42, 0.31]
const EARTH: Rgb = [0.2, 0.15, 0.1]

/** Burning pieces' flame tongues and smoke column (mutated per puff). */
const FLAME: PuffSpec = { life: 0.6, r0: 1, r1: 2, grow: 0.15, drag: 2, rise: 5, wind: 0.2, heat: 0.95, cool: 0.45, emit: 1, col: SMOKE, fade: 0.6, sunlit: 0.6 }
const COLUMN: PuffSpec = { life: 6, r0: 1, r1: 2, grow: 0.9, swell: 0.2, drag: 1.2, rise: 2.2, wind: 0.35, heat: 0, cool: 0.25, emit: 0.7, col: SMOKE, under: 0, sunlit: 0.7, fade: 0.45 }

/** Parts that carry fire and smoke when they come off, and how long they burn (s, min..max). */
const BURNS: Partial<Record<ChunkPart, [number, number, number]>> = {
  // [min burn, max burn, smoke size]
  core: [8, 12, 2.6],
  front: [3, 7, 1.8],
  aft: [5, 9, 2.2],
  wingL: [3, 6, 1.5],
  wingR: [3, 6, 1.5],
  nose: [1, 3, 1.1],
  finL: [0, 2.5, 0.9],
  finR: [0, 2.5, 0.9],
  tipL: [0, 1.5, 0],
  tipR: [0, 1.5, 0],
  stabL: [0, 2, 0.7],
  stabR: [0, 2, 0.7],
}

/** The JetChunks and their mesh refs for one model. */
type ModelChunks = { chunks: JetChunk[]; refs: MeshRef[]; centre: number }

const registry = new WeakMap<Renderer, Explosions>()

/** The renderer's explosions (created by the flight module), for anyone else who blows things up (boats, bombs). */
export const explosionsFor = (r: Renderer): Explosions | null => registry.get(r) ?? null

/**
 * Per frame: `begin(dt, t, eye, fov, viewportH, ships)` before any events, `drawWreck` for each falling wreck, then
 * `end()` (steps the pieces and uploads). Events (`airKill`, `crash`, `wreckImpact`, `blast`, `boatKill`) any time.
 */
export class Explosions {
  readonly fx: ExplosionFx
  /** The two passes (opaque, alpha), e.g. for benchmarks. */
  readonly passes: { draw(p: GPURenderPassEncoder): void }[]
  world: BlastWorld = { sea: null, arch: null }
  /** Wind (m/s, plan) smoke drifts with. */
  wind: [number, number] = [3, 0]
  private models: Partial<Record<VehicleKind, ModelChunks>> = {}
  private pieces: Piece[] = []
  private lights: Light[] = []
  private scorches: Scorch[] = []
  private foams: Foam[] = []
  private t = 0
  private dt = 0
  private trauma = 0
  private rs = 1
  private shipsNow: readonly (ShipPoseLike & { id?: number; u?: number; v?: number })[] = []

  constructor(renderer: Renderer) {
    this.fx = new ExplosionFx(renderer)
    renderer.addPass("opaque", this.fx.opaque)
    renderer.addPass("alpha", this.fx.alpha)
    this.passes = [this.fx.opaque, this.fx.alpha]
    registry.set(renderer, this)
    for (let i = 0; i < MAX_PIECES; i++) this.pieces.push(this.blank())
    for (let i = 0; i < MAX_LIGHTS; i++) this.lights.push({ live: false, x: 0, y: 0, z: 0, age: 0, life: 1, radius: 1, k: 0, ground: -1e9, gx: 0, gy: 1, gz: 0 })
    for (let i = 0; i < MAX_SCORCH; i++) this.scorches.push({ live: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, r: 1, age: 0, life: 1, ship: -1, lx: 0, ly: 0, lz: 0, seed: 0 })
    for (let i = 0; i < MAX_FOAM; i++) this.foams.push({ live: false, x: 0, z: 0, age: 0, life: 1, size: 1 })
  }

  private blank(): Piece {
    return {
      state: S.Dead, mesh: { first: 0, count: 0 }, rad: 1, sx: 1, sy: 1, sz: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, q: [0, 0, 0, 1], ax: 0, ay: 1, az: 0, spin: 0, drag: 0,
      age: 0, life: 1, burn: 0, fire: 0, smoke: 0, char: 0, ember: 0, accent: [0.55, 0.58, 0.62], seed: 0, rs: 1, floats: false, floatT: 0, sub: 0, trail: 0, puffT: 0, tx: 0, ty: 0, tz: 0, tt: 0, laid: false,
      ship: -1, lx: 0, ly: 0, lz: 0, lvx: 0, lvy: 0, lvz: 0, lq: [0, 0, 0, 1], wreck: -1, ox: 0, oy: 0, oz: 0, seen: 0, wet: false,
    }
  }

  /** The jet models: cut into chunks and uploaded once. */
  setModels(models: PlaneModels): void {
    const kinds = Object.keys(models) as VehicleKind[]
    const cut = kinds.map((k) => jetChunks(models[k]))
    const refs = this.fx.setMeshes(cut.map((c) => c.map((ch) => ch.verts)))
    kinds.forEach((k, i) => (this.models[k] = { chunks: cut[i]!, refs: refs[i]!, centre: models[k].centre }))
  }

  /** Camera trauma owed by nearby bursts since the last call (0..1, presentation only). */
  takeTrauma(): number {
    const t = this.trauma
    this.trauma = 0
    return t
  }

  // ---- frame ---------------------------------------------------------------------------------------------------------

  begin(dt: number, t: number, eye: ArrayLike<number>, fov: number, viewportH: number, ships?: readonly (ShipPoseLike & { id?: number; u?: number; v?: number })[]): void {
    this.dt = Math.min(0.1, Math.max(0, dt))
    this.t = t
    if (ships) this.shipsNow = ships
    this.fx.windX = this.wind[0]
    this.fx.windZ = this.wind[1]
    this.fx.begin(eye, t, this.dt, fov, viewportH)
  }

  end(): void {
    const dt = this.dt
    for (const p of this.pieces) if (p.state !== S.Dead) this.stepPiece(p, dt)
    this.drawLights(dt)
    this.drawScorches(dt)
    this.drawFoam(dt)
    this.fx.upload()
  }

  /**
   * A falling wreck of jet `id` at `pose` this frame: draws whatever is still attached to it (charred, burning, with
   * its smoke column). False when this jet did not break up here (draw the whole model as before).
   */
  drawWreck(id: number, pose: PlaneDrawPose): boolean {
    let any = false
    for (const p of this.pieces) {
      if (p.state !== S.Wreck || p.wreck !== id) continue
      any = true
      quatRotate(pose.qx, pose.qy, pose.qz, pose.qw, p.ox, p.oy, p.oz, vt)
      const nx = pose.x + vt[0]
      const ny = pose.y + vt[1]
      const nz = pose.z + vt[2]
      const dt = this.t - p.seen
      if (dt > 1e-3 && dt < 0.3) {
        p.vx = (nx - p.x) / dt
        p.vy = (ny - p.y) / dt
        p.vz = (nz - p.z) / dt
      }
      p.x = nx
      p.y = ny
      p.z = nz
      p.q[0] = pose.qx
      p.q[1] = pose.qy
      p.q[2] = pose.qz
      p.q[3] = pose.qw
      p.seen = this.t
    }
    return any
  }

  // ---- events --------------------------------------------------------------------------------------------------------

  /**
   * Jet of type `kind` (team `accent`) destroyed mid-air: flash, fireball, sparks, shards, and its pieces flying apart.
   * `wreck` is the id its falling wreck is drawn with (`drawWreck`); `heavy` (a missile) blows more off.
   */
  airKill(seed: number, kind: VehicleKind, accent: Rgb, j: JetState, wreck: number, heavy = true): void {
    const r = seeded(seed)
    this.fireball(r, j.x, j.y, j.z, j.vx, j.vy, j.vz, 1.15, -1e9)
    this.shards(r, j.x, j.y, j.z, j.vx * 0.75, j.vy * 0.75, j.vz * 0.75, heavy ? 22 : 14, 60, 1)
    this.bang(j.x, j.y, j.z, 1.1)
    const m = this.models[kind]
    if (!m) return
    // What comes off: a seeded few; the rest stays on the wreck.
    const p = (k: number) => r() < (heavy ? k : k * 0.7)
    const off = new Set<ChunkPart>()
    if (p(0.9)) off.add("canopy")
    if (p(0.6)) off.add("tipL")
    if (p(0.6)) off.add("tipR")
    const fin = r() < 0.5 ? "finL" : "finR"
    if (p(0.75)) off.add(fin)
    if (p(0.3)) off.add(fin === "finL" ? "finR" : "finL")
    if (p(0.5)) off.add("stabL")
    if (p(0.5)) off.add("stabR")
    if (p(0.3)) off.add("doorL")
    if (p(0.3)) off.add("doorR")
    const wing = r() < 0.5 ? "wingL" : "wingR"
    if (p(0.35)) {
      off.add(wing)
      off.add(wing === "wingL" ? "tipL" : "tipR")
    }
    if (p(0.2)) off.add("nose")
    for (let i = 0; i < m.chunks.length; i++) {
      const c = m.chunks[i]!
      const pc = this.alloc()
      if (!pc) break
      this.initChunk(pc, m, i, j, accent, seed + i * 977)
      if (off.has(c.part)) {
        // Flung off: the jet's momentum, a kick outward from its centre and some lift, tumbling.
        const ox = pc.x - j.x
        const oy = pc.y - j.y
        const oz = pc.z - j.z
        const ol = Math.hypot(ox, oy, oz) || 1
        const kick = (6 + 16 * r()) * (c.bulk < 5 ? 1.5 : 1)
        pc.vx = j.vx * (0.8 + 0.1 * r()) + (ox / ol) * kick + (r() - 0.5) * 8
        pc.vy = j.vy * (0.8 + 0.1 * r()) + (oy / ol) * kick + 3 + 6 * r()
        pc.vz = j.vz * (0.8 + 0.1 * r()) + (oz / ol) * kick + (r() - 0.5) * 8
        this.tumble(pc, r, (2 + 6 * r()) / Math.sqrt(Math.max(0.5, c.bulk / 8)))
        pc.state = S.Fly
        pc.char = 0.35
        pc.ember = 0.5
      } else {
        // Stays on the wreck: drawn at its pose (drawWreck); the wreck's fire and smoke column ride on its middle.
        pc.state = S.Wreck
        pc.wreck = wreck
        quatRotate(-j.qx, -j.qy, -j.qz, j.qw, pc.x - j.x, pc.y - j.y, pc.z - j.z, vt)
        pc.ox = vt[0]
        pc.oy = vt[1]
        pc.oz = vt[2]
        pc.seen = this.t
        pc.char = 0.45
        pc.ember = 0.7
        if (c.part !== "core") {
          pc.burn = 0
          pc.smoke = 0
        } else {
          pc.burn = 60
          pc.fire = 3.2
          pc.smoke = 3
        }
      }
    }
  }

  /** The falling wreck of jet `id` struck `hit` at (x, y, z) moving at v: a secondary burst, and its pieces scatter. */
  wreckImpact(seed: number, id: number, hit: "sea" | "land" | "ship", x: number, y: number, z: number, vx: number, vy: number, vz: number): boolean {
    const r = seeded(seed ^ 0x5eed)
    let any = false
    for (const p of this.pieces) {
      if (p.state !== S.Wreck || p.wreck !== id) continue
      any = true
      p.wreck = -1
      p.vx = vx
      p.vy = vy
      p.vz = vz
      p.state = S.Fly
      this.scatter(p, r, hit, vx, vy, vz)
    }
    this.impact(r, hit, x, y, z, vx, vy, vz, any ? 0.85 : 1, true)
    return true
  }

  /**
   * Jet of type `kind` crashed into `surface` at (x, y, z), moving at v, oriented q: the impact and the whole jet in
   * pieces (on a deck, `ship` is the carrier's id).
   */
  crash(seed: number, kind: VehicleKind, accent: Rgb, surface: "sea" | "land" | "ship", j: JetState): void {
    const r = seeded(seed ^ 0xc4a5)
    this.impact(r, surface, j.x, j.y, j.z, j.vx, j.vy, j.vz, 1.25, false)
    const m = this.models[kind]
    if (!m) return
    for (let i = 0; i < m.chunks.length; i++) {
      const pc = this.alloc()
      if (!pc) break
      this.initChunk(pc, m, i, j, accent, seed + i * 977)
      pc.state = S.Fly
      pc.char = 0.3
      pc.ember = 0.6
      this.scatter(pc, r, surface, j.vx, j.vy, j.vz)
    }
  }

  /**
   * A generic big burst at (x, y, z) of `size` (1 = a jet's fireball) on `surface`: fireball, shards, smoke; on the sea
   * the spray column instead (bombs, ship magazines, anything without its own pieces).
   */
  blast(seed: number, x: number, y: number, z: number, size: number, surface: BlastSurface): void {
    const r = seeded(seed)
    if (surface === "air") {
      this.fireball(r, x, y, z, 0, 0, 0, size, -1e9)
      this.shards(r, x, y, z, 0, 0, 0, Math.round(14 * size), 50 * Math.sqrt(size), size)
      this.bang(x, y, z, size)
    } else this.impact(r, surface, x, y, z, 0, -10, 0, size, false)
  }

  /**
   * A small craft (a boat) blown apart on the water at (x, y, z), drifting at (vx, vz), bow toward `heading`: a
   * fireball, splintered debris (some floats a while), spray and a smoke column. `size` 1 is a ~10 m boat.
   */
  boatKill(seed: number, x: number, y: number, z: number, vx: number, vz: number, heading: number, size = 1): void {
    const r = seeded(seed ^ 0xb0a7)
    const s = size
    this.fireball(r, x, y + 2 * s, z, vx, 0, vz, 0.9 * s, y)
    this.splash(r, x, y, z, vx, vz, 0.55 * s)
    this.bang(x, y, z, 0.8 * s)
    // Splintered hull: panels and wedges flung up and out, some burning, a few float.
    const n = Math.round(16 * s)
    const fx = Math.sin(heading)
    const fz = -Math.cos(heading)
    for (let i = 0; i < n; i++) {
      const p = this.alloc()
      if (!p) break
      const along = (r() - 0.5) * 8 * s
      this.initShard(p, r, x + fx * along, y + 1, z + fz * along, vx + (r() - 0.5) * 22, 10 + 22 * r(), vz + (r() - 0.5) * 22, (0.4 + 1.1 * r()) * s, i % 3 === 0 ? [0.35, 0.3, 0.26] : [0.62, 0.64, 0.67], 0.8)
      p.floats = r() < 0.55
      p.floatT = 5 + 6 * r()
      if (i % 4 === 0) {
        p.burn = 2 + 4 * r()
        p.fire = 0.9
        p.smoke = 0.9
      }
    }
    // A smoke column off the burning wreckage on the water.
    this.addLight(x, y + 3, z, 0.9 * s, y)
    for (let i = 0; i < 6; i++)
      this.puffAt(r, x + (r() - 0.5) * 6 * s, y + 2 + 4 * i * s, z + (r() - 0.5) * 6 * s, vx * 0.2, 3 + 2 * r(), vz * 0.2, {
        life: 7 + 3 * r(), r0: 2 * s, r1: (4.5 + 2 * r()) * s, grow: 0.8, swell: 0.4, drag: 1, rise: 1.2, wind: 0.35, col: SMOKE, heat: i < 2 ? 0.6 : 0, cool: 0.6, emit: 0.8, under: 1, sunlit: 0.7,
      })
  }

  // ---- parts ---------------------------------------------------------------------------------------------------------

  /** The flash, the fireball rolling into smoke, sparks and embers, and the light. `floor`: the surface under it. */
  private fireball(r: () => number, x: number, y: number, z: number, vx: number, vy: number, vz: number, s: number, floor: number): void {
    const fx = this.fx
    // On a surface the fireball can only go up and out: it lifts off and rolls up into a column.
    const ground = floor > -1e8
    const lift = ground ? 7 : 2
    const buoy = ground ? 3.5 : 1.6
    // A flash for a frame or two, then the light it throws on everything around.
    fx.spark(x, y, z, vx * 0.5, vy * 0.5, vz * 0.5, 0.07, 16 * s, 9, 8, 6.5, 0, 0, 0)
    this.addLight(x, y, z, s, floor)
    // The fireball: hot balls bursting out from the middle, swelling fast, then cooling into soot as they slow.
    const n = Math.round(16 * Math.sqrt(s))
    for (let i = 0; i < n; i++) {
      const dx = r() - 0.5
      const dy = ground ? r() * 0.8 : r() - 0.45
      const dz = r() - 0.5
      const l = Math.hypot(dx, dy, dz) || 1
      const out = (5 + 12 * r()) * s
      // Inner balls burn longest; the outer ones are already half smoke (fire and soot mixed from the start).
      const core = i < n * 0.45
      this.puffAt(r, x + (dx / l) * 2 * s, Math.max(floor + 1, y + (dy / l) * 2 * s), z + (dz / l) * 2 * s, vx * 0.3 + (dx / l) * out, vy * 0.3 + (dy / l) * out + lift, vz * 0.3 + (dz / l) * out, {
        life: 7 + 4 * r(), r0: (1.2 + 1.2 * r()) * s, r1: (core ? 3.8 + 2.6 * r() : 4.5 + 3.5 * r()) * s, grow: 0.2 + 0.15 * r(), swell: 0.55 * s, drag: 2.4, rise: buoy, wind: 0.22,
        heat: core ? 0.85 + 0.15 * r() : 0.4 + 0.3 * r(), cool: core ? 0.7 + 0.5 * r() : 0.35 + 0.3 * r(), emit: 1.15, col: r() < 0.3 ? SMOKE_GREY : SMOKE, pale: SMOKE_PALE, under: 1.6, sunlit: 0.75, fade: 0.6, floor, stretch: 0.85 + 0.3 * r(), spin: (r() - 0.5) * 0.8,
      })
    }
    // Billows rolling out around it a moment later, already mostly smoke.
    for (let i = 0; i < Math.round(7 * Math.sqrt(s)); i++) {
      const a = r() * Math.PI * 2
      const e = ground ? r() * 0.9 : (r() - 0.3) * 1.2
      const d = (4.5 + 4 * r()) * s
      const ox = Math.cos(a) * Math.cos(e) * d
      const oy = Math.sin(e) * d
      const oz = Math.sin(a) * Math.cos(e) * d
      this.puffAt(r, x + ox, Math.max(floor + 1, y + oy), z + oz, vx * 0.08 + ox * 0.9, vy * 0.08 + oy * 0.9 + lift * 0.8, vz * 0.08 + oz * 0.9, {
        life: 8 + 3 * r(), r0: 2.2 * s, r1: (6 + 3 * r()) * s, grow: 0.5, swell: 0.5 * s, drag: 1.6, rise: buoy * 0.85, wind: 0.3, heat: 0.45, cool: 0.35, emit: 0.9, col: SMOKE, pale: SMOKE_PALE,
        under: 1.2, sunlit: 0.75, fade: 0.6, floor, spin: (r() - 0.5) * 0.6,
      })
    }
    // Sparks streaking out and arcing down, and slower embers.
    const ns = Math.round(46 * s)
    for (let i = 0; i < ns; i++) {
      const dx = r() - 0.5
      const dy = r() - 0.4
      const dz = r() - 0.5
      const l = Math.hypot(dx, dy, dz) || 1
      const sp = (45 + 70 * r()) * Math.sqrt(s)
      fx.spark(x, y, z, vx * 0.5 + (dx / l) * sp, vy * 0.5 + (dy / l) * sp, vz * 0.5 + (dz / l) * sp, 0.35 + 0.6 * r(), 0.32, 9, 5.5, 2.2, 2.4, G, 0.035)
    }
    for (let i = 0; i < Math.round(18 * s); i++) {
      const dx = r() - 0.5
      const dy = r() - 0.3
      const dz = r() - 0.5
      const sp = 10 + 25 * r()
      fx.spark(x, y, z, vx * 0.4 + dx * sp, vy * 0.4 + dy * sp, vz * 0.4 + dz * sp, 1.2 + 1.8 * r(), 0.22, 5, 2, 0.45, 0.9, G * 0.6, 0.02)
    }
  }

  /** `n` shards flung from (x, y, z) at v plus up to `speed` outward; size scale `s`. */
  private shards(r: () => number, x: number, y: number, z: number, vx: number, vy: number, vz: number, n: number, speed: number, s: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.alloc()
      if (!p) return
      const dx = r() - 0.5
      const dy = r() - 0.4
      const dz = r() - 0.5
      const l = Math.hypot(dx, dy, dz) || 1
      const sp = speed * (0.35 + 0.65 * r())
      const col: Rgb = r() < 0.3 ? [0.18, 0.18, 0.19] : [0.6, 0.63, 0.67]
      this.initShard(p, r, x, y, z, vx + (dx / l) * sp, vy + (dy / l) * sp, vz + (dz / l) * sp, (0.25 + 0.55 * r()) * s, col, 0.5)
      if (r() < 0.3) {
        p.burn = 1 + 2.5 * r()
        p.fire = 0.5
        p.smoke = 0.55
      }
    }
  }

  /** What happens where something big hits a surface: spray on the sea, fire, dirt and smoke on land or a deck. */
  private impact(r: () => number, hit: "sea" | "land" | "ship", x: number, y: number, z: number, vx: number, vy: number, vz: number, s: number, burning: boolean): void {
    const speed = Math.hypot(vx, vy, vz)
    if (hit === "sea") {
      const sy = this.world.sea ? seaHeight(this.world.sea, x, z, this.t) : 0
      this.splash(r, x, sy, z, vx, vz, s * Math.min(1.3, 0.55 + speed / 220))
      // A burning wreck flares as it goes in; anything hitting hard throws up steam and spray mist.
      if (burning) this.fireball(r, x, sy + 3, z, vx * 0.1, 0, vz * 0.1, 0.4 * s, sy + 0.5)
      if (burning) this.steam(r, x, sy, z, s * 0.8)
      this.bang(x, sy, z, 0.9 * s)
      return
    }
    const ground = this.surfaceHeight(x, z, y + 2)
    const h = ground.h
    this.fireball(r, x, h + 2.5 * s, z, vx * 0.12, 0, vz * 0.12, 0.85 * s, h + 0.5)
    this.bang(x, h, z, 1.2 * s)
    // Flung earth or deck debris, and the dust or smoke rolling out over the surface.
    const deck = ground.ship >= 0
    const col: Rgb = deck ? [0.32, 0.33, 0.35] : EARTH
    for (let i = 0; i < Math.round(16 * s); i++) {
      const p = this.alloc()
      if (!p) break
      const a = r() * Math.PI * 2
      const out = 6 + 22 * r()
      this.initShard(p, r, x, h + 1, z, Math.cos(a) * out + vx * 0.15, 14 + 26 * r(), Math.sin(a) * out + vz * 0.15, (0.35 + 0.8 * r()) * s, col, 0.2)
      p.life = 6 + 6 * r()
    }
    const dust = deck ? SMOKE : DUST
    const nd = deck ? 6 : 12
    for (let i = 0; i < nd; i++) {
      const a = (i / nd) * Math.PI * 2 + r() * 0.4
      this.puffAt(r, x + Math.cos(a) * 4 * s, h + 1.5, z + Math.sin(a) * 4 * s, Math.cos(a) * (12 + 10 * r()) + vx * 0.1, 0.8 + r(), Math.sin(a) * (12 + 10 * r()) + vz * 0.1, {
        life: 3 + 3 * r(), r0: 1.5 * s, r1: (4 + 2.5 * r()) * s, grow: 0.6, swell: 0.4, drag: 1.4, rise: 0.6, wind: 0.4, col: dust, pale: deck ? SMOKE_PALE : dust, cover: 0.9, fade: 0.55, floor: h + 0.5, sunlit: 0.9,
      })
    }
    // A low sheet of sparks skidding along a steel deck.
    if (deck)
      for (let i = 0; i < 40; i++) {
        const a = Math.atan2(vz, vx) + (r() - 0.5) * 1.6
        const sp = 20 + 40 * r()
        this.fx.spark(x, h + 0.5, z, Math.cos(a) * sp, 2 + 6 * r(), Math.sin(a) * sp, 0.4 + 0.6 * r(), 0.25, 9, 5.5, 2.2, 1.8, G, 0.03)
      }
    this.addScorch(x, h, z, 7 + 3 * s, ground)
  }

  /** The spray column, crown and rooster tail, droplets, mist and the foam ring of something hitting the sea. */
  private splash(r: () => number, x: number, sy: number, z: number, vx: number, vz: number, s: number): void {
    const hs = Math.hypot(vx, vz)
    const fx = hs > 1 ? vx / hs : 0
    const fz = hs > 1 ? vz / hs : 0
    const floor = sy - 1.5
    const q = Math.sqrt(s)
    // The column: narrow, fast spray up the middle over a fatter, slower stem; it thins out toward the top.
    const nc = Math.round(30 * s + 6)
    for (let i = 0; i < nc; i++) {
      const a = r() * Math.PI * 2
      const k = r()
      const rr = (0.4 + 2.6 * k) * s
      const up = (16 + 34 * (1 - k) * r() + 8 * r()) * q
      this.puffAt(r, x + Math.cos(a) * rr, sy, z + Math.sin(a) * rr, Math.cos(a) * (0.5 + 3 * k) + fx * hs * 0.06, up, Math.sin(a) * (0.5 + 3 * k) + fz * hs * 0.06, {
        life: 1.8 + 1.4 * r(), r0: (0.6 + 0.5 * r()) * s, r1: (1.2 + 1.2 * r()) * s * (0.6 + 0.6 * k), grow: 0.45, drag: 0.4, grav: G, wind: 0.1, stretch: 1.8 + 1.4 * r(), col: SPRAY, soft: 0.3, sunlit: 1, fade: 0.5, floor, spin: (r() - 0.5) * 2,
      })
    }
    // Droplets: small, falling out of the column and the crown.
    for (let i = 0; i < Math.round(26 * s); i++) {
      const a = r() * Math.PI * 2
      const out = (3 + 12 * r()) * q
      this.puffAt(r, x, sy + 1, z, Math.cos(a) * out + fx * hs * 0.05, (12 + 26 * r()) * q, Math.sin(a) * out + fz * hs * 0.05, {
        life: 1.6 + 1.2 * r(), r0: 0.25 * s, r1: (0.45 + 0.35 * r()) * s, grow: 0.3, drag: 0.3, grav: G, wind: 0.1, col: SPRAY, soft: 0.3, sunlit: 1, fade: 0.3, floor, spin: 3,
      })
    }
    // The crown, a ring thrown outward and falling back.
    const nr = Math.round(18 * q + 4)
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * Math.PI * 2 + r() * 0.3
      const rr = (2 + 1.5 * r()) * s
      const out = (7 + 8 * r()) * q
      this.puffAt(r, x + Math.cos(a) * rr, sy, z + Math.sin(a) * rr, Math.cos(a) * out, (8 + 8 * r()) * q, Math.sin(a) * out, {
        life: 1.6 + 0.8 * r(), r0: 0.6 * s, r1: (1.3 + 0.7 * r()) * s, grow: 0.35, drag: 0.4, grav: G, wind: 0.1, stretch: 1.5, col: SPRAY, soft: 0.3, sunlit: 1, fade: 0.45, floor,
      })
    }
    // The rooster tail: spray sheeting forward along the line of the impact.
    if (hs > 20)
      for (let i = 0; i < Math.round(12 * q); i++) {
        const k = r()
        this.puffAt(r, x + fx * k * 6, sy, z + fz * k * 6, fx * hs * (0.12 + 0.18 * r()) + (r() - 0.5) * 4, 6 + 12 * r(), fz * hs * (0.12 + 0.18 * r()) + (r() - 0.5) * 4, {
          life: 1.4 + 0.8 * r(), r0: 0.7 * s, r1: 1.7 * s, grow: 0.35, drag: 0.6, grav: G, wind: 0.1, stretch: 1.3, col: SPRAY, soft: 0.3, sunlit: 1, fade: 0.5, floor,
        })
      }
    // A little mist at the base, drifting off.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + r()
      this.puffAt(r, x + Math.cos(a) * 3 * s, sy + 1.5, z + Math.sin(a) * 3 * s, Math.cos(a) * (3 + 4 * r()), 0.6, Math.sin(a) * (3 + 4 * r()), {
        life: 3 + 2 * r(), r0: 1.5 * s, r1: (3.5 + 1.5 * r()) * s, grow: 1, swell: 0.3, drag: 1.2, rise: 0.4, wind: 0.5, col: SPRAY, cover: 0.6, fade: 0.7, sunlit: 1, floor: sy,
      })
    }
    this.addFoam(x, z, s)
  }

  /** Steam off hot wreckage in the water: grey-white billows rising and drifting. */
  private steam(r: () => number, x: number, sy: number, z: number, s: number): void {
    for (let i = 0; i < 7; i++)
      this.puffAt(r, x + (r() - 0.5) * 8 * s, sy + 2 + 2.5 * i * s, z + (r() - 0.5) * 8 * s, (r() - 0.5) * 2, 3 + 3 * r(), (r() - 0.5) * 2, {
        life: 4 + 3 * r(), r0: 1.8 * s, r1: (4.5 + 2.5 * r()) * s, grow: 0.9, swell: 0.5, drag: 1, rise: 1.2, wind: 0.45, col: STEAM, sunlit: 0.95, fade: 0.6, cover: 0.8,
      })
  }

  /** Camera trauma owed by a burst of `size` at (x, y, z). */
  private bang(x: number, y: number, z: number, size: number): void {
    const e = this.fx.eye
    const d = Math.hypot(x - e[0]!, y - e[1]!, z - e[2]!)
    const k = Math.max(0, 1 - d / (420 * Math.sqrt(size)))
    this.trauma = Math.min(1, Math.max(this.trauma, k * k * Math.min(1, size)))
  }

  // ---- pieces --------------------------------------------------------------------------------------------------------

  private alloc(): Piece | null {
    let oldest: Piece | null = null
    for (const p of this.pieces) {
      if (p.state === S.Dead) return p
      // Steal the oldest resting or sinking shard when the pool is full.
      if (p.state !== S.Wreck && p.sx !== 1 && (!oldest || p.age > oldest.age)) oldest = p
    }
    return oldest
  }

  private reset(p: Piece, seed: number): void {
    p.age = 0
    p.burn = 0
    p.fire = 0
    p.smoke = 0
    p.char = 0
    p.ember = 0
    p.seed = seed >>> 0
    p.rs = (seed >>> 0) || 1
    p.floats = false
    p.floatT = 0
    p.sub = 0
    p.trail = 0
    p.puffT = 0
    p.laid = false
    p.ship = -1
    p.wreck = -1
    p.wet = false
    p.spin = 0
  }

  /** Chunk `i` of model `m` placed where it sits on the jet. */
  private initChunk(p: Piece, m: ModelChunks, i: number, j: JetState, accent: Rgb, seed: number): void {
    const c = m.chunks[i]!
    this.reset(p, seed)
    p.mesh = m.refs[i]!
    p.sx = p.sy = p.sz = 1
    p.rad = Math.max(0.3, Math.min(c.half[0], c.half[1], c.half[2]) * 0.8 + 0.2)
    quatRotate(j.qx, j.qy, j.qz, j.qw, c.centre[0], c.centre[1] - m.centre, c.centre[2], vt)
    p.x = j.x + vt[0]
    p.y = j.y + vt[1]
    p.z = j.z + vt[2]
    p.vx = j.vx
    p.vy = j.vy
    p.vz = j.vz
    p.q[0] = j.qx
    p.q[1] = j.qy
    p.q[2] = j.qz
    p.q[3] = j.qw
    p.drag = 0.06 + 0.45 / Math.sqrt(c.bulk + 0.5)
    p.life = 16 + 6 * this.rand(p)
    p.accent = accent
    const b = BURNS[c.part]
    if (b) {
      p.burn = b[0] + (b[1] - b[0]) * this.rand(p)
      p.fire = 1 + 1.6 * Math.min(1, c.bulk / 30)
      p.smoke = b[2]
    }
    p.floats = c.part !== "core" && c.part !== "aft" && c.part !== "front" && this.rand(p) < 0.6
    p.floatT = 6 + 5 * this.rand(p)
  }

  private initShard(p: Piece, r: () => number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, col: Rgb, char: number): void {
    this.reset(p, Math.floor(r() * 4294967296))
    const shapes = this.fx.shards
    p.mesh = shapes[Math.floor(r() * shapes.length) % Math.max(1, shapes.length)] ?? { first: 0, count: 0 }
    p.sx = size * (0.8 + 0.5 * r())
    p.sy = size * (0.5 + 0.5 * r())
    p.sz = size * (0.8 + 0.6 * r())
    p.rad = size * 0.5
    p.x = x
    p.y = y
    p.z = z
    p.vx = vx
    p.vy = vy
    p.vz = vz
    p.q[0] = r() - 0.5
    p.q[1] = r() - 0.5
    p.q[2] = r() - 0.5
    p.q[3] = r() - 0.5
    normalizeQ(p.q)
    p.drag = 0.35
    p.life = 8 + 6 * r()
    p.accent = col
    p.char = char
    p.floats = r() < 0.3
    p.floatT = 3 + 4 * r()
    p.state = S.Fly
    this.tumble(p, r, 5 + 12 * r())
  }

  private tumble(p: Piece, r: () => number, rate: number): void {
    const ax = r() - 0.5
    const ay = r() - 0.5
    const az = r() - 0.5
    const l = Math.hypot(ax, ay, az) || 1
    p.ax = ax / l
    p.ay = ay / l
    p.az = az / l
    p.spin = rate * (r() < 0.5 ? -1 : 1)
  }

  /** Sends a chunk off from an impact on `hit` (it carried velocity v into it). */
  private scatter(p: Piece, r: () => number, hit: "sea" | "land" | "ship", vx: number, vy: number, vz: number): void {
    const hs = Math.hypot(vx, vz) || 1
    if (hit === "sea") {
      // Most of it goes straight under; the light pieces skip on and float.
      const keep = p.floats
      p.vx = vx * (keep ? 0.12 + 0.1 * r() : 0.05) + (r() - 0.5) * 8
      p.vy = keep ? 4 + 6 * r() : -2
      p.vz = vz * (keep ? 0.12 + 0.1 * r() : 0.05) + (r() - 0.5) * 8
      if (!keep) {
        p.state = S.Sink
        p.sub = 0
      }
      p.burn = 0
      this.tumble(p, r, 2 + 4 * r())
      return
    }
    // Onto land or a deck: carried on along the ground, thrown up and out, tumbling (less far over a deck's steel).
    const k = hit === "ship" ? 0.1 + 0.2 * r() : 0.25 + 0.4 * r()
    const side = (r() - 0.5) * 0.9
    p.vx = vx * k + (-vz / hs) * side * hs * 0.25 + (r() - 0.5) * 10
    p.vy = 5 + 12 * r()
    p.vz = vz * k + (vx / hs) * side * hs * 0.25 + (r() - 0.5) * 10
    p.burn = Math.max(p.burn, p.fire > 0 ? 5 + 6 * r() : 0)
    if (p.fire === 0 && r() < 0.4) {
      p.fire = 0.8
      p.burn = 3 + 4 * r()
    }
    this.tumble(p, r, 3 + 8 * r())
  }

  /** The piece `curRand` draws from (one bound function, so burning pieces allocate nothing per frame). */
  private cur: Piece | null = null
  private curRand = (): number => (this.cur ? this.rand(this.cur) : 0.5)

  private rand(p: Piece): number {
    p.rs = (Math.imul(p.rs, 1664525) + 1013904223) >>> 0
    return p.rs / 4294967296
  }

  private stepPiece(p: Piece, dt: number): void {
    p.age += dt
    const fx = this.fx
    if (p.state === S.Wreck) {
      // Riding a falling wreck (drawWreck places it); its impact (wreckImpact) lets go. A wreck that stops coming for
      // long (its jet's sortie ended) goes with it.
      if (this.t - p.seen > 4 || this.t < p.seen - 1) p.state = S.Dead
    } else if (p.state === S.Fly) this.fly(p, dt)
    else if (p.state === S.Deck) this.onDeck(p, dt)
    else if (p.state === S.Float || p.state === S.Sink) this.afloat(p, dt)
    else if (p.state === S.Rest && p.age > p.life) {
      p.sub += dt * 0.6
      if (p.sub > p.rad * 2.5) p.state = S.Dead
    }
    if (p.state === S.Dead) return
    if (p.age > p.life + 6 && p.state !== S.Wreck) {
      p.state = S.Dead
      return
    }
    // Burning: flames, smoke, char and embers.
    if (p.burn > 0) {
      p.burn -= dt
      p.char = Math.min(1, p.char + dt * 0.15)
      p.ember = Math.min(1, p.ember + dt)
      this.burnFx(p, dt)
    } else p.ember = Math.max(0, p.ember - dt * 0.3)
    let y = p.y
    if (p.state === S.Rest) y -= p.sub
    fx.piece(p.mesh, p.x, y, p.z, p.q[0], p.q[1], p.q[2], p.q[3], p.sx, p.sy, p.sz, p.accent[0], p.accent[1], p.accent[2], p.char, p.ember, p.seed)
  }

  private fly(p: Piece, dt: number): void {
    const k = Math.exp(-p.drag * dt)
    p.vx *= k
    p.vy = p.vy * k - G * dt
    p.vz *= k
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.z += p.vz * dt
    this.spinBy(p, dt)
    // What it reaches: a deck, land or the sea.
    const g = this.surfaceHeight(p.x, p.z, p.y + 2)
    if (p.y - p.rad > g.h) return
    const speed = Math.hypot(p.vx, p.vy, p.vz)
    if (g.kind === "sea") {
      if (!p.wet && speed > 18 && p.sx === 1) {
        // A chunk smacking into the water: a small spout and a foam patch.
        const r = seeded(p.seed ^ 0x51a5)
        this.splash(r, p.x, g.h, p.z, p.vx, p.vz, Math.min(0.55, 0.2 + p.rad * 0.25))
        if (p.burn > 0) this.steam(r, p.x, g.h, p.z, 0.4)
      }
      p.wet = true
      p.burn = 0
      p.state = p.floats ? S.Float : S.Sink
      p.sub = 0
      p.vx *= 0.1
      p.vz *= 0.1
      p.vy = 0
      return
    }
    if (g.kind === "ship") {
      const ship = this.shipById(g.ship)
      if (ship) {
        this.toDeck(p, ship)
        this.onDeck(p, 0)
        return
      }
    }
    // Land: bounce, skid and come to rest.
    p.y = g.h + p.rad
    this.bounce(p, g.kind === "land")
    if (Math.hypot(p.vx, p.vy, p.vz) < 2.5) {
      p.state = S.Rest
      p.vx = p.vy = p.vz = 0
      p.spin = 0
    }
  }

  /** Bounce off a surface: lose most of the fall, slide on with friction, spin less; puff dust on a hard landing. */
  private bounce(p: Piece, dirt: boolean): void {
    const hard = -p.vy
    p.vy = hard > 3 ? hard * 0.32 : 0
    p.vx *= 0.6
    p.vz *= 0.6
    p.spin *= 0.55
    if (hard > 8 && p.sx === 1) {
      const r = seeded(p.seed + Math.floor(p.age * 100))
      this.puffAt(r, p.x, p.y, p.z, p.vx * 0.2, 1, p.vz * 0.2, { life: 2.5 + r(), r0: 0.8 + p.rad, r1: 2.5 + p.rad * 2, grow: 0.5, drag: 1.5, rise: 0.3, wind: 0.4, col: dirt ? DUST : SMOKE_GREY, fade: 0.5, sunlit: 0.9 })
    }
  }

  private spinBy(p: Piece, dt: number): void {
    if (!p.spin) return
    quatMulInto(axisAngle(p.ax, p.ay, p.az, p.spin * dt, qt), p.q, p.q)
    normalizeQ(p.q)
    p.spin *= Math.exp(-0.15 * dt)
  }

  /** Moves a piece into ship `s`'s frame (it lands on, or crashes onto, its deck). */
  private toDeck(p: Piece, s: ShipPoseLike & { id?: number; u?: number; v?: number }): void {
    const sv = this.shipVel(s)
    worldToShip(s, p.x, p.y, p.z, vt)
    p.lx = vt[0]
    p.ly = vt[1]
    p.lz = vt[2]
    const q = shipQuat(s, qs)
    quatRotate(-q[0], -q[1], -q[2], q[3], p.vx - sv[0], p.vy, p.vz - sv[2], vt)
    p.lvx = vt[0]
    p.lvy = vt[1]
    p.lvz = vt[2]
    qs[0] = -q[0]
    qs[1] = -q[1]
    qs[2] = -q[2]
    quatMulInto(qs, p.q, p.lq)
    p.ship = s.id ?? -1
    p.state = S.Deck
  }

  /** A piece on (or skidding over, or falling off) a carrier's deck, simulated in the ship's frame. */
  private onDeck(p: Piece, dt: number): void {
    const s = this.shipById(p.ship)
    if (!s) {
      p.state = S.Fly
      return
    }
    const top = DECK_Y + p.rad
    const on = p.lx > DECK_X0 && p.lx < DECK_X1 && p.lz > STERN_Z && p.lz < BOW_Z
    if (dt > 0) {
      p.lvy -= G * dt
      p.lx += p.lvx * dt
      p.ly += p.lvy * dt
      p.lz += p.lvz * dt
      if (p.spin) {
        quatMulInto(axisAngle(p.ax, p.ay, p.az, p.spin * dt, qt), p.lq, p.lq)
        normalizeQ(p.lq)
      }
    }
    if (on && p.ly < top) {
      p.ly = top
      const hard = -p.lvy
      p.lvy = hard > 3 ? hard * 0.3 : 0
      // Skidding on steel: strong friction, and sparks while it's fast.
      const f = Math.exp(-dt * 3.5)
      p.lvx *= f
      p.lvz *= f
      p.spin *= Math.exp(-dt * 3)
      if (hard > 6) {
        p.lvx *= 0.7
        p.lvz *= 0.7
      }
    }
    // World pose from the ship's.
    shipToWorld(s, p.lx, p.ly, p.lz, vt)
    const q = shipQuat(s, qs)
    quatMulInto(q, p.lq, p.q)
    const sv = this.shipVel(s)
    quatRotate(q[0], q[1], q[2], q[3], p.lvx, p.lvy, p.lvz, vu)
    p.x = vt[0]
    p.y = vt[1]
    p.z = vt[2]
    const skid = Math.hypot(p.lvx, p.lvz)
    if (on && p.ly <= top + 0.05 && skid > 8 && p.sx === 1 && this.rand(p) < dt * 30) this.fx.spark(p.x, p.y - p.rad * 0.6, p.z, vu[0] * 0.6 + sv[0], 3, vu[2] * 0.6 + sv[2], 0.3 + 0.3 * this.rand(p), 0.22, 9, 5.5, 2.2, 1.5, G, 0.03)
    // Off the edge: back into the world, falling.
    if (!on && p.ly < DECK_Y - 1) {
      p.vx = vu[0] + sv[0]
      p.vy = vu[1]
      p.vz = vu[2] + sv[2]
      p.state = S.Fly
      p.ship = -1
    }
  }

  /** Bobbing on the swell (Float), or going under (Sink). */
  private afloat(p: Piece, dt: number): void {
    const sea = this.world.sea
    const h = sea ? seaHeight(sea, p.x, p.z, this.t) : 0
    if (p.state === S.Float) {
      p.floatT -= dt
      if (p.floatT <= 0) p.state = S.Sink
      // Drift a little downwind; ride the water and tilt with it.
      const w = 1 - Math.exp(-dt * 0.5)
      p.vx += (this.wind[0] * 0.15 - p.vx) * w
      p.vz += (this.wind[1] * 0.15 - p.vz) * w
      p.x += p.vx * dt
      p.z += p.vz * dt
      p.y = h - p.rad * 0.35
      if (sea) {
        const e = 2
        const nx = (seaHeight(sea, p.x - e, p.z, this.t) - seaHeight(sea, p.x + e, p.z, this.t)) / (2 * e)
        const nz = (seaHeight(sea, p.x, p.z - e, this.t) - seaHeight(sea, p.x, p.z + e, this.t)) / (2 * e)
        // Rock toward the wave's tilt (small-angle: rotate about (nz, 0, -nx)).
        const tilt = Math.min(0.5, Math.hypot(nx, nz))
        if (tilt > 1e-4) {
          axisAngle(nz / Math.hypot(nx, nz), 0, -nx / Math.hypot(nx, nz), tilt * dt * 2, qt)
          quatMulInto(qt, p.q, p.q)
        }
        this.spinBy(p, dt)
        p.spin *= Math.exp(-dt * 2)
      }
      return
    }
    // Sinking: down it goes, slowly turning, then gone.
    p.sub += dt * (0.8 + p.rad * 0.3)
    p.y = Math.min(p.y, h) - dt * (0.8 + p.rad * 0.3)
    p.x += p.vx * dt
    p.z += p.vz * dt
    p.vx *= Math.exp(-dt)
    p.vz *= Math.exp(-dt)
    this.spinBy(p, dt)
    if (p.sub > p.rad * 3 + 2) p.state = S.Dead
  }

  /**
   * Fire and smoke off a burning piece: flames as glows and short hot puffs; while it flies, a soft smoke trail laid
   * segment by segment (never beads) with faceted billows over it on the big pieces; at rest, a rising column.
   */
  private burnFx(p: Piece, dt: number): void {
    const fx = this.fx
    const moving = p.state === S.Fly || p.state === S.Wreck
    const speed = moving ? Math.hypot(p.vx, p.vy, p.vz) : 0
    const f = p.fire * Math.min(1, p.burn / 1.5) * (0.85 + 0.15 * Math.sin(this.t * 23 + p.seed))
    if (f > 0.05) {
      fx.glow(p.x, p.y, p.z, f * 1.7, 4, 1.5, 0.35, 0.9)
      fx.glow(p.x, p.y + f * 0.2, p.z, f * 0.8, 8, 5, 1.8, 1)
    }
    this.cur = p
    const r = this.curRand
    const fade = Math.min(1, p.burn / 2)
    if (moving && p.smoke > 0) {
      if (!p.laid) {
        p.laid = true
        p.tx = p.x
        p.ty = p.y
        p.tz = p.z
        p.tt = this.t
      }
      const d = Math.hypot(p.x - p.tx, p.y - p.ty, p.z - p.tz)
      if (d > 300) {
        p.tx = p.x
        p.ty = p.y
        p.tz = p.z
      } else if (d >= Math.max(2.5, p.smoke * 1.2)) {
        const w = p.smoke
        // Fire glowing through at the head, dark smoke behind, widening and drifting off.
        const life = p.state === S.Wreck ? 7 : 4.5
        // The tail is where the last segment's head was laid (its birth position): the trail drifts as one ribbon.
        fx.streak(p.tx, p.ty, p.tz, p.x, p.y, p.z, Math.max(0, this.t - p.tt), life, w * 0.35, w * (p.state === S.Wreck ? 3.6 : 2.6), SMOKE[0], SMOKE[1], SMOKE[2], 0.75 * (0.5 + 0.5 * fade), 0.5 * fade * Math.min(1, p.fire), 0.8)
        p.tx = p.x
        p.ty = p.y
        p.tz = p.z
        p.tt = this.t
      }
    } else p.laid = false
    p.puffT += dt
    if (moving) return
    if (p.puffT < (p.smoke > 1.2 ? 0.16 : 0.3)) return
    p.puffT = 0
    // (Two reused specs: nothing allocated per puff.)
    if (f > 0.3) {
      const q = FLAME
      q.life = 0.5 + 0.3 * r()
      q.r0 = f * 0.45
      q.r1 = f * 0.95
      this.puffAt(r, p.x + (r() - 0.5) * f, p.y, p.z + (r() - 0.5) * f, 0, 3, 0, q)
    }
    if (p.smoke > 1.2) {
      const s = p.smoke * (0.75 + 0.5 * r())
      const q = COLUMN
      q.life = 5 + 3 * r()
      q.r0 = s * 0.55
      q.r1 = s * 2.4
      q.swell = s * 0.2
      q.heat = 0.35 * fade
      q.under = 0.4 * fade
      this.puffAt(r, p.x + (r() - 0.5) * s * 0.4, p.y + 1, p.z + (r() - 0.5) * s * 0.4, 0, 2 + 1.5 * r(), 0, q)
    }
  }

  // ---- lights, scorches, foam ----------------------------------------------------------------------------------------

  /** A fireball's light: a big soft glow and a pool on the surface under it (`floor`; -1e9 in the air). */
  private addLight(x: number, y: number, z: number, s: number, floor: number): void {
    let l = this.lights.find((q) => !q.live)
    if (!l) l = this.lights.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b))
    l.live = true
    l.x = x
    l.y = y
    l.z = z
    l.age = 0
    l.life = 0.9 + 0.3 * s
    l.radius = 26 * s
    l.k = 1
    const g = floor > -1e8 ? { h: floor } : this.surfaceHeight(x, z, y)
    l.ground = y - g.h < 60 ? g.h : -1e9
  }

  private drawLights(dt: number): void {
    const fx = this.fx
    for (const l of this.lights) {
      if (!l.live) continue
      l.age += dt
      const u = l.age / l.life
      if (u >= 1) {
        l.live = false
        continue
      }
      const k = (1 - u) * (1 - u)
      fx.glow(l.x, l.y, l.z, l.radius * (0.7 + 0.5 * u), 3.2, 1.5, 0.5, -0.4 * k)
      if (l.ground > -1e8) {
        const h = Math.max(0, l.y - l.ground)
        fx.disc(true, l.x, l.ground + 0.6, l.z, l.radius * 1.6 + h * 0.6, 0, 1, 0, 3.2, 1.5, 0.45, 0.45 * k * Math.max(0, 1 - h / 60), 7)
      }
    }
  }

  private addScorch(x: number, y: number, z: number, r: number, g: { h: number; ship: number; nx: number; ny: number; nz: number }): void {
    let s = this.scorches.find((q) => !q.live)
    if (!s) s = this.scorches.reduce((a, b) => (a.age > b.age ? a : b))
    s.live = true
    s.x = x
    s.y = g.h + 0.35
    s.z = z
    s.nx = g.nx
    s.ny = g.ny
    s.nz = g.nz
    s.r = r
    s.age = 0
    s.life = 40
    s.seed = Math.floor(x * 7 + z * 13) & 0xffff
    s.ship = g.ship
    const ship = g.ship >= 0 ? this.shipById(g.ship) : null
    if (ship) {
      worldToShip(ship, x, y, z, vt)
      s.lx = vt[0]
      s.ly = DECK_Y + 0.12
      s.lz = vt[2]
    } else s.ship = -1
  }

  private drawScorches(dt: number): void {
    for (const s of this.scorches) {
      if (!s.live) continue
      s.age += dt
      if (s.age > s.life) {
        s.live = false
        continue
      }
      const a = 0.82 * Math.min(1, s.age * 6) * Math.min(1, (s.life - s.age) / 6)
      if (s.ship >= 0) {
        const ship = this.shipById(s.ship)
        if (!ship) {
          s.live = false
          continue
        }
        shipToWorld(ship, s.lx, s.ly, s.lz, vt)
        const q = shipQuat(ship, qs)
        quatRotate(q[0], q[1], q[2], q[3], 0, 1, 0, vu)
        this.fx.disc(false, vt[0], vt[1], vt[2], s.r, vu[0], vu[1], vu[2], 0.03, 0.028, 0.026, a, s.seed)
      } else this.fx.disc(false, s.x, s.y, s.z, s.r, s.nx, s.ny, s.nz, 0.035, 0.03, 0.025, a, s.seed)
    }
  }

  private addFoam(x: number, z: number, size: number): void {
    let f = this.foams.find((q) => !q.live)
    if (!f) f = this.foams.reduce((a, b) => (a.age > b.age ? a : b))
    f.live = true
    f.x = x
    f.z = z
    f.age = 0
    f.life = 14
    f.size = size
  }

  private drawFoam(dt: number): void {
    for (const f of this.foams) {
      if (!f.live) continue
      f.age += dt
      if (f.age > f.life) {
        f.live = false
        continue
      }
      const s = f.size
      const u = f.age / f.life
      // A churned patch where it went in, and a ring spreading out from it, both fading and ageing.
      const ring = (6 + 26 * (1 - Math.exp(-f.age / 1.6))) * Math.sqrt(s)
      const width = (2.5 + 5 * u) * Math.sqrt(s)
      this.fx.foam(f.x, f.z, Math.max(0.5, ring - width), ring + width, 0.95 * (1 - u) * (1 - u), Math.min(1, u * 1.4))
      this.fx.foam(f.x, f.z, 0, (5 + 6 * u) * Math.sqrt(s), (1 - u) * Math.min(1, 1.3 - u), Math.min(1, 0.2 + u))
    }
  }

  // ---- helpers -------------------------------------------------------------------------------------------------------

  private puffAt(r: () => number, x: number, y: number, z: number, vx: number, vy: number, vz: number, s: PuffSpec): void {
    this.fx.puff(x, y, z, vx, vy, vz, s, Math.floor(r() * 16777215))
  }

  private shipById(id: number): (ShipPoseLike & { id?: number; u?: number; v?: number }) | null {
    if (id < 0) return null
    for (const s of this.shipsNow) if (s.id === id) return s
    return null
  }

  private shipVel(s: ShipPoseLike & { u?: number; v?: number }): V3 {
    const u = s.u ?? 0
    const v = s.v ?? 0
    const sh = Math.sin(s.heading)
    const ch = Math.cos(s.heading)
    vs[0] = sh * u + ch * v
    vs[1] = 0
    vs[2] = -ch * u + sh * v
    return vs
  }

  private surf = { h: 0, kind: "sea" as "sea" | "land" | "ship", ship: -1, nx: 0, ny: 1, nz: 0 }

  /** The surface under (x, z) for something at height y: a carrier's deck, land or the sea, and its normal. */
  surfaceHeight(x: number, z: number, y: number): { h: number; kind: "sea" | "land" | "ship"; ship: number; nx: number; ny: number; nz: number } {
    const o = this.surf
    const w = this.world
    o.ship = -1
    o.nx = 0
    o.ny = 1
    o.nz = 0
    for (const s of this.shipsNow) {
      if (Math.abs(x - s.x) > 200 || Math.abs(z - s.z) > 200) continue
      worldToShip(s, x, y, z, vt)
      if (vt[0] > DECK_X0 && vt[0] < DECK_X1 && vt[2] > STERN_Z && vt[2] < BOW_Z && vt[1] > DECK_Y - 6) {
        shipToWorld(s, vt[0], DECK_Y, vt[2], vu)
        o.h = vu[1]
        o.kind = "ship"
        o.ship = s.id ?? -1
        return o
      }
    }
    const sea = w.sea ? seaHeight(w.sea, x, z, this.t) : 0
    const land = w.arch ? terrainHeight(w.arch, x, z) : -1e9
    if (land > sea) {
      o.h = land
      o.kind = "land"
      if (w.arch) {
        const e = 2
        const dx = terrainHeight(w.arch, x + e, z) - terrainHeight(w.arch, x - e, z)
        const dz = terrainHeight(w.arch, x, z + e) - terrainHeight(w.arch, x, z - e)
        const l = Math.hypot(dx, 2 * e, dz)
        o.nx = -dx / l
        o.ny = (2 * e) / l
        o.nz = -dz / l
      }
      return o
    }
    o.h = sea
    o.kind = "sea"
    return o
  }
}
