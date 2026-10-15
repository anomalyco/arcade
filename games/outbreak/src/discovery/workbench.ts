import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { ALL_PAIRS, matStoreId, pairKey, pinStoreId, readPin, TINKER_MATERIALS } from "../../shared/discovery/tinker"
import { RECIPES, type BenchSite, type OutbreakProgression } from "../../shared/progression"
import { hex } from "../level"
import { isLongItem, registerItemModels, type ItemModels } from "./items"
import { CARD, ideaCard, pinMesh, SCRAP, sketchCard, triedCard } from "./sketches"

const RANGE = 24
const MAX = 64
/** The corkboard leans on the pegboard at the back of the bench, tilted back so the camera above can read it. */
const BOARD_TILT = 0.7
const BOARD_LEN = 0.4
const BOARD_SETBACK = 0.36
const BENCH_TOP = 0.955
/** The board's face, out from the board along its normal. */
const FACE = 0.016
/** Where recipe sketches and crossed-out tries sit up the board's slope. */
const SKETCH_U = 0.27
const TRIED_U = 0.085
const SLOT_PITCH = 0.285

const FAILED_PAIRS = ALL_PAIRS.map(([a, b]) => pairKey(a, b)).filter((p) => !RECIPES.some((r) => pairKey(r.tinker[0], r.tinker[1]) === p))

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>
type Mover = { x: number; y: number; channel: { kind: string; elapsed: number; duration: number; x: number; y: number } | null }

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
export const sketchSlot = (recipe: string) => (RECIPES.findIndex((r) => r.id === recipe) - (RECIPES.length - 1) / 2) * SLOT_PITCH
export const triedSlot = (pair: string) => (FAILED_PAIRS.indexOf(pair) - (FAILED_PAIRS.length - 1) / 2) * SLOT_PITCH

/**
 * The safehouse workbench as the squad's notebook (D-19 slice 2): the felt mat with what is laid out on it, the
 * corkboard of pinned sketches, ideas and crossed-out tries, and the parts installed in the bench (toolbox on top,
 * car battery on the shelf under it). A try that came to nothing shakes the mat's materials. Reads ledger state only.
 */
export class WorkbenchProps {
  private readonly items: ItemModels
  private readonly models: { mat: number; board: number; pin: number; sketch: Map<string, number>; idea: Map<string, number>; tried: Map<string, number> }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  private readonly shake = new Map<string, number>()
  private readonly lastChannel = new Map<number, { bench: string; progress: number; mat: string } | null>()
  /** Proof readout: bench id → what is on its mat and which cards are pinned. */
  readonly shown = new Map<string, { mat: string[]; sketches: string[]; ideas: string[]; tried: string[]; shaking: boolean }>()

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
    for (const r of RECIPES) {
      sketch.set(r.id, renderer.addModel(sketchCard(r.id, r.tinker)))
      idea.set(r.id, renderer.addModel(ideaCard(r.id, r.tinker)))
    }
    const tried = new Map<string, number>()
    for (const p of FAILED_PAIRS) tried.set(p, renderer.addModel(triedCard(p.split("+") as [string, string])))
    this.models = { mat: renderer.addModel(mat), board: renderer.addModel(board), pin: renderer.addModel(pinMesh()), sketch, idea, tried }
  }

  collect(
    progression: OutbreakProgression,
    centre: { x: number; y: number },
    survivors: readonly Mover[],
    seatColour: (seat: number) => readonly [number, number, number],
    clatterTime: number,
    dt: number,
    support: (x: number, z: number) => number,
  ): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    this.shown.clear()
    this.noticeClatter(progression, survivors, clatterTime)
    const board = progression.corkboard()
    for (const site of progression.benches) {
      if (Math.abs(site.bench.x - centre.x) > RANGE || Math.abs(site.bench.y - centre.y) > RANGE) continue
      const f = benchFrame(site)
      const ground = support(site.bench.x, site.bench.y)
      const shakeLeft = this.shake.get(site.id) ?? 0
      if (shakeLeft > 0) this.shake.set(site.id, Math.max(0, shakeLeft - dt))

      // The felt mat, and what lies on it: two materials side by side, or what they made in the middle.
      this.put(this.models.mat, f.mat.x, ground + BENCH_TOP, f.mat.z, 0, 0, 0, 1)
      const mat = progression.mat(site.id)
      const k = clatterTime > 0 ? shakeLeft / clatterTime : 0
      mat.forEach((s, i) => {
        const model = this.items.model(s.item)
        if (model === undefined) return
        const made = !(TINKER_MATERIALS as readonly string[]).includes(s.item)
        const side = made ? 0 : i === 0 ? -1 : 1
        const hop = Math.abs(Math.sin(k * Math.PI * 3)) * 0.035 * k
        const jig = Math.sin(k * 23 + i * 2.1) * 0.35 * k
        const long = isLongItem(s.item)
        const scale = long ? 0.72 : made ? 0.95 : 0.8
        // Held weapons are modelled from the grip; lay them centred on the mat, along it.
        const shift = long ? -0.38 * scale : 0
        const lift = long ? 0.03 * scale : 0
        this.put(model, f.mat.x + side * 0.055 + jig * 0.04, ground + BENCH_TOP + 0.005 + lift + hop, f.mat.z + side * 0.13 + shift, Math.PI / 2 + side * 0.12 + jig, 0, long ? Math.PI / 2 : 0, scale)
      })

      // Parts installed in the bench: the red toolbox on top at the near end, the car battery on the shelf below.
      const toolbox = this.items.model("toolbox")
      if (toolbox !== undefined && progression.ledger.count(site.id, "toolbox") > 0) this.put(toolbox, f.a + 0.18, ground + BENCH_TOP, f.e - 0.15, 0.06, 0, 0, 0.8)
      const car = this.items.model("car-battery")
      if (car !== undefined && progression.ledger.count(site.id, "car-battery") > 0) this.put(car, (f.a + f.r) / 2 - 0.05, ground + 0.38, f.c + 0.45, 0.1, 0, 0, 1)

      // The corkboard: recipe slots up top, crossed-out tries along the foot.
      const foot = onBoard(site, 0, 0, 0)
      this.put(this.models.board, foot.x, ground + foot.y, foot.z, 0, BOARD_TILT, 0, 1)
      for (const r of RECIPES) {
        const learned = board.learned.includes(r.id)
        const idea = !learned && board.ideas.includes(r.id)
        if (!learned && !idea) continue
        const at = onBoard(site, SKETCH_U, sketchSlot(r.id))
        this.put((learned ? this.models.sketch : this.models.idea).get(r.id)!, at.x, ground + at.y, at.z, 0, BOARD_TILT, 0, 1)
        const pin = readPin(progression.ledger.store(pinStoreId(r.id)), r.id)
        const colour = learned && pin?.seat !== null && pin?.seat !== undefined ? seatColour(pin.seat) : ([0.78, 0.62, 0.3] as const)
        const head = onBoard(site, SKETCH_U + CARD.w / 2 - 0.022, sketchSlot(r.id), FACE + 0.003)
        this.put(this.models.pin, head.x, ground + head.y, head.z, 0, BOARD_TILT, 0, 1, colour)
      }
      for (const pair of board.tried) {
        const at = onBoard(site, TRIED_U, triedSlot(pair))
        const model = this.models.tried.get(pair)
        if (model === undefined) continue
        this.put(model, at.x, ground + at.y, at.z, 0, BOARD_TILT, 0, 1)
        const head = onBoard(site, TRIED_U + SCRAP.w / 2 - 0.014, triedSlot(pair), FACE + 0.003)
        this.put(this.models.pin, head.x, ground + head.y, head.z, 0, BOARD_TILT, 0, 0.8, [0.78, 0.62, 0.3])
      }
      this.shown.set(site.id, { mat: mat.map((s) => s.item), sketches: board.learned, ideas: board.ideas, tried: board.tried, shaking: shakeLeft > 0 })
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  /** A survivor's try at a mat ended (rather than being walked away from) with the mat as it was: it clattered. */
  private noticeClatter(progression: OutbreakProgression, survivors: readonly Mover[], clatterTime: number): void {
    const key = (bench: string) => progression.contents(matStoreId(bench)).map((s) => s.item).join("+")
    survivors.forEach((s, i) => {
      const prev = this.lastChannel.get(i) ?? null
      const ch = s.channel?.kind === "tinker" ? s.channel : null
      if (ch) {
        const site = progression.benches.find((b) => Math.hypot(b.bench.x - ch.x, b.bench.y - ch.y) < 0.5)
        if (site) this.lastChannel.set(i, { bench: site.id, progress: ch.elapsed / Math.max(0.01, ch.duration), mat: key(site.id) })
        return
      }
      if (prev && prev.progress >= 0.8 && key(prev.bench) === prev.mat) this.shake.set(prev.bench, clatterTime)
      this.lastChannel.set(i, null)
    })
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
