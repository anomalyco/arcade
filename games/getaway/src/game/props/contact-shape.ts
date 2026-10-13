import { PROP_SIZE } from "./dimensions"
import type { PropKind } from "./placement"

type V3 = readonly [number, number, number]
export type GroundShape = { points: readonly V3[]; centerY: number; rests: readonly V3[] }
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Compile convex support faces once, keeping only faces that support the mass centre with a tipping margin.
 * Points can describe a compound: its convex envelope has the same support against a flat ground plane.
 * This is ground contact geometry; body/body contacts retain the decorative solver's rounded proxies. */
function compile(points: V3[], centerY: number): GroundShape {
  const rests: V3[] = [], center: V3 = [0, centerY, 0], epsilon = 1e-7
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) for (let k = j + 1; k < points.length; k++) {
    const a = points[i]!, n = cross(sub(points[j]!, a), sub(points[k]!, a)), length = Math.hypot(...n)
    if (length < epsilon) continue
    let normal: V3 = [n[0] / length, n[1] / length, n[2] / length]
    let distance = dot(normal, a)
    if (points.some(p => dot(normal, p) > distance + epsilon)) {
      normal = [-normal[0], -normal[1], -normal[2]]; distance = -distance
      if (points.some(p => dot(normal, p) > distance + epsilon)) continue
    }
    const up: V3 = [-normal[0], -normal[1], -normal[2]]
    if (rests.some(r => dot(r, up) > 1 - epsilon)) continue
    const height = distance - dot(normal, center)
    if (height <= epsilon) continue
    const face = points.filter(p => Math.abs(dot(normal, p) - distance) < epsilon)
    const origin: V3 = [center[0] + normal[0] * height, center[1] + normal[1] * height, center[2] + normal[2] * height]
    const tangent = sub(face[0]!, origin), bitangent = cross(normal, tangent)
    const tl = Math.hypot(...tangent), bl = Math.hypot(...bitangent)
    if (tl < epsilon || bl < epsilon) continue
    face.sort((a, b) => Math.atan2(dot(sub(a, origin), bitangent) / bl, dot(sub(a, origin), tangent) / tl) - Math.atan2(dot(sub(b, origin), bitangent) / bl, dot(sub(b, origin), tangent) / tl))
    let margin = Infinity
    for (let e = 0; e < face.length; e++) {
      const start = face[e]!, edge = sub(face[(e + 1) % face.length]!, start)
      margin = Math.min(margin, dot(cross(edge, sub(origin, start)), normal) / Math.hypot(...edge))
    }
    // A tiny lid, nozzle or tip is not a stable rest for a tall prop, even if perfectly balanced numerically.
    if (margin > Math.max(.012, height * .12)) rests.push(up)
  }
  if (!rests.length) throw new Error("Prop shape has no stable ground face")
  return { points, centerY, rests }
}

const cache = new Map<PropKind, GroundShape>()
export function propGroundShape(kind: PropKind): GroundShape | undefined {
  if (!["cone", "barrier", "sawhorse", "bin", "hydrant", "sign", "meter", "propane"].includes(kind)) return
  const cached = cache.get(kind)
  if (cached) return cached
  const [w, h, d] = PROP_SIZE[kind], points: V3[] = []
  const point = (x: number, y: number, z: number) => points.push([x, y - h / 2, z])
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) point(x, y, z)
  }
  const ring = (r: number, y: number) => {
    for (let i = 0; i < 8; i++) point(Math.cos(i * Math.PI / 4) * r, y, Math.sin(i * Math.PI / 4) * r)
  }
  let centerY = h * .45
  switch (kind) {
    case "cone":
      box(-w / 2, w / 2, 0, .05, -d / 2, d / 2)
      ring(.175, .05); point(0, h, 0)
      centerY = .105 // Heavy rubber foot, light hollow cone.
      break
    case "hydrant":
      ring(.15, 0); ring(.15, .08); ring(.09, .6); point(0, h, 0)
      box(-.15, .15, .39, .49, -.065, .065)
      centerY = .28
      break
    case "barrier":
    case "sawhorse": {
      const foot = kind === "barrier" ? .04 : .03, x = kind === "barrier" ? w / 2 - .15 : .44
      for (const side of [-1, 1]) for (const end of [-1, 1]) box(end * x - foot, end * x + foot, 0, .025, side * (d / 2 - foot) - foot, side * (d / 2 - foot) + foot)
      const top = kind === "barrier" ? .9 : h
      const depth = kind === "barrier" ? .04 : .06
      box(-w / 2, w / 2, top - .18, top, -depth, depth)
      if (kind === "barrier") box(-w / 2 + .09, -w / 2 + .21, .98, h, -.06, .06)
      centerY = h * .52
      break
    }
    case "sign":
      for (const s of [-1, 1]) box(-.06, .06, 0, .025, s * .27 - .03, s * .27 + .03)
      box(-w / 2, w / 2, h - .6, h, -.025, .025)
      centerY = .72
      break
    case "meter":
      ring(.04, 0); box(-w / 2, w / 2, h - .32, h, -.1, .1)
      centerY = .95
      break
    case "propane":
      ring(.125, 0); ring(.16, .12); ring(.16, .37); ring(.06, .43)
      box(-.05, .05, .43, h, -.035, .035)
      centerY = .2
      break
    case "bin":
      box(-w / 2, w / 2, 0, h, -d / 2, d / 2)
      centerY = .38
      break
  }
  const shape = compile(points, centerY - h / 2)
  cache.set(kind, shape)
  return shape
}
