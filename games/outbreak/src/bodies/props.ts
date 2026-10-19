import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { bodySites, type BodySite } from "../../shared/bodies/bodies"
import type { SessionView } from "../../shared/session"
import { BODY_LOOK, bodyMesh } from "../discovery/vignettes"
import { hex } from "../level"

const MAX = 48
const RANGE = 30
const POSES = 3

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>

/**
 * Dead survivors to search (AR-56): the bodies `shared/bodies` places that no vignette draws, face down where they
 * fell (their blood pools are the Blood feature's), each with a satchel beside it until someone has emptied it. A body
 * that is rising twitches and lifts for its moment, then is gone: it is one of the dead now. Reads the `body:*` stores.
 */
export class BodyProps {
  private readonly models: { body: number[]; satchel: number }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  private sites: BodySite[] = []
  private key = ""
  /** Proof readout: bodies drawn last frame, by state. */
  readonly shown = { lying: [] as string[], searched: [] as string[], rising: [] as string[] }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const satchel = new Mesh()
    satchel.yawBox(0, 0, 0.34, 0.24, 0, 0.12, 0, hex(0x4a4630), MAT.cloth)
    satchel.yawBox(0, 0.02, 0.3, 0.2, 0.12, 0.15, 0, hex(0x3c3826), MAT.cloth)
    satchel.yawBox(-0.02, -0.13, 0.08, 0.04, 0.03, 0.1, 0, hex(0x8a7a50), MAT.shiny)
    satchel.yawBox(0.32, 0, 0.36, 0.035, 0, 0.012, 0.5, hex(0x2c2a1e), MAT.cloth)
    this.models = {
      body: Array.from({ length: POSES }, (_, i) => renderer.addModel(bodyMesh(BODY_LOOK.survivor, i))),
      satchel: renderer.addModel(satchel),
    }
  }

  collect(view: SessionView, support: (x: number, z: number) => number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const { town, progression, player: p, time } = view
    const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}:${(town.vehicles ?? []).length}`
    if (key !== this.key) {
      this.key = key
      this.sites = bodySites(town)
    }
    const shown = this.shown
    shown.lying.length = shown.searched.length = shown.rising.length = 0
    for (const b of this.sites) {
      if (Math.abs(b.x - p.x) > RANGE || Math.abs(b.y - p.y) > RANGE) continue
      const st = progression.ledger.store(b.id)
      if (st?.counts.risen) continue
      const ground = support(b.x, b.y)
      const full = !st?.revealed || st.slots.some((s) => s !== null)
      if (full) this.put(this.models.satchel, b.x + Math.cos(b.yaw + 1.9) * 0.62, ground + 0.004, b.y + Math.sin(b.yaw + 1.9) * 0.62, b.yaw + 0.8, 0, 0)
      // The vignette draws its own survivor; this only adds the satchel beside it.
      if (b.vignette) continue
      let y = ground + 0.008
      let roll = 0
      if (st?.counts.rise) {
        // Coming back: shudders, then the shoulders lift off the floor.
        const u = Math.max(0, Math.min(1, (time - st.counts.rise / 10) / 0.7))
        roll = Math.sin(time * 47) * 0.06 * (1 - u * 0.5)
        y += u * u * 0.12
        shown.rising.push(b.id)
      } else (st?.revealed ? shown.searched : shown.lying).push(b.id)
      this.put(this.models.body[b.pose % POSES]!, b.x, y, b.y, b.yaw, 0, roll)
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, 1, 1, 1, 1, pitch, roll, 1, 0], v.count++ * INST_FLOATS)
  }
}
