import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { hex } from "../level"

/** Length of one lead segment mesh (m); segments are scaled to the chord they span. */
const SEGMENT = 0.3
const LEAD_SEGMENTS = 5
const MAX_LEADS = 96

/** A dog's lead in plan metres: from the hand to the collar, sagging when slack. */
function buildLeadMeshes(): [Mesh, Mesh] {
  const strap = new Mesh()
  strap.box(0, -0.007, -0.009, SEGMENT, 0.007, 0.009, hex(0x7a2f2a), MAT.actor)
  const collar = new Mesh()
  const red = hex(0x8a3029)
  collar.box(-0.06, -0.018, -0.06, 0.06, 0.018, -0.045, red, MAT.actor)
  collar.box(-0.06, -0.018, 0.045, 0.06, 0.018, 0.06, red, MAT.actor)
  collar.box(-0.06, -0.018, -0.045, -0.045, 0.018, 0.045, red, MAT.actor)
  collar.box(0.045, -0.018, -0.045, 0.06, 0.018, 0.045, red, MAT.actor)
  collar.box(0.06, -0.05, -0.012, 0.068, -0.016, 0.012, hex(0xc9b56a), MAT.shiny)
  return [strap, collar]
}

/**
 * Instanced empty dog leads (AR-88) for the crowd renderer: five straight segments along a sagging curve from the
 * hand to a collar that is not round anything. Refilled every frame.
 */
export class CharacterAccessories {
  private readonly strap: Batch
  private readonly collar: Batch
  private readonly out: Batch[] = []

  constructor(renderer: Pick<Renderer, "addModel">) {
    const [strap, collar] = buildLeadMeshes()
    this.strap = { model: renderer.addModel(strap), data: new Float32Array(MAX_LEADS * LEAD_SEGMENTS * INST_FLOATS), count: 0 }
    this.collar = { model: renderer.addModel(collar), data: new Float32Array(MAX_LEADS * INST_FLOATS), count: 0 }
  }

  begin(): void {
    this.strap.count = 0
    this.collar.count = 0
  }

  /** A lead from the hand `(hx, hy, hz)` to the collar `(cx, cy, cz)` (world x, height, plan y), `sag` metres slack. */
  lead(hx: number, hy: number, hz: number, cx: number, cy: number, cz: number, sag: number, collarYaw: number, shade: number, alpha: number): void {
    if (this.collar.count >= MAX_LEADS) return
    let px = hx
    let py = hy
    let pz = hz
    for (let i = 1; i <= LEAD_SEGMENTS; i++) {
      const u = i / LEAD_SEGMENTS
      const x = hx + (cx - hx) * u
      const z = hz + (cz - hz) * u
      const y = hy + (cy - hy) * u - sag * 4 * u * (1 - u)
      const dx = x - px
      const dy = y - py
      const dz = z - pz
      const len = Math.hypot(dx, dy, dz)
      if (len > 1e-4) this.push(this.strap, px, py, pz, Math.atan2(dz, dx), Math.asin(Math.max(-1, Math.min(1, dy / len))), len / SEGMENT, shade, alpha)
      px = x
      py = y
      pz = z
    }
    this.push(this.collar, cx, cy, cz, collarYaw, 0, 1, shade, alpha)
  }

  private push(b: Batch, x: number, y: number, z: number, yaw: number, pitch: number, scale: number, shade: number, alpha: number): void {
    const o = b.count++ * INST_FLOATS
    const d = b.data
    d[o] = x
    d[o + 1] = y
    d[o + 2] = z
    d[o + 3] = yaw
    d[o + 4] = shade
    d[o + 5] = shade
    d[o + 6] = shade
    d[o + 7] = scale
    d[o + 8] = pitch
    d[o + 9] = 0
    d[o + 10] = alpha
    d[o + 11] = 0
  }

  collect(): readonly Batch[] {
    this.out.length = 0
    if (this.strap.count > 0) this.out.push(this.strap)
    if (this.collar.count > 0) this.out.push(this.collar)
    return this.out
  }
}
