import { writeOrbitCamera, type LabLight } from "../stage"
import type { LabContext, LabSection } from "../types"
import type { LabStation, StationProp } from "./types"

/** Plot pitch and size in metres. Plots sit on a grid four wide, first station at the back left. */
export const PLOT_SPACING = 13.5
export const PLOT_HALF = 5.2
const PLOT_TOP = 0.4

export type Plot = { station: LabStation; index: number; x: number; z: number }
export type OverworldCamera = { yaw: number; pitch: number; distance: number; focus: [number, number, number] }

/** Plots on a grid; the column count is whichever lets the whole map sit closest to the camera at `aspect`. */
export function layoutPlots(stations: readonly LabStation[], aspect = 1.6): Plot[] {
  let best: Plot[] = [], bestDistance = Infinity
  for (let columns = 3; columns <= 7; columns++) {
    const plots = gridPlots(stations, columns)
    const d = overviewCamera(plots, aspect).distance
    if (d < bestDistance - 0.5) { best = plots; bestDistance = d }
  }
  return best
}

function gridPlots(stations: readonly LabStation[], columns: number): Plot[] {
  const rows = Math.max(1, Math.ceil(stations.length / columns))
  return stations.map((station, index) => {
    const col = index % columns, row = Math.floor(index / columns)
    const inRow = Math.min(columns, stations.length - row * columns)
    return { station, index, x: (col - (inRow - 1) / 2) * PLOT_SPACING, z: (row - (rows - 1) / 2) * PLOT_SPACING }
  })
}

/**
 * Camera that fits every plot and its props inside the viewport, leaving `margin` (fractions of the viewport) clear
 * for the overlays: top bar, station card and strip.
 */
export function overviewCamera(plots: readonly Plot[], aspect: number, margin = { left: 0.03, right: 0.03, top: 0.07, bottom: 0.15 }): OverworldCamera {
  const pitch = 0.98, yaw = 0, height = 800, width = Math.round(height * Math.max(0.5, aspect))
  const pts: [number, number, number][] = []
  for (const p of plots) for (const dx of [-1, 1]) for (const dz of [-1, 1]) for (const y of [0, 4.5]) pts.push([p.x + dx * (PLOT_HALF + 0.6), y, p.z + dz * (PLOT_HALF + 0.9)])
  const vp = new Float32Array(16), inv = new Float32Array(16), eye = new Float32Array(3)
  const cx = (Math.max(...plots.map(p => p.x)) + Math.min(...plots.map(p => p.x))) / 2
  let cz = (Math.max(...plots.map(p => p.z)) + Math.min(...plots.map(p => p.z))) / 2
  const box = (focus: number[], dist: number) => {
    writeOrbitCamera(width, height, vp, inv, eye, focus, yaw, pitch, dist)
    let u0 = 1, u1 = 0, v0 = 1, v1 = 0
    for (const [x, y, z] of pts) {
      const w = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!
      const u = ((vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!) / w + 1) / 2
      const v = (1 - (vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!) / w) / 2
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
    }
    return { u0, u1, v0, v1 }
  }
  let dist = 40
  for (let pass = 0; pass < 3; pass++) {
    let lo = 8, hi = 105
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2, b = box([cx, 0, cz], mid)
      const fits = b.u0 >= margin.left && b.u1 <= 1 - margin.right && b.v0 >= margin.top && b.v1 <= 1 - margin.bottom
      if (fits) hi = mid
      else lo = mid
    }
    dist = hi
    // Centre the content vertically in the space between the margins.
    const b = box([cx, 0, cz], dist), want = (margin.top + 1 - margin.bottom) / 2, have = (b.v0 + b.v1) / 2
    cz += (have - want) * dist * 0.9
  }
  return { yaw, pitch, distance: dist, focus: [cx, 0, cz] }
}

export function plotCamera(plot: Plot): OverworldCamera {
  return { yaw: 0, pitch: 0.82, distance: 19, focus: [plot.x, 1.2, plot.z] }
}

export function plotAt(plots: readonly Plot[], x: number, z: number): Plot | null {
  const margin = PLOT_HALF + 1
  return plots.find(p => Math.abs(p.x - x) <= margin && Math.abs(p.z - z) <= margin) ?? null
}

type Rgb = readonly [number, number, number]
const rgb = (hex: number): Rgb => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]

/** Position, normal, colour and emission per vertex: the Lab mesh format (stride 10). */
class Builder {
  readonly v: number[] = []
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: Rgb, emission = 0, yaw = 0) {
    const hx = sx / 2, hz = sz / 2, c = Math.cos(yaw), s = Math.sin(yaw)
    const p = (x: number, y: number, z: number) => [cx + x * c + z * s, y0 + y, cz - x * s + z * c] as const
    const n = (x: number, y: number, z: number) => [x * c + z * s, y, -x * s + z * c] as const
    const faces: [readonly [number, number, number], (readonly [number, number, number])[]][] = [
      [n(0, 1, 0), [p(-hx, sy, -hz), p(-hx, sy, hz), p(hx, sy, hz), p(hx, sy, -hz)]],
      [n(0, -1, 0), [p(-hx, 0, -hz), p(hx, 0, -hz), p(hx, 0, hz), p(-hx, 0, hz)]],
      [n(0, 0, 1), [p(-hx, 0, hz), p(hx, 0, hz), p(hx, sy, hz), p(-hx, sy, hz)]],
      [n(0, 0, -1), [p(hx, 0, -hz), p(-hx, 0, -hz), p(-hx, sy, -hz), p(hx, sy, -hz)]],
      [n(1, 0, 0), [p(hx, 0, hz), p(hx, 0, -hz), p(hx, sy, -hz), p(hx, sy, hz)]],
      [n(-1, 0, 0), [p(-hx, 0, -hz), p(-hx, 0, hz), p(-hx, sy, hz), p(-hx, sy, -hz)]],
    ]
    for (const [normal, [a, b, cc, d]] of faces) for (const q of [a, b, cc, a, cc, d]) this.v.push(...q!, ...normal, ...color, emission)
  }
}

const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

/** Small box props that say what each plot is from across the map. Local coordinates, plot top at y = 0. */
function prop(b: Builder, kind: StationProp, x: number, z: number, accent: Rgb) {
  const y = PLOT_TOP
  const at = (dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, color: Rgb, emission = 0, yaw = 0) => b.box(x + dx, y + dy, z + dz, sx, sy, sz, color, emission, yaw)
  const dark: Rgb = [0.12, 0.12, 0.13], grey: Rgb = [0.42, 0.43, 0.45], fire: Rgb = [1, 0.48, 0.12]
  switch (kind) {
    case "burst":
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; at(Math.cos(a) * 3, 0, Math.sin(a) * 3, 1.1, 0.35, 0.7, dark, 0, a) }
      at(0, 0.2, 0, 1.6, 1.6, 1.6, fire, 1.6, 0.4)
      at(0.6, 1.4, -0.3, 1.1, 1.1, 1.1, [1, 0.72, 0.25], 2.2, 0.9)
      at(-0.7, 1.1, 0.5, 0.9, 0.9, 0.9, [0.95, 0.32, 0.08], 1.3, 0.2)
      for (let i = 0; i < 6; i++) { const a = i * 1.7; at(Math.cos(a) * 2, 0.6 + (i % 3) * 0.7, Math.sin(a) * 2, 0.25, 0.25, 0.25, [1, 0.8, 0.4], 2, a) }
      break
    case "smoke":
      at(0, 0, 0, 1.4, 0.5, 1.4, [0.25, 0.2, 0.18])
      at(0, 0.5, 0, 0.8, 0.5, 0.8, fire, 1.8)
      for (let i = 0; i < 7; i++) { const s = 1.2 + i * 0.35; at(Math.sin(i * 1.3) * 0.6 + i * 0.25, 1 + i * 0.75, Math.cos(i * 1.1) * 0.4, s, s * 0.8, s, shade(grey, 1.15 - i * 0.07), 0.05, i * 0.5) }
      break
    case "cloud":
      at(-1, 4.2, 0, 4.2, 1.1, 2.6, [0.55, 0.6, 0.68], 0.06)
      at(1.2, 4.6, 0.6, 3.2, 1.2, 2.4, [0.62, 0.66, 0.74], 0.06)
      for (let i = 0; i < 14; i++) at(-2.6 + (i % 7) * 0.8, 0.4 + (i % 3) * 0.4, -0.6 + Math.floor(i / 7) * 1.2, 0.05, 2.6, 0.05, [0.6, 0.75, 0.95], 0.6)
      at(0, 0, 0, 6, 0.04, 4, [0.15, 0.22, 0.3], 0.1)
      break
    case "tree":
      for (const [dx, dz, h] of [[-2, -1.5, 3.4], [1.8, -0.8, 2.6], [0.2, 2, 3]] as const) {
        at(dx, 0, dz, 0.4, h, 0.4, [0.3, 0.2, 0.12])
        at(dx, h - 0.6, dz, 2.4, 1.8, 2.4, [0.2, 0.42, 0.18], 0.04, dx)
        at(dx + 0.3, h + 0.8, dz - 0.2, 1.5, 1.1, 1.5, [0.27, 0.52, 0.22], 0.04, dz)
      }
      for (let i = 0; i < 12; i++) at(-3.5 + (i % 6) * 1.3, 0, 3.6 - Math.floor(i / 6) * 7, 0.5, 0.4, 0.5, [0.32, 0.5, 0.2], 0.03, i)
      break
    case "panels": {
      const looks: Rgb[] = [[0.75, 0.75, 0.78], [1, 0.6, 0.22], [0.3, 0.62, 0.66], [0.95, 0.78, 0.45]]
      looks.forEach((c, i) => { at(-3 + i * 2, 0, 0, 1.6, 2.6, 0.25, c, i === 0 ? 0.25 : 0.5); at(-3 + i * 2, 0, 0.3, 1.8, 0.2, 0.6, dark) })
      break
    }
    case "lamp":
      at(0, 0, 0, 0.25, 4.2, 0.25, [0.25, 0.26, 0.28])
      at(0.6, 4, 0, 1.4, 0.18, 0.3, [0.25, 0.26, 0.28])
      at(1.2, 3.75, 0, 0.5, 0.25, 0.5, [1, 0.85, 0.55], 3)
      at(1.2, 0, 0, 3, 0.03, 3, [0.5, 0.42, 0.28], 0.25)
      at(-2.5, 0, 1.5, 0.6, 1.8, 0.4, [0.2, 0.22, 0.25])
      at(-2.5, 1.8, 1.5, 0.35, 0.35, 0.35, [0.9, 0.95, 1], 2)
      break
    case "swatches": {
      const mats: Rgb[] = [[0.55, 0.36, 0.2], [0.58, 0.26, 0.2], [0.82, 0.8, 0.74], [0.2, 0.2, 0.22], [0.3, 0.45, 0.2], [0.55, 0.55, 0.52]]
      mats.forEach((c, i) => at(-3.2 + (i % 3) * 3.2, Math.floor(i / 3) * 0, -1.4 + Math.floor(i / 3) * 2.8, 1.8, 1.8, 1.8, c, 0.08, 0.3))
      break
    }
    case "figure":
      for (const [dx, step, color] of [[-2.4, 0.35, [0.5, 0.55, 0.4]], [0, -0.3, [0.35, 0.4, 0.55]], [2.4, 0.5, [0.45, 0.5, 0.42]]] as const) {
        at(dx - 0.2, 0, step, 0.28, 1, 0.28, dark)
        at(dx + 0.2, 0, -step, 0.28, 1, 0.28, dark)
        at(dx, 1, 0, 0.8, 1, 0.45, color, 0.1)
        at(dx - 0.55, 1.15, -step, 0.22, 0.8, 0.22, color, 0.05)
        at(dx + 0.55, 1.15, step, 0.22, 0.8, 0.22, color, 0.05)
        at(dx, 2.05, 0, 0.45, 0.5, 0.45, [0.85, 0.7, 0.58], 0.1)
      }
      break
    case "speaker":
      at(-1.5, 0, 0, 1.8, 2.6, 1.4, [0.16, 0.16, 0.18])
      at(-1.5, 0.5, 0.71, 1.1, 1.1, 0.05, [0.3, 0.3, 0.32], 0.1)
      at(-1.5, 1.8, 0.71, 0.6, 0.6, 0.05, [0.3, 0.3, 0.32], 0.1)
      for (let i = 0; i < 9; i++) at(0.8 + i * 0.4, 0, 0, 0.22, 0.4 + Math.abs(Math.sin(i * 1.4)) * 2.2, 0.22, accent, 0.9)
      break
    case "house":
      at(0, 0, 0, 5, 2.6, 4, [0.62, 0.56, 0.46])
      at(0, 2.6, 0, 5.6, 0.5, 4.6, [0.3, 0.2, 0.17])
      at(0, 3.1, 0, 4.2, 0.6, 3.4, [0.3, 0.2, 0.17])
      at(-1.4, 0.9, 2.01, 1, 0.9, 0.05, [1, 0.62, 0.25], 1.6)
      at(1.4, 0.9, 2.01, 1, 0.9, 0.05, [1, 0.62, 0.25], 1.2)
      at(0, 0, 2.01, 0.8, 1.7, 0.05, [0.25, 0.16, 0.1])
      at(3.6, 0, 2.6, 0.35, 2, 0.35, [0.3, 0.2, 0.12])
      at(3.6, 1.8, 2.6, 1.8, 1.6, 1.8, [0.18, 0.32, 0.16], 0.03)
      break
    case "office":
      at(-0.6, 0, -0.5, 5, 3.6, 3.6, [0.4, 0.42, 0.44])
      for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) at(-2.4 + c * 1.2, 0.7 + r * 1.4, 1.31, 0.7, 0.7, 0.05, [0.45, 0.65, 0.95], 0.9)
      at(2.9, 0, 2.2, 1, 1, 1, [0.4, 0.32, 0.2])
      at(3.4, 0, 3.2, 0.8, 0.8, 0.8, [0.4, 0.32, 0.2], 0, 0.5)
      break
    case "car":
      at(0, 0.35, 0, 4.6, 0.8, 2, accent, 0.25)
      at(-0.3, 1.15, 0, 2.4, 0.7, 1.8, shade(accent, 0.8), 0.15)
      at(0.5, 1.2, 0, 0.9, 0.55, 1.82, [0.35, 0.5, 0.65], 0.4)
      for (const [dx, dz] of [[-1.5, -1], [1.5, -1], [-1.5, 1], [1.5, 1]] as const) at(dx, 0, dz, 0.75, 0.75, 0.3, dark)
      at(2.33, 0.55, -0.6, 0.05, 0.25, 0.4, [1, 0.95, 0.8], 2.5)
      at(2.33, 0.55, 0.6, 0.05, 0.25, 0.4, [1, 0.95, 0.8], 2.5)
      break
    case "ship":
      at(0, 0, 0, 10, 0.04, 10, [0.08, 0.2, 0.32], 0.2)
      at(0, 0.05, 0, 8.4, 0.9, 2.6, [0.38, 0.4, 0.42])
      at(0, 0.95, 0, 9, 0.1, 3, [0.3, 0.31, 0.33])
      at(1.6, 1.05, 1.1, 1.4, 1.8, 0.6, [0.42, 0.44, 0.46])
      at(1.6, 2.85, 1.1, 0.4, 0.8, 0.4, [0.42, 0.44, 0.46])
      at(-2, 1.05, -0.4, 1.2, 0.2, 0.7, [0.55, 0.58, 0.6], 0.1, 0.2)
      at(-3.6, 1.06, 0, 1.5, 0.02, 0.12, [1, 0.9, 0.4], 0.8)
      break
  }
}

/** The overworld's static geometry: ground, paths, every plot and its prop. */
export function dioramaVertices(plots: readonly Plot[]): number[] {
  const b = new Builder()
  const xs = plots.map(p => p.x), zs = plots.map(p => p.z)
  const w = Math.max(...xs) - Math.min(...xs) + PLOT_SPACING * 2, d = Math.max(...zs) - Math.min(...zs) + PLOT_SPACING * 2
  const cz = (Math.max(...zs) + Math.min(...zs)) / 2
  b.box(0, -0.6, cz, w, 0.6, d, [0.11, 0.13, 0.12], 0.04)
  // Paths between plots.
  for (const z of new Set(zs)) b.box(0, 0, z + PLOT_SPACING / 2, w - 6, 0.02, 2.2, [0.24, 0.23, 0.21], 0.06)
  for (const x of new Set(xs)) b.box(x + PLOT_SPACING / 2, 0, cz, 2.2, 0.02, d - 6, [0.24, 0.23, 0.21], 0.06)
  for (const plot of plots) {
    const accent = rgb(plot.station.color)
    b.box(plot.x, 0, plot.z, PLOT_HALF * 2 + 0.6, 0.18, PLOT_HALF * 2 + 0.6, shade(accent, 0.35), 0.1)
    b.box(plot.x, 0.18, plot.z, PLOT_HALF * 2, PLOT_TOP - 0.18, PLOT_HALF * 2, shade(accent, 0.18), 0.05)
    // Front edge stripe in the station colour, so plots read at a glance.
    b.box(plot.x, 0.18, plot.z + PLOT_HALF + 0.15, PLOT_HALF * 2 + 0.6, 0.24, 0.3, accent, 0.9)
    prop(b, plot.station.prop, plot.x, plot.z, accent)
  }
  return b.v
}

/** A square frame around a plot, tinted per instance (negative emission makes the Lab mesh shader use the tint). */
function frameVertices(): number[] {
  const b = new Builder(), h = PLOT_HALF + 0.55, t = 0.3, c: Rgb = [1, 1, 1]
  b.box(0, 0, -h, h * 2 + t, 0.12, t, c, -1.4)
  b.box(0, 0, h, h * 2 + t, 0.12, t, c, -1.4)
  b.box(-h, 0, 0, t, 0.12, h * 2, c, -1.4)
  b.box(h, 0, 0, t, 0.12, h * 2, c, -1.4)
  return b.v
}

const LIGHT_PROPS: Partial<Record<StationProp, { dx: number; dy: number; dz: number; color: Rgb; power: number; radius: number; flicker?: number }>> = {
  burst: { dx: 0, dy: 2.2, dz: 0, color: [1, 0.55, 0.2], power: 4, radius: 9, flicker: 9 },
  smoke: { dx: 0, dy: 1.4, dz: 0, color: [1, 0.5, 0.18], power: 3, radius: 7, flicker: 13 },
  lamp: { dx: 1.2, dy: 3.6, dz: 0, color: [1, 0.85, 0.6], power: 5, radius: 9 },
  house: { dx: 0, dy: 1.6, dz: 3, color: [1, 0.65, 0.3], power: 3, radius: 7 },
  office: { dx: -0.6, dy: 2, dz: 2.5, color: [0.5, 0.7, 1], power: 2.5, radius: 7 },
}

export type OverworldDiorama = {
  section: LabSection
  plots: Plot[]
  /** Plot outlined in the overworld (hovered or picked); null hides the outline. */
  setHighlight(id: string | null): void
}

export function createOverworldSection(context: LabContext, stations: readonly LabStation[], camera: () => OverworldCamera, aspect = 1.6): OverworldDiorama {
  const { stage } = context
  const plots = layoutPlots(stations, aspect)
  const model = stage.meshes.add(dioramaVertices(plots))
  const frame = stage.meshes.add(frameVertices(), 10, e => e, 0.9)
  let highlight: string | null = null, time = 0
  const lights: LabLight[] = []
  const settings = {}
  const section: LabSection = {
    id: "overworld",
    label: "Overworld",
    settings,
    controls: [],
    enter() {
      stage.sceneMode = 4
      const c = camera()
      stage.focus[0] = c.focus[0]; stage.focus[1] = c.focus[1]; stage.focus[2] = c.focus[2]
      stage.camYaw = c.yaw; stage.camPitch = c.pitch; stage.camDist = c.distance
      stage.camCustom = true; stage.hasDampedTarget = false
      stage.updateCamera()
    },
    leave() { stage.dynamicLights = null },
    update(dt) { time += dt },
    prepare() {
      stage.meshes.instance(model, 0, 0, 0)
      const lit = plots.find(p => p.station.id === highlight)
      if (lit) {
        const pulse = 0.75 + 0.25 * Math.sin(time * 4)
        stage.meshes.instance(frame, lit.x, PLOT_TOP + 0.01, lit.z, 0, 0, 0, 1, [pulse, pulse * 0.95, pulse * 0.8])
      }
      lights.length = 0
      if (lit) lights.push({ x: lit.x, y: 9, z: lit.z + 2, radius: 16, r: 1, g: 0.95, b: 0.85, power: 3.5, dx: 0, dy: -1, dz: -0.15, cone: Math.cos(0.75) })
      for (const p of plots) {
        const l = LIGHT_PROPS[p.station.prop]
        if (!l || lights.length >= 8) continue
        const flicker = l.flicker ? 0.8 + 0.2 * Math.sin(time * l.flicker + p.index) * Math.sin(time * l.flicker * 0.37) : 1
        lights.push({ x: p.x + l.dx, y: PLOT_TOP + l.dy, z: p.z + l.dz, radius: l.radius, r: l.color[0], g: l.color[1], b: l.color[2], power: l.power * flicker })
      }
      stage.dynamicLights = lights
    },
    telemetry: () => `Overworld · ${plots.length} stations`,
  }
  return { section, plots, setHighlight: id => { highlight = id } }
}
