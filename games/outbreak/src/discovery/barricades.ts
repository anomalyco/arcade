import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { OutbreakAISubsystem } from "../../shared/ai"
import { barricadeWear, plankHealths, plankLook } from "../../shared/discovery/barricade"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../../shared/map"
import { hex } from "../level"

const MAX_PLANKS = 96
const HALF = 0.78
const NAIL = 0.66
/** How far a bowed board's middle is pushed into the room, in metres. */
const BOW_DEPTH = 0.09
/** How far a hanging board has swung down from its remaining nail, in radians. */
const HANG_ANGLE = 1.05
const HEIGHTS = [0, 0.34, -0.32]
const TILTS = [0.06, -0.08, 0.03]

const hash = (s: string, k: number) => {
  let h = 2166136261 ^ k
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/**
 * Barricade boards across doors and windows. A board's health shows in its shape: flush and nailed at both ends
 * when sound, bowed into the room and split down the middle at half, hanging from one nail near the end.
 */
export class BarricadeBoards {
  private readonly fullModel: number
  private readonly halfModel: number
  private readonly fullData = new Float32Array(MAX_PLANKS * INST_FLOATS)
  private readonly halfData = new Float32Array(MAX_PLANKS * 2 * INST_FLOATS)
  private readonly batches: Batch[] = []
  /** The last frame's board looks per portal, for proofs. */
  readonly looks = new Map<string, string[]>()

  constructor(renderer: Pick<Renderer, "addModel">) {
    const plank = new Mesh()
    plank.box(-HALF, -0.065, -0.025, HALF, 0.065, 0.025, hex(0x8e6f48), MAT.timber)
    plank.box(-0.68, -0.02, -0.032, -0.64, 0.02, 0.032, hex(0x353738), MAT.actor)
    plank.box(0.64, -0.02, -0.032, 0.68, 0.02, 0.032, hex(0x353738), MAT.actor)
    this.fullModel = renderer.addModel(plank)

    // Half a split board, pivoting on its nail at the outer end; the broken end is ragged and paler.
    const half = new Mesh()
    half.box(0, -0.065, -0.025, HALF - 0.05, 0.065, 0.025, hex(0x8a6b45), MAT.timber)
    half.box(HALF - 0.05, -0.065, -0.022, HALF, 0.02, 0.022, hex(0xb59468), MAT.timber)
    half.box(HALF - 0.09, 0.02, -0.02, HALF - 0.03, 0.065, 0.02, hex(0xa98a60), MAT.timber)
    half.box(0.1, -0.02, -0.032, 0.14, 0.02, 0.032, hex(0x353738), MAT.actor)
    this.halfModel = renderer.addModel(half)
  }

  collect(town: Town, ai: OutbreakAISubsystem, support: (x: number, z: number) => number): readonly Batch[] {
    let full = 0
    let halves = 0
    this.looks.clear()
    const put = (data: Float32Array, i: number, x: number, y: number, z: number, yaw: number, pitch: number) => {
      data.set([x, y, z, yaw, 1, 1, 1, 1, pitch, 0, 1, 0], i * INST_FLOATS)
    }
    const portal = (id: string, rect: Rect, baseH: number, inward: number) => {
      const st = ai.portalStates.get(id)
      const n = Math.min(3, st?.barricadePlanks ?? 0)
      if (!st || n <= 0) return
      const [x0, y0, x1, y1] = rect
      const horizontal = x1 - x0 > y1 - y0
      const cx = (x0 + x1) * 0.5
      const cz = (y0 + y1) * 0.5
      const yaw = horizontal ? 0 : Math.PI / 2
      const ux = Math.cos(yaw)
      const uz = Math.sin(yaw)
      // Into the room: perpendicular to the board, towards the building's middle.
      const nx = horizontal ? 0 : inward
      const nz = horizontal ? inward : 0
      const ground = support(cx, cz)
      const looks: string[] = []
      plankHealths(n, barricadeWear(n, st.barricadeHp)).forEach((health, k) => {
        const look = plankLook(health)
        looks.push(look)
        const y = ground + baseH + HEIGHTS[k]!
        if (look === "flush" && full < MAX_PLANKS) {
          put(this.fullData, full++, cx, y, cz, yaw, TILTS[k]!)
        } else if (look === "bowed" && halves < MAX_PLANKS * 2 - 1) {
          // Two halves meet in a V pushed into the room, each still nailed at its outer end.
          const a = Math.asin(Math.min(0.9, BOW_DEPTH / HALF)) * (0.7 + 0.6 * (1 - health / 0.5))
          for (const side of [-1, 1]) {
            const px = cx + side * ux * HALF
            const pz = cz + side * uz * HALF
            const dx = -side * ux * Math.cos(a) + nx * Math.sin(a)
            const dz = -side * uz * Math.cos(a) + nz * Math.sin(a)
            put(this.halfData, halves++, px, y, pz, Math.atan2(dz, dx), -0.04 - 0.03 * k)
          }
        } else if (look === "hanging" && full < MAX_PLANKS) {
          // Swung down from the nail that held; which end gave way is fixed per board.
          const side = hash(id, k) < 0.5 ? -1 : 1
          const swing = HANG_ANGLE * (0.85 + 0.3 * hash(id, k + 7))
          const nailX = cx + side * ux * NAIL + nx * 0.035
          const nailZ = cz + side * uz * NAIL + nz * 0.035
          put(
            this.fullData,
            full++,
            nailX - side * ux * NAIL * Math.cos(swing),
            y - NAIL * Math.sin(swing),
            nailZ - side * uz * NAIL * Math.cos(swing),
            yaw,
            side * swing,
          )
        }
      })
      this.looks.set(id, looks)
    }
    for (const d of town.doors) portal(d.id, d.rect, 1.25, inwardSign(town, d.rect))
    for (const w of town.windows) portal(w.id, w.rect, 1.42, inwardSign(town, w.rect))
    this.batches.length = 0
    if (full) this.batches.push({ model: this.fullModel, data: this.fullData, count: full })
    if (halves) this.batches.push({ model: this.halfModel, data: this.halfData, count: halves })
    return this.batches
  }
}

/** +1 when the room is on the positive side of the opening's normal, -1 otherwise. */
function inwardSign(town: Town, rect: Rect): number {
  const [x0, y0, x1, y1] = rect
  const cx = (x0 + x1) * 0.5
  const cz = (y0 + y1) * 0.5
  const horizontal = x1 - x0 > y1 - y0
  const b = town.buildings.find((b) => cx >= b.rect[0] - 0.3 && cx <= b.rect[2] + 0.3 && cz >= b.rect[1] - 0.3 && cz <= b.rect[3] + 0.3)
  if (!b) return 1
  const mid = horizontal ? (b.rect[1] + b.rect[3]) * 0.5 : (b.rect[0] + b.rect[2]) * 0.5
  return (horizontal ? mid - cz : mid - cx) >= 0 ? 1 : -1
}
