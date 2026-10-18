import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { Rect } from "@arcade/kit/sim/geom"
import { carStoreId, ds, portals, tripLine, tripStoreId } from "../../shared/discovery/verbs"
import type { SessionView } from "../../shared/session"
import { ABANDONED_VEHICLE_SPECS } from "../clutter"
import { hex } from "../level"

const MAX = 128
const RANGE = 30
/** Seconds per car-alarm flash: the lights blink twice for each wail. */
const FLASH = 0.6

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>

/**
 * Where a car's mesh really sits, in a frame with the nose along +x: the street wrecks use clutter model 8 at their
 * authored yaw; anything else is a driveway sedan parked nose-north with its slight parking yaw.
 */
export function carPose(rect: Rect): { x: number; z: number; yaw: number; halfLength: number; halfWidth: number; cabin: readonly [number, number]; halfCabin: number; glassY: number } {
  const spec = ABANDONED_VEHICLE_SPECS.find((v) => v.rect.every((n, i) => Math.abs(n - rect[i]!) < 0.01))
  if (spec) return { x: spec.x, z: spec.z, yaw: spec.yaw, halfLength: 1.95, halfWidth: 0.8, cabin: [-0.9, 0.7], halfCabin: 0.72, glassY: 0.95 }
  const x = (rect[0] + rect[2]) / 2
  const z = (rect[1] + rect[3]) / 2
  const yaw = rect[3] - rect[1] > rect[2] - rect[0] ? -0.055 - Math.PI / 2 : 0
  return { x, z, yaw, halfLength: 2.02, halfWidth: 0.8, cabin: [-0.85, 0.6], halfCabin: 0.74, glassY: 1.0 }
}

/** Whether a car's alarm lights are in the on half of their flash (shared by the flashers and Night lights' glow). */
export function alarmFlashOn(st: { counts: Record<string, number | undefined> }, time: number): boolean {
  return Boolean(st.counts.alarm) && ds(time) < (st.counts.until ?? 0) && Math.floor((time - (st.counts.start ?? 0) / 10) / (FLASH / 2)) % 2 === 0
}

/** Whether a car's alarm is wailing now (flashing or between flashes). */
export function alarmWailing(st: { counts: Record<string, number | undefined> }, time: number): boolean {
  return Boolean(st.counts.alarm) && ds(time) < (st.counts.until ?? 0)
}

/**
 * What the slice-4 verbs leave in the world (D-19): cans strung low across a doorway, the same cans scattered once
 * someone walks through, glass where a bottle broke, a car with a window in and its indicators flashing while the
 * alarm wails. Reads ledger stores only, so every co-op client sees the same.
 */
export class VerbProps {
  private readonly models: { wire: number; can: number; shard: number; window: number; flasher: number; tailFlasher: number }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  /** Proof readout: what was drawn last frame. */
  readonly shown = { lines: [] as string[], sprung: [] as string[], glass: 0, smashed: [] as string[], flashing: [] as string[] }

  constructor(renderer: Pick<Renderer, "addModel">) {
    // A unit wire along +x, scaled to the doorway's width.
    const wire = new Mesh()
    // Drawn thicker than real wire and cans so they still read from the camera's height.
    wire.box(-0.5, -0.012, -0.012, 0.5, 0.012, 0.012, hex(0xc8cac4), MAT.shiny)
    const can = new Mesh()
    can.prism(0, 0, 0.055, 0.055, -0.15, 0, 10, hex(0xb8bcbc), MAT.shiny)
    can.prism(0, 0, 0.057, 0.057, -0.11, -0.05, 10, hex(0xb8482c), MAT.lit)
    can.box(-0.004, 0, -0.004, 0.004, 0.03, 0.004, hex(0xc8cac4), MAT.shiny)
    const shard = new Mesh()
    for (const [x, z, w, d, yaw] of [[0, 0, 0.07, 0.03, 0.3], [0.06, 0.05, 0.05, 0.02, 1.4], [-0.05, 0.04, 0.04, 0.025, 2.2], [0.02, -0.06, 0.06, 0.02, -0.6], [-0.07, -0.03, 0.03, 0.02, 0.9], [0.12, 0.09, 0.03, 0.015, 0.5], [-0.11, 0.1, 0.025, 0.015, -1.1], [0.1, -0.11, 0.035, 0.018, 2.6]] as const)
      shard.yawBox(x, z, w, d, 0, 0.006, yaw, hex(0xc4dad2), MAT.shiny)
    shard.prism(0.09, -0.02, 0.03, 0.025, 0, 0.05, 8, hex(0x3f7a46), MAT.shiny)
    // A broken side window: a dark hole with a jagged rim of glass left in the frame.
    const window = new Mesh()
    window.box(-0.55, -0.2, -0.012, 0.55, 0.2, 0.012, hex(0x141414), MAT.lit)
    for (const [x, h] of [[-0.45, 0.08], [-0.15, 0.05], [0.2, 0.09], [0.45, 0.06]] as const) window.box(x - 0.08, -0.2, -0.016, x + 0.08, -0.2 + h, 0.016, hex(0xb4ccc4), MAT.shiny)
    const flasher = new Mesh()
    flasher.box(-0.11, -0.06, -0.05, 0.11, 0.06, 0.05, hex(0xff7a10), MAT.glow, 2.4)
    const tailFlasher = new Mesh()
    tailFlasher.box(-0.11, -0.06, -0.05, 0.11, 0.06, 0.05, hex(0xff1c0c), MAT.glow, 2.6)
    this.models = {
      wire: renderer.addModel(wire),
      can: renderer.addModel(can),
      shard: renderer.addModel(shard),
      window: renderer.addModel(window),
      flasher: renderer.addModel(flasher),
      tailFlasher: renderer.addModel(tailFlasher),
    }
  }

  collect(view: SessionView, time: number, support: (x: number, z: number) => number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const shown = this.shown
    shown.lines.length = shown.sprung.length = shown.smashed.length = shown.flashing.length = 0
    shown.glass = 0
    const { progression, player: p, town } = view
    const ledger = progression.ledger
    const near = (x: number, y: number) => Math.abs(x - p.x) < RANGE && Math.abs(y - p.y) < RANGE

    for (const portal of portals(town)) {
      const st = ledger.store(tripStoreId(portal.id))
      if (!st || st.counts.down || !near(st.at?.x ?? 0, st.at?.y ?? 0)) continue
      const line = tripLine(town, portal)
      const [x0, y0, x1, y1] = line.rect
      const horizontal = x1 - x0 > y1 - y0
      const len = horizontal ? x1 - x0 : y1 - y0
      const yaw = horizontal ? 0 : Math.PI / 2
      const ground = support(line.x, line.y)
      const ax = horizontal ? 1 : 0
      const az = horizontal ? 0 : 1
      if (st.counts.armed) {
        // Taut at shin height, three cans hanging off it.
        shown.lines.push(portal.id)
        this.put(this.models.wire, line.x, ground + 0.2, line.y, yaw, 0, 0, len)
        for (const k of [-0.3, 0, 0.3]) this.put(this.models.can, line.x + ax * k * len, ground + 0.196, line.y + az * k * len, yaw + k, 0, 0, 1)
      } else {
        // Sprung: the wire down and the cans kicked across the floor.
        shown.sprung.push(portal.id)
        for (const [k, out, spin] of [[-0.42, 0.18, 0.7], [0.08, 0.42, 2.1], [0.36, -0.12, -0.9]] as const)
          this.put(this.models.can, line.x + ax * k * len + az * out, ground + 0.058, line.y + az * k * len + ax * out, yaw + spin, Math.PI / 2, 0, 1)
      }
    }

    for (const st of ledger.stores.values()) {
      if (!st.id.startsWith("glass:") || !st.at || !near(st.at.x, st.at.y)) continue
      shown.glass++
      this.put(this.models.shard, st.at.x, support(st.at.x, st.at.y) + 0.003, st.at.y, (st.counts.t ?? 0) * 0.37, 0, 0, 1.4)
    }

    for (const car of progression.verbs.cars) {
      if (!near(car.x, car.y)) continue
      const st = ledger.store(carStoreId(car.key))
      if (!st) continue
      const pose = carPose(car.rect)
      const c = Math.cos(pose.yaw)
      const s = Math.sin(pose.yaw)
      const ground = support(pose.x, pose.z)
      const at = (lx: number, lz: number) => [pose.x + lx * c - lz * s, pose.z + lx * s + lz * c] as const
      if (st.counts.smashed) {
        shown.smashed.push(car.key)
        // The glass on whichever face of the cabin the camera sees best: a side window or an end windscreen.
        const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
        let face: readonly [number, number] = faces[0]
        for (const f of faces) if (f[0] * s + f[1] * c > face[0] * s + face[1] * c) face = f
        const [fx, fz] = face
        const lx = fx > 0 ? pose.cabin[1] + 0.02 : fx < 0 ? pose.cabin[0] - 0.02 : (pose.cabin[0] + pose.cabin[1]) / 2
        const lz = fz * (pose.halfCabin + 0.02)
        const [wx, wz] = at(lx, lz)
        this.put(this.models.window, wx, ground + pose.glassY, wz, fx ? pose.yaw + Math.PI / 2 : pose.yaw, 0, 0, fx ? (pose.halfCabin * 2) / 1.2 : 1)
        const [gx, gz] = at(lx + fx * 0.55, lz + fz * 0.45)
        this.put(this.models.shard, gx, ground + 0.003, gz, 1.1, 0, 0, 1.8)
      }
      if (alarmFlashOn(st, time)) {
        shown.flashing.push(car.key)
        // Amber indicators at the nose, the tail lights flashing red with them.
        for (const lx of [-pose.halfLength, pose.halfLength])
          for (const lz of [-pose.halfWidth, pose.halfWidth]) {
            const [fx, fz] = at(lx, lz)
            this.put(lx < 0 ? this.models.tailFlasher : this.models.flasher, fx, ground + 0.55, fz, pose.yaw, 0, 0, 1)
          }
      }
    }

    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, scale: number, flash = 0): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, 1, 1, 1, scale, pitch, roll, 1, flash], v.count++ * INST_FLOATS)
  }
}
