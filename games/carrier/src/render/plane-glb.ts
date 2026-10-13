// Jet models (art/hornet.glb, art/f35.glb) as game meshes: a registry keyed by vehicle type (shared/vehicles.ts), each
// with its movable parts, procedural landing gear, team-accent faces and the anchor points the effects and night lights
// hang on.
//
// Both files are glTF-standard: +Y up, nose +Z, +X the pilot's left. That is a right-handed body frame, so a model
// reaches the world by a proper rotation and is used as is (no mirroring; shared/plane.ts uses the same body frame).
// Pieces are in model space (origin at the lowest belly point): the body, the canopy, and in their own frames (drawn at
// `pivot`) the two all-moving stabilisers (rotate about local X), the tailhook (about local X, `hookDown` when down),
// the weapons-bay doors (about local Z, `doorOpen` for the left door, its negative for the right) and the stores (one
// piece per bomb, in release order), plus the gear legs.
//
// Team accents change no geometry. The Hornet's are the upper part of both fins (faces split along y = ACCENT_FIN_Y,
// coplanar) and the wingtip rails (faces beyond |x| = ACCENT_RAIL_X); the F-35C's are its own F35_accent material (fin
// caps and wingtip strips). Either way they are tagged with the ACCENT material, whose colour plane-pass.ts takes from
// each jet's uniform. Everything else keeps the GLB's material colours, except the Hornet's PAINT overrides.

import f35Url from "../../art/f35.glb?url"
import hornetUrl from "../../art/hornet.glb?url"
import { VEHICLES, VEHICLE_KINDS, type VehicleKind } from "../../shared/vehicles"
import { type Glb, parseGlb } from "../dev/glb"
import { FLOATS_PER_VERT, MAT, Mesh, type Rgb } from "./mesh"

/** Material id of team-accent faces (plane-pass.ts colours them per jet). */
export const ACCENT = 3
/** Hornet fin faces above this height (model space) wear the team colour; the fins run from ~1.6 m to 4.71 m. */
export const ACCENT_FIN_Y = 3.85
/** Hornet wingtip rail faces beyond this |x| wear the team colour. */
export const ACCENT_RAIL_X = 6.6

type V3 = [number, number, number]

export type PlanePiece = { verts: number[]; pivot: V3 }

export type PlaneModel = {
  kind: VehicleKind
  body: number[]
  /** Canopy glass and frames (hidden in the cockpit view). */
  canopy: number[]
  stabL: PlanePiece
  stabR: PlanePiece
  /** The tailhook in its own frame: rotate about local X at `pivot` by `hookDown` (rad) when down. */
  hook: PlanePiece
  hookDown: number
  /** Weapons-bay doors in their own frames (hinge along local Z at `pivot`): the left opens by `doorOpen` about Z, the
   *  right by −doorOpen. Null for a jet without a bay. */
  doorL: PlanePiece | null
  doorR: PlanePiece | null
  doorOpen: number
  /** Bombs in release order (VEHICLES[kind].bombs), each in its own frame at `pivot`. */
  stores: PlanePiece[]
  gear: number[]
  /** Height of the jet's centre above the model origin (VEHICLES[kind].flight.centre). */
  centre: number
  /** Nozzle exit centres (model space) and their radius: one flame each. */
  nozzles: V3[]
  nozzleRadius: number
  /** Wingtips (model space): vapour trails and the red/green nav lights. */
  tips: V3[]
  /** Fin tips (model space), left fin first: the anti-collision strobes. */
  fins: V3[]
  /** Under the belly, clear of the bay (model space): the red beacon. */
  beacon: V3
  /** Pilot's eye (model space). */
  eye: V3
}

export type PlaneModels = Readonly<Record<VehicleKind, PlaneModel>>

/** Procedural gear: nose leg (twin wheels) and two main legs, in model space. */
export type GearSpec = { noseZ: number; noseR: number; mainZ: number; mainX: number; mainR: number; strutX: number }

/** How one GLB becomes a PlaneModel. */
type ModelSpec = {
  url: string
  /** Paint in place of file colours, by material name (sRGB). */
  paint: Record<string, Rgb>
  /** Materials that shine (canopy glass). */
  shiny: RegExp
  /** Team-accent faces: a material, or the Hornet's fin-top and rail rule. */
  accent: string | "hornet"
  gear: GearSpec
  /** Fixed anchors where the file has no usable marker (else computed from the mesh). */
  nozzles?: V3[]
  nozzleRadius: number
  tips: V3[]
  beacon: V3
  eye?: V3
  /** Tailhook down angle (rad about local X: negative swings the aft-pointing hook down). */
  hookDown: number
  doorOpen: number
  /** Store node names in release order. */
  stores: string[]
}

const DEG = Math.PI / 180
const srgb = (c: readonly number[]): Rgb => [c[0]! ** (1 / 2.2), c[1]! ** (1 / 2.2), c[2]! ** (1 / 2.2)]
const WHITE: Rgb = [1, 1, 1]

export const MODEL_SPECS: Readonly<Record<VehicleKind, ModelSpec>> = {
  hornet: {
    url: hornetUrl,
    // US Navy tactical paint in place of the GLB's lighter greys: FS 36320 dark ghost grey above, FS 36375 light ghost
    // grey below, darker radome, frames and anti-glare panel. Materials not listed keep their file colour.
    paint: {
      HORNET_grey: [0.37, 0.41, 0.46],
      HORNET_grey_low: [0.53, 0.56, 0.6],
      HORNET_radome: [0.46, 0.49, 0.52],
      HORNET_grey_dark: [0.27, 0.3, 0.34],
      HORNET_frame: [0.22, 0.24, 0.27],
      HORNET_antiglare: [0.15, 0.16, 0.18],
    },
    shiny: /gold/i,
    accent: "hornet",
    gear: { noseZ: 5.6, noseR: 0.3, mainZ: -1.2, mainX: 1.6, mainR: 0.43, strutX: 1.05 },
    nozzleRadius: 0.5,
    tips: [
      [7, 0.95, -2.9],
      [-7, 0.95, -2.9],
    ],
    beacon: [0, 0.15, -1.2],
    hookDown: -0.7,
    doorOpen: 0,
    stores: [],
  },
  f35: {
    url: f35Url,
    // The file's own stealth greys and RAM tones are the paint.
    paint: {},
    shiny: /glass/i,
    accent: "F35_accent",
    // Twin-wheel nose leg ahead of the bay, main legs outboard of it under the wing roots (F-35C track ~3.4 m).
    gear: { noseZ: 3.7, noseR: 0.27, mainZ: -2.35, mainX: 1.72, mainR: 0.4, strutX: 1.1 },
    nozzles: [[0, 1.18, -7.11]],
    nozzleRadius: 0.55,
    tips: [
      [6.55, 1.52, -3.0],
      [-6.55, 1.52, -3.0],
    ],
    beacon: [0, 0.05, -3.2],
    eye: [0, 2.15, 3.85],
    hookDown: -0.7,
    doorOpen: 95 * DEG,
    stores: ["F35_bomb_bay_L", "F35_bomb_bay_R", "F35_bomb_wing_L", "F35_bomb_wing_R"],
  },
}

function transform(m: Float64Array, x: number, y: number, z: number): V3 {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
}

const isFin = (a: V3, b: V3, c: V3) => Math.max(a[1], b[1], c[1]) > 3.2 && Math.min(a[2], b[2], c[2]) < -3

/** Splits triangle (a, b, c) along y = h into the pieces below and above (coplanar, same winding). */
function splitY(a: V3, b: V3, c: V3, h: number): { below: V3[][]; above: V3[][] } {
  const pts = [a, b, c]
  const below: V3[] = []
  const above: V3[] = []
  for (let i = 0; i < 3; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % 3]!
    ;(p[1] >= h ? above : below).push(p)
    if (p[1] >= h !== q[1] >= h) {
      const t = (h - p[1]) / (q[1] - p[1])
      const x: V3 = [p[0] + (q[0] - p[0]) * t, h, p[2] + (q[2] - p[2]) * t]
      below.push(x)
      above.push(x)
    }
  }
  const fan = (poly: V3[]) => (poly.length < 3 ? [] : poly.slice(1, -1).map((p, i) => [poly[0]!, p, poly[i + 2]!]))
  return { below: fan(below), above: fan(above) }
}

/** Adds a node's triangles to `mesh`, through `m` (null keeps the node-local frame). Faces whose winding disagrees
 *  with the file's normals are flipped so back-face culling holds. `accents` tags the spec's accent faces. */
function addNode(mesh: Mesh, node: Glb["nodes"][number], m: Float64Array | null, spec: ModelSpec, accents = false): void {
  for (const prim of node.prims) {
    const col = spec.paint[prim.material] ?? srgb(prim.color)
    const shiny = spec.shiny.test(prim.material) ? 1 : 0
    const tagged = accents && prim.material === spec.accent
    const P = prim.positions
    const N = prim.normals
    for (let i = 0; i + 9 <= P.length; i += 9) {
      const pt = (k: number): V3 => (m ? transform(m, P[i + k]!, P[i + k + 1]!, P[i + k + 2]!) : [P[i + k]!, P[i + k + 1]!, P[i + k + 2]!])
      const a = pt(0)
      let b = pt(3)
      let c = pt(6)
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!)
      if (len < 1e-12) continue
      n = [n[0]! / len, n[1]! / len, n[2]! / len]
      if (N) {
        const fx = N[i]! + N[i + 3]! + N[i + 6]!
        const fy = N[i + 1]! + N[i + 4]! + N[i + 7]!
        const fz = N[i + 2]! + N[i + 5]! + N[i + 8]!
        const wn = m ? [m[0]! * fx + m[4]! * fy + m[8]! * fz, m[1]! * fx + m[5]! * fy + m[9]! * fz, m[2]! * fx + m[6]! * fy + m[10]! * fz] : [fx, fy, fz]
        if (n[0]! * wn[0]! + n[1]! * wn[1]! + n[2]! * wn[2]! < 0) {
          ;[b, c] = [c, b]
          n = [-n[0]!, -n[1]!, -n[2]!]
        }
      }
      const put = (t: V3[], accent: boolean) => {
        for (const p of t) mesh.vert(p, n, accent ? WHITE : col, (accent ? ACCENT : MAT.lit) as 0, accent ? 0.3 : shiny)
      }
      if (tagged) put([a, b, c], true)
      else if (accents && spec.accent === "hornet" && Math.min(Math.abs(a[0]), Math.abs(b[0]), Math.abs(c[0])) > ACCENT_RAIL_X) put([a, b, c], true)
      else if (accents && spec.accent === "hornet" && isFin(a, b, c) && Math.max(a[1], b[1], c[1]) > ACCENT_FIN_Y) {
        const { below, above } = splitY(a, b, c, ACCENT_FIN_Y)
        for (const t of below) put(t, false)
        for (const t of above) put(t, true)
      } else put([a, b, c], false)
    }
  }
}

/** An n-sided prism along X (a wheel or an axle) centred at (x, y, z). */
function wheel(m: Mesh, x: number, y: number, z: number, r: number, w: number, col: Rgb, hub: Rgb): void {
  const n = 8
  const x0 = x - w / 2
  const x1 = x + w / 2
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const p = (a: number, xx: number) => [xx, y + Math.cos(a) * r, z + Math.sin(a) * r]
    m.quadAuto(p(a0, x0), p(a1, x0), p(a1, x1), p(a0, x1), col)
    m.facet([x1, y, z], p(a0, x1), p(a1, x1), hub)
    m.facet([x0, y, z], p(a1, x0), p(a0, x0), hub)
  }
}

/** Landing gear for a jet resting with its belly `height` above the ground: a nose leg with twin wheels and two main
 *  legs with single wheels, in model space (y = -height is the ground). Defaults: the Hornet's. */
export function buildGear(height: number, g: GearSpec = MODEL_SPECS.hornet.gear): number[] {
  const m = new Mesh()
  const strut: Rgb = [0.78, 0.8, 0.82]
  const tyre: Rgb = [0.09, 0.09, 0.1]
  const hub: Rgb = [0.6, 0.62, 0.64]
  const door: Rgb = [0.72, 0.75, 0.79]
  const y0 = -height
  // Nose leg under the cockpit.
  const nz = g.noseZ
  const nr = g.noseR
  m.box(-0.09, y0 + nr, nz - 0.09, 0.09, 0.45, nz + 0.09, strut)
  m.box(-0.05, y0 + nr * 0.8, nz - 0.6, 0.05, y0 + nr * 1.8, nz, strut)
  wheel(m, -0.2, y0 + nr, nz, nr, 0.17, tyre, hub)
  wheel(m, 0.2, y0 + nr, nz, nr, 0.17, tyre, hub)
  m.box(-0.02, -0.25, nz - 1.2, 0.02, 0.35, nz - 0.2, door)
  // Main legs: splayed out from the fuselage sides, wheels under the wing roots.
  const mz = g.mainZ
  const mr = g.mainR
  for (const side of [-1, 1]) {
    const wx = side * g.mainX
    m.box(wx - 0.1, y0 + mr, mz - 0.1, wx + 0.1, 0.55, mz + 0.1, strut)
    m.box(Math.min(wx, side * g.strutX) - 0.05, 0.1, mz - 0.45, Math.max(wx, side * g.strutX) + 0.05, 0.25, mz - 0.3, strut)
    wheel(m, wx + side * 0.15, y0 + mr, mz, mr, 0.26, tyre, hub)
    m.box(wx - side * 0.02 - 0.02, -0.4, mz - 0.9, wx - side * 0.02 + 0.02, 0.45, mz + 0.5, door)
  }
  return m.v
}

const pivotOf = (node: Glb["nodes"][number]): V3 => [node.world[12]!, node.world[13]!, node.world[14]!]

/** The highest body vertex on each side (|x| > 0.4 m) of the rear half: the fin tips, left (+X) first. */
function finTips(body: number[]): V3[] {
  const best: (V3 | null)[] = [null, null]
  for (let i = 0; i + 2 < body.length; i += FLOATS_PER_VERT) {
    const x = body[i]!
    const y = body[i + 1]!
    const z = body[i + 2]!
    if (z > 0 || Math.abs(x) < 0.4) continue
    const k = x > 0 ? 0 : 1
    if (!best[k] || y > best[k]![1]) best[k] = [x, y, z]
  }
  return best.filter((b): b is V3 => !!b)
}

export function buildPlaneModel(glb: Glb, kind: VehicleKind = "hornet"): PlaneModel {
  const spec = MODEL_SPECS[kind]
  const body = new Mesh()
  const glass = new Mesh()
  const stab = { L: new Mesh(), R: new Mesh() }
  const hook = new Mesh()
  const door = { L: new Mesh(), R: new Mesh() }
  let hookPivot: V3 = [0, 0.473, -6.35]
  const pivots: Record<"L" | "R", V3> = { L: [1.28, 1.069, -6.354], R: [-1.28, 1.069, -6.354] }
  const doorPivots: Record<"L" | "R", V3 | null> = { L: null, R: null }
  const stores: (PlanePiece | null)[] = spec.stores.map(() => null)
  let canopy = [0, 0, 0, 0, 0] // y max, z min, z max, z at y max, seen
  const nozzle = { L: [0, 0, 0, 0], R: [0, 0, 0, 0] }
  let nozzleZ = Infinity
  for (const node of glb.nodes) {
    const side = /stab_L/i.test(node.name) ? "L" : /stab_R/i.test(node.name) ? "R" : null
    if (side) {
      addNode(stab[side], node, null, spec)
      pivots[side] = pivotOf(node)
      continue
    }
    if (/tailhook/i.test(node.name)) {
      addNode(hook, node, null, spec)
      hookPivot = pivotOf(node)
      continue
    }
    const bay = /bay_door_L/i.test(node.name) ? "L" : /bay_door_R/i.test(node.name) ? "R" : null
    if (bay) {
      addNode(door[bay], node, null, spec)
      doorPivots[bay] = pivotOf(node)
      continue
    }
    const store = spec.stores.indexOf(node.name)
    if (store >= 0) {
      const m = new Mesh()
      addNode(m, node, null, spec)
      stores[store] = { verts: m.v, pivot: pivotOf(node) }
      continue
    }
    const isCanopy = /canopy/i.test(node.name)
    addNode(isCanopy ? glass : body, node, node.world, spec, !isCanopy)
    for (const prim of node.prims) {
      const P = prim.positions
      if (/canopy|gold/i.test(prim.material)) {
        for (let i = 0; i < P.length; i += 3) {
          const p = transform(node.world, P[i]!, P[i + 1]!, P[i + 2]!)
          if (!canopy[4]) canopy = [p[1], p[2], p[2], p[2], 1]
          if (p[1] > canopy[0]!) {
            canopy[0] = p[1]
            canopy[3] = p[2]
          }
          canopy[1] = Math.min(canopy[1]!, p[2])
          canopy[2] = Math.max(canopy[2]!, p[2])
        }
      }
      if (!spec.nozzles && /nozzle/i.test(prim.material))
        for (let i = 0; i < P.length; i += 3) {
          const p = transform(node.world, P[i]!, P[i + 1]!, P[i + 2]!)
          const acc = p[0] > 0 ? nozzle.L : nozzle.R
          acc[0]! += p[0]
          acc[1]! += p[1]
          acc[2]! += p[2]
          acc[3]!++
          nozzleZ = Math.min(nozzleZ, p[2])
        }
    }
  }
  const centre = (a: number[]): V3 => [a[0]! / a[3]!, a[1]! / a[3]!, nozzleZ]
  const nozzles = spec.nozzles ?? (nozzle.L[3] && nozzle.R[3] ? [centre(nozzle.L), centre(nozzle.R)] : ([[0.72, 1.21, -8.25], [-0.72, 1.21, -8.25]] as V3[]))
  // The eye sits at the canopy bow, a little high (a game view, not a seat), so the nose fills only the bottom of the view.
  const eye: V3 = spec.eye ?? (canopy[4] ? [0, canopy[0]! + 0.07, canopy[3]! + 0.6] : [0, 2.75, 3.6])
  const piece = (m: Mesh, pivot: V3 | null): PlanePiece | null => (pivot && m.v.length ? { verts: m.v, pivot } : null)
  const v = VEHICLES[kind]
  return {
    kind,
    body: body.v,
    canopy: glass.v,
    stabL: { verts: stab.L.v, pivot: pivots.L },
    stabR: { verts: stab.R.v, pivot: pivots.R },
    hook: { verts: hook.v, pivot: hookPivot },
    hookDown: spec.hookDown,
    doorL: piece(door.L, doorPivots.L),
    doorR: piece(door.R, doorPivots.R),
    doorOpen: spec.doorOpen,
    stores: stores.filter((s): s is PlanePiece => !!s),
    gear: buildGear(v.gear, spec.gear),
    centre: v.flight.centre,
    nozzles,
    nozzleRadius: spec.nozzleRadius,
    tips: spec.tips,
    fins: finTips(body.v),
    beacon: spec.beacon,
    eye,
  }
}

/** Loads and builds one jet model. */
export async function loadPlaneModel(kind: VehicleKind = "hornet"): Promise<PlaneModel> {
  const url = MODEL_SPECS[kind].url
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${kind} model: HTTP ${r.status}`)
  return buildPlaneModel(parseGlb(await r.arrayBuffer()), kind)
}

/** Every jet model, keyed by vehicle type. */
export async function loadPlaneModels(): Promise<PlaneModels> {
  const list = await Promise.all(VEHICLE_KINDS.map((k) => loadPlaneModel(k)))
  return Object.fromEntries(VEHICLE_KINDS.map((k, i) => [k, list[i]!])) as Record<VehicleKind, PlaneModel>
}
