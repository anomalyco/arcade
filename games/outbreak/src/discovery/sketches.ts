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
}

/** The drawing on a recipe's sketch for what it makes. */
export const RESULT_DRAWING: Readonly<Record<string, string>> = {
  bandage: "bandage",
  lure: "noisemaker",
  "spiked-board": "spiked-board",
  reinforced: "reinforced",
  battery: "cell",
}

const GRAPHITE = hex(0x343334)
const FAINT = hex(0x9a927e)
const RED_PENCIL = hex(0xa0342a)
const PAPER = hex(0xd8ceb2)
const OLD_PAPER = hex(0xc4b896)

/** A pencil on a card: strokes as thin boxes just proud of the paper, wobbling a little like a hand drew them. */
class Pen {
  private n = 0
  constructor(
    private readonly mesh: Mesh,
    private readonly seed: number,
    private readonly top: number,
  ) {}

  private wobble(): number {
    const x = Math.sin((this.seed + this.n++) * 12.9898) * 43758.5453
    return x - Math.floor(x) - 0.5
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: Rgb, dash = 0): void {
    const j = width * 0.6
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
export const SCRAP = { w: 0.1, h: 0.13 } as const
const THICK = 0.003
const W = 0.0042

function paper(m: Mesh, w: number, h: number, colour: Rgb, torn = false): void {
  m.box(-w / 2, 0, -h / 2, w / 2, THICK, h / 2, colour, MAT.lit)
  // A torn scrap has a ragged lower edge: a few nicks out of the paper colour, drawn as darker slivers.
  if (torn) for (let i = 0; i < 4; i++) m.box(-w / 2 + (i + 0.3) * (w / 4), THICK, h / 2 - 0.006, -w / 2 + (i + 0.6) * (w / 4), THICK + 0.0006, h / 2, hex(0x8a7e62), MAT.lit)
}

/** A finished sketch: the two materials, a plus, an arrow down, and what they make. */
export function sketchCard(recipe: string, pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  paper(m, CARD.w, CARD.h, PAPER)
  const pen = new Pen(m, recipe.length * 7.1 + 3, THICK)
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

/** An idea that needs a better bench: the same sketch, faint and broken, with the toolbox drawn in red in the corner. */
export function ideaCard(recipe: string, pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  paper(m, CARD.w, CARD.h, PAPER)
  const pen = new Pen(m, recipe.length * 5.3 + 11, THICK)
  pen.draw(pair[0], -0.05, 0.065, 0.036, W, FAINT, 0.008)
  pen.draw(pair[1], 0.05, 0.065, 0.036, W, FAINT, 0.008)
  pen.line(0, 0.016, 0, -0.026, W, FAINT, 0.008)
  pen.draw(RESULT_DRAWING[recipe] ?? "scrap", 0, -0.072, 0.048, W, FAINT, 0.01)
  pen.draw("toolbox", 0.066, -0.1, 0.026, W, RED_PENCIL)
  return m
}

/** A pair that came to nothing: a torn scrap with the two materials and a red cross through them. */
export function triedCard(pair: readonly [string, string]): Mesh {
  const m = new Mesh()
  paper(m, SCRAP.w, SCRAP.h, OLD_PAPER, true)
  const pen = new Pen(m, pair[0].length * 3.7 + pair[1].length * 1.3, THICK)
  pen.draw(pair[0], -0.024, 0.01, 0.019, W * 0.85, GRAPHITE)
  pen.draw(pair[1], 0.024, 0.01, 0.019, W * 0.85, GRAPHITE)
  pen.line(-0.04, 0.045, 0.04, -0.03, W * 1.1, RED_PENCIL)
  pen.line(-0.04, -0.03, 0.04, 0.045, W * 1.1, RED_PENCIL)
  return m
}

/** A drawing pin: white in the mesh, tinted by the instance (the maker's colour, or brass). */
export function pinMesh(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.011, 0.009, 0, 0.007, 10, hex(0xffffff), MAT.cloth)
  m.prism(0, 0, 0.006, 0.004, 0.007, 0.013, 8, hex(0xffffff), MAT.cloth)
  return m
}
