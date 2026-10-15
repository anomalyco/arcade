import { Spring, springMotion, type SpringValue } from "../core/spring.js"

// A die drawn like Phosphor's dice icons, but solid: a rounded cube whose bevel is inked wherever the
// surface turns more than `bevel` degrees from a face. Face-on, that band is exactly the glyph's
// outline (outer corner 32, inner 16, stroke 16 on the 256 grid), so at rest it is the icon; mid-roll
// every edge and corner is one continuous surface. The DOM traces it on a small canvas, the GPU in
// WGSL generated from the same constants, so both draw identical pixels.

/**
 * Icon units (Phosphor's 256 grid): half the cube's edge, its rounding, and the pip radius. The ink
 * band runs from `bevel` off one face to `bevel` off the next; seen face-on its edges sit at
 * inner + round·sin(bevel) and inner + round·cos(bevel), with corner radii round·sin and round·cos.
 * Phosphor's outline (80 to 96, corners 16 and 32) needs round·sin = 16 and round·cos = 32: a
 * rounding of 16√5 on a 64 inner half, with the bevel at atan(½).
 */
const ROUND = 16 * Math.sqrt(5)
export const DIE = { half: 64 + ROUND, round: ROUND, pip: 12 } as const

/** Pip centres per face value, relative to the face centre, in icon units (y down). */
export const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[0, 0]],
  2: [
    [-20, -20],
    [20, 20],
  ],
  3: [
    [-36, -36],
    [0, 0],
    [36, 36],
  ],
  4: [
    [-28, -28],
    [28, -28],
    [-28, 28],
    [28, 28],
  ],
  5: [
    [-36, -36],
    [36, -36],
    [0, 0],
    [-36, 36],
    [36, 36],
  ],
  6: [
    [-36, -44],
    [36, -44],
    [-36, 0],
    [36, 0],
    [-36, 44],
    [36, 44],
  ],
}

type V3 = readonly [number, number, number]

/** CSS `rotateX(ax) rotateY(ay)` (degrees) applied to a vector (y down, z towards the viewer). */
function rotate([x, y, z]: V3, ax: number, ay: number): V3 {
  const a = (ay * Math.PI) / 180
  const b = (ax * Math.PI) / 180
  const x1 = x * Math.cos(a) + z * Math.sin(a)
  const z1 = -x * Math.sin(a) + z * Math.cos(a)
  return [x1, y * Math.cos(b) - z1 * Math.sin(b), y * Math.sin(b) + z1 * Math.cos(b)]
}
const round = (v: V3): V3 => [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]

/**
 * Faces: value, the cube rotation that brings it to the front, and its outward normal and in-plane
 * axes in cube space (the front face rotated by the inverse turn). Opposites sum to 7.
 */
export const FACES = (
  [
    [5, 0, 0],
    [2, 0, 180],
    [3, 0, -90],
    [4, 0, 90],
    [1, -90, 0],
    [6, 90, 0],
  ] as const
).map(([value, fx, fy]) => {
  // Undo the front rotation: rotateY(-fy) then rotateX(-fx) is its inverse.
  const axis = (v: V3) => round(rotate(rotate(v, -fx, 0), 0, -fy))
  return {
    value,
    front: [fx, fy] as const,
    n: axis([0, 0, 1]),
    u: axis([1, 0, 0]),
    v: axis([0, 1, 0]),
  }
})

export interface DieLook {
  /** Eye distance in icon sizes at full spin (the resting die is seen orthographically). */
  readonly perspective: number
  /** How far a spinning die rises towards the eye, in icon sizes, at full spin. */
  readonly lift: number
  /** Degrees from a face where the inked bevel begins (atan ½ ≈ 26.6° is Phosphor's outline). */
  readonly bevel: number
  /** Face fill while spinning: ambient and lit (Lambert) parts. */
  readonly fill: number
  readonly shade: number
}
export const DIE_LOOK: DieLook = {
  perspective: 3.2,
  lift: 0.45,
  bevel: +((Math.atan(0.5) * 180) / Math.PI).toFixed(2),
  fill: 0.1,
  shade: 0.22,
}

export interface DieSpin {
  readonly spring: SpringValue
  /** Extra whole turns per roll. */
  readonly turns: number
}
export const DIE_SPIN: DieSpin = { spring: { duration: 0.38, bounce: 0.3 }, turns: 1 }

/**
 * The box around a die of `size` px, in sizes: room for the corners while it tumbles and lifts
 * (they reach 0.6 of a size out at the default look), so it overflows its button's round wash
 * rather than clipping to it. Past `DIE_FEATHER` of the way out it fades, so a die tuned to lift
 * further never meets a hard edge.
 */
export const DIE_BOX = 2
export const DIE_FEATHER = 0.75
export const dieBox = (size: number) => Math.ceil(size * DIE_BOX)
/** How much of the die shows `r` px from its centre: all of it, fading out at the box's edge. */
export function dieFeather(size: number, r: number) {
  const half = dieBox(size) / 2
  const t = Math.min(1, Math.max(0, (r - half * DIE_FEATHER) / (half - half * DIE_FEATHER)))
  return 1 - t * t * (3 - 2 * t)
}
/** Supersamples per axis: dense at icon sizes, cheaper when large. */
export const dieSamples = (size: number) => (size <= 40 ? 6 : 3)

export class DieMotion {
  readonly rx = new Spring(0, 24, 0.86, 0.25)
  readonly ry = new Spring(0, 24, 0.86, 0.25)
  value = 5
  turns = DIE_SPIN.turns

  constructor(spin: DieSpin = DIE_SPIN) {
    this.tune(spin)
  }

  tune({ spring, turns }: DieSpin) {
    const { omega, zeta } = springMotion(spring)
    for (const s of [this.rx, this.ry]) {
      s.omega = omega
      s.zeta = zeta
    }
    this.turns = turns
  }

  /** Tumble to a different face (or `to`) from wherever it is now. */
  roll(to?: number, random = Math.random) {
    const others = FACES.filter((f) => f.value !== this.value)
    const face = FACES.find((f) => f.value === to) ?? others[Math.floor(random() * others.length)]!
    this.value = face.value
    const [bx, by] = face.front
    const spin = 360 * this.turns * (random() < 0.5 ? -1 : 1)
    // One axis takes the extra turns; the other just goes where it must, so it reads as a flick.
    const flipX = random() < 0.5
    this.rx.set(nearest(bx, this.rx.target + (flipX ? spin : 0)))
    this.ry.set(nearest(by, this.ry.target + (flipX ? 0 : spin)))
    return face.value
  }

  /** A quarter turn onto a neighbouring face: a nudge rather than a roll. */
  nudge(random = Math.random) {
    const opposite = 7 - this.value
    const near = FACES.filter((f) => f.value !== this.value && f.value !== opposite)
    const face = near[Math.floor(random() * near.length)]!
    this.value = face.value
    this.rx.set(nearest(face.front[0], this.rx.target))
    this.ry.set(nearest(face.front[1], this.ry.target))
    return face.value
  }

  snapTo(value: number) {
    const face = FACES.find((f) => f.value === value) ?? FACES[0]!
    this.value = face.value
    this.rx.snap(face.front[0])
    this.ry.snap(face.front[1])
  }

  /** Advance; returns the orientation (degrees) and spin energy 0…1 for lift and shading. */
  step(dt: number): DieView {
    const rx = this.rx.step(dt)
    const ry = this.ry.step(dt)
    const energy = Math.min(1, (Math.abs(this.rx.v) + Math.abs(this.ry.v)) / 900)
    return { rx, ry, energy }
  }

  get resting() {
    return this.rx.resting && this.ry.resting
  }
}

export interface DieView {
  readonly rx: number
  readonly ry: number
  readonly energy: number
}

/** The value congruent to `base` (mod 360) closest to `around`. */
function nearest(base: number, around: number) {
  return base + 360 * Math.round((around - base) / 360)
}

/** Light direction for the spin shading (towards the viewer, from the upper left; y down). */
export const DIE_LIGHT: V3 = [-0.4818, -0.6424, 0.5961]

const INNER = DIE.half - DIE.round
const BOUND = INNER * Math.sqrt(3) + DIE.round + 1
/** How far in front of the icon plane rays start (icon units): beyond any lifted corner. */
const START = 512

/** A ray that misses the die (coverage 0), told apart so the canvas can skip empty pixels. */
const MISS = -1

/**
 * Traces one ray through the pixel offset (`x`, `y`) px from the die's centre and returns
 * ink + fill coverage (0…1), or `MISS`. Mirrors `die_trace` in die.wgsl.ts step for step.
 */
export function dieTracer(size: number, view: DieView, look: DieLook) {
  const unit = size / 256
  // Perspective grows with the spin: at rest the projection is orthographic, so the die is exactly
  // the glyph; tumbling, the eye sits `perspective` icon sizes away.
  const k = view.energy / (look.perspective * 256)
  const cz = look.lift * view.energy * 256 - DIE.half
  const ax = (view.rx * Math.PI) / 180
  const ay = (view.ry * Math.PI) / 180
  const cx = Math.cos(ax)
  const sx = Math.sin(ax)
  const cy = Math.cos(ay)
  const sy = Math.sin(ay)
  const cosBevel = Math.cos((look.bevel * Math.PI) / 180)
  const toWorld = (v: V3) => rotate(v, view.rx, view.ry)
  return (x: number, y: number): number => {
    // The ray through (x, y) on the icon plane, started well in front of the die.
    const ix = x / unit
    const iy = y / unit
    let rx = ix * k
    let ry = iy * k
    let rz = -1
    const l = Math.sqrt(rx * rx + ry * ry + rz * rz)
    rx /= l
    ry /= l
    rz /= l
    const wx = ix - rx * START
    const wy = iy - ry * START
    const wz = -rz * START - cz
    // Enter the bounding sphere in world space (rotation preserves dot products) before rotating.
    const b = wx * rx + wy * ry + wz * rz
    const c = wx * wx + wy * wy + wz * wz - BOUND * BOUND
    const disc = b * b - c
    if (disc < 0) return MISS
    // Into cube space: undo rotateX, then rotateY.
    let y1 = ry * cx + rz * sx
    let z1 = -ry * sx + rz * cx
    const d0 = rx * cy - z1 * sy
    const d1 = y1
    const d2 = rx * sy + z1 * cy
    y1 = wy * cx + wz * sx
    z1 = -wy * sx + wz * cx
    const o0 = wx * cy - z1 * sy
    const o1 = y1
    const o2 = wx * sy + z1 * cy
    let t = Math.max(0, -b - Math.sqrt(disc))
    const far = -b + Math.sqrt(disc)
    let px = 0
    let py = 0
    let pz = 0
    let hit = false
    for (let i = 0; i < 48 && t < far; i++) {
      px = o0 + t * d0
      py = o1 + t * d1
      pz = o2 + t * d2
      const qx = Math.abs(px) - INNER
      const qy = Math.abs(py) - INNER
      const qz = Math.abs(pz) - INNER
      const mx = qx > 0 ? qx : 0
      const my = qy > 0 ? qy : 0
      const mz = qz > 0 ? qz : 0
      const inside = qx > qy ? (qx > qz ? qx : qz) : qy > qz ? qy : qz
      const dist = Math.sqrt(mx * mx + my * my + mz * mz) + (inside < 0 ? inside : 0) - DIE.round
      if (dist < 0.02) {
        hit = true
        break
      }
      t += dist
    }
    if (!hit) return MISS
    let nx = Math.max(Math.abs(px) - INNER, 0) * Math.sign(px)
    let ny = Math.max(Math.abs(py) - INNER, 0) * Math.sign(py)
    let nz = Math.max(Math.abs(pz) - INNER, 0) * Math.sign(pz)
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl
    ny /= nl
    nz /= nl
    if (Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz)) < cosBevel) return 1
    let best = 0
    let score = -2
    for (let f = 0; f < 6; f++) {
      const n = FACES[f]!.n
      const s = n[0] * nx + n[1] * ny + n[2] * nz
      if (s > score) {
        score = s
        best = f
      }
    }
    const face = FACES[best]!
    const u = face.u[0] * px + face.u[1] * py + face.u[2] * pz
    const v = face.v[0] * px + face.v[1] * py + face.v[2] * pz
    for (const [x0, y0] of PIPS[face.value]!)
      if ((u - x0) * (u - x0) + (v - y0) * (v - y0) < DIE.pip * DIE.pip) return 1
    const w = toWorld([nx, ny, nz])
    const lambert = Math.max(0, w[0] * DIE_LIGHT[0] + w[1] * DIE_LIGHT[1] + w[2] * DIE_LIGHT[2])
    return view.energy * (look.fill + look.shade * lambert)
  }
}

/**
 * The DOM die: a canvas traced in JS. Its backing store is whole device pixels and `render` takes
 * the die centre in those pixels, so the caller can land the canvas on the pixel grid (no
 * resampling blur). Each pixel is traced 2×2; only pixels whose samples disagree (an edge, a pip)
 * are refined at `dieSamples` × `dieSamples`.
 */
export function createDieCanvas(doc: Document, size: number) {
  const canvas = doc.createElement("canvas")
  canvas.className = "knobs-die"
  canvas.setAttribute("aria-hidden", "true")
  canvas.style.cssText = "position:absolute;display:block;pointer-events:none"
  const ctx = canvas.getContext("2d")!
  let img: ImageData | undefined
  return {
    canvas,
    /** Backing size (device px) for a given ratio; the CSS size is this over the ratio. */
    pixels: (dpr: number) => Math.round(dieBox(size) * dpr),
    render(
      view: DieView,
      look: DieLook,
      rgba: readonly [number, number, number, number],
      dpr: number,
      centre: readonly [number, number],
    ) {
      const w = Math.round(dieBox(size) * dpr)
      if (canvas.width !== w || !img) {
        canvas.width = canvas.height = w
        canvas.style.width = canvas.style.height = `${w / dpr}px`
        img = ctx.createImageData(w, w)
      } else img.data.fill(0)
      const trace = dieTracer(size, view, look)
      const fine = dieSamples(size)
      const at = (x: number, y: number) =>
        Math.max(0, trace((x - centre[0]) / dpr, (y - centre[1]) / dpr))
      const data = img.data
      for (let j = 0; j < w; j++)
        for (let i = 0; i < w; i++) {
          const feather = dieFeather(
            size,
            Math.hypot(i + 0.5 - centre[0], j + 0.5 - centre[1]) / dpr,
          )
          if (feather <= 0) continue
          const a = at(i + 0.25, j + 0.25)
          const b = at(i + 0.75, j + 0.25)
          const c = at(i + 0.25, j + 0.75)
          const d = at(i + 0.75, j + 0.75)
          let cov = (a + b + c + d) / 4
          if (Math.max(a, b, c, d) - Math.min(a, b, c, d) > 0.02) {
            cov = 0
            for (let y = 0; y < fine; y++)
              for (let x = 0; x < fine; x++) cov += at(i + (x + 0.5) / fine, j + (y + 0.5) / fine)
            cov /= fine * fine
          }
          cov *= feather
          if (cov <= 0) continue
          const k = (j * w + i) * 4
          data[k] = rgba[0]
          data[k + 1] = rgba[1]
          data[k + 2] = rgba[2]
          data[k + 3] = Math.round(cov * rgba[3] * 255)
        }
      ctx.putImageData(img, 0, 0)
    },
  }
}

/** Icon size of the header die (px), matching the other header icons. */
export const HEADER_DIE = 14
/** A group's die, beside its reset icon. */
export const GROUP_DIE = 13

/**
 * A die button's icon. It is always the traced die, rolling or at rest, so nothing swaps shape
 * when a roll starts or lands. In the DOM it is a canvas laid on whole device pixels and re-traced
 * when its colour changes (hover, focus, theme) or the zoom does; in GPU mode the canvas is skipped
 * and the renderer traces `view` itself, with `onFrame` waking it.
 */
export function createHeaderDie(doc: Document, onFrame: () => void, size = HEADER_DIE) {
  const node = doc.createElement("span")
  node.className = "knobs-die-icon"
  node.style.width = node.style.height = `${size}px`
  const win = doc.defaultView
  let canvas: ReturnType<typeof createDieCanvas> | undefined
  const motion = new DieMotion()
  let view: DieView = { rx: 0, ry: 0, energy: 0 }
  let frame = 0
  let last = 0
  let painted = ""
  const gpu = () => node.closest('[data-gpu-active="true"]') !== null

  /** Traces the current view in the button's current colour, unless nothing visible changed. */
  const paint = (force = false) => {
    if (gpu() || !node.isConnected) return
    canvas ??= createDieCanvas(doc, size)
    if (!canvas.canvas.isConnected) node.append(canvas.canvas)
    const color = getComputedStyle(node).color
    const dpr = win?.devicePixelRatio ?? 1
    const r = node.getBoundingClientRect()
    // Land the canvas's top-left on a device pixel; the die centre falls where the icon's is.
    const pad = (dieBox(size) - size) / 2
    const left = Math.round((r.left - pad) * dpr)
    const top = Math.round((r.top - pad) * dpr)
    const key = `${color}|${dpr}|${left - r.left * dpr}|${top - r.top * dpr}|${view.rx}|${view.ry}|${view.energy}|${motion.value}`
    if (!force && key === painted) return
    painted = key
    canvas.canvas.style.left = `${left / dpr - r.left}px`
    canvas.canvas.style.top = `${top / dpr - r.top}px`
    const m = color.match(/[\d.]+/g) ?? ["255", "255", "255"]
    const rgba = [
      Number(m[0]),
      Number(m[1]),
      Number(m[2]),
      m[3] !== undefined ? Number(m[3]) : 1,
    ] as const
    canvas.render(view, DIE_LOOK, rgba, dpr, [
      (r.left + size / 2) * dpr - left,
      (r.top + size / 2) * dpr - top,
    ])
  }

  // Colour transitions (hover, focus, disabled, theme) re-trace each frame until they settle.
  let fading = 0
  const follow = (until: number) => {
    const step = () => {
      paint()
      fading = performance.now() < until && !frame ? requestAnimationFrame(step) : 0
    }
    if (!fading) fading = requestAnimationFrame(step)
  }
  const nudgeColour = () => follow(performance.now() + 260)
  queueMicrotask(() => {
    const button = node.closest("button")
    for (const type of [
      "pointerenter",
      "pointerleave",
      "focusin",
      "focusout",
      "transitionrun",
      "transitionend",
    ])
      button?.addEventListener(type, nudgeColour)
  })
  const onResize = () => paint()
  win?.addEventListener("resize", onResize)
  requestAnimationFrame(() => paint(true))

  const tick = (now: number) => {
    view = motion.step((now - last) / 1000)
    last = now
    paint()
    onFrame()
    if (motion.resting) {
      frame = 0
      paint()
      onFrame()
    } else frame = requestAnimationFrame(tick)
  }
  return {
    node,
    size,
    /** Tumble to another face; `nudge` turns a quarter onto a neighbour instead (Mutate). */
    roll(nudge = false) {
      const still = win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      if (still) {
        const others = FACES.filter((f) => f.value !== motion.value)
        motion.snapTo(others[Math.floor(Math.random() * others.length)]!.value)
        view = motion.step(0)
        paint()
        onFrame()
        return
      }
      if (nudge) motion.nudge()
      else motion.roll()
      if (!frame) {
        last = performance.now()
        frame = requestAnimationFrame(tick)
      }
    },
    /** Re-trace now (e.g. after the panel moved or switched renderer). */
    repaint: () => paint(true),
    get view() {
      return view
    },
    get value() {
      return motion.value
    },
    get rolling() {
      return frame !== 0
    },
    dispose() {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(fading)
      win?.removeEventListener("resize", onResize)
    },
  }
}
export type HeaderDie = ReturnType<typeof createHeaderDie>
