import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { MAT, Mesh, type Mat } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { dayCycle } from "../../shared/day-cycle"
import type { SessionView } from "../../shared/session"
import type { ClueSite } from "../../shared/way-out/clues"
import { arrivalHeading, LANDMARK_SOLIDS, landmarkToWorld } from "../../shared/way-out/landmark"
import { DESTINATION_KINDS, type DestinationKind, type WayOutPlan } from "../../shared/way-out/plan"
import type { WayOutView } from "../../shared/way-out/state"
import { BODY_LOOK, bodyMesh } from "../discovery/vignettes"
import { hex } from "../level"

const MAX = 32
const RANGE = 34
/** The destination is drawn (and lit) from this far, so its lights read down the road before you arrive (m). */
const LANDMARK_RANGE = 110
const SOLDIER_LOOK = { top: hex(0x4c5434), legs: hex(0x3f4630), skin: hex(0xa88468), hair: hex(0x3a3c2c), shoes: hex(0x1c1a14) } as const

/** Floodlights in the landmark's frame: where the pole stands and which way its head points (radians, landmark frame). */
const FLOODS: Readonly<Record<DestinationKind, readonly { x: number; z: number; aim: number }[]>> = {
  ferry: [{ x: 7, z: -9, aim: 0.5 }, { x: 7, z: 9, aim: -0.5 }, { x: -9, z: 9, aim: -2.4 }],
  checkpoint: [{ x: 12, z: -10, aim: Math.PI }, { x: 9, z: 10, aim: -2.6 }, { x: -9, z: -9, aim: 2.4 }],
  airfield: [{ x: 8, z: -9, aim: 0.4 }, { x: 16, z: 8, aim: -1.2 }, { x: -9, z: 9, aim: -2.4 }],
  dam: [{ x: 7, z: -12, aim: 2.8 }, { x: 7, z: 12, aim: -2.8 }, { x: -9, z: -9, aim: 2.4 }],
}

/** The beacon over each place, red, blinking once the signal is sent (landmark frame, with its height). */
const BEACON: Readonly<Record<DestinationKind, { x: number; z: number; h: number }>> = {
  ferry: { x: 22, z: 0, h: 6.6 },
  checkpoint: { x: 12, z: -10, h: 5.4 },
  airfield: { x: 12.2, z: 12.5, h: 5.6 },
  dam: { x: 10, z: 0, h: 7.6 },
}

function landmarkMesh(kind: DestinationKind): Mesh {
  const m = new Mesh()
  const concrete = hex(0x8a8a84)
  const dark = hex(0x2a2c2e)
  const olive = hex(0x4f5536)
  const solid = (b: { x0: number; z0: number; x1: number; z1: number; h: number }, col: ReturnType<typeof hex>, mat: Mat = MAT.lit) =>
    m.box(b.x0, 0, b.z0, b.x1, b.h, b.z1, col, mat)
  if (kind === "ferry") {
    // Black water on the far road, a quay edge with bollards, the ferry moored along it with its gangway down.
    m.box(7, 0.005, -7, 36, 0.03, 7, hex(0x162229), MAT.shiny)
    m.box(6, 0, -7.5, 7.4, 0.35, 7.5, concrete, MAT.wall)
    for (const z of [-6, -2, 2, 6]) m.prism(6.7, z, 0.18, 0.2, 0.35, 0.75, 8, dark, MAT.shiny)
    solid(LANDMARK_SOLIDS.ferry[0]!, hex(0x2a1c1a), MAT.shiny)
    m.box(12, 2.4, -3.6, 30, 2.6, 3.6, hex(0x9a3a2a), MAT.lit)
    m.box(15, 2.6, -2.8, 25, 4.6, 2.8, hex(0xd8d2c0), MAT.wall)
    m.box(17, 4.6, -2.2, 23, 5.8, 2.2, hex(0xc8c2b0), MAT.wall)
    for (const x of [15.6, 17.4, 19.2, 21, 22.8]) m.box(x, 3.3, -2.85, x + 1, 3.9, 2.85, hex(0xffd890), MAT.accent)
    m.prism(21.8, 0, 0.55, 0.6, 5.8, 7.4, 10, hex(0x1a1a1a), MAT.lit)
    m.box(8, 0.35, -1, 12, 0.5, 1, hex(0x5c5a52), MAT.shiny)
  } else if (kind === "checkpoint") {
    // A striped barrier across the far road, a guard booth, a truck, a watchtower, sandbags and concrete blocks.
    m.box(8.6, 0, -6.4, 9.2, 1.1, -5.8, olive, MAT.lit)
    for (let i = 0; i < 6; i++) m.box(8.75, 1.0, -5.8 + i * 1.9, 9.05, 1.2, -4.85 + i * 1.9, i % 2 ? hex(0xd8d0bc) : hex(0xb43a28), MAT.lit)
    solid(LANDMARK_SOLIDS.checkpoint[0]!, olive, MAT.wall)
    m.box(8.3, 2.6, 6.8, 10.7, 2.8, 9.8, dark, MAT.roof)
    m.box(8.35, 1.3, 7.4, 8.4, 2, 9.2, hex(0xffd890), MAT.accent)
    solid(LANDMARK_SOLIDS.checkpoint[1]!, olive, MAT.lit)
    m.box(17.5, 0, 2.2, 19.6, 2, 4.6, hex(0x434830), MAT.lit)
    for (const [x, z] of [[11, -11], [13, -11], [11, -9], [13, -9]] as const) m.box(x - 0.12, 0, z - 0.12, x + 0.12, 4.2, z + 0.12, hex(0x4a4436), MAT.timber)
    m.box(10.6, 4, -11.4, 13.4, 4.2, -8.6, hex(0x5a503e), MAT.timber)
    m.box(10.6, 4.2, -11.4, 13.4, 5.1, -11.2, hex(0x5a503e), MAT.timber)
    for (let i = 0; i < 7; i++) m.box(-14 + i * 1.1, 0, 7.2, -13.1 + i * 1.1, 0.5, 8, hex(0x7c6e4e), MAT.cloth)
    for (let i = 0; i < 7; i++) m.box(-14 + i * 1.1, 0, -8, -13.1 + i * 1.1, 0.5, -7.2, hex(0x7c6e4e), MAT.cloth)
    for (const [x, z] of [[11, -3], [14, 0.5], [11, 4]] as const) m.box(x - 1, 0, z - 0.3, x + 1, 0.8, z + 0.3, concrete, MAT.wall)
    m.box(-15, 0, 9, -9, 2.2, 15, hex(0x5a5e40), MAT.cloth)
  } else if (kind === "airfield") {
    // The runway down the far road, edge lights, a small plane, a hangar, a windsock.
    m.box(6, 0.005, -8, 40, 0.025, 8, hex(0x222426), MAT.floor)
    for (let x = 8; x < 40; x += 5) m.box(x, 0.025, -0.15, x + 2.4, 0.035, 0.15, hex(0xd8d4c4), MAT.lit)
    for (let x = 7; x < 40; x += 6) {
      m.box(x, 0.02, -8.3, x + 0.25, 0.3, -8.05, hex(0xffe6a0), MAT.accent)
      m.box(x, 0.02, 8.05, x + 0.25, 0.3, 8.3, hex(0xffe6a0), MAT.accent)
    }
    solid(LANDMARK_SOLIDS.airfield[0]!, hex(0x6c7076), MAT.wall)
    m.box(8.8, 5, 9.3, 15.7, 5.4, 15.7, hex(0x55585c), MAT.roof)
    m.box(9, 0, 9.4, 15.5, 3.6, 9.5, hex(0x1e1e20), MAT.lit)
    solid(LANDMARK_SOLIDS.airfield[1]!, hex(0xc8c4b8), MAT.shiny)
    m.box(17.4, 1.1, -5, 19.2, 1.3, 5, hex(0xc8c4b8), MAT.shiny)
    m.box(21.6, 1.2, -1.8, 22.6, 1.35, 1.8, hex(0xc8c4b8), MAT.shiny)
    m.box(22, 1.3, -0.1, 23, 2.6, 0.1, hex(0x9a3a2a), MAT.lit)
    m.box(14.4, 0.6, -0.4, 15, 1.4, 0.4, hex(0x2a2a2a), MAT.lit)
    m.box(8, 0, -11.06, 8.12, 4, -10.94, hex(0x8a8a84), MAT.shiny)
    m.box(8.1, 3.6, -11.15, 9.6, 3.95, -10.85, hex(0xd8661e), MAT.cloth)
  } else {
    // The dam: a great wall across the far road with a walkway on top, black water far below beyond it, a control hut.
    solid(LANDMARK_SOLIDS.dam[0]!, hex(0x9a978c), MAT.wall)
    m.box(8.6, 6.5, -16, 11.4, 6.8, 16, hex(0x6e6c64), MAT.wall)
    for (const z of [-12, -6, 0, 6, 12]) m.box(9.6, 0, z - 1, 10.4, 6.5, z + 1, hex(0x86847a), MAT.wall)
    m.box(11, 0.005, -16, 40, 0.03, 16, hex(0x101a20), MAT.shiny)
    solid(LANDMARK_SOLIDS.dam[1]!, hex(0x7a7a70), MAT.wall)
    m.box(3.8, 2.8, 8.8, 8.2, 3.1, 13.2, dark, MAT.roof)
    m.box(3.95, 1.2, 10, 4.0, 2.1, 12, hex(0xffd890), MAT.accent)
    m.box(5, 0.03, -16, 8.5, 0.05, 8, hex(0x5a5a54), MAT.floor)
  }
  return m
}

function floodPole(): Mesh {
  const m = new Mesh()
  m.box(-0.09, 0, -0.09, 0.09, 6, 0.09, hex(0x3a3c3e), MAT.shiny)
  m.box(-0.35, 6, -0.5, 0.35, 6.12, 0.5, hex(0x3a3c3e), MAT.shiny)
  m.box(0.1, 5.7, -0.45, 0.42, 6.05, 0.45, hex(0xf2f4ff), MAT.accent)
  return m
}

function beacon(): Mesh {
  const m = new Mesh()
  m.box(-0.14, -0.14, -0.14, 0.14, 0.14, 0.14, hex(0xff3020), MAT.accent)
  return m
}

/** The signal post: a flare stand at the quay, a field radio on a crate, a siren on a pole, an orange beacon box. */
function signalPost(kind: DestinationKind): Mesh {
  const m = new Mesh()
  if (kind === "checkpoint") {
    m.box(-0.35, 0, -0.3, 0.35, 0.6, 0.3, hex(0x4f5536), MAT.timber)
    m.box(-0.22, 0.6, -0.15, 0.22, 0.9, 0.15, hex(0x3c4230), MAT.lit)
    m.box(0.1, 0.9, -0.1, 0.12, 1.5, -0.08, hex(0x222222), MAT.shiny)
    m.box(-0.15, 0.72, 0.15, -0.02, 0.8, 0.16, hex(0x80ff60), MAT.accent)
  } else if (kind === "dam") {
    m.box(-0.07, 0, -0.07, 0.07, 3.2, 0.07, hex(0x6a6a64), MAT.shiny)
    m.prism(0, 0, 0.18, 0.32, 3.2, 3.6, 10, hex(0xb8b4a8), MAT.shiny)
    m.box(-0.2, 1, 0.07, 0.2, 1.5, 0.15, hex(0xd8661e), MAT.lit)
  } else {
    m.box(-0.06, 0, -0.06, 0.06, 1.2, 0.06, hex(0x7a7a70), MAT.shiny)
    m.box(-0.25, 1.2, -0.2, 0.25, 1.55, 0.2, hex(0xd8661e), MAT.lit)
    m.box(-0.12, 1.55, -0.12, 0.12, 1.75, 0.12, hex(0xff4030), MAT.accent)
  }
  return m
}

function signMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.05, 0, -0.05, 0.05, 2.3, 0.05, hex(0x8a8a84), MAT.shiny)
  m.box(0.05, 1.5, -0.95, 0.1, 2.25, 0.95, hex(0x2f5a3a), MAT.lit)
  m.box(0.1, 1.58, -0.88, 0.11, 2.17, 0.88, hex(0xd8d4c4), MAT.lit)
  m.box(0.105, 1.64, -0.82, 0.12, 2.11, 0.82, hex(0x2f5a3a), MAT.lit)
  // An arrow along the road (toward -z) and a place mark.
  m.box(0.12, 1.85, -0.7, 0.13, 1.91, 0.1, hex(0xe8e4d4), MAT.lit)
  m.box(0.12, 1.78, -0.7, 0.13, 1.98, -0.55, hex(0xe8e4d4), MAT.lit)
  m.box(0.12, 1.75, 0.3, 0.13, 2.02, 0.7, hex(0xe8e4d4), MAT.lit)
  return m
}

function paper(col: number, lines: number): Mesh {
  const m = new Mesh()
  m.box(-0.11, 0, -0.15, 0.11, 0.006, 0.15, hex(col), MAT.cloth)
  for (let i = 0; i < lines; i++) m.box(-0.08, 0.006, -0.11 + i * 0.045, 0.07 - (i % 2) * 0.04, 0.008, -0.1 + i * 0.045, hex(0x3a3630), MAT.lit)
  return m
}

function soldier(): Mesh {
  const m = bodyMesh(SOLDIER_LOOK as unknown as (typeof BODY_LOOK)["survivor"], 0)
  // Helmet by the head and a satchel of papers.
  m.prism(1.05, 0.25, 0.15, 0.17, 0, 0.14, 8, hex(0x3e4430), MAT.shiny)
  m.box(-0.1, 0, 0.32, 0.22, 0.12, 0.56, hex(0x4a4630), MAT.cloth)
  m.box(-0.04, 0.12, 0.36, 0.16, 0.125, 0.52, hex(0xd8d4c4), MAT.lit)
  return m
}

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>

/**
 * The Way Out in the world (AR-64): the clues (notes, the police map piece, the road sign, the dead soldier), the
 * destination itself with its floodlights and beacon, lit by its own lights at night (Darkwood: colour only where
 * there is light), and its signal post. Reads the plan and the `wayout` store only.
 */
export class WayOutProps {
  private readonly models: { note: number; map: number; sign: number; soldier: number; flood: number; beacon: number; landmark: Record<DestinationKind, number>; post: Record<DestinationKind, number> }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  readonly shown = { clues: [] as string[], landmark: false, lights: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const per = (f: (k: DestinationKind) => Mesh) => Object.fromEntries(DESTINATION_KINDS.map((k) => [k, renderer.addModel(f(k))])) as Record<DestinationKind, number>
    this.models = {
      note: renderer.addModel(paper(0xe4dccb, 4)),
      map: renderer.addModel(paper(0xc8b48a, 0)),
      sign: renderer.addModel(signMesh()),
      soldier: renderer.addModel(soldier()),
      flood: renderer.addModel(floodPole()),
      beacon: renderer.addModel(beacon()),
      landmark: per(landmarkMesh),
      post: per(signalPost),
    }
  }

  collect(view: SessionView, plan: WayOutPlan, wv: WayOutView | null, sites: readonly ClueSite[], support: (x: number, z: number) => number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const p = view.player
    const shown = this.shown
    shown.clues.length = 0
    for (const c of sites) {
      if (Math.abs(c.x - p.x) > RANGE || Math.abs(c.y - p.y) > RANGE) continue
      const found = wv?.clues.has(c.id) ?? false
      const g = support(c.x, c.y)
      if (c.kind === "note") this.put(this.models.note, c.x, g + c.z + 0.004, c.y, c.yaw)
      else if (c.kind === "police") {
        if (found) continue
        this.put(this.models.map, c.x, g + c.z + 0.004, c.y, c.yaw)
      } else if (c.kind === "sign") this.put(this.models.sign, c.x, g, c.y, c.yaw)
      else if (c.kind === "soldier") this.put(this.models.soldier, c.x, g + 0.008, c.y, c.yaw)
      shown.clues.push(c.id)
    }
    shown.landmark = false
    if (Math.abs(plan.x - p.x) <= LANDMARK_RANGE && Math.abs(plan.y - p.y) <= LANDMARK_RANGE) {
      shown.landmark = true
      const h = arrivalHeading(plan.arrival)
      this.put(this.models.landmark[plan.kind], plan.x, support(plan.x, plan.y), plan.y, h)
      for (const f of FLOODS[plan.kind]) {
        const w = landmarkToWorld(plan, f.x, f.z)
        this.put(this.models.flood, w.x, support(w.x, w.y), w.y, h + f.aim)
      }
      const b = BEACON[plan.kind]
      const bw = landmarkToWorld(plan, b.x, b.z)
      const blink = wv?.signalled ? (Math.sin(view.time * 7) > 0 ? 1.6 : 0.15) : 0.5 + 0.5 * Math.sin(view.time * 1.6)
      this.put(this.models.beacon, bw.x, support(bw.x, bw.y) + b.h, bw.y, 0, [blink, blink * 0.25, blink * 0.15])
      this.put(this.models.post[plan.kind], plan.signal.x, support(plan.signal.x, plan.signal.y), plan.signal.y, h)
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  /** The destination's floodlights and beacon, packed after the other lights; returns the new count. */
  writeLights(view: SessionView, plan: WayOutPlan, wv: WayOutView | null, support: (x: number, z: number) => number, lights: Float32Array, count: number, max: number): number {
    this.shown.lights = 0
    const p = view.player
    if (Math.abs(plan.x - p.x) > LANDMARK_RANGE || Math.abs(plan.y - p.y) > LANDMARK_RANGE) return count
    const night = dayCycle(view.hour).lamps
    if (night < 0.05) return count
    const add = (x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number) => {
      if (count >= max || power <= 0.01) return
      const o = count * LIGHT_FLOATS
      lights.fill(0, o, o + LIGHT_FLOATS)
      lights[o] = x
      lights[o + 1] = h
      lights[o + 2] = z
      lights[o + 3] = r
      lights[o + 4] = c[0]
      lights[o + 5] = c[1]
      lights[o + 6] = c[2]
      lights[o + 7] = power
      lights[o + 11] = -1
      lights[o + 14] = 0.12
      lights[o + 15] = -1
      count++
      this.shown.lights++
    }
    for (const f of FLOODS[plan.kind]) {
      // The pool falls a few metres out from the pole, the way its head points.
      const a = arrivalHeading(plan.arrival) + f.aim
      const w = landmarkToWorld(plan, f.x, f.z)
      add(w.x + Math.cos(a) * 3.5, support(w.x, w.y) + 5.2, w.y + Math.sin(a) * 3.5, 15, [0.82, 0.88, 1], 1.3 * night)
    }
    const b = BEACON[plan.kind]
    const bw = landmarkToWorld(plan, b.x, b.z)
    const blink = wv?.signalled ? (Math.sin(view.time * 7) > 0 ? 1 : 0.1) : 0.35
    add(bw.x, support(bw.x, bw.y) + b.h, bw.y, 9, [1, 0.22, 0.12], 0.9 * blink * night)
    return count
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, tint: readonly [number, number, number] = [1, 1, 1]): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, tint[0], tint[1], tint[2], 1, 0, 0, 1, 0], v.count++ * INST_FLOATS)
  }
}
