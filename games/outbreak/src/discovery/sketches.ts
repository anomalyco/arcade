import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { hex } from "../level"

/**
 * Pencil drawings for the corkboard: each item as a few strokes in a unit square (y up), and the cards they go on.
 * Cards are built flat in their own frame: x across the card, y out of it, z down the card (picture y = −z), so a
 * card pitched onto the leaning corkboard reads upright from the game camera.
 */

type Pt = readonly [number, number]
type Drawing = readonly (readonly Pt[])[]

const circle = (cx: number, cy: number, r: number, n = 12): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r] as const)
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]

const PLANK: Drawing = [
  [[-0.95, -0.35], [0.85, 0.45], [0.95, 0.25], [-0.85, -0.55], [-0.95, -0.35]],
  [[-0.66, -0.36], [-0.54, -0.24]],
  [[0.54, 0.2], [0.66, 0.32]],
]

export const DRAWINGS: Readonly<Record<string, Drawing>> = {
  plank: PLANK,
  scrap: [
    [[-0.9, -0.5], [-0.35, 0.05], [0.15, -0.2], [0.85, 0.35]],
    ...[-0.5, 0, 0.5].flatMap((x): Pt[][] => [[[x, 0.35], [x + 0.08, 0.85]], [[x - 0.08, 0.85], [x + 0.22, 0.85]]]),
  ],
  chem: [
    [[-0.35, -0.95], [0.15, -0.95], [0.15, 0.15], [0, 0.4], [0, 0.8], [-0.2, 0.8], [-0.2, 0.4], [-0.35, 0.15], [-0.35, -0.95]],
    [[-0.35, -0.3], [0.15, -0.3]],
    [[0.15, 0.1], [0.5, 0], [0.7, -0.3], [0.9, -0.75]],
  ],
  battery: [rect(-0.4, -0.9, 0.4, 0.55), rect(-0.15, 0.55, 0.15, 0.8), [[-0.2, -0.1], [0.2, -0.1]], [[0, -0.3], [0, 0.1]]],
  bandage: [circle(0, 0.05, 0.72), circle(0, 0.05, 0.24, 8), [[0.66, -0.25], [0.95, -0.85]]],
  noisemaker: [
    circle(0, -0.15, 0.62),
    circle(-0.55, 0.62, 0.22, 7),
    circle(0.55, 0.62, 0.22, 7),
    [[0, -0.15], [0, 0.22]],
    [[0, -0.15], [0.28, -0.3]],
    [[-0.4, -0.64], [-0.62, -0.95]],
    [[0.4, -0.64], [0.62, -0.95]],
  ],
  "spiked-board": [...PLANK, [[-0.35, 0.02], [-0.5, 0.5]], [[0.05, 0.22], [-0.05, 0.7]], [[0.45, 0.4], [0.42, 0.88]]],
  reinforced: [
    rect(-0.85, -0.85, 0.85, 0.85),
    [[-0.85, 0.45], [0.85, -0.15]],
    [[-0.85, 0.15], [0.85, -0.45]],
    [[-0.85, -0.2], [0.85, 0.4]],
    [[-0.85, -0.5], [0.85, 0.1]],
  ],
  cell: [rect(-0.4, -0.9, 0.4, 0.55), rect(-0.15, 0.55, 0.15, 0.8), [[0.12, 0.35], [-0.15, -0.12], [0.12, -0.12], [-0.12, -0.65]]],
  toolbox: [rect(-0.85, -0.55, 0.85, 0.3), [[-0.3, 0.3], [-0.3, 0.62], [0.3, 0.62], [0.3, 0.3]], [[-0.85, -0.05], [0.85, -0.05]]],
  "car-battery": [rect(-0.85, -0.7, 0.85, 0.4), rect(-0.6, 0.4, -0.35, 0.62), rect(0.35, 0.4, 0.6, 0.62), [[-0.6, -0.15], [-0.35, -0.15]], [[0.35, -0.15], [0.6, -0.15]], [[0.475, -0.28], [0.475, -0.02]]],
  // Cans strung across a doorway: the frame, the line low across it, and three cans hanging off it.
  cans: [
    [[-0.9, -0.95], [-0.9, 0.9], [0.9, 0.9], [0.9, -0.95]],
    [[-0.9, -0.45], [0.9, -0.45]],
    ...[-0.45, 0, 0.45].flatMap((x): Pt[][] => [[[x, -0.45], [x, -0.55]], rect(x - 0.12, -0.9, x + 0.12, -0.55)]),
  ],
  // Fire & explosives (AR-62).
  bottle: [[[-0.3, -0.95], [0.3, -0.95], [0.3, 0.2], [0.1, 0.45], [0.1, 0.85], [-0.1, 0.85], [-0.1, 0.45], [-0.3, 0.2], [-0.3, -0.95]], [[-0.3, -0.35], [0.3, -0.35]]],
  fuel: [
    [[-0.7, 0.35], [-0.35, 0.75], [0.6, 0.75], [0.7, 0.65], [0.7, -0.9], [-0.7, -0.9], [-0.7, 0.35]],
    [[-0.35, 0.75], [-0.35, 0.95], [0.05, 0.95]],
    [[-0.4, 0.1], [0.4, -0.6]],
    [[0.4, 0.1], [-0.4, -0.6]],
  ],
  molotov: [
    [[-0.3, -0.95], [0.3, -0.95], [0.3, 0.2], [0.1, 0.45], [0.1, 0.62], [-0.1, 0.62], [-0.1, 0.45], [-0.3, 0.2], [-0.3, -0.95]],
    [[-0.3, -0.35], [0.3, -0.35]],
    [[0, 0.62], [-0.15, 0.78], [0.05, 0.98], [0.18, 0.8], [0, 0.62]],
  ],
  "pressure-tank": [
    [[-0.4, -0.65], [-0.4, 0.45], [-0.2, 0.68], [0.2, 0.68], [0.4, 0.45], [0.4, -0.65], [0.2, -0.9], [-0.2, -0.9], [-0.4, -0.65]],
    rect(-0.12, 0.68, 0.12, 0.9),
    circle(0, -0.05, 0.2, 8),
  ],
  flamethrower: [
    [[-0.95, -0.85], [-0.95, 0.35], [-0.75, 0.55], [-0.55, 0.35], [-0.55, -0.85], [-0.95, -0.85]],
    [[-0.55, -0.15], [-0.25, -0.15], [-0.1, 0.05], [0.55, 0.05], [0.55, 0.25], [-0.1, 0.25]],
    [[-0.2, -0.15], [-0.2, -0.45]],
    [[0.62, 0.15], [0.8, 0.35], [0.75, 0.6], [0.92, 0.45], [0.98, 0.15], [0.8, 0], [0.62, 0.15]],
  ],
}

/** The drawing on a recipe's sketch for what it makes. */
export const RESULT_DRAWING: Readonly<Record<string, string>> = {
  bandage: "bandage",
  lure: "noisemaker",
  "spiked-board": "spiked-board",
  reinforced: "reinforced",
  battery: "cell",
  tripwire: "cans",
  molotov: "molotov",
  flamethrower: "flamethrower",
}

const GRAPHITE = hex(0x343334)
const FAINT = hex(0x9a927e)
const RED_PENCIL = hex(0xa0342a)
const PAPER = hex(0xd8ceb2)

/** A pencil on a card: strokes as thin boxes just proud of the paper, wobbling a little like a hand drew them. */
class Pen {
  private n = 0
  constructor(
    private readonly mesh: Mesh,
    private readonly seed: number,
    private readonly top: number,
    /** How far strokes wander, as a share of their width: a hand's wobble, or 0 for print. */
    private readonly jitter = 0.6,
  ) {}

  private wobble(): number {
    const x = Math.sin((this.seed + this.n++) * 12.9898) * 43758.5453
    return x - Math.floor(x) - 0.5
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: Rgb, dash = 0): void {
    const j = width * this.jitter
    const ax = x0 + this.wobble() * j
    const ay = y0 + this.wobble() * j
    const bx = x1 + this.wobble() * j
    const by = y1 + this.wobble() * j
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-5) return
    const pieces = dash > 0 ? Math.max(1, Math.round(len / dash)) : 1
    for (let i = 0; i < pieces; i++) {
      if (dash > 0 && i % 2 === 1) continue
      const t0 = i / pieces
      const t1 = (i + 1) / pieces
      const cx = ax + (bx - ax) * ((t0 + t1) / 2)
      const cy = ay + (by - ay) * ((t0 + t1) / 2)
      // Picture y is −z on the card.
      this.mesh.yawBox(cx, -cy, len * (t1 - t0) + width, width, this.top, this.top + 0.0012, Math.atan2(-(by - ay), bx - ax), colour, MAT.lit)
    }
  }

  draw(name: string, cx: number, cy: number, size: number, width: number, colour: Rgb, dash = 0): void {
    for (const stroke of DRAWINGS[name] ?? []) {
      for (let i = 1; i < stroke.length; i++) {
        const [x0, y0] = stroke[i - 1]!
        const [x1, y1] = stroke[i]!
        this.line(cx + x0 * size, cy + y0 * size, cx + x1 * size, cy + y1 * size, width, colour, dash)
      }
    }
  }
}

/** Card sizes: x across the card (along the board's slope), y down it (along the bench). */
export const CARD = { w: 0.2, h: 0.25 } as const
const THICK = 0.003
const W = 0.0042

function paper(m: Mesh, w: number, h: number, colour: Rgb): void {
  m.box(-w / 2, 0, -h / 2, w / 2, THICK, h / 2, colour, MAT.lit)
}

/** A finished sketch: the two materials, a plus, an arrow down, and what they make (or just the thing, for no pair). */
export function sketchCard(recipe: string, pair: readonly [string, string] | undefined): Mesh {
  const m = new Mesh()
  paper(m, CARD.w, CARD.h, PAPER)
  const pen = new Pen(m, recipe.length * 7.1 + 3, THICK)
  if (!pair) {
    // Learned by taking one apart, not from materials: the thing itself, drawn large.
    pen.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, 0, 0.075, W * 1.15, GRAPHITE)
    return m
  }
  pen.draw(pair[0], -0.05, 0.065, 0.036, W, GRAPHITE)
  pen.draw(pair[1], 0.05, 0.065, 0.036, W, GRAPHITE)
  pen.line(-0.01, 0.065, 0.01, 0.065, W, GRAPHITE)
  pen.line(0, 0.055, 0, 0.075, W, GRAPHITE)
  pen.line(0, 0.016, 0, -0.026, W, GRAPHITE)
  pen.line(0, -0.026, -0.011, -0.013, W, GRAPHITE)
  pen.line(0, -0.026, 0.011, -0.013, W, GRAPHITE)
  pen.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, -0.072, 0.048, W * 1.15, GRAPHITE)
  return m
}

/** An idea waiting on a bench part: the same sketch, faint and broken, with the part drawn in red in the corner. */
export function ideaCard(recipe: string, pair: readonly [string, string], part: string): Mesh {
  const m = new Mesh()
  paper(m, CARD.w, CARD.h, PAPER)
  const pen = new Pen(m, recipe.length * 5.3 + 11, THICK)
  pen.draw(pair[0], -0.05, 0.065, 0.036, W, FAINT, 0.008)
  pen.draw(pair[1], 0.05, 0.065, 0.036, W, FAINT, 0.008)
  pen.line(0, 0.016, 0, -0.026, W, FAINT, 0.008)
  pen.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, -0.072, 0.048, W, FAINT, 0.01)
  pen.draw(part, 0.066, -0.1, 0.026, W, RED_PENCIL)
  return m
}

/** A flat patch printed on a card, in picture coordinates (y up), at `lift` over the paper. */
function patch(m: Mesh, x0: number, y0: number, x1: number, y1: number, colour: Rgb, lift = 0.0004): void {
  m.box(x0, THICK, -y1, x1, THICK + lift, -y0, colour, MAT.lit)
}

const INK = hex(0x1d1c1e)
const FLYER_RED = hex(0xb2342a)
const FLYER_PAPER = hex(0xe9e2cf)
const CHART_PAPER = hex(0xd3dfd8)
const CHART_GRID = hex(0xa7bab1)
const CHART_INK = hex(0x27384a)
const PHOTO_FRAME = hex(0xe6e3d8)
const PHOTO_DARK = hex(0x2b2723)
const PHOTO_LIGHT = hex(0xcfc6ae)

/**
 * A store flyer found in a hardware store or a garage: printed, not drawn. A red band across the top with what it
 * makes knocked out in paper, the two materials and an arrow in bold ink, and tear-off tabs along the foot.
 */
export function flyerCard(recipe: string, pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  const { w, h } = CARD
  paper(m, w, h, FLYER_PAPER)
  patch(m, -w / 2, h / 2 - 0.07, w / 2, h / 2, FLYER_RED)
  const top = THICK + 0.0008
  const print = new Pen(m, 1, top, 0)
  print.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, h / 2 - 0.035, 0.026, W * 1.1, FLYER_PAPER)
  print.draw(pair[0], -0.052, 0.022, 0.032, W * 1.35, INK)
  print.draw(pair[1], 0.052, 0.022, 0.032, W * 1.35, INK)
  print.line(-0.012, 0.022, 0.012, 0.022, W * 1.35, INK)
  print.line(0, 0.01, 0, 0.034, W * 1.35, INK)
  print.line(0, -0.022, 0, -0.06, W * 1.6, FLYER_RED)
  print.line(0, -0.064, -0.013, -0.048, W * 1.6, FLYER_RED)
  print.line(0, -0.064, 0.013, -0.048, W * 1.6, FLYER_RED)
  // Tear-off tabs: short cuts up from the foot.
  for (let i = 1; i < 7; i++) patch(m, -w / 2 + (i * w) / 7 - 0.0012, -h / 2, -w / 2 + (i * w) / 7 + 0.0012, -h / 2 + 0.03, hex(0x8b826c))
  patch(m, -w / 2, -h / 2 + 0.03, w / 2, -h / 2 + 0.0322, hex(0x8b826c))
  return m
}

/**
 * A pharmacy chart: pale green-grey paper ruled in a grid, a red cross in the corner, and the steps as a little
 * flow diagram, each material boxed and what they make circled.
 */
export function chartCard(recipe: string, pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  const { w, h } = CARD
  paper(m, w, h, CHART_PAPER)
  for (let i = 1; i < 8; i++) patch(m, -w / 2, -h / 2 + (i * h) / 8 - 0.0006, w / 2, -h / 2 + (i * h) / 8 + 0.0006, CHART_GRID, 0.0003)
  for (let i = 1; i < 6; i++) patch(m, -w / 2 + (i * w) / 6 - 0.0006, -h / 2, -w / 2 + (i * w) / 6 + 0.0006, h / 2, CHART_GRID, 0.0003)
  // The red cross, top left.
  const cx = -w / 2 + 0.03
  const cy = h / 2 - 0.03
  patch(m, cx - 0.017, cy - 0.006, cx + 0.017, cy + 0.006, FLYER_RED, 0.0006)
  patch(m, cx - 0.006, cy - 0.017, cx + 0.006, cy + 0.017, FLYER_RED, 0.0006)
  const top = THICK + 0.0009
  const print = new Pen(m, 2, top, 0)
  const box = (x: number, y: number, s: number) => {
    for (const [a, b, c, d] of [[x - s, y - s, x + s, y - s], [x + s, y - s, x + s, y + s], [x + s, y + s, x - s, y + s], [x - s, y + s, x - s, y - s]] as const) print.line(a, b, c, d, W * 0.8, CHART_INK)
  }
  box(-0.05, 0.045, 0.038)
  box(0.05, 0.045, 0.038)
  print.draw(pair[0], -0.05, 0.045, 0.026, W, CHART_INK)
  print.draw(pair[1], 0.05, 0.045, 0.026, W, CHART_INK)
  print.line(-0.05, 0.005, 0, -0.03, W, CHART_INK)
  print.line(0.05, 0.005, 0, -0.03, W, CHART_INK)
  print.line(0, -0.03, 0, -0.045, W, CHART_INK)
  for (let i = 0; i < 16; i++) {
    const a0 = (i / 16) * Math.PI * 2
    const a1 = ((i + 1) / 16) * Math.PI * 2
    print.line(Math.cos(a0) * 0.04, -0.085 + Math.sin(a0) * 0.04, Math.cos(a1) * 0.04, -0.085 + Math.sin(a1) * 0.04, W * 0.8, CHART_INK)
  }
  print.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, -0.085, 0.026, W * 1.1, CHART_INK)
  return m
}

/**
 * A snapshot found in a police station or a garage: a white-bordered print of the thing itself, light on dark,
 * and the two materials it took pencilled in the margin underneath by whoever kept it.
 */
export function photoCard(recipe: string, pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  const { w, h } = CARD
  paper(m, w, h, PHOTO_FRAME)
  const border = 0.014
  patch(m, -w / 2 + border, -h / 2 + 0.06, w / 2 - border, h / 2 - border, PHOTO_DARK)
  const top = THICK + 0.0008
  const print = new Pen(m, 3, top, 0.2)
  print.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, 0.03, 0.06, W * 1.5, PHOTO_LIGHT)
  const pen = new Pen(m, recipe.length * 2.3 + 5, top)
  pen.draw(pair[0], -0.04, -h / 2 + 0.03, 0.017, W * 0.8, GRAPHITE)
  pen.line(-0.012, -h / 2 + 0.03, 0.006, -h / 2 + 0.03, W * 0.8, GRAPHITE)
  pen.line(-0.003, -h / 2 + 0.021, -0.003, -h / 2 + 0.039, W * 0.8, GRAPHITE)
  pen.draw(pair[1], 0.034, -h / 2 + 0.03, 0.017, W * 0.8, GRAPHITE)
  return m
}

/** The card for a found page of `style`. */
export function foundCard(style: "flyer" | "chart" | "photo", recipe: string, pair: readonly [string, string]): Mesh {
  return style === "flyer" ? flyerCard(recipe, pair) : style === "chart" ? chartCard(recipe, pair) : photoCard(recipe, pair)
}

/** A drawing pin: white in the mesh, tinted by the instance (the maker's colour, or brass). */
export function pinMesh(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.011, 0.009, 0, 0.007, 10, hex(0xffffff), MAT.cloth)
  m.prism(0, 0, 0.006, 0.004, 0.007, 0.013, 8, hex(0xffffff), MAT.cloth)
  return m
}
