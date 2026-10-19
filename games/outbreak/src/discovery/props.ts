import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { Stack } from "@arcade/kit/sim/ledger"
import type { OutbreakAISubsystem } from "../../shared/ai"
import type { LootSite } from "../../shared/progression"
import type { SessionView } from "../../shared/session"
import { BodyProps } from "../bodies/props"
import { DogProps } from "../dogs/props"
import { FlareProps } from "../flares/props"
import { hex } from "../level"
import { RadioProps } from "../radios/props"
import { BarricadeBoards } from "./barricades"
import { isLongItem, registerItemModels, type ItemModels } from "./items"
import type { DiscoverySettings } from "./settings"
import { VerbProps } from "./verbs"
import { VignetteProps } from "./vignettes"
import { WorkbenchProps } from "./workbench"

const MAX_ITEMS = 256
const MAX_FIXTURES = 64
const CONTAINER_RANGE = 26

/** Where a searched container shows what is left: a line of item props along `dir` from `x,z` at height `y`. */
type Shelf = { x: number; y: number; z: number; dirX: number; dirZ: number; length: number }
type Fixture = { model: "drawer" | "door" | "fridgeDoor"; x: number; y: number; z: number; yaw: number; scale: number }

/** How many props show for a stack: a few boxes of ammo, a couple of planks, one of anything held. */
function copies(s: Stack): number {
  if (s.item === "ammo") return Math.min(3, Math.ceil(s.count / 6))
  if (s.item === "plank" || s.item === "battery" || s.item === "medkit" || s.item === "bandage" || s.item === "noisemaker") return Math.min(3, s.count)
  if (s.item === "scrap" || s.item === "chem") return Math.min(2, Math.ceil(s.count / 2))
  return 1
}

/**
 * A searched container, opened: the dresser's top drawer pulled out, a cabinet or fridge door swung wide, the
 * shelf's top board, and the line along which what is left inside lies. Front faces follow `src/level.ts`.
 */
export function openContainer(c: Pick<LootSite, "kind" | "rect" | "x" | "y">, height: number): { fixtures: Fixture[]; shelf: Shelf } {
  const [a, top, r, e] = c.rect
  switch (c.kind) {
    case "dresser": {
      const cx = (a + (a + r) / 2) / 2
      return {
        fixtures: [{ model: "drawer", x: cx, y: 0.95, z: e, yaw: 0, scale: 1 }],
        shelf: { x: cx - 0.36, y: 0.84, z: e + 0.17, dirX: 1, dirZ: 0, length: 0.72 },
      }
    }
    case "nightstand":
      return {
        fixtures: [{ model: "drawer", x: c.x, y: 0.6, z: e, yaw: 0, scale: 0.5 }],
        shelf: { x: c.x - 0.18, y: 0.55, z: e + 0.085, dirX: 1, dirZ: 0, length: 0.36 },
      }
    case "counter": {
      // The middle cabinet door swings out into the kitchen; what was inside sits on the worktop above it.
      const hingeZ = c.y - 0.32
      return {
        fixtures: [{ model: "door", x: a - 0.01, y: 0.2, z: hingeZ, yaw: Math.PI / 2 + 1.75, scale: 1 }],
        shelf: { x: a + 0.22, y: height, z: c.y - 0.45, dirX: 0, dirZ: 1, length: 0.9 },
      }
    }
    case "fridge": {
      // Hinged at the back corner, the door swings out past square; bottles and jars ride its inner shelf.
      const hingeZ = top + 0.05
      const open = Math.PI / 2 + 1.9
      const dirX = Math.cos(open)
      const dirZ = Math.sin(open)
      return {
        fixtures: [{ model: "fridgeDoor", x: a - 0.015, y: 0.22, z: hingeZ, yaw: open, scale: 1 }],
        shelf: { x: a - 0.015 + dirX * 0.1 + dirZ * 0.12, y: 1.02, z: hingeZ + dirZ * 0.1 - dirX * 0.12, dirX, dirZ, length: 0.6 },
      }
    }
    default:
      // Bookcase and store shelving: open at the front, the top board is what you look down on.
      return { fixtures: [], shelf: { x: c.x - 0.68, y: 1.78, z: (top + e) / 2, dirX: 1, dirZ: 0, length: 1.36 } }
  }
}

/**
 * World props for the Discovered, Not Told pillar: barricade boards that show their wear, searched containers left
 * open with what remains inside, and drops lying on the floor. Presentation only; reads the session view.
 */
export class DiscoveryProps {
  readonly barricades: BarricadeBoards
  /** The workbench mats and corkboards. */
  readonly bench: WorkbenchProps
  /** Tripwires, broken glass and car alarms (D-19 verbs). */
  readonly verbs: VerbProps
  /** Bodies, casings and broken panes the environmental vignettes leave (D-19 slice 5). */
  readonly vignettes: VignetteProps
  /** House radios (AR-56). */
  readonly radios: RadioProps
  /** Burning road flares, dead survivors to search and chained dogs (AR-56). */
  readonly flares: FlareProps
  readonly bodies: BodyProps
  readonly dogs: DogProps
  private readonly items: ItemModels
  private readonly fixtureModels: Record<Fixture["model"], number>
  private readonly itemData = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly fixtureData = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly out: Batch[] = []
  /** Props drawn last frame, for proofs: container or drop id → item ids. */
  readonly shown = new Map<string, string[]>()

  constructor(renderer: Pick<Renderer, "addModel">) {
    this.barricades = new BarricadeBoards(renderer)
    this.items = registerItemModels(renderer)
    this.bench = new WorkbenchProps(renderer, this.items)
    this.verbs = new VerbProps(renderer)
    this.vignettes = new VignetteProps(renderer)
    this.radios = new RadioProps(renderer)
    this.flares = new FlareProps(renderer)
    this.bodies = new BodyProps(renderer)
    this.dogs = new DogProps(renderer)
    const wood = hex(0x6e4e30)
    const drawer = new Mesh()
    drawer.box(-0.45, -0.14, 0.01, 0.45, -0.12, 0.34, hex(0x4a3420), MAT.timber)
    drawer.box(-0.45, -0.14, 0.01, -0.43, -0.02, 0.34, wood, MAT.timber)
    drawer.box(0.43, -0.14, 0.01, 0.45, -0.02, 0.34, wood, MAT.timber)
    drawer.box(-0.45, -0.14, 0.01, 0.45, -0.02, 0.03, wood, MAT.timber)
    drawer.box(-0.46, -0.16, 0.34, 0.46, 0.0, 0.365, wood, MAT.timber)
    drawer.box(-0.08, -0.1, 0.365, 0.08, -0.06, 0.395, hex(0xa88e5c), MAT.shiny)
    const door = new Mesh()
    door.box(0, 0, -0.012, 0.64, 0.68, 0.012, hex(0x6e4e32), MAT.timber)
    door.box(0.5, 0.42, 0.012, 0.56, 0.46, 0.03, hex(0xa88e5c), MAT.shiny)
    const fridge = new Mesh()
    fridge.box(0, 0, -0.03, 0.8, 1.56, 0.03, hex(0x6c4c30), MAT.timber)
    fridge.box(0.04, 0.04, -0.07, 0.76, 1.52, -0.03, hex(0xb8b4a6))
    fridge.box(0.06, 0.78, -0.16, 0.74, 0.8, -0.07, hex(0xd0ccc0))
    fridge.box(0.06, 0.78, -0.17, 0.74, 0.86, -0.155, hex(0xd0ccc0))
    this.fixtureModels = {
      drawer: renderer.addModel(drawer),
      door: renderer.addModel(door),
      fridgeDoor: renderer.addModel(fridge),
    }
  }

  collect(
    view: SessionView,
    ai: OutbreakAISubsystem,
    settings: DiscoverySettings,
    time: number,
    support: (x: number, z: number) => number,
    squad: { survivors: Parameters<WorkbenchProps["collect"]>[2]; seatColour: (seat: number) => readonly [number, number, number]; dt: number } = { survivors: [], seatColour: () => [1, 1, 1], dt: 0 },
  ): readonly Batch[] {
    const out = this.out
    out.length = 0
    for (const b of this.barricades.collect(view.town, ai, support)) out.push(b)
    for (const b of this.bench.collect(view.progression, view.player, squad.survivors, squad.seatColour, settings.discoveryClatterTime, squad.dt, support)) out.push(b)
    for (const b of this.verbs.collect(view, time, support)) out.push(b)
    for (const b of this.vignettes.collect(view, support)) out.push(b)
    for (const b of this.radios.collect(view, time, settings, support)) out.push(b)
    for (const b of this.flares.collect(view, time, support)) out.push(b)
    for (const b of this.bodies.collect(view, support)) out.push(b)
    for (const b of this.dogs.collect(view, ai.agents, settings, support)) out.push(b)
    for (const v of this.itemData.values()) v.count = 0
    for (const v of this.fixtureData.values()) v.count = 0
    this.shown.clear()
    const { progression, player: p } = view
    const scale = settings.discoveryPropScale

    if (settings.discoveryOpenContainers) {
      for (const c of view.containers) {
        if (Math.abs(c.x - p.x) > CONTAINER_RANGE || Math.abs(c.y - p.y) > CONTAINER_RANGE) continue
        const st = progression.ledger.store(c.id)
        if (!st?.revealed) continue
        const ground = support(c.x, c.y)
        const height = c.rect ? (PROP_HEIGHT[c.kind] ?? 1) : 1
        const { fixtures, shelf } = openContainer(c, height)
        for (const f of fixtures) {
          this.push(this.fixtureData, this.fixtureModels[f.model], MAX_FIXTURES, f.x, ground + f.y, f.z, f.yaw, 0, 0, f.scale)
        }
        const stacks = progression.contents(c.id)
        this.shown.set(c.id, stacks.map((s) => s.item))
        this.layLine(stacks, shelf.x, ground + shelf.y, shelf.z, shelf.dirX, shelf.dirZ, shelf.length, scale)
      }
    }

    if (settings.discoveryGroundProps) {
      for (const st of progression.ledger.stores.values()) {
        if (!st.id.startsWith("drop:") || !st.at) continue
        if (Math.abs(st.at.x - p.x) > CONTAINER_RANGE || Math.abs(st.at.y - p.y) > CONTAINER_RANGE) continue
        const stacks = progression.contents(st.id)
        if (!stacks.length) continue
        this.shown.set(st.id, stacks.map((s) => s.item))
        // A small pile around the drop point, turned a little per drop so piles do not look stamped.
        const turn = (st.id.length * 0.73 + st.at.x * 1.31) % (Math.PI * 2)
        const dirX = Math.cos(turn)
        const dirZ = Math.sin(turn)
        const length = 0.5
        this.layLine(stacks, st.at.x - (dirX * length) / 2, support(st.at.x, st.at.y) + 0.005, st.at.y - (dirZ * length) / 2, dirX, dirZ, length, scale)
      }
    }

    // Pages left in buildings lie flat on their shelf or counter until someone reads them.
    for (const site of progression.knowledge.pages) {
      if (Math.abs(site.x - p.x) > CONTAINER_RANGE || Math.abs(site.y - p.y) > CONTAINER_RANGE) continue
      if (progression.ledger.count(site.id, "page") <= 0) continue
      const model = this.bench.foundModel(site.style, site.recipe)
      if (model === undefined) continue
      this.shown.set(site.id, [`${site.style}:${site.recipe}`])
      this.push(this.itemData, model, MAX_ITEMS, site.x, support(site.x, site.y) + site.z + 0.004, site.y, site.yaw, 0, 0, settings.discoveryPageScale)
    }

    // A thrown noisemaker rattles where it landed.
    const lure = this.items.model("noisemaker")
    if (lure !== undefined) {
      for (const l of progression.lures) {
        const shake = Math.sin(time * 61 + l.id) * 0.04
        this.push(this.itemData, lure, MAX_ITEMS, l.x, support(l.x, l.y) + 0.005, l.y, l.id * 1.7 + shake, shake * 0.5, 0, scale * 1.15)
      }
    }

    for (const [model, v] of this.fixtureData) if (v.count) out.push({ model, data: v.data, count: v.count })
    for (const [model, v] of this.itemData) if (v.count) out.push({ model, data: v.data, count: v.count })
    return out
  }

  /** Lays stacks side by side along a line, shrinking them to fit; extra copies sit a little behind and askew. */
  private layLine(stacks: readonly Stack[], x: number, y: number, z: number, dirX: number, dirZ: number, length: number, scale: number): void {
    const parts: { item: string; k: number }[] = []
    for (const s of stacks) for (let k = 0; k < copies(s); k++) parts.push({ item: s.item, k })
    if (!parts.length) return
    const total = parts.reduce((n, q) => n + (q.k ? 0 : this.items.footprint(q.item) * scale + 0.03), 0)
    const fit = Math.min(1, length / Math.max(0.01, total))
    const yaw = Math.atan2(dirZ, dirX)
    // Perpendicular to the line, for copies stacked behind the first.
    const px = -dirZ
    const pz = dirX
    let at = 0
    let lastWidth = 0
    for (const { item, k } of parts) {
      const model = this.items.model(item)
      if (model === undefined) continue
      const s = scale * fit
      const w = this.items.footprint(item) * s
      if (k === 0) {
        at += lastWidth / 2 + (lastWidth ? 0.03 * fit : 0) + w / 2
        lastWidth = w
      }
      const lift = isLongItem(item) ? 0.03 * s : 0
      const ox = x + dirX * at + px * k * 0.05 * s
      const oz = z + dirZ * at + pz * k * 0.05 * s
      const skew = (k * 0.37 + item.length * 0.11) % 0.5 - 0.25
      this.push(this.itemData, model, MAX_ITEMS, ox, y + lift + (item === "plank" ? k * 0.03 * s : 0), oz, yaw + skew, 0, isLongItem(item) ? Math.PI / 2 : 0, s)
    }
  }

  private push(
    pool: Map<number, { data: Float32Array<ArrayBuffer>; count: number }>,
    model: number,
    max: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
    scale: number,
  ): void {
    let v = pool.get(model)
    if (!v) pool.set(model, (v = { data: new Float32Array(max * INST_FLOATS), count: 0 }))
    if (v.count >= max) return
    v.data.set([x, y, z, yaw, 1, 1, 1, scale, pitch, roll, 1, 0], v.count++ * INST_FLOATS)
  }
}

const PROP_HEIGHT: Partial<Record<string, number>> = { counter: 1.02, dresser: 1.1, fridge: 1.9, nightstand: 0.65, shelf: 1.8 }
