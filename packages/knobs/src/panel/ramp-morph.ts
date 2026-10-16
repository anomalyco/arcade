// A curve's or gradient's change from one shape to another, kept continuous: the line is drawn
// from a fixed number of samples blended one for one, and the points keep their identity. The
// ends stay the ends and travel; inner points pair up by order and position, a point left
// without a partner merges into its nearest neighbour (shrinking into it), and a new one buds out
// of the line where it will sit. One loop moves it all, and both renderers read the same numbers.
import { springMotion, type SpringValue } from "../core/spring.js"
import type { RowContext } from "./editors.js"
import { clamp } from "./motion.js"

export interface Pt {
  readonly x: number
  readonly y: number
}

export interface MorphPlan {
  /** For each new point, the old point it travels from, or -1: it buds. */
  readonly from: readonly number[]
  /** Each old point without a partner, and the new point it merges into (-1: none, it shrinks). */
  readonly merges: readonly { readonly old: number; readonly into: number }[]
}

/** What leaving a point unpaired costs: more than any travel, so as many pair as can. */
const GAP = 1e3

/**
 * Pairs `prev`'s points with `next`'s. The first stays the first and the last the last; the inner
 * ones pair in order, as many as both have, choosing the pairing that travels least (in the 0…1
 * box). Only the surplus is left over: merging when there are fewer, budding when more.
 */
export function matchPoints(prev: readonly Pt[], next: readonly Pt[]): MorphPlan {
  const gap = GAP
  const P = prev.length
  const N = next.length
  const from = new Array<number>(N).fill(-1)
  const ends = P >= 2 && N >= 2
  if (P && N) from[0] = 0
  if (ends) from[N - 1] = P - 1
  const oi: number[] = []
  const ni: number[] = []
  for (let i = 1; i < (ends ? P - 1 : P); i++) oi.push(i)
  for (let j = 1; j < (ends ? N - 1 : N); j++) ni.push(j)
  if (!P || !N) {
    oi.length = 0
    ni.length = 0
  }
  const m = oi.length
  const n = ni.length
  // Order-keeping alignment: pair (travel), leave an old one (merge) or a new one (bud).
  const W = n + 1
  const cost = new Float64Array((m + 1) * W)
  const how = new Uint8Array((m + 1) * W)
  for (let i = 1; i <= m; i++) {
    cost[i * W] = i * gap
    how[i * W] = 1
  }
  for (let j = 1; j <= n; j++) {
    cost[j] = j * gap
    how[j] = 2
  }
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const a = prev[oi[i - 1]!]!
      const b = next[ni[j - 1]!]!
      const pair = cost[(i - 1) * W + j - 1]! + Math.hypot(a.x - b.x, a.y - b.y)
      const merge = cost[(i - 1) * W + j]! + gap
      const bud = cost[i * W + j - 1]! + gap
      const best = Math.min(pair, merge, bud)
      cost[i * W + j] = best
      how[i * W + j] = best === pair ? 0 : best === merge ? 1 : 2
    }
  const paired = new Array<boolean>(P).fill(false)
  if (P && N) paired[0] = true
  if (ends) paired[P - 1] = true
  for (let i = m, j = n; i > 0 || j > 0; ) {
    const step = how[i * W + j]!
    if (i > 0 && j > 0 && step === 0) {
      from[ni[j - 1]!] = oi[i - 1]!
      paired[oi[i - 1]!] = true
      i--
      j--
    } else if (i > 0 && (j === 0 || step === 1)) i--
    else j--
  }
  const partnerOf = new Map<number, number>()
  for (const [j, i] of from.entries()) if (i >= 0) partnerOf.set(i, j)
  const merges: { old: number; into: number }[] = []
  for (let i = 0; i < P; i++) {
    if (paired[i]) continue
    // The nearest paired neighbour along the line, on either side.
    let left = i - 1
    while (left >= 0 && !paired[left]) left--
    let right = i + 1
    while (right < P && !paired[right]) right++
    const d = (k: number) =>
      k < 0 || k >= P ? Infinity : Math.hypot(prev[k]!.x - prev[i]!.x, prev[k]!.y - prev[i]!.y)
    const k = d(left) <= d(right) ? left : right
    merges.push({ old: i, into: k < 0 || k >= P ? -1 : (partnerOf.get(k) ?? -1) })
  }
  return { from, merges }
}

/** `flat` (`stride` numbers per sample) resampled to `n` samples evenly along its index. */
export function resample(flat: readonly number[], stride: number, n: number): number[] {
  const m = Math.floor(flat.length / stride)
  if (m === n) return flat.slice(0, n * stride)
  const out = new Array<number>(n * stride).fill(0)
  if (m === 0 || n === 0) return out
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i * (m - 1)) / (n - 1)
    let k = Math.floor(t)
    let f = t - k
    if (k >= m - 1) {
      k = Math.max(0, m - 2)
      f = m === 1 ? 0 : 1
    }
    for (let c = 0; c < stride; c++) {
      const a = flat[k * stride + c]!
      const b = flat[Math.min(m - 1, k + 1) * stride + c]!
      out[i * stride + c] = a + (b - a) * f
    }
  }
  return out
}

/** The y of an x, y polyline (x not decreasing) at `x`, holding its ends past them. */
export function sampleAt(flat: readonly number[], x: number): number {
  const n = flat.length >> 1
  if (!n) return 0
  if (x <= flat[0]!) return flat[1]!
  for (let i = 1; i < n; i++) {
    const x1 = flat[i * 2]!
    if (x <= x1) {
      const x0 = flat[i * 2 - 2]!
      const y0 = flat[i * 2 - 1]!
      const y1 = flat[i * 2 + 1]!
      return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1
    }
  }
  return flat[n * 2 - 1]!
}

/** A point on its way: its channels (x, y, then any extras, then its size), their speeds and goals. */
export interface MorphDot {
  readonly id: number
  readonly at: number[]
  readonly vel: number[]
  readonly to: number[]
  /** Merging: the dot it shrinks into (-1 shrinks where it is); undefined while it's one of the points. */
  into?: number
}

/** The default travel: .3 s with no bounce. */
export const MORPH_SPRING: SpringValue = { duration: 0.3, bounce: 0 }
/** How long a point merging into its neighbour takes to shrink away (s). */
export const MERGE_SPRING: SpringValue = { duration: 0.2, bounce: 0 }
const EPS = 1e-4
const H = 1 / 480

export interface MorphSet {
  /** Snap there: nothing moves (a drag, a different item, reduced motion). */
  readonly instant?: boolean
  /** Hold the current motion this long (ms) first, as a cascade of rows does. */
  readonly delay?: number
  readonly now: number
}

/**
 * The shown samples and points of a ramp between shapes: `stride` numbers per sample, `dims`
 * channels per point (x, y and any extras; the dot's size is kept after them). Every number has
 * its own spring, so a change mid-flight keeps each one's speed.
 */
export class RampMorph {
  samples: number[] = []
  private sampleVel: number[] = []
  private sampleTo: number[] = []
  /** The points, in order. */
  live: MorphDot[] = []
  /** Points merging away into others. */
  gone: MorphDot[] = []
  private ids = 0
  private last = -1
  private pending: { samples: number[]; points: number[][]; at: number } | undefined
  private resting = true
  omega: number
  zeta: number
  private readonly shrink = springMotion(MERGE_SPRING)
  constructor(
    readonly stride: number,
    readonly dims: number,
    spring: SpringValue = MORPH_SPRING,
    /** Where a new point buds from: on the line under it as it's shown now (no size channel). */
    private readonly origin: (to: readonly number[], samples: readonly number[]) => number[] = (
      to,
    ) => [...to],
  ) {
    const s = springMotion(spring)
    this.omega = s.omega
    this.zeta = s.zeta
  }
  get moving() {
    return !this.resting || this.pending !== undefined
  }
  /** The points' channels as the shape stands (where the live dots are going). */
  private points(): Pt[] {
    return this.live.map((d) => ({ x: d.to[0] ?? 0, y: d.to[1] ?? 0 }))
  }
  private dot(at: number[], to: number[]): MorphDot {
    return { id: ++this.ids, at, vel: at.map(() => 0), to }
  }
  /** Moves toward `samples` and `points` (each `dims` channels, without the size). */
  set(samples: readonly number[], points: readonly (readonly number[])[], o: MorphSet) {
    const fresh = !this.samples.length && !this.live.length
    const same =
      !this.pending &&
      samples.length === this.sampleTo.length &&
      samples.every((v, i) => v === this.sampleTo[i]) &&
      points.length === this.live.length &&
      points.every((p, i) => p.every((v, c) => v === this.live[i]!.to[c]))
    if (same && !o.instant) return
    if (o.instant || fresh) {
      this.pending = undefined
      this.snap(samples, points)
      return
    }
    if (o.delay && o.delay > 0) {
      this.pending = {
        samples: [...samples],
        points: points.map((p) => [...p]),
        at: o.now + o.delay,
      }
      if (this.last < 0) this.last = o.now
      return
    }
    this.pending = undefined
    this.retarget(samples, points, o.now)
  }
  private snap(samples: readonly number[], points: readonly (readonly number[])[]) {
    this.samples = [...samples]
    this.sampleVel = samples.map(() => 0)
    this.sampleTo = [...samples]
    const keep = this.live.length === points.length
    this.live = points.map((p, i) => {
      const at = [...p, 1]
      const id = keep ? this.live[i]!.id : ++this.ids
      return { id, at, vel: at.map(() => 0), to: [...at] }
    })
    this.gone = []
    this.resting = true
  }
  private retarget(
    samples: readonly number[],
    points: readonly (readonly number[])[],
    now: number,
  ) {
    const shown =
      this.samples.length === samples.length
        ? this.samples
        : resample(this.samples, this.stride, samples.length / this.stride)
    if (shown !== this.samples) {
      this.samples = shown
      this.sampleVel = resample(this.sampleVel, this.stride, samples.length / this.stride)
    }
    this.sampleTo = [...samples]
    const plan = matchPoints(
      this.points(),
      points.map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 })),
    )
    const was = this.live
    const next = points.map((p, j) => {
      const i = plan.from[j]!
      const to = [...p, 1]
      if (i >= 0) {
        const d = was[i]!
        d.to.splice(0, d.to.length, ...to)
        return d
      }
      return this.dot([...this.origin(p, this.samples), 0], to)
    })
    for (const { old, into } of plan.merges) {
      const d = was[old]!
      d.into = into >= 0 ? next[into]!.id : -1
      this.gone.push(d)
    }
    this.live = next
    if (this.last < 0) this.last = now
    this.resting = false
  }
  /** Where a merging dot is headed: the dot it merges into, followed if that one is merging too. */
  private target(d: MorphDot): readonly number[] | undefined {
    let into = d.into
    for (let hops = 0; into !== undefined && into >= 0 && hops < 8; hops++) {
      const live = this.live.find((x) => x.id === into)
      if (live) return live.to
      into = this.gone.find((x) => x.id === into)?.into
    }
    return undefined
  }
  /** Advances to `now` (ms); whether anything still moves. A time already reached is a no-op. */
  step(now: number): boolean {
    if (this.pending && now >= this.pending.at) {
      const p = this.pending
      this.pending = undefined
      this.retarget(p.samples, p.points, now)
    }
    if (this.resting) {
      this.last = now
      return this.moving
    }
    if (now <= this.last) return true
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const { omega: w, zeta: z } = this
    const w2 = w * w
    const zw = 2 * z * w
    let still = true
    const run = (at: number[], vel: number[], to: readonly number[], from = 0, end = at.length) => {
      for (let c = from; c < end; c++) {
        let x = at[c]!
        let v = vel[c]!
        const t = to[c]!
        if (x === t && v === 0) continue
        for (let s = 0; s < dt; s += H) {
          const k = Math.min(H, dt - s)
          v += (-w2 * (x - t) - zw * v) * k
          x += v * k
        }
        if (Math.abs(x - t) < EPS && Math.abs(v) < EPS * 20) {
          x = t
          v = 0
        } else still = false
        at[c] = x
        vel[c] = v
      }
    }
    run(this.samples, this.sampleVel, this.sampleTo)
    for (const d of this.live) run(d.at, d.vel, d.to)
    const size = this.dims
    for (const d of this.gone) {
      const to = this.target(d)
      if (to) for (let c = 0; c < size; c++) d.to[c] = to[c]!
      d.to[size] = 0
      run(d.at, d.vel, d.to, 0, size)
      // The shrink runs on its own, shorter spring.
      const { omega: sw, zeta: sz } = this.shrink
      let s = d.at[size]!
      let v = d.vel[size]!
      for (let t = 0; t < dt; t += H) {
        const k = Math.min(H, dt - t)
        v += (-sw * sw * s - 2 * sz * sw * v) * k
        s += v * k
      }
      d.at[size] = s
      d.vel[size] = v
    }
    this.gone = this.gone.filter((d) => d.at[size]! > 0.02)
    if (this.gone.length) still = false
    this.resting = still
    return this.moving
  }
  /** The line's fastest sample (px/s), given px per unit across and up. */
  sampleSpeed(sx: number, sy: number): number {
    if (this.resting) return 0
    const v = this.sampleVel
    let best = 0
    for (let i = 0; i + 1 < v.length; i += this.stride)
      best = Math.max(best, Math.hypot(v[i]! * sx, v[i + 1]! * sy))
    return best
  }
}

/**
 * How wide (px) a moving line or point smears at `speed` px/s, by `strength` (--k-curve-blur, 0
 * to 1): at 1, about what a half-open shutter catches in a 60 Hz frame. Under a quarter pixel it
 * is 0, so it rests crisp.
 */
export function curveSmear(speed: number, strength: number, cap = 6) {
  const px = Math.min(cap, speed * 0.008 * strength)
  return px < 0.25 ? 0 : px
}

// The DOM's side: one frame loop per row while its morph moves, and the motion blur.

/** The widest a moving curve's line smears (px): it's thin, so less than a point does. */
export const LINE_SMEAR = 4

/** How strongly a ramp's moving line and points smear (--k-curve-blur, 0 off to 1). */
export const curveBlur = (row: HTMLElement) =>
  row.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : clamp(parseFloat(getComputedStyle(row).getPropertyValue("--k-curve-blur")) || 0, 0, 1)

/**
 * Runs a morph on one frame loop while it moves, drawing each frame; `wake` asks the GPU for a
 * frame too, which reads the same morph (stepping it to its own frame time first: a time already
 * reached is a no-op, so the two never step it twice).
 */
export function morphLoop(c: RowContext<unknown>, morph: RampMorph, draw: () => void) {
  const win = c.doc.defaultView
  let frame = 0
  const run = (now: number) => {
    const moving = morph.step(now)
    draw()
    c.wake()
    frame = moving && win ? win.requestAnimationFrame(run) : 0
  }
  return {
    kick() {
      if (!frame && win) frame = win.requestAnimationFrame(run)
    },
    dispose() {
      if (frame) win?.cancelAnimationFrame(frame)
      frame = 0
    },
  }
}

let smearIds = 0
/**
 * The DOM's motion blur for a ramp's line and points: an SVG Gaussian per element, its deviation
 * the GPU smear's box width over √12 (the same spread). Off (no filter at all) at rest.
 */
export function smearFilters(doc: Document, plot: SVGSVGElement) {
  const ns = "http://www.w3.org/2000/svg"
  const defs = doc.createElementNS(ns, "defs")
  plot.prepend(defs)
  const sigma = (px: number) => (px / Math.sqrt(12)).toFixed(2)
  const make = (box: boolean) => {
    const filter = doc.createElementNS(ns, "filter")
    filter.id = `knobs-smear-${++smearIds}`
    if (box) {
      // Around the whole element, with room for the smear.
      filter.setAttribute("x", "-1")
      filter.setAttribute("y", "-1")
      filter.setAttribute("width", "3")
      filter.setAttribute("height", "3")
    } else filter.setAttribute("filterUnits", "userSpaceOnUse")
    const blur = doc.createElementNS(ns, "feGaussianBlur")
    filter.append(blur)
    defs.append(filter)
    return { filter, blur }
  }
  const byDot = new Map<Element, ReturnType<typeof make>>()
  return {
    /** The line's smear: `set(px)` blurs `path` across (0 takes the filter off). */
    line(path: SVGPathElement) {
      const { filter, blur } = make(false)
      let on = 0
      return (px: number) => {
        if (px === on) return
        on = px
        if (!px) return path.removeAttribute("filter")
        const box = plot.viewBox.baseVal
        filter.setAttribute("x", String(-20))
        filter.setAttribute("y", String(-20))
        filter.setAttribute("width", String((box?.width || 0) + 40))
        filter.setAttribute("height", String((box?.height || 0) + 40))
        blur.setAttribute("stdDeviation", sigma(px))
        path.setAttribute("filter", `url(#${filter.id})`)
      }
    },
    /** A point's smear along its travel (px across, px down); 0, 0 takes it off. */
    dot(node: HTMLElement, sx: number, sy: number) {
      if (!sx && !sy) {
        if (byDot.has(node)) node.style.filter = ""
        return
      }
      let f = byDot.get(node)
      if (!f) byDot.set(node, (f = make(true)))
      f.blur.setAttribute("stdDeviation", `${sigma(Math.abs(sx))} ${sigma(Math.abs(sy))}`)
      node.style.filter = `url(#${f.filter.id})`
    },
    drop(node: HTMLElement) {
      byDot.get(node)?.filter.remove()
      byDot.delete(node)
    },
  }
}
