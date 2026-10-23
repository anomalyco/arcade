import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { ForestLookSettings } from "@arcade/kit/forest/settings"
import { CLUE, type Clue, type NightLayout, type NightState } from "../shared/night"
import { TAPE_HEIGHT, type Tape } from "../shared/sim"
import { EVIDENCE } from "../shared/verdict"
import { terrainHeight, type WoodsWorld } from "../shared/world"

/**
 * The night's things in the world (NIGHT.md): Barbara's car in the lot with the driver's door open and a donut box on the
 * seat, the appointment-book page tied to a trunk with orange tape, her ID badge in the creek mud, the tape recorder,
 * and the spare torch batteries (three on the mess-hall table, one or two in the woods) until someone takes them. Small
 * greybox models in world coordinates, rebuilt when the night or the spares change. The extra searcher's strip on the
 * ridge is a real tape (`tapes`, drawn by `TapeView` like the team's own). The verdict's evidence lies with its clue
 * (`evidence`), the county radio stands at the foot of the tower, and a taken searcher's torch lies lit where they
 * stood. `DawnSky` greys the sky towards the end.
 */

const FLOATS = 11

/** Turns the vertices added since `from` about an axis through the origin ('x' pitches, 'y' yaws, 'z' rolls). */
function turn(m: Mesh, from: number, axis: "x" | "y" | "z", a: number) {
  const c = Math.cos(a), s = Math.sin(a)
  const [i, j] = axis === "x" ? [1, 2] : axis === "y" ? [0, 2] : [0, 1]
  for (let k = from; k < m.v.length; k += FLOATS) for (const o of [0, 3]) {
    const p = m.v[k + o + i]!, q = m.v[k + o + j]!
    m.v[k + o + i] = p * c - q * s
    m.v[k + o + j] = p * s + q * c
  }
}
function move(m: Mesh, from: number, x: number, y: number, z: number) {
  for (let k = from; k < m.v.length; k += FLOATS) { m.v[k]! += x; m.v[k + 1]! += y; m.v[k + 2]! += z }
}

const PAINT: Rgb = [0.09, 0.13, 0.11]
const GLASS: Rgb = [0.03, 0.035, 0.04]
const TYRE: Rgb = [0.025, 0.025, 0.025]
const PAPER: Rgb = [0.78, 0.76, 0.68]
/** Blaze-orange tape: not the camp's pink. */
const OTHER_TAPE: Rgb = [0.95, 0.38, 0.05]

/** A 1990s saloon, nose towards −z, the driver's door (left, −x) swung open. */
function car(m: Mesh) {
  m.bevelBox(-0.88, 0.32, -2.45, 0.88, 0.86, 2.45, 0.08, PAINT, PAINT, MAT.shiny)
  // Windows as dark gloss: the forest batch has no glass of its own (kit MAT.glass there sums every light in reach
  // at full power, unshadowed, and burned the cab white-peach under the lot lamp and a flare).
  m.bevelBox(-0.78, 0.86, -0.85, 0.78, 1.38, 1.05, 0.1, GLASS, PAINT, MAT.shiny, MAT.shiny)
  m.box(-0.8, 0.42, -2.47, 0.8, 0.58, -2.44, [0.5, 0.5, 0.48], MAT.shiny)
  m.box(-0.75, 0.62, 2.44, -0.4, 0.74, 2.47, [0.35, 0.03, 0.02])
  m.box(0.4, 0.62, 2.44, 0.75, 0.74, 2.47, [0.35, 0.03, 0.02])
  for (const [x, z] of [[-0.8, -1.5], [0.8, -1.5], [-0.8, 1.45], [0.8, 1.45]] as const) {
    const from = m.length
    m.prism(0, 0, 0.32, 0.32, -0.11, 0.11, 12, TYRE)
    turn(m, from, "z", Math.PI / 2)
    move(m, from, x, 0.32, z)
  }
  // The open door: hinged at its front edge, swung out about 55°.
  const from = m.length
  m.box(0, 0.36, 0, 0.07, 1.32, 1.05, PAINT, MAT.shiny)
  m.box(0.01, 0.9, 0.05, 0.06, 1.3, 1, GLASS, MAT.shiny)
  turn(m, from, "y", 0.95)
  move(m, from, -0.9, 0, -0.75)
  // The seat and the dark of the cab through the gap, and the pink donut box on the passenger seat.
  m.box(-0.7, 0.5, -0.4, -0.15, 0.95, 0.3, [0.12, 0.1, 0.08])
  m.box(0.15, 0.5, -0.4, 0.7, 0.95, 0.3, [0.12, 0.1, 0.08])
  m.box(0.22, 0.95, -0.25, 0.6, 1.05, 0.15, [0.9, 0.5, 0.62])
}

/** A page from the appointment book, taped to a stake at waist height. */
function page(m: Mesh) {
  m.prism(0, 0, 0.018, 0.014, -0.2, 0.75, 6, [0.22, 0.16, 0.1])
  m.box(0.02, 0.42, -0.004, 0.17, 0.63, 0.004, PAPER)
  m.box(-0.02, 0.6, -0.006, 0.05, 0.62, 0.006, OTHER_TAPE, MAT.tape)
  m.box(-0.02, 0.44, -0.006, 0.05, 0.46, 0.006, OTHER_TAPE, MAT.tape)
  // A tail of the tape fluttering below.
  const from = m.length
  m.box(0, -0.18, -0.003, 0.02, 0, 0.003, OTHER_TAPE, MAT.tape)
  turn(m, from, "z", 0.3)
  move(m, from, -0.01, 0.6, 0)
}

/** Her ID badge face up in the leaves, the snapped lanyard beside it. */
function badge(m: Mesh) {
  m.box(-0.045, 0.01, -0.06, 0.045, 0.016, 0.06, [0.85, 0.85, 0.82], MAT.shiny)
  m.box(-0.04, 0.0165, -0.055, 0.04, 0.018, -0.03, [0.1, 0.18, 0.45])
  for (let i = 0; i < 9; i++) {
    const a = i * 0.5
    m.yawBox(0.06 + Math.sin(a) * 0.08, -0.06 + i * 0.035, 0.012, 0.04, 0.005, 0.012, 0.4 + Math.cos(a) * 0.6, [0.5, 0.06, 0.05])
  }
}

/** A handheld cassette recorder on its back, the window showing the tape. */
function recorder(m: Mesh) {
  const from = m.length
  m.bevelBox(-0.06, 0, -0.095, 0.06, 0.035, 0.095, 0.006, [0.04, 0.04, 0.045], [0.06, 0.06, 0.065], MAT.shiny)
  m.box(-0.04, 0.035, -0.02, 0.04, 0.037, 0.04, [0.1, 0.1, 0.11], MAT.shiny)
  m.box(-0.03, 0.036, 0, 0.03, 0.038, 0.03, [0.65, 0.6, 0.5])
  for (let i = 0; i < 4; i++) m.box(-0.05 + i * 0.026, 0.035, -0.09, -0.03 + i * 0.026, 0.042, -0.07, [0.5, 0.5, 0.52], MAT.shiny)
  turn(m, from, "z", 0.12)
  move(m, from, 0, 0.01, 0)
}

/** The page tied flat to a trunk at chest height with a band of orange tape round the trunk (world coordinates). */
function pageOnTrunk(m: Mesh, c: Clue, t: { x: number; z: number; radius: number }) {
  const nx = c.x - t.x, nz = c.z - t.z, l = Math.hypot(nx, nz) || 1
  const yaw = Math.atan2(-nx / l, nz / l)
  m.yawBox(c.x + (nx / l) * 0.01, c.z + (nz / l) * 0.01, 0.15, 0.004, c.y + 1.18, c.y + 1.4, yaw, PAPER)
  m.prism(t.x, t.z, t.radius + 0.018, t.radius + 0.018, c.y + 1.32, c.y + 1.355, 16, OTHER_TAPE, MAT.tape, 0, false)
}

/** A D-cell on its side. */
function battery(m: Mesh, x: number, y: number, z: number, yaw: number) {
  const from = m.length
  m.prism(0, 0, 0.017, 0.017, -0.03, 0.026, 10, [0.06, 0.06, 0.06], MAT.shiny)
  m.prism(0, 0, 0.0171, 0.0171, 0.026, 0.03, 10, [0.6, 0.38, 0.12], MAT.shiny)
  m.prism(0, 0, 0.005, 0.005, 0.03, 0.034, 6, [0.6, 0.6, 0.6], MAT.shiny)
  turn(m, from, "x", Math.PI / 2)
  turn(m, from, "y", yaw)
  move(m, from, x, y + 0.017, z)
}

const MUD: Rgb = [0.035, 0.028, 0.02]
const SILK: Rgb = [0.62, 0.62, 0.6]
const SCORE: Rgb = [0.55, 0.42, 0.3]

/** The county radio bolted to the foot of the mast: a steel box on a post, the handset on its hook, a green lamp. */
function radio(m: Mesh, x: number, y: number, z: number, yaw: number) {
  const from = m.length
  m.prism(0, 0, 0.04, 0.04, 0, 0.95, 8, [0.3, 0.3, 0.3], MAT.shiny)
  m.bevelBox(-0.22, 0.95, -0.14, 0.22, 1.42, 0.14, 0.02, [0.32, 0.34, 0.3], [0.36, 0.38, 0.34], MAT.shiny)
  m.box(-0.16, 1.05, 0.14, 0.02, 1.33, 0.17, [0.02, 0.02, 0.02], MAT.shiny)
  m.box(0.08, 1.3, 0.14, 0.12, 1.34, 0.16, [0.2, 1, 0.3], MAT.glow)
  m.box(0.06, 1.05, 0.14, 0.18, 1.2, 0.15, [0.08, 0.08, 0.08])
  turn(m, from, "y", yaw)
  move(m, from, x, y, z)
}

/** A torch dropped in the leaves, lit, lying along `yaw`. */
function droppedTorch(m: Mesh, x: number, y: number, z: number, yaw: number) {
  const from = m.length
  m.prism(0, 0, 0.022, 0.022, -0.12, 0.06, 10, [0.08, 0.08, 0.09], MAT.shiny)
  m.prism(0, 0, 0.032, 0.03, 0.06, 0.12, 10, [0.15, 0.15, 0.16], MAT.shiny)
  m.prism(0, 0, 0.028, 0.028, 0.12, 0.122, 10, [1, 0.95, 0.8], MAT.glow)
  turn(m, from, "x", -Math.PI / 2)
  turn(m, from, "y", yaw)
  move(m, from, x, y + 0.03, z)
}

/**
 * The evidence by each clue (`verdict.ts`), in world coordinates: scrapes on the car roof or its aerial snapped, a
 * second band of orange tape far up the page's trunk, grey thread round it, bark scored overhead, scratches across
 * the badge, big prints or a ring of holes in the mud. The cassette's is a sound, so it has none.
 */
function evidence(m: Mesh, layout: NightLayout, world: WoodsWorld) {
  const ground = (x: number, z: number) => terrainHeight(world.terrain, x, z)
  for (const i of layout.verdict.evidence) {
    const e = EVIDENCE[i]!, c = layout.clues[e.clue]!
    const tree = c.tree >= 0 ? world.trees[c.tree] : undefined
    const face = Math.atan2(c.fx, -c.fz)
    switch (e.id) {
      case "roof": {
        for (let k = 0; k < 4; k++) {
          const from = m.length
          m.box(-0.5 + k * 0.28, 1.384, -0.7, -0.48 + k * 0.28, 1.388, 0.9, SCORE)
          turn(m, from, "y", 0.25)
          turn(m, from, "y", -face)
          move(m, from, c.x, c.y, c.z)
        }
        break
      }
      case "aerial": {
        const from = m.length
        m.prism(0.6, 2.2, 0.006, 0.006, 0.86, 0.98, 5, [0.6, 0.6, 0.62], MAT.shiny)
        turn(m, from, "y", -face)
        move(m, from, c.x, c.y, c.z)
        break
      }
      case "high":
        if (tree) m.prism(tree.x, tree.z, tree.radius * 0.8 + 0.018, tree.radius * 0.8 + 0.018, c.y + 3.15, c.y + 3.19, 16, OTHER_TAPE, MAT.tape, 0, false)
        break
      case "thread":
        if (tree) for (let k = 0; k < 5; k++) m.prism(tree.x, tree.z, tree.radius + 0.022, tree.radius + 0.022, c.y + 1.2 + k * 0.045, c.y + 1.204 + k * 0.045, 16, SILK, MAT.lit, 0, false)
        break
      case "bark":
        if (tree) {
          const nx = c.x - tree.x, nz = c.z - tree.z, l = Math.hypot(nx, nz) || 1
          for (let k = 0; k < 4; k++) {
            const a = Math.atan2(nz / l, nx / l) + (k - 1.5) * 0.12, r = tree.radius + 0.01
            m.yawBox(tree.x + Math.cos(a) * r, tree.z + Math.sin(a) * r, 0.02, 0.01, c.y + 2.5 + k * 0.05, c.y + 3.5 + k * 0.05, -a, SCORE)
          }
        }
        break
      case "scratch":
        for (let k = 0; k < 4; k++) m.yawBox(c.x - 0.03 + k * 0.016, c.z - 0.042, 0.002, 0.03, c.y + 0.0185, c.y + 0.0195, -face + 0.4, [0.2, 0.2, 0.2])
        break
      case "feet":
        for (let k = -2; k <= 2; k++) {
          if (k === 0) continue
          const x = c.x + c.fz * 0.25 * (k % 2) + c.fx * k * 1.9, z = c.z - c.fx * 0.25 * (k % 2) + c.fz * k * 1.9
          m.yawBox(x, z, 0.16, 0.44, ground(x, z) + 0.004, ground(x, z) + 0.012, -face, MUD)
        }
        break
      case "pins":
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2, x = c.x + Math.cos(a) * 0.9, z = c.z + Math.sin(a) * 0.9
          m.prism(x, z, 0.03, 0.03, ground(x, z) + 0.002, ground(x, z) + 0.008, 6, [0.01, 0.008, 0.006])
        }
        break
    }
  }
}

const BUILD: Record<Exclude<Clue["kind"], "strip">, (m: Mesh) => void> = { car, page, badge, cassette: recorder }

export class NightView {
  private clueModel = -1
  private spareModel = -1
  private seed = NaN
  private spareKey = ""

  constructor(private readonly renderer: Renderer) {}

  private slot(id: number, mesh: Mesh): number {
    if (id < 0) return this.renderer.addModel(mesh)
    this.renderer.setModel(id, mesh)
    return id
  }

  private build(layout: NightLayout, world: WoodsWorld) {
    const m = new Mesh()
    for (const c of layout.clues) {
      if (c.kind === "strip") continue
      const tree = c.tree >= 0 ? world.trees[c.tree] : undefined
      if (c.kind === "page" && tree) { pageOnTrunk(m, c, tree); continue }
      const from = m.length
      BUILD[c.kind](m)
      turn(m, from, "y", -Math.atan2(c.fx, -c.fz))
      move(m, from, c.x, c.y, c.z)
    }
    evidence(m, layout, world)
    const r = layout.radio
    radio(m, r.x, r.y, r.z, Math.atan2(layout.ridge.x - r.x, layout.ridge.z - r.z) + Math.PI)
    this.clueModel = this.slot(this.clueModel, m)
  }

  /** Every clue where it lies (found or not), and the spares nobody has taken. */
  draw(fp: FrameParts, n: NightState, world: WoodsWorld): void {
    if (n.seed !== this.seed) { this.seed = n.seed; this.build(n.layout, world); this.spareKey = "" }
    const key = `${n.seed}:${n.taken.join(",")}:${n.verdict.gone.length}`
    if (key !== this.spareKey) {
      this.spareKey = key
      const m = new Mesh()
      for (const s of n.layout.spares) if (!n.taken.includes(s.id)) battery(m, s.x, s.y, s.z, s.id * 1.7)
      for (const g of n.verdict.gone) {
        const fx = -Math.sin(g.yaw), fz = -Math.cos(g.yaw), x = g.x + fx * 0.5, z = g.z + fz * 0.5
        droppedTorch(m, x, terrainHeight(world.terrain, x, z), z, g.yaw + Math.PI)
      }
      // An empty mesh still needs a slot, so a later spare can fill it.
      if (!m.length) m.box(0, -50, 0, 0.001, -49.999, 0.001, [0, 0, 0])
      this.spareModel = this.slot(this.spareModel, m)
    }
    if (this.clueModel >= 0) fp.push(this.clueModel, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
    if (this.spareModel >= 0) fp.push(this.spareModel, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
  }
}

/** The extra searcher's strip on the ridge as a tape on its trunk, tied the way the team ties theirs (none if no trunk). */
export function nightTapes(n: NightState, world: WoodsWorld): Tape[] {
  const c = n.layout.clues[CLUE.strip]
  const t = c && c.tree >= 0 ? world.trees[c.tree] : undefined
  if (!c || !t) return []
  return [{ id: -1 - (n.seed % 100000), tree: t.id, x: t.x, y: t.y + TAPE_HEIGHT, z: t.z, yaw: Math.atan2(c.z - t.z, c.x - t.x), by: -1, at: 0 }]
}

/** Sky glow, skylight and mist glow at full dawn, × their night values (civil twilight greys the woods). */
const DAWN_GAIN = { sky: 40, skylight: 30, fogBrightness: 12 } as const
type DawnKey = keyof typeof DAWN_GAIN

/**
 * The sky greying towards dawn (`dawnShare`): scales the forest look's sky glow, skylight and mist glow up from the
 * values the Lab holds. A Lab edit while it's greying becomes the new night value.
 */
export class DawnSky {
  private base: Partial<Record<DawnKey, number>> = {}
  private wrote: Partial<Record<DawnKey, number>> = {}

  apply(s: ForestLookSettings, share: number): void {
    const k = share * share
    for (const key of Object.keys(DAWN_GAIN) as DawnKey[]) {
      if (this.base[key] === undefined || s[key] !== this.wrote[key]) this.base[key] = s[key]
      const v = this.base[key]! * (1 + (DAWN_GAIN[key] - 1) * k)
      s[key] = v
      this.wrote[key] = v
    }
  }
}
