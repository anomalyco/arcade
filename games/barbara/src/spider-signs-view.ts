import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { nextRandom, type WoodsWorld } from "../shared/world"
import type { SilkBundle, SpiderSigns, SpiderWeb } from "../shared/spider-signs"

/**
 * Draws the spider's signs (`shared/spider-signs.ts`) as static models in world coordinates: the web strung across the
 * trail, torn through on one side with two strips of the team's pink tape caught in it, and the silk-wrapped bundles
 * hanging in the canopy. `webMesh` and `bundleMesh` add one sign to any `Mesh`, so another view (the night's ending, a
 * close-up) can build the same evidence.
 */

type V = [number, number, number]
/** Old silk, grimy: it catches a torch as a grey glint, never a white line (sRGB, about 6% linear). */
const SILK: Rgb = [0.3, 0.29, 0.27]
/** The wrapping, dirtier still: a dull grey-brown under a torch, not a white pod (about 4%). */
const WRAP: Rgb = [0.25, 0.23, 0.2]
/** The team's flagging tape (`tape-view.ts`). */
const PINK: Rgb = [1, 0.2, 0.58]
/** Strand radius (m): a giant's silk, thick as string, so a lit thread is a thread at a few metres. */
const THREAD = 0.003

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** A thread from `a` to `b`: a three-sided tube, wound both ways so it shows from either side. */
function thread(m: Mesh, a: V, b: V, r: number, c: Rgb, mat: Mat = MAT.shiny): void {
  const u = norm(sub(b, a))
  const p = norm(cross(u, Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), q = cross(u, p)
  const ring = (k: number): V => { const t = (k / 3) * Math.PI * 2, c0 = Math.cos(t), s0 = Math.sin(t); return [p[0] * c0 + q[0] * s0, p[1] * c0 + q[1] * s0, p[2] * c0 + q[2] * s0] }
  for (let k = 0; k < 3; k++) {
    const n0 = ring(k), n1 = ring(k + 1)
    const a0: V = [a[0] + n0[0] * r, a[1] + n0[1] * r, a[2] + n0[2] * r], a1: V = [a[0] + n1[0] * r, a[1] + n1[1] * r, a[2] + n1[2] * r]
    const b0: V = [b[0] + n0[0] * r, b[1] + n0[1] * r, b[2] + n0[2] * r], b1: V = [b[0] + n1[0] * r, b[1] + n1[1] * r, b[2] + n1[2] * r]
    m.vert(a0, n0, c, mat); m.vert(a1, n1, c, mat); m.vert(b1, n1, c, mat)
    m.vert(a0, n0, c, mat); m.vert(b1, n1, c, mat); m.vert(b0, n0, c, mat)
    m.vert(a0, n0, c, mat); m.vert(b1, n1, c, mat); m.vert(a1, n1, c, mat)
    m.vert(a0, n0, c, mat); m.vert(b0, n0, c, mat); m.vert(b1, n1, c, mat)
  }
}

/** A thread that sags between `a` and `b` (by `sag` m at its middle), in `n` pieces. */
function sagging(m: Mesh, a: V, b: V, sag: number, r: number, c: Rgb, n = 4): void {
  let prev = a
  for (let i = 1; i <= n; i++) {
    const t = i / n, d = sag * 4 * t * (1 - t)
    const p: V = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - d, a[2] + (b[2] - a[2]) * t]
    thread(m, prev, p, r, c)
    prev = p
  }
}

/**
 * The web across the trail: old and irregular, never a decoration. A frame anchored to both trunks, radials at uneven
 * angles, and a capture spiral (a real spiral, its turns unevenly spaced, pieces missing) bellied a little by the air.
 * One side is torn through, a ragged hole from the hub outwards (something walked into it): its spiral gone, its
 * radials snapped and hanging in loose curls, and strips of the team's pink tape caught on the torn edge, twisting.
 */
export function webMesh(m: Mesh, web: SpiderWeb, world: WoodsWorld): void {
  const rng = { seed: Math.round(web.seed * 1e6) | 1 }
  const rand = () => nextRandom(rng)
  const R = web.radius
  const n = norm(cross([web.ux, 0, web.uz], [0, 1, 0]))
  const belly = 0.12 + 0.1 * rand()
  // A point on the web: x along the anchors, y up, bellied out along its normal towards the middle.
  const at = (x: number, y: number): V => {
    const k = Math.max(0, 1 - (x * x + y * y) / (R * R)) * belly
    return [web.x + web.ux * x + n[0] * k, web.y + y, web.z + web.uz * x + n[2] * k]
  }
  const polar = (a: number, r: number) => at(Math.cos(a) * r, Math.sin(a) * r)
  const tear = rand() * Math.PI * 2, tearWidth = 1.3 + 0.5 * rand()
  const torn = (a: number, r: number) => {
    const d = (((a - tear) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    // Ragged: wider further out.
    return d < tearWidth * (0.55 + 0.45 * Math.min(1, r / R)) && r > R * 0.12
  }
  // The frame: an uneven polygon a little inside the trunks, tied to each trunk top and bottom.
  const frame: V[] = []
  const corners = 6 + Math.floor(rand() * 3)
  for (let i = 0; i < corners; i++) {
    const a = (i / corners) * Math.PI * 2 + 0.3 * (rand() - 0.5), r = R * (0.88 + 0.22 * rand())
    frame.push(polar(a, r))
  }
  for (let i = 0; i < corners; i++) sagging(m, frame[i]!, frame[(i + 1) % corners]!, 0.03, THREAD * 1.3, SILK, 3)
  for (const [k, id] of web.trees.entries()) {
    const t = world.trees[id]
    if (!t) continue
    const side = k === 0 ? -1 : 1
    const near = frame.map((p, i) => ({ i, d: Math.hypot(p[0] - t.x, p[2] - t.z) })).sort((a, b) => a.d - b.d).slice(0, 2)
    for (const { i } of near) {
      const p = frame[i]!
      sagging(m, p, [t.x - web.ux * side * t.radius, p[1] + (rand() - 0.5) * 0.8, t.z - web.uz * side * t.radius], 0.04, THREAD * 1.3, SILK, 3)
    }
  }
  // Radials at uneven angles; snapped ones hang in a loose curl from where they broke.
  const spokes = 18 + Math.floor(rand() * 6)
  const radials: { a: number; end: number; broke: number }[] = []
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + (rand() - 0.5) * 0.18
    const end = R * (0.8 + 0.12 * rand())
    const broke = torn(a, end) ? end * (0.15 + 0.3 * rand()) : end
    radials.push({ a, end, broke })
    const p = polar(a, broke)
    thread(m, polar(a, R * 0.03), p, THREAD, SILK)
    if (broke < end) {
      const l = 0.2 + 0.5 * rand()
      sagging(m, p, [p[0] + n[0] * (rand() - 0.5) * 0.3, p[1] - l, p[2] + n[2] * (rand() - 0.5) * 0.3], -0.06, THREAD * 0.8, SILK, 3)
    }
  }
  // The capture spiral: out from near the hub, spacing uneven, pieces missing, none across the tear.
  const order = radials.slice().sort((p, q) => p.a - q.a)
  let r = R * 0.16, k = 0
  while (r < R * 0.8 && k < 600) {
    const s0 = order[k % spokes]!, s1 = order[(k + 1) % spokes]!
    const gap = R * (0.045 + 0.035 * rand())
    const r1 = r + gap / spokes
    const a1 = s1.a < s0.a ? s1.a + Math.PI * 2 : s1.a
    if (rand() > 0.12 && r < s0.broke && r1 < s1.broke && !torn(s0.a, r) && !torn(s1.a, r1)) {
      const mid = (s0.a + a1) / 2
      const p0 = polar(s0.a, r), p1 = polar(a1, r1), pm = polar(mid, (r + r1) / 2 * 0.975)
      thread(m, p0, [pm[0], pm[1] - 0.01, pm[2]], THREAD * 0.6, SILK)
      thread(m, [pm[0], pm[1] - 0.01, pm[2]], p1, THREAD * 0.6, SILK)
    }
    r = r1
    k++
  }
  // Torn tape: strips caught on the edge of the hole, hanging and twisting, one long one trailing.
  for (let j = 0; j < web.tape + 1; j++) {
    const a = tear + tearWidth * (j === 0 ? -0.02 : j === 1 ? 0.95 : 0.4 * rand()), rr = R * (0.3 + 0.45 * rand())
    const top = polar(a, rr)
    const length = j === 0 ? 0.8 + 0.3 * rand() : 0.25 + 0.35 * rand(), twist = 2 + 4 * rand(), w = 0.0125
    const STEPS = 10
    for (let i = 0; i < STEPS; i++) {
      const t0 = i / STEPS, t1 = (i + 1) / STEPS
      const e0 = Math.cos(t0 * twist), e1 = Math.cos(t1 * twist), f0 = Math.sin(t0 * twist), f1 = Math.sin(t1 * twist)
      // Hangs down and drifts a little off the web on the air.
      const edge = (t: number, e: number, f: number, sd: number): V => [top[0] + (web.ux * e + n[0] * f) * w * sd + n[0] * t * t * 0.15, top[1] - t * length, top[2] + (web.uz * e + n[2] * f) * w * sd + n[2] * t * t * 0.15]
      const a0 = edge(t0, e0, f0, -1), a1 = edge(t0, e0, f0, 1), b0 = edge(t1, e1, f1, -1), b1 = edge(t1, e1, f1, 1)
      const face: V = norm([n[0] * e0 - web.ux * f0, 0, n[2] * e0 - web.uz * f0])
      m.quad(a0, a1, b1, b0, face, PINK, MAT.tape)
      m.quad(a0, b0, b1, a1, [-face[0], -face[1], -face[2]], PINK, MAT.tape)
    }
  }
}

/**
 * A wrapped bundle: lumpy, the shape of what's inside showing through (a person's is broad at the shoulders and
 * narrows to the head and the feet), its silk grimy and wound in loose strands round and round, hanging a little
 * askew on a few strands that run up into the branches.
 */
export function bundleMesh(m: Mesh, b: SilkBundle): void {
  const rng = { seed: Math.round(b.seed * 1e6) | 1 }
  const rand = () => nextRandom(rng)
  const LAT = 18, LON = 12
  const person = b.size === "person"
  // Low lumps, seeded: a few bumps round and along it.
  const lumps = Array.from({ length: 6 }, () => ({ t: 0.15 + 0.7 * rand(), a: rand() * Math.PI * 2, k: 0.08 + 0.1 * rand() }))
  const lean = (rand() - 0.5) * 0.25, leanA = rand() * Math.PI * 2
  const shape = (t: number) => {
    const base = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.6)
    if (!person) return base * (0.9 + 0.2 * t)
    // Feet (bottom) narrow, hips and shoulders broad, a neck, then the head.
    const shoulders = Math.exp(-((t - 0.72) ** 2) / 0.02) * 0.18, neck = Math.exp(-((t - 0.86) ** 2) / 0.002) * 0.3
    return base * (0.72 + 0.25 * t + shoulders - neck)
  }
  const point = (i: number, j: number): [V, V] => {
    const t = i / LAT, a = (j / LON) * Math.PI * 2
    let bump = 0
    for (const l of lumps) bump += l.k * Math.exp(-((t - l.t) ** 2) / 0.01) * Math.max(0, Math.cos(a - l.a)) ** 2
    const r = b.radius * shape(t) * (1 + bump)
    const y = b.y - b.length / 2 + t * b.length
    // Hangs from its top, so it leans from there.
    const off = lean * (1 - t) * b.length
    const cx = b.x + Math.cos(leanA) * off, cz = b.z + Math.sin(leanA) * off
    const dr = (b.radius * (shape(Math.min(1, t + 0.02)) - shape(Math.max(0, t - 0.02)))) / (0.04 * b.length)
    return [[cx + Math.cos(a) * r, y, cz + Math.sin(a) * r], norm([Math.cos(a), -dr, Math.sin(a)])]
  }
  for (let i = 0; i < LAT; i++) for (let j = 0; j < LON; j++) {
    const [p0, n0] = point(i, j), [p1, n1] = point(i + 1, j), [p2, n2] = point(i + 1, j + 1), [p3, n3] = point(i, j + 1)
    // Grimier towards the bottom, where it drips.
    const g = 0.75 + 0.25 * (i / LAT), c: Rgb = [WRAP[0] * g, WRAP[1] * g, WRAP[2] * g]
    m.vert(p0, n0, c, MAT.lit); m.vert(p2, n2, c, MAT.lit); m.vert(p1, n1, c, MAT.lit)
    m.vert(p0, n0, c, MAT.lit); m.vert(p3, n3, c, MAT.lit); m.vert(p2, n2, c, MAT.lit)
  }
  // Loose strands wound round it, standing a touch proud of the wrap.
  for (let h = 0; h < 5; h++) {
    const turns = 2 + 3 * rand(), from = rand() * Math.PI * 2, dir = rand() < 0.5 ? -1 : 1
    let prev: V | null = null
    for (let i = 1; i < LAT; i++) {
      const j = (((from / (Math.PI * 2)) * LON + dir * (i / LAT) * turns * LON) % LON + LON) % LON
      const [p, nn] = point(i, Math.round(j))
      const q: V = [p[0] + nn[0] * 0.012, p[1], p[2] + nn[2] * 0.012]
      if (prev) thread(m, prev, q, THREAD * 1.2, SILK)
      prev = q
    }
  }
  const top = b.y + b.length / 2
  for (let s = 0; s < 3; s++) {
    const dx = (rand() - 0.5) * 0.5, dz = (rand() - 0.5) * 0.5
    thread(m, [b.x + dx * 0.15, top - 0.05, b.z + dz * 0.15], [b.x + dx, top + b.strand, b.z + dz], THREAD * 1.6, SILK)
  }
}

/** The signs as one static model, rebuilt when they change (a new night). */
export class SpiderSignsView {
  private model = -1
  private signs: SpiderSigns | null = null

  constructor(private readonly renderer: Renderer) {}

  /** Draws `signs` (null: none this night). */
  draw(fp: FrameParts, signs: SpiderSigns | null, world: WoodsWorld): void {
    if (signs !== this.signs) {
      this.signs = signs
      const m = new Mesh()
      if (signs) {
        for (const w of signs.webs) webMesh(m, w, world)
        for (const b of signs.bundles) bundleMesh(m, b)
      }
      // An empty mesh still needs a slot, so a later night can fill it.
      if (!m.length) m.box(0, -50, 0, 0.001, -49.999, 0.001, [0, 0, 0])
      if (this.model < 0) this.model = this.renderer.addModel(m)
      else this.renderer.setModel(this.model, m)
    }
    if (signs && this.model >= 0) fp.push(this.model, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
  }
}
