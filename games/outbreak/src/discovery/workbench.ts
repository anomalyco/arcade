import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { pinStoreId, readPin, type PinSource } from "../../shared/discovery/recipes"
import { RECIPES, type BenchSite, type OutbreakProgression } from "../../shared/progression"
import { hex } from "../level"
import { registerItemModels, type ItemModels } from "./items"
import { CARD, foundCard, ideaCard, pinMesh, sketchCard } from "./sketches"

const RANGE = 24
const MAX = 64
/** The corkboard leans on the pegboard at the back of the bench, tilted back so the camera above can read it. */
const BOARD_TILT = 0.7
const BOARD_LEN = 0.4
const BOARD_SETBACK = 0.36
const BENCH_TOP = 0.955
/** The board's face, out from the board along its normal. */
const FACE = 0.016
/** Where recipe sketches sit up the board's slope. */
const SKETCH_U = 0.27
const SLOT_PITCH = 0.285
/** Recipe cards share the board's length (1.47 m of cork), crowding a little as recipes are added. */
const SKETCH_PITCH = Math.min(SLOT_PITCH, 1.22 / Math.max(1, RECIPES.length - 1))

const FOUND_STYLES = ["flyer", "chart", "photo"] as const

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>

/** Frame of a bench: rect edges, the mat's centre and size, and the board's foot. */
export function benchFrame(site: Pick<BenchSite, "bench">) {
  const [a, c, r, e] = site.bench.rect
  const matX0 = a + 0.05
  const matX1 = r - BOARD_SETBACK - 0.03
  return {
    a,
    c,
    r,
    e,
    mat: { x: (matX0 + matX1) / 2, z: (c + 0.42 + e - 0.3) / 2, w: matX1 - matX0, d: e - 0.3 - (c + 0.42) },
    board: { x: r - BOARD_SETBACK, y: BENCH_TOP, z: (c + e) / 2, len: e - c - 0.08 },
  }
}

/** World position of a point `u` up the board's slope, `v` along the bench, lifted `lift` off its face. */
export function onBoard(site: Pick<BenchSite, "bench">, u: number, v: number, lift = FACE): { x: number; y: number; z: number } {
  const { board } = benchFrame(site)
  const cu = Math.cos(BOARD_TILT)
  const su = Math.sin(BOARD_TILT)
  return { x: board.x + u * cu - lift * su, y: board.y + u * su + lift * cu, z: board.z + v }
}

/** Corkboard slot of a recipe (fixed, so empty cork shows how much is still to find). */
export const sketchSlot = (recipe: string) => (RECIPES.findIndex((r) => r.id === recipe) - (RECIPES.length - 1) / 2) * SKETCH_PITCH

/**
 * The safehouse workbench as the squad's recipe board (D-39): the felt mat, the corkboard of pinned sketches and the
 * ideas waiting on a part, and the parts installed in the bench (toolbox on top, car battery on the shelf under it).
 * Reads ledger state only.
 */
export class WorkbenchProps {
  private readonly items: ItemModels
  private readonly models: { mat: number; board: number; pin: number; sketch: Map<string, number>; idea: Map<string, number>; found: Map<string, number> }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  /** Proof readout: bench id → which cards are pinned. */
  readonly shown = new Map<string, { sketches: string[]; ideas: string[]; found: string[] }>()

  constructor(renderer: Pick<Renderer, "addModel">, items?: ItemModels) {
    this.items = items ?? registerItemModels(renderer)
    // Every workbench has the same footprint, so the mat and board are modelled at size once.
    const f = benchFrame({ bench: { x: 0, y: 0, rect: [-0.35, -0.8, 0.35, 0.8] } })
    const mw = f.mat.w / 2
    const md = f.mat.d / 2
    const mat = new Mesh()
    mat.box(-mw, 0, -md, mw, 0.004, md, hex(0x2c4434), MAT.cloth)
    for (let i = 1; i < 4; i++) mat.box(-mw + (i * f.mat.w) / 4 - 0.002, 0.004, -md, -mw + (i * f.mat.w) / 4 + 0.002, 0.0048, md, hex(0x56745e), MAT.cloth)
    for (let i = 1; i < 12; i++) mat.box(-mw, 0.004, -md + (i * f.mat.d) / 12 - 0.002, mw, 0.0048, -md + (i * f.mat.d) / 12 + 0.002, hex(0x56745e), MAT.cloth)
    const board = new Mesh()
    // Board frame: x up the slope from its foot, y out of the face, z along the bench (centred).
    const bl = f.board.len / 2
    board.box(0, -0.012, -bl, BOARD_LEN, FACE - 0.004, bl, hex(0x7a5634), MAT.timber)
    board.box(0.025, FACE - 0.004, -bl + 0.025, BOARD_LEN - 0.025, FACE - 0.001, bl - 0.025, hex(0xa98458), MAT.lit)
    const sketch = new Map<string, number>()
    const idea = new Map<string, number>()
    const found = new Map<string, number>()
    for (const r of RECIPES) {
      sketch.set(r.id, renderer.addModel(sketchCard(r.id, r.sketch)))
      if (!r.sketch) continue
      if (r.part) idea.set(r.id, renderer.addModel(ideaCard(r.id, r.sketch, r.part)))
      for (const style of FOUND_STYLES) found.set(`${style}:${r.id}`, renderer.addModel(foundCard(style, r.id, r.sketch)))
    }
    this.models = { mat: renderer.addModel(mat), board: renderer.addModel(board), pin: renderer.addModel(pinMesh()), sketch, idea, found }
  }

  /** The model of a found page: a flyer, chart or photo for `recipe`. */
  foundModel(style: (typeof FOUND_STYLES)[number], recipe: string): number | undefined {
    return this.models.found.get(`${style}:${recipe}`)
  }

  /** The card a learned recipe's pin holds up: the maker's sketch, or the page they found. */
  private cardModel(recipe: string, source: PinSource | undefined): number {
    const found = source && source !== "sketch" ? this.foundModel(source, recipe) : undefined
    return found ?? this.models.sketch.get(recipe)!
  }

  collect(
    progression: OutbreakProgression,
    centre: { x: number; y: number },
    seatColour: (seat: number) => readonly [number, number, number],
    support: (x: number, z: number) => number,
  ): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    this.shown.clear()
    const board = progression.board.corkboard()
    const found: string[] = []
    for (const site of progression.benches) {
      found.length = 0
      if (Math.abs(site.bench.x - centre.x) > RANGE || Math.abs(site.bench.y - centre.y) > RANGE) continue
      const f = benchFrame(site)
      const ground = support(site.bench.x, site.bench.y)
      this.put(this.models.mat, f.mat.x, ground + BENCH_TOP, f.mat.z, 0, 0, 0, 1)

      // Parts installed in the bench: the red toolbox on top at the near end, the car battery on the shelf below.
      const toolbox = this.items.model("toolbox")
      if (toolbox !== undefined && progression.ledger.count(site.id, "toolbox") > 0) this.put(toolbox, f.a + 0.18, ground + BENCH_TOP, f.e - 0.15, 0.06, 0, 0, 0.8)
      const car = this.items.model("car-battery")
      if (car !== undefined && progression.ledger.count(site.id, "car-battery") > 0) this.put(car, (f.a + f.r) / 2 - 0.05, ground + 0.38, f.c + 0.45, 0.1, 0, 0, 1)
      // A pressure tank installed for the flamethrower (AR-62) stands on the shelf beside it.
      const tank = this.items.model("pressure-tank")
      if (tank !== undefined && progression.ledger.count(site.id, "pressure-tank") > 0) this.put(tank, f.r - 0.25, ground + 0.38, f.c + 0.4, 0, 0, 0, 1)

      // The corkboard: a slot per recipe, so empty cork shows how much is still to find.
      const foot = onBoard(site, 0, 0, 0)
      this.put(this.models.board, foot.x, ground + foot.y, foot.z, 0, BOARD_TILT, 0, 1)
      for (const r of RECIPES) {
        const learned = board.learned.includes(r.id)
        const idea = !learned && board.ideas.includes(r.id)
        if (!learned && !idea) continue
        const at = onBoard(site, SKETCH_U, sketchSlot(r.id))
        const pin = readPin(progression.ledger.store(pinStoreId(r.id)), r.id)
        this.put(learned ? this.cardModel(r.id, pin?.source) : this.models.idea.get(r.id)!, at.x, ground + at.y, at.z, 0, BOARD_TILT, 0, 1)
        if (learned && pin && pin.source !== "sketch") found.push(`${pin.source}:${r.id}`)
        const colour = learned && pin?.seat !== null && pin?.seat !== undefined ? seatColour(pin.seat) : ([0.78, 0.62, 0.3] as const)
        const head = onBoard(site, SKETCH_U + CARD.w / 2 - 0.022, sketchSlot(r.id), FACE + 0.003)
        this.put(this.models.pin, head.x, ground + head.y, head.z, 0, BOARD_TILT, 0, 1, colour)
      }
      this.shown.set(site.id, { sketches: board.learned, ideas: board.ideas, found: [...found] })
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(
    model: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
    scale: number,
    tint: readonly [number, number, number] = [1, 1, 1],
  ): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, tint[0], tint[1], tint[2], scale, pitch, roll, 1, 0], v.count++ * INST_FLOATS)
  }
}
