import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { drawnTrunk, type DrawnTrunk } from "@arcade/kit/forest/trunk"
import { forestTree } from "../shared/forest-world"
import { boundaryLine, standHeight, terrainHeight, treesNear, type WoodsWorld } from "../shared/world"

const POST: Rgb = [0.2, 0.16, 0.12]
/** Boundary paint: the blaze a state forest puts on its line posts and trees; the brightest paint in the woods. */
const PAINT: Rgb = [0.95, 0.38, 0.06]
const RUST: Rgb = [0.24, 0.13, 0.08]
const POSTED: Rgb = [0.95, 0.76, 0.08]
const INK: Rgb = [0.05, 0.04, 0.03]
const FOREST_BROWN: Rgb = [0.24, 0.15, 0.07]
const FOREST_LETTER: Rgb = [0.93, 0.8, 0.42]

const SPACING = 3.5
const STRANDS = [0.42, 0.78, 1.12]
/** A sign every this many posts, alternating POSTED and the state forest's own. */
const SIGN_EVERY = 6
/**
 * The signs' retroreflective sheeting (kit `MAT.retro`, the yellow POSTED face and the forest sign's letters): dark
 * paint until your own torch is on it, then up to 1 + this brighter (about twice at 4 m, three times at 15 m, where
 * the main build's flat ×2 sat); a flare beside a sign lights it as paint. More than this blooms over the lettering.
 * The paint on posts and trunks is fluorescent (`MAT.tape` with no gain: the dye's roll-off keeps it orange, never a
 * glow), as bright as the light on it and no brighter.
 */
const SHEETING = 2.5

/** 3×5 capitals, rows top to bottom. */
const GLYPHS: Record<string, string[]> = {
  A: ["010", "101", "111", "101", "101"], B: ["110", "101", "110", "101", "110"], D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"], F: ["111", "100", "110", "100", "100"], G: ["011", "100", "101", "101", "011"],
  I: ["111", "010", "010", "010", "111"], N: ["101", "111", "111", "111", "101"], O: ["010", "101", "101", "101", "010"],
  P: ["110", "101", "110", "100", "100"], R: ["110", "101", "110", "101", "101"], S: ["011", "100", "010", "001", "110"],
  T: ["111", "010", "010", "010", "010"], U: ["101", "101", "101", "101", "111"], Y: ["101", "101", "010", "010", "010"],
  " ": ["000", "000", "000", "000", "000"],
}

/**
 * The state forest's boundary: a rusted three-strand wire fence on weathered posts with orange-painted tops, all round
 * the map `BOUNDARY_INSET` inside its edge, with a sign every few posts facing in (yellow POSTED / NO TRESPASSING and
 * the brown STATE FOREST / BOUNDARY). One static mesh; the sim's edge collision stands on the same line.
 */
export function boundaryMesh(world: WoodsWorld): Mesh {
  const m = new Mesh()
  const L = boundaryLine(world)
  // Each side as seen from inside: a point on the line at `s` (−L..L) and the inward normal.
  const sides: { at: (s: number) => [number, number]; n: [number, number] }[] = [
    { at: (s) => [s, -L], n: [0, 1] },
    { at: (s) => [s, L], n: [0, -1] },
    { at: (s) => [-L, s], n: [1, 0] },
    { at: (s) => [L, s], n: [-1, 0] },
  ]
  const count = Math.ceil((2 * L) / SPACING)
  for (const side of sides) {
    let prev: [number, number, number] | null = null
    for (let i = 0; i <= count; i++) {
      const [x, z] = side.at(-L + (2 * L * i) / count)
      const g = standHeight(world, x, z)
      const onTrunk = treesNear(world, x, z, 0.6).some((t) => Math.hypot(t.x - x, t.z - z) < t.radius + 0.12)
      if (!onTrunk) post(m, x, g, z, 0.045 + ((i * 7) % 3) * 0.004, 1.3 + ((i * 5) % 4) * 0.03)
      if (prev) for (const h of STRANDS) wire(m, prev[0], prev[1] + h, prev[2], x, g + h + Math.sin(i * 1.7) * 0.015, z)
      prev = [x, g, z]
      if (i % SIGN_EVERY === 3 && !onTrunk) sign(m, x, g, z, side.n, (i / SIGN_EVERY) % 2 < 1 ? "posted" : "forest")
    }
  }
  // The line's trees carry the same paint: a band round every trunk within 4 m inside the fence.
  for (const t of world.trees) {
    const d = L - Math.max(Math.abs(t.x), Math.abs(t.z))
    if (d < -0.5 || d > 4) continue
    blaze(m, drawnTrunk(world.params.seed, (x, z) => terrainHeight(world.terrain, x, z), forestTree(t)), t.y + 1.3, t.y + 1.48)
  }
  return m
}

/** A painted band round a drawn trunk between world heights y0 and y1, just proud of its bark. */
function blaze(m: Mesh, trunk: DrawnTrunk, y0: number, y1: number): void {
  const lo = trunk.section(y0), hi = trunk.section(y1)
  if (lo.length < 3 || lo.length !== hi.length) return
  const ring = (pts: [number, number][]) => {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length
    return pts.map(([x, z]) => { const d = Math.hypot(x - cx, z - cz) || 1; return [x + ((x - cx) / d) * 0.012, z + ((z - cz) / d) * 0.012] as const })
  }
  const a = ring(lo), b = ring(hi)
  const cx = a.reduce((t, p) => t + p[0], 0) / a.length, cz = a.reduce((t, p) => t + p[1], 0) / a.length
  for (let i = 0; i < a.length; i++) {
    const j = (i + 1) % a.length
    // Facing out from the trunk, wound counter-clockwise seen from outside whichever way the section runs.
    const ox = (a[i]![0] + a[j]![0]) / 2 - cx, oz = (a[i]![1] + a[j]![1]) / 2 - cz, ol = Math.hypot(ox, oz) || 1
    const ex = a[j]![0] - a[i]![0], ez = a[j]![1] - a[i]![1]
    const [p, q] = ex * oz - ez * ox > 0 ? [i, j] : [j, i]
    m.quad([a[p]![0], y0, a[p]![1]], [a[q]![0], y0, a[q]![1]], [b[q]![0], y1, b[q]![1]], [b[p]![0], y1, b[p]![1]], [ox / ol, 0, oz / ol], PAINT, MAT.tape)
  }
}

function post(m: Mesh, x: number, g: number, z: number, r: number, h: number): void {
  m.box(x - r, g - 0.1, z - r, x + r, g + h - 0.14, z + r, POST)
  m.box(x - r - 0.003, g + h - 0.14, z - r - 0.003, x + r + 0.003, g + h, z + r + 0.003, PAINT, MAT.tape)
}

/** A strand as a thin ribbon both ways round, so it reads from either side. */
function wire(m: Mesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const t = 0.007
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1
  const nx = -dz / l, nz = dx / l
  const a = [x0, y0 - t, z0], b = [x1, y1 - t, z1], c = [x1, y1 + t, z1], d = [x0, y0 + t, z0]
  m.quad(a, b, c, d, [nx, 0, nz], RUST)
  m.quad(b, a, d, c, [-nx, 0, -nz], RUST)
}

function sign(m: Mesh, x: number, g: number, z: number, n: [number, number], kind: "posted" | "forest"): void {
  // Nailed to the post's inner face: u runs to the reader's right (facing −n), v up.
  const u: [number, number] = [n[1], -n[0]]
  const w = 0.38, h = 0.28, cy = g + 1.02, face = 0.052
  const cx = x + n[0] * face, cz = z + n[1] * face
  const at = (pu: number, pv: number, out = 0): number[] => [cx + u[0] * pu + n[0] * out, cy + pv, cz + u[1] * pu + n[1] * out]
  const plate = kind === "posted" ? POSTED : FOREST_BROWN
  m.quad(at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2), [n[0], 0, n[1]], plate, kind === "posted" ? MAT.retro : MAT.lit, kind === "posted" ? SHEETING : 0)
  m.quad(at(w / 2, -h / 2, -0.004), at(-w / 2, -h / 2, -0.004), at(-w / 2, h / 2, -0.004), at(w / 2, h / 2, -0.004), [-n[0], 0, -n[1]], [0.32, 0.3, 0.28])
  const lines = kind === "posted"
    ? [{ text: "POSTED", px: 0.0135, v: 0.055 }, { text: "NO TRESPASSING", px: 0.0058, v: -0.065 }]
    : [{ text: "STATE FOREST", px: 0.0068, v: 0.07 }, { text: "BOUNDARY", px: 0.0102, v: -0.045 }]
  const ink = kind === "posted" ? INK : FOREST_LETTER
  for (const line of lines) {
    const cols = line.text.length * 4 - 1
    const left = (-cols * line.px) / 2
    for (let k = 0; k < line.text.length; k++) {
      const glyph = GLYPHS[line.text[k]!]!
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
        if (glyph[r]![c] !== "1") continue
        const u0 = left + (k * 4 + c) * line.px, v0 = line.v + (2 - r) * line.px
        m.quad(at(u0, v0 - line.px / 2, 0.002), at(u0 + line.px, v0 - line.px / 2, 0.002), at(u0 + line.px, v0 + line.px / 2, 0.002), at(u0, v0 + line.px / 2, 0.002), [n[0], 0, n[1]], ink, kind === "posted" ? MAT.lit : MAT.retro, kind === "posted" ? 0 : SHEETING)
      }
    }
  }
}

/** Plan distance (m) from (x, z) to the nearest stretch of the boundary fence. */
export function toBoundary(world: WoodsWorld, x: number, z: number): number {
  return boundaryLine(world) - Math.max(Math.abs(x), Math.abs(z))
}
