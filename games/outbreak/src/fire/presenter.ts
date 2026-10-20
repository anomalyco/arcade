import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_CAPSULE, LIGHT_FLOATS } from "@arcade/kit/limits"
import { blastAge, DYN_RING, dynamiteAt, FIRE_RING, fireHash, fireLit, ringId, SCORCH_RING, TRAP_RING, TREE_RING, treeBurn } from "../../shared/fire/fire"
import { hex } from "../level"
import { setFoliageBurnSpots, setTreeBurnSource, treeIdAt } from "../vegetation/trees"
import { fireAlphaSprites, fireLights, sprayers, type FireFrame } from "./fx"
import { bearTrapMesh, buildFireItemMeshes } from "./items"

const MAX_CAND = 40

type Pool = { model: number; data: Float32Array<ArrayBuffer>; count: number }

const UP = [0, 1, 0] as const

/** A ragged flat blob on the ground: a fan from `core` at the centre out through `mid` to `rim` at a wavy edge. */
function blot(m: Mesh, seed: number, cx: number, cz: number, r: number, core: Rgb, mid: Rgb, rim: Rgb, y = 0): void {
  const n = 18
  const amps = [0, 1, 2, 3].map((k) => (0.28 * (0.5 + fireHash(seed, k))) / (k + 1.4))
  const phases = [0, 1, 2, 3].map((k) => fireHash(seed, k + 9) * Math.PI * 2)
  const edge = (t: number) => r * Math.max(0.45, 1 + amps.reduce((s, a, k) => s + a * Math.sin((k + 2) * t + phases[k]!), 0))
  const at = (t: number, f: number): [number, number, number] => [cx + Math.cos(t) * edge(t) * f, y, cz + Math.sin(t) * edge(t) * f]
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2
    const t1 = ((i + 1) / n) * Math.PI * 2
    // Counter-clockwise in (x, z) seen from above, emitted reversed so the face points up through back-face culling.
    m.vert([cx, y, cz], UP, core, MAT.lit)
    m.vert(at(t1, 0.55), UP, mid, MAT.lit)
    m.vert(at(t0, 0.55), UP, mid, MAT.lit)
    m.vert(at(t0, 0.55), UP, mid, MAT.lit)
    m.vert(at(t1, 0.55), UP, mid, MAT.lit)
    m.vert(at(t1, 1), UP, rim, MAT.lit)
    m.vert(at(t0, 0.55), UP, mid, MAT.lit)
    m.vert(at(t1, 1), UP, rim, MAT.lit)
    m.vert(at(t0, 1), UP, rim, MAT.lit)
  }
}

/** Soot on the ground: a ragged dark core and a few smaller blots round it (a crater adds thrown streaks). Unit radius. */
function scorchMesh(seed: number, crater: boolean): Mesh {
  const m = new Mesh()
  const core = hex(0x070605)
  const mid = hex(crater ? 0x0d0b09 : 0x110e0c)
  const rim = hex(0x1d1a17)
  blot(m, seed, 0, 0, crater ? 0.62 : 0.5, core, mid, rim)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + fireHash(seed, i) * 0.9
    const d = 0.45 + fireHash(seed, i + 10) * 0.3
    blot(m, seed + i * 17, Math.cos(a) * d, Math.sin(a) * d, 0.12 + fireHash(seed, i + 20) * 0.14, mid, mid, rim, 0.0004)
  }
  if (crater) {
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + fireHash(seed, i + 30) * 0.4
      const len = 0.5 + fireHash(seed, i + 40) * 0.6
      m.yawBox(Math.cos(a) * (0.55 + len * 0.5), Math.sin(a) * (0.55 + len * 0.5), len, 0.04 + 0.04 * fireHash(seed, i + 50), 0, 0.0008, -a, mid, MAT.lit)
    }
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + fireHash(seed, i + 60)
      m.yawBox(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.1, 0.07, 0, 0.025, a, hex(0x24201b), MAT.lit)
    }
  }
  return m
}

/** The flamethrower worn and held: twin tanks on the back, a hose, and the wand along the right hip. Survivor frame. */
function rigMesh(): Mesh {
  const m = new Mesh()
  const tank = hex(0x7a2418)
  for (const z of [-0.085, 0.085]) {
    m.prism(-0.26, z, 0.075, 0.075, 0.82, 1.42, 10, tank, MAT.shiny)
    m.prism(-0.26, z, 0.05, 0.03, 1.42, 1.48, 8, hex(0x8a8e90), MAT.shiny)
  }
  m.box(-0.3, 0.98, -0.12, -0.22, 1.02, 0.12, hex(0x222222))
  m.yawBox(-0.06, 0.14, 0.42, 0.03, 0.9, 0.93, 0.35, hex(0x1a1a1a))
  m.yawBox(0.36, 0.16, 0.56, 0.045, 0.955, 1.005, 0, hex(0x3a3d40), MAT.shiny)
  m.yawBox(0.64, 0.16, 0.06, 0.07, 0.945, 1.015, 0, hex(0x1e2022), MAT.shiny)
  m.yawBox(0.16, 0.16, 0.06, 0.05, 0.9, 0.96, 0, hex(0x2a2a2a))
  return m
}

/**
 * Fire & explosives in the scene: scorch marks and craters on the ground, dynamite (in flight and lying with its fuse
 * spitting), set and sprung bear traps, and the flamethrower rig on whoever is spraying (and on the local survivor
 * holding one). Also packs fire's light into the frame's map lights, after the night lights, through the same
 * lamp grid, and writes smoke into the alpha sprites. Reads only ledger stores, so every co-op client sees the same.
 */
export class FirePresenter {
  private readonly scorch: number[]
  private readonly crater: number
  private readonly dynamite: number
  private readonly trapOpen: number
  private readonly trapShut: number
  private readonly rig: number
  private readonly pools = new Map<number, Pool>()
  private readonly out: Batch[] = []
  private readonly cand: { d2: number; o: number }[] = []
  private readonly candData = new Float32Array(MAX_CAND * LIGHT_FLOATS)
  private readonly treeBurns = new Map<number, number>()
  /** Shrub and hedge burn spots, flat: x, z, radius, burn. */
  private readonly spots: number[] = []
  /** Proof readout of the last frame. */
  readonly shown = { scorch: 0, lights: 0, sprayers: 0, dynamite: 0, traps: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    this.scorch = [11, 23, 37].map((seed) => renderer.addModel(scorchMesh(seed, false)))
    this.crater = renderer.addModel(scorchMesh(53, true))
    this.dynamite = renderer.addModel(buildFireItemMeshes().dynamite!)
    this.trapOpen = renderer.addModel(bearTrapMesh(false))
    this.trapShut = renderer.addModel(bearTrapMesh(true))
    this.rig = renderer.addModel(rigMesh())
  }

  private readonly burnOf = (id: number) => this.treeBurns.get(id) ?? 0
  private readonly pushSpots = (push: (x: number, z: number, r: number, burn: number) => void) => {
    const sp = this.spots
    for (let i = 0; i < sp.length; i += 4) push(sp[i]!, sp[i + 1]!, sp[i + 2]!, sp[i + 3]!)
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, scale = 1, alpha = 1, pitch = 0, roll = 0): void {
    let p = this.pools.get(model)
    if (!p) this.pools.set(model, (p = { model, data: new Float32Array(16 * INST_FLOATS), count: 0 }))
    if ((p.count + 1) * INST_FLOATS > p.data.length) {
      const grown = new Float32Array(p.data.length * 2)
      grown.set(p.data)
      p.data = grown
    }
    p.data.set([x, y, z, yaw, 1, 1, 1, scale, pitch, roll, alpha, 0], p.count++ * INST_FLOATS)
  }

  /** The frame's meshes; `rect` is the camera's ground rect. */
  collect(frame: FireFrame, rect: readonly [number, number, number, number]): readonly Batch[] {
    for (const p of this.pools.values()) p.count = 0
    this.out.length = 0
    const { view, support, look } = frame
    const time = view.time
    const ledger = view.progression.ledger
    const [x0, y0, x1, y1] = rect
    const inView = (x: number, z: number, m = 3) => x > x0 - m && x < x1 + m && z > y0 - m && z < y1 + m
    const sh = this.shown
    sh.scorch = sh.dynamite = sh.traps = 0
    // The kit fire draws scorch as noise decals (`kit-fx.ts`).
    if (look.fireChar > 0 && look.fireStyle !== 1) {
      for (let k = 0; k < SCORCH_RING; k++) {
        const st = ledger.store(ringId("scorch", k))
        if (!st?.at || !st.counts.r || !inView(st.at.x, st.at.y)) continue
        const r = (st.counts.r ?? 0) / 100
        const grow = Math.min(1, Math.max(0.05, (time - (st.counts.t ?? 0) / 10) / 0.35))
        const crater = Boolean(st.counts.crater)
        const model = crater ? this.crater : this.scorch[k % this.scorch.length]!
        // Each a hair above the last, so overlapping marks never fight.
        this.put(model, st.at.x, support(st.at.x, st.at.y) + 0.009 + (k % 16) * 0.0005 + (crater ? 0.008 : 0), st.at.y, fireHash(k, st.counts.t ?? 0) * Math.PI * 2, r * (0.6 + 0.4 * grow), look.fireChar)
        sh.scorch++
      }
    }
    for (let k = 0; k < DYN_RING; k++) {
      const st = ledger.store(ringId("dyn", k))
      if (!st?.at || !st.counts.t || blastAge(st, time) >= 0) continue
      const p = dynamiteAt(st, time)
      if (!inView(p.x, p.y)) continue
      const spin = p.flying ? time * 11 : 0
      this.put(this.dynamite, p.x, support(p.x, p.y) + p.h, p.y, fireHash(st.counts.t, 1) * 6.28 + spin, 1, 1, p.flying ? time * 7 : 0)
      sh.dynamite++
    }
    for (let k = 0; k < TRAP_RING; k++) {
      const st = ledger.store(ringId("trap", k))
      if (!st?.at || !st.counts.t || !inView(st.at.x, st.at.y)) continue
      this.put(st.counts.snap ? this.trapShut : this.trapOpen, st.at.x, support(st.at.x, st.at.y) + 0.004, st.at.y, fireHash(k, st.counts.t) * 6.28)
      sh.traps++
    }
    const spraying = sprayers(frame)
    sh.sprayers = spraying.length
    const rigged = new Set(spraying.map((s) => s.s.id))
    const me = frame.survivors.find((s) => s.id === view.actorId)
    if (me && view.progression.selected(view.actorId)?.item === "flamethrower") rigged.add(me.id)
    for (const s of frame.survivors) {
      if (!rigged.has(s.id) || !inView(s.x, s.y)) continue
      this.put(this.rig, s.x, support(s.x, s.y), s.y, s.aim)
    }
    // Dynamite in flight goes into the TAA reactive mask.
    for (const p of this.pools.values()) if (p.count) this.out.push({ model: p.model, data: p.data, count: p.count, reactive: p.model === this.dynamite })
    return this.out
  }

  /** Smoke into the alpha sprites from `count`; returns the new count. */
  smoke(frame: FireFrame, sprites: Float32Array, count: number): number {
    return fireAlphaSprites(frame, sprites, count)
  }

  /** Gathers this frame's fire lights (call before `writeLights`), and the burning trees and charred ground vegetation draws. */
  gatherLights(frame: FireFrame, camX: number, camY: number): void {
    this.gatherBurns(frame)
    this.cand.length = 0
    const d = this.candData
    fireLights(frame, (x, h, z, r, c, power, hx = 0, hy = 0, hz = 0) => {
      if (this.cand.length >= MAX_CAND) return
      const o = this.cand.length * LIGHT_FLOATS
      const capsule = hx !== 0 || hy !== 0 || hz !== 0
      d[o] = x
      d[o + 1] = h
      d[o + 2] = z
      // A capsule's reach is from its centre: the radius plus its plan half-length (the lamp grid and reject use it).
      d[o + 3] = r + (capsule ? Math.hypot(hx, hz) : 0)
      d[o + 4] = c[0]
      d[o + 5] = c[1]
      d[o + 6] = c[2]
      d[o + 7] = power
      d[o + 8] = hx
      d[o + 9] = hy
      d[o + 10] = hz
      // Points and capsules alike are kept out of rooms in the interior view, like the road flares and porch lights.
      d[o + 11] = capsule ? LIGHT_CAPSULE : -1
      d[o + 12] = 0
      d[o + 13] = 0
      d[o + 14] = 0.12
      d[o + 15] = -1
      this.cand.push({ d2: (x - camX) ** 2 + (z - camY) ** 2, o })
    })
  }

  /** Burn state per burning or burnt tree, and the burning and scorched ground that chars shrubs and hedges. */
  private gatherBurns(frame: FireFrame): void {
    const { view, look } = frame
    const time = view.time
    const ledger = view.progression.ledger
    this.treeBurns.clear()
    for (let k = 0; k < TREE_RING; k++) {
      const st = ledger.store(ringId("tree", k))
      if (!st?.at || !st.counts.t) continue
      this.treeBurns.set(treeIdAt(st.at.x, st.at.y), treeBurn(st, time, look.treeBurnSeconds))
    }
    // Vegetation only walks its trees while one has caught.
    setTreeBurnSource(this.treeBurns.size ? this.burnOf : null)
    const spots = this.spots
    spots.length = 0
    const ch = look.foliageChar
    setFoliageBurnSpots(ch > 0 ? this.pushSpots : null)
    if (ch <= 0) return
    for (let k = 0; k < FIRE_RING; k++) {
      const st = ledger.store(ringId("fire", k))
      if (!st?.at || !fireLit(st, time)) continue
      spots.push(st.at.x, st.at.y, ((st.counts.r ?? 0) / 100) * 1.1, 0.32 * ch)
    }
    for (let k = 0; k < SCORCH_RING; k++) {
      const st = ledger.store(ringId("scorch", k))
      if (!st?.at || !st.counts.r) continue
      const age = time - (st.counts.t ?? 0) / 10
      // Black and half gone where fire passed (a crater strips them), coming on over a few seconds.
      spots.push(st.at.x, st.at.y, ((st.counts.r ?? 0) / 100) * (st.counts.crater ? 1.5 : 1.2), Math.min(0.78, 0.3 + Math.max(0, age) * 0.12) * ch)
    }
  }

  /** Packs the nearest fire lights into `lights` from `count`, at most `fireMaxLights`; returns the new count. */
  writeLights(lights: Float32Array, count: number, max: number, maxFire: number): number {
    this.cand.sort((a, b) => a.d2 - b.d2)
    const n = Math.min(this.cand.length, Math.max(0, Math.round(maxFire)), Math.max(0, max - count))
    for (let i = 0; i < n; i++) {
      const src = this.cand[i]!.o
      lights.set(this.candData.subarray(src, src + LIGHT_FLOATS), (count + i) * LIGHT_FLOATS)
    }
    this.shown.lights = n
    return count + n
  }
}

let current: FirePresenter | null = null

export function setCurrentFire(p: FirePresenter): void {
  current = p
}

export const currentFire = (): FirePresenter | null => current
