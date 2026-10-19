import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { blastAge, DYN_RING, dynamiteAt, fireHash, ringId, SCORCH_RING, TRAP_RING } from "../../shared/fire/fire"
import { hex } from "../level"
import { fireAlphaSprites, fireLights, sprayers, type FireFrame } from "./fx"
import { bearTrapMesh, buildFireItemMeshes } from "./items"

const MAX_CAND = 40

type Pool = { model: number; data: Float32Array<ArrayBuffer>; count: number }

/** A soot blot: a dark core, ragged lobes round it and a fainter rim, flat on the ground. Unit radius. */
function scorchMesh(seed: number, crater: boolean): Mesh {
  const m = new Mesh()
  const soot: Rgb = hex(crater ? 0x0b0a09 : 0x100e0c)
  const rim: Rgb = hex(crater ? 0x1c1915 : 0x1f1b17)
  m.prism(0, 0, 0.72, 0.72, 0, 0.003, 14, soot, MAT.lit, 0, true, seed)
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + fireHash(seed, i) * 0.7
    const d = 0.45 + fireHash(seed, i + 10) * 0.35
    const r = 0.22 + fireHash(seed, i + 20) * 0.25
    m.prism(Math.cos(a) * d, Math.sin(a) * d, r, r, 0, 0.002, 9, i % 2 ? rim : soot, MAT.lit, 0, true, a)
  }
  if (crater) {
    // Blast streaks thrown out from the centre, and a ring of broken ground.
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + fireHash(seed, i + 30) * 0.4
      const len = 0.7 + fireHash(seed, i + 40) * 0.8
      m.yawBox(Math.cos(a) * len * 0.6, Math.sin(a) * len * 0.6, len, 0.06 + 0.05 * fireHash(seed, i + 50), 0, 0.0025, -a, soot, MAT.lit)
    }
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + fireHash(seed, i + 60)
      m.yawBox(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.12, 0.08, 0, 0.03, a, hex(0x2a2520), MAT.lit)
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
    if (look.fireChar > 0) {
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
    for (const p of this.pools.values()) if (p.count) this.out.push({ model: p.model, data: p.data, count: p.count })
    return this.out
  }

  /** Smoke into the alpha sprites from `count`; returns the new count. */
  smoke(frame: FireFrame, sprites: Float32Array, count: number): number {
    return fireAlphaSprites(frame, sprites, count)
  }

  /** Gathers this frame's fire lights (call before `writeLights`). */
  gatherLights(frame: FireFrame, camX: number, camY: number): void {
    this.cand.length = 0
    const d = this.candData
    fireLights(frame, (x, h, z, r, c, power) => {
      if (this.cand.length >= MAX_CAND) return
      const o = this.cand.length * LIGHT_FLOATS
      d[o] = x
      d[o + 1] = h
      d[o + 2] = z
      d[o + 3] = r
      d[o + 4] = c[0]
      d[o + 5] = c[1]
      d[o + 6] = c[2]
      d[o + 7] = power
      d[o + 8] = 0
      d[o + 9] = 0
      d[o + 10] = 0
      // A point light kept out of rooms in the interior view, like the road flares and porch lights.
      d[o + 11] = -1
      d[o + 12] = 0
      d[o + 13] = 0
      d[o + 14] = 0.12
      d[o + 15] = -1
      this.cand.push({ d2: (x - camX) ** 2 + (z - camY) ** 2, o })
    })
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
