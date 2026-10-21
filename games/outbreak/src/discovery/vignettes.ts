import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { parseVignetteId, vignetteScene, type VignetteScene } from "../../shared/discovery/vignettes"
import type { SessionView } from "../../shared/session"
import { hex } from "../level"
import { noteLyingBody } from "../soft-shadows/lying-bodies"

const MAX = 96
const RANGE = 32
const POSES = 3

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>

export const BODY_LOOK = {
  survivor: { top: hex(0x56633e), legs: hex(0x2f3a50), skin: hex(0xc0906c), hair: hex(0x2a2018), shoes: hex(0x1e1a16) },
  zombie: { top: hex(0x5a4f44), legs: hex(0x3a3630), skin: hex(0x7f8c74), hair: hex(0x2a2a24), shoes: hex(0x24201c) },
} as const

/**
 * A body face down on the floor, head along +x from the hips at the origin, in one of three falls: arms flung past the
 * head, one arm under and the legs crossed, or curled on its side.
 */
export function bodyMesh(look: (typeof BODY_LOOK)[keyof typeof BODY_LOOK], pose: number): Mesh {
  const m = new Mesh()
  const limb = (cx: number, cz: number, len: number, w: number, h: number, yaw: number, col: Rgb) => m.yawBox(cx, cz, len, w, 0, h, yaw, col, MAT.lit)
  if (pose === 2) {
    // On its side, knees drawn up.
    limb(0.25, 0, 0.62, 0.3, 0.3, 0.15, look.top)
    limb(0.72, 0.06, 0.22, 0.2, 0.24, 0.3, look.skin)
    limb(0.76, 0.06, 0.12, 0.21, 0.25, 0.3, look.hair)
    limb(-0.18, 0.22, 0.48, 0.16, 0.2, 1.0, look.legs)
    limb(-0.12, 0.5, 0.42, 0.15, 0.18, -0.2, look.legs)
    limb(-0.36, 0.54, 0.12, 0.1, 0.12, -0.2, look.shoes)
    limb(0.45, -0.22, 0.5, 0.1, 0.12, -0.6, look.top)
  } else {
    limb(0.25, 0, 0.62, 0.38, 0.2, 0, look.top)
    limb(0.7, 0.02, 0.22, 0.2, 0.19, pose ? -0.25 : 0.3, look.skin)
    limb(0.74, 0.02, 0.12, 0.21, 0.2, pose ? -0.25 : 0.3, look.hair)
    const spread = pose ? -0.05 : 0.12
    limb(-0.42, -0.11, 0.86, 0.15, 0.14, spread, look.legs)
    limb(-0.42, 0.11, 0.86, 0.15, 0.14, pose ? 0.25 : -spread, look.legs)
    limb(-0.88, -0.16, 0.12, 0.12, 0.12, spread, look.shoes)
    limb(-0.86, pose ? 0.0 : 0.16, 0.12, 0.12, 0.12, pose ? 0.25 : -spread, look.shoes)
    if (pose === 0) {
      // Arms flung out past the head.
      limb(0.78, -0.34, 0.58, 0.11, 0.1, -0.55, look.top)
      limb(0.62, 0.4, 0.58, 0.11, 0.1, 0.85, look.top)
      limb(1.04, -0.52, 0.1, 0.1, 0.08, 0, look.skin)
      limb(0.84, 0.63, 0.1, 0.1, 0.08, 0, look.skin)
    } else {
      // One arm under the chest, the other along the side.
      limb(0.22, 0.27, 0.56, 0.11, 0.1, 0.12, look.top)
      limb(-0.08, 0.31, 0.1, 0.1, 0.08, 0, look.skin)
    }
  }
  return m
}

/**
 * What a vignette leaves that the simulation does not need (D-19 slice 5): the bodies, a pool of old blood under
 * each, spent casings, a snapped bat and a window put in. Drawn from the same geometry the simulation seeded the glass
 * and drops from (`vignetteScene`), for every `vignette:` store near the survivor, so every co-op client sees the same.
 */
export class VignetteProps {
  private readonly models: { survivor: number[]; zombie: number[]; blood: number; casing: number; bat: number; pane: number }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  private readonly scenes = new Map<string, VignetteScene>()
  /** Proof readout: the scenes drawn last frame and how many bodies. */
  readonly shown = { scenes: [] as string[], bodies: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const blood = new Mesh()
    blood.yawBox(0, 0, 1.1, 0.62, 0, 0.004, 0.2, hex(0x4a1411), MAT.lit)
    blood.yawBox(0.32, 0.22, 0.5, 0.36, 0, 0.005, -0.5, hex(0x3c100e), MAT.lit)
    blood.yawBox(-0.4, -0.12, 0.34, 0.24, 0, 0.005, 0.9, hex(0x3c100e), MAT.lit)
    const casing = new Mesh()
    for (const [x, z, yaw] of [[0, 0, 0.4], [0.07, 0.05, 1.9], [-0.05, 0.08, 2.8]] as const) casing.yawBox(x, z, 0.024, 0.01, 0, 0.01, yaw, hex(0xc8a046), MAT.shiny)
    const bat = new Mesh()
    bat.yawBox(0, 0, 0.42, 0.06, 0, 0.06, 0, hex(0x9a7448), MAT.timber)
    bat.yawBox(-0.25, 0, 0.1, 0.04, 0, 0.04, 0, hex(0x2a2420), MAT.lit)
    bat.yawBox(0.4, 0.2, 0.36, 0.075, 0, 0.075, 0.9, hex(0xa47c4e), MAT.timber)
    bat.yawBox(0.24, 0.04, 0.08, 0.03, 0.02, 0.05, 0.4, hex(0xd8bc8c), MAT.timber)
    const pane = new Mesh()
    pane.box(-0.5, -0.32, -0.015, 0.5, 0.32, 0.015, hex(0x101214), MAT.lit)
    for (const [x, h] of [[-0.38, 0.14], [-0.1, 0.08], [0.18, 0.16], [0.4, 0.1]] as const) pane.box(x - 0.08, -0.32, -0.02, x + 0.08, -0.32 + h, 0.02, hex(0xb4ccc4), MAT.shiny)
    for (const [x, h] of [[-0.3, 0.09], [0.28, 0.12]] as const) pane.box(x - 0.07, 0.32 - h, -0.02, x + 0.07, 0.32, 0.02, hex(0xb4ccc4), MAT.shiny)
    this.models = {
      survivor: Array.from({ length: POSES }, (_, i) => renderer.addModel(bodyMesh(BODY_LOOK.survivor, i))),
      zombie: Array.from({ length: POSES }, (_, i) => renderer.addModel(bodyMesh(BODY_LOOK.zombie, i))),
      blood: renderer.addModel(blood),
      casing: renderer.addModel(casing),
      bat: renderer.addModel(bat),
      pane: renderer.addModel(pane),
    }
  }

  collect(view: SessionView, support: (x: number, z: number) => number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const shown = this.shown
    shown.scenes.length = 0
    shown.bodies = 0
    const { progression, player: p, town } = view
    for (const st of progression.ledger.stores.values()) {
      if (!st.id.startsWith("vignette:") || !st.at) continue
      if (Math.abs(st.at.x - p.x) > RANGE || Math.abs(st.at.y - p.y) > RANGE) continue
      let scene = this.scenes.get(st.id)
      if (!scene) {
        const v = parseVignetteId(st.id)
        const made = v && vignetteScene(town, v.kind, v.target)
        if (!made) continue
        this.scenes.set(st.id, (scene = made))
      }
      shown.scenes.push(st.id)
      for (const b of scene.bodies) {
        const ground = support(b.x, b.y)
        this.put(this.models.blood, b.x, ground + 0.002, b.y, b.yaw + 0.3, 1, 0)
        this.put(this.models[b.who][b.pose % POSES]!, b.x, ground + 0.008, b.y, b.yaw, 1, 0)
        noteLyingBody(b.x, ground, b.y, b.yaw)
        shown.bodies++
      }
      for (const c of scene.casings) this.put(this.models.casing, c.x, support(c.x, c.y) + 0.004, c.y, c.x * 7.3, 1, 0)
      if (scene.bat) this.put(this.models.bat, scene.bat.x, support(scene.bat.x, scene.bat.y) + 0.004, scene.bat.y, scene.bat.yaw, 1, 0)
      if (scene.pane) {
        const w = town.windows.find((x) => x.id === scene.pane)
        if (w) {
          const [x0, y0, x1, y1] = w.rect
          const alongY = y1 - y0 > x1 - x0
          const len = alongY ? y1 - y0 : x1 - x0
          this.put(this.models.pane, (x0 + x1) / 2, support((x0 + x1) / 2, (y0 + y1) / 2) + 1.35, (y0 + y1) / 2, alongY ? Math.PI / 2 : 0, len / 1.1, 0)
        }
      }
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, scale: number, pitch: number): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, 1, 1, 1, scale, pitch, 0, 1, 0], v.count++ * INST_FLOATS)
  }
}
