// Dev ship viewer (ship.html): the procedural carrier from buildCarrier(), the Blender carrier (art/carrier.glb), the
// jets (art/hornet.glb, art/f35.glb, through the game's model registry src/render/plane-glb.ts) and the interceptor boat
// (art/boat.glb, src/render/boat-glb.ts) under the game's
// renderer, alone or side by side, with camera presets matching the concept sheets, reference overlays, and pinned
// feedback notes stored by scripts/feedback-plugin.ts (dev) or localStorage (production). Edits to any model reload the
// page; the view, toggles and an unsent note survive it.
// URL (one-shot, for scripted screenshots): ?model=procedural|blender|side|hornet|f35|boat&preset=HERO&env=sea|studio&deck=1
// &wiggle=1&weapons=0|1&ui=0. globalThis.shipViewer exposes the state.
import "@fontsource/ibm-plex-mono/300.css"
import "@fontsource/ibm-plex-mono/400.css"
import "./ship-viewer.css"
import { mat4 } from "wgpu-matrix"
import { ATMOSPHERE, ATMOSPHERE_WGSL, fillAtmosphere, type Atmosphere } from "../render/atmosphere"
import { FRAME, FRAME_BINDING_WGSL, FRAME_FLOATS, TIME_WRAP } from "../render/frame"
import { MESH_LAYOUT } from "../render/lit"
import { FLOATS_PER_VERT, MAT, Mesh, packVerts } from "../render/mesh"
import { ACCENT, type PlaneModel, type PlanePiece, buildPlaneModel } from "../render/plane-glb"
import { type BoatModel, buildBoatModel } from "../render/boat-glb"
import { buildShipWeapons } from "../render/ship-weapons"
import { DEFAULT_GRADE, type Grade } from "../render/post"
import { teamColor } from "../render/team"
import { VEHICLES, type VehicleKind } from "../../shared/vehicles"
import { Renderer, type ScenePass } from "../render/renderer"
import { fmtPoint, openFeedback, type CameraPose, type FeedbackStore, type Note, type NoteInput, type Vec3 } from "./feedback"
import { multiply, parseGlb, type Glb } from "./glb"

const DEG = Math.PI / 180
const FOV = 36 * DEG
const TAN = Math.tan(FOV / 2)
const MAX_DPR = 1.5
const SHOT_MAX_W = 1920
const RADAR_RPS = 0.25
const STAB_HZ = 0.5
const STAB_AMP = 15 * DEG
const DOOR_OPEN = 95 * DEG
const SETTINGS_KEY = "carrier.ship-viewer.v1"
const DRAFT_KEY = "carrier.ship-viewer.draft.v1"

// ---- the model (optional files: the viewer waits for them) ------------------------------------------------------------

type BuildMesh = { readonly v: ArrayLike<number> }
type ShipVehicle = { kind: string; mesh: BuildMesh; x: number; z: number; yaw: number }
type CarrierModel = { hull: BuildMesh; radar: BuildMesh; radarPivot: Vec3; vehicles: ShipVehicle[]; triangles: number }
type Rect = { x0: number; z0: number; x1: number; z1: number }
type Spec = { PARKING?: readonly { kind: string; x: number; z: number; yaw: number }[]; DECK_Y?: number; DECK_WIDTH?: number; LENGTH?: number; ISLAND?: Rect; RUNWAY?: Rect; APRON?: Rect; ELEVATOR?: Rect }

const carrierModule = import.meta.glob<{ buildCarrier?: () => unknown }>("../render/carrier-mesh.ts")
const spec: Spec = Object.values(import.meta.glob<Spec>("../../shared/carrier-spec.ts", { eager: true }))[0] ?? {}
const conceptUrls = import.meta.glob<string>(
  ["../../concept/carrier-*.png", "../../concept/hornet-v2-*.png", "../../concept/hornet-blender-overlay-*.png", "../../concept/f35-v4-*.png", "../../concept/f35-blender-overlay-*.png"],
  { eager: true, query: "?url", import: "default" },
)
const artUrls = import.meta.glob<string>("../../art/*.glb", { eager: true, query: "?url", import: "default" })
const carrierGlbUrl = artUrls["../../art/carrier.glb"] ?? null
const jetGlbUrls: Record<VehicleKind, string | null> = { hornet: artUrls["../../art/hornet.glb"] ?? null, f35: artUrls["../../art/f35.glb"] ?? null }
const boatGlbUrl = artUrls["../../art/boat.glb"] ?? null
const DECK_Y = spec.DECK_Y ?? 18

type ModelId = "procedural" | "blender" | VehicleKind | "boat"
type Mode = ModelId | "side"
type Subject = "carrier" | VehicleKind | "boat"
const MODELS: ModelId[] = ["procedural", "blender", "hornet", "f35", "boat"]
const JETS: VehicleKind[] = ["hornet", "f35"]
const isJet = (m: string): m is VehicleKind => (JETS as string[]).includes(m)
const CARRIERS = ["procedural", "blender"] as const
const MODES: Mode[] = ["procedural", "blender", "side", "hornet", "f35", "boat"]
const MODE_LABEL: Record<Mode, string> = { procedural: "PROCEDURAL", blender: "BLENDER", side: "SIDE BY SIDE", hornet: "HORNET", f35: "F-35C", boat: "BOAT" }
const subjectOf = (mode: Mode): Subject => (isJet(mode) || mode === "boat" ? mode : "carrier")
/** In a jet mode the jet flies (gear up) a little above the water plane, like its concepts. */
const JET_LIFT = 8
/** Side by side: parallel, same heading, this far apart between deck edges; procedural at −X (left of the screen from HERO), Blender at +X. */
const SIDE_GAP = 120
const SIDE_HALF = ((spec.DECK_WIDTH ?? 76) + SIDE_GAP) / 2
const modelsIn = (mode: Mode): ModelId[] => (mode === "side" ? [...CARRIERS] : [mode])
/** Where a model's own frame sits in the scene for a mode. */
const placement = (m: ModelId, mode: Mode): Vec3 => (isJet(m) ? [0, JET_LIFT, 0] : mode !== "side" ? [0, 0, 0] : m === "procedural" ? [-SIDE_HALF, 0, 0] : [SIDE_HALF, 0, 0])

/** The boundary where another agent's module enters: check the shape once, then everything downstream is typed. */
function decodeModel(raw: unknown): CarrierModel {
  const o = raw as Partial<Record<keyof CarrierModel, unknown>> | null
  const mesh = (m: unknown, what: string): BuildMesh => {
    const v = (m as { v?: unknown } | null)?.v as ArrayLike<number> | undefined
    if (!v || typeof v.length !== "number" || v.length % (FLOATS_PER_VERT * 3)) throw new Error(`${what} is not a Mesh`)
    return m as BuildMesh
  }
  if (!o || typeof o !== "object") throw new Error("buildCarrier() returned nothing")
  const pivot = o.radarPivot as number[] | undefined
  if (!Array.isArray(pivot) || pivot.length !== 3) throw new Error("radarPivot must be [x, y, z]")
  if (!Array.isArray(o.vehicles)) throw new Error("vehicles must be an array")
  return {
    hull: mesh(o.hull, "hull"),
    radar: mesh(o.radar, "radar"),
    radarPivot: [pivot[0]!, pivot[1]!, pivot[2]!],
    vehicles: (o.vehicles as ShipVehicle[]).map((v, i) => ({ kind: String(v.kind), mesh: mesh(v.mesh, `vehicle ${i}`), x: +v.x, z: +v.z, yaw: +v.yaw })),
    triangles: typeof o.triangles === "number" ? o.triangles : 0,
  }
}

/** Packed GPU data plus object-space triangle positions (9 floats each) for picking, split into named parts. */
type Geo = { data: ArrayBuffer; verts: number; tris: Float32Array; parts: { end: number; name: string }[] }

function trisOf(v: ArrayLike<number>): Float32Array {
  const n = v.length / FLOATS_PER_VERT
  const out = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    out[k * 3] = v[k * FLOATS_PER_VERT]!
    out[k * 3 + 1] = v[k * FLOATS_PER_VERT + 1]!
    out[k * 3 + 2] = v[k * FLOATS_PER_VERT + 2]!
  }
  return out
}

const geoOf = (v: ArrayLike<number>, name: string): Geo => {
  const tris = trisOf(v)
  return { data: packVerts(v), verts: v.length / FLOATS_PER_VERT, tris, parts: [{ end: tris.length / 9, name }] }
}

const vehiclePart = (kind: string) => (kind.startsWith("crew") ? `crew · ${kind.slice(5) || "deck"}` : kind)

/** Every vehicle in ship space in one buffer: local +Z turns toward (sin yaw, 0, cos yaw), ground at the deck. */
function vehiclesGeo(vs: ShipVehicle[]): Geo {
  const out: number[] = []
  const parts: { end: number; name: string }[] = []
  for (const veh of vs) {
    const c = Math.cos(veh.yaw)
    const s = Math.sin(veh.yaw)
    const v = veh.mesh.v
    for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
      const x = v[i]!
      const z = v[i + 2]!
      const nx = v[i + 3]!
      const nz = v[i + 5]!
      out.push(x * c + z * s + veh.x, v[i + 1]! + DECK_Y, -x * s + z * c + veh.z, nx * c + nz * s, v[i + 4]!, -nx * s + nz * c)
      for (let k = 6; k < FLOATS_PER_VERT; k++) out.push(v[i + k]!)
    }
    parts.push({ end: out.length / FLOATS_PER_VERT / 3, name: vehiclePart(veh.kind) })
  }
  const tris = trisOf(out)
  return { data: packVerts(out), verts: out.length / FLOATS_PER_VERT, tris, parts }
}

type Bounds = [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number]
const FALLBACK_BOUNDS: Bounds = [-42, -11, -166, 52, 72, 166]

function boundsOf(list: { tris: Float32Array; m: Float32Array }[]): Bounds {
  const b: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const { tris, m } of list)
    for (let i = 0; i < tris.length; i += 3) {
      const v = xform(m, [tris[i]!, tris[i + 1]!, tris[i + 2]!], 1)
      for (let a = 0; a < 3; a++) {
        if (v[a]! < b[a]!) b[a] = v[a]!
        if (v[a]! > b[a + 3]!) b[a + 3] = v[a]!
      }
    }
  return Number.isFinite(b[0]) ? b : FALLBACK_BOUNDS
}

const unionBounds = (a: Bounds, b: Bounds): Bounds => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])]
const shiftBounds = (b: Bounds, d: Vec3): Bounds => [b[0] + d[0], b[1] + d[1], b[2] + d[2], b[3] + d[0], b[4] + d[1], b[5] + d[2]]

/** How a piece moves about its own origin: the radar spins about +Y, a jet's stabilisers pitch about +X, its bay
 *  doors swing about ±Z. */
type Motion = "radar" | "stab" | "doorL" | "doorR" | null
/** A node of a model in its own frame, placed in model space by `base`. */
type PieceSrc = { name: string; geo: Geo; base: Float32Array; motion: Motion }

/** glTF base colours are linear; the lit shader linearises vertex colours with pow 2.2, so store them gamma-encoded. */
const vertexColor = (c: readonly number[]): [number, number, number] => [c[0]! ** (1 / 2.2), c[1]! ** (1 / 2.2), c[2]! ** (1 / 2.2)]

const MIRROR_X = Float64Array.from([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * A GLB as game meshes: de-indexed, flat-shaded with face normals, vertex colour = material base colour. Where the file
 * has normals, a face whose winding disagrees with them is flipped so back-face culling matches the game.
 * `mirrorX` reflects the model through x = 0: each node's geometry and normals are negated in x in its own frame with
 * the winding reversed (so nothing turns inside out), and its transform is conjugated by the reflection, so pivots
 * land on the mirrored side.
 */
function glbPieces(glb: Glb, opts: { mirrorX?: boolean; motion?: (name: string) => Motion } = {}): { pieces: PieceSrc[]; flipped: number } {
  let flipped = 0
  const sx = opts.mirrorX ? -1 : 1
  const pieces = glb.nodes.map((node): PieceSrc => {
    const m = new Mesh()
    for (const prim of node.prims) {
      const col = vertexColor(prim.color)
      const P = prim.positions
      const N = prim.normals
      for (let i = 0; i + 9 <= P.length; i += 9) {
        const a = [P[i]! * sx, P[i + 1]!, P[i + 2]!]
        let b = [P[i + 3]! * sx, P[i + 4]!, P[i + 5]!]
        let c = [P[i + 6]! * sx, P[i + 7]!, P[i + 8]!]
        if (sx < 0) [b, c] = [c, b]
        let f = cross([b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!])
        const len = Math.hypot(...f)
        if (len < 1e-12) continue
        if (N && dot(f, [(N[i]! + N[i + 3]! + N[i + 6]!) * sx, N[i + 1]! + N[i + 4]! + N[i + 7]!, N[i + 2]! + N[i + 5]! + N[i + 8]!]) < 0) {
          ;[b, c] = [c, b]
          f = [-f[0], -f[1], -f[2]]
          flipped++
        }
        const n = [f[0] / len, f[1] / len, f[2] / len]
        m.vert(a, n, col, MAT.lit)
        m.vert(b, n, col, MAT.lit)
        m.vert(c, n, col, MAT.lit)
      }
    }
    const world = opts.mirrorX ? multiply(multiply(MIRROR_X, node.world), MIRROR_X) : node.world
    return { name: node.name, geo: geoOf(m.v, node.name), base: Float32Array.from(world), motion: opts.motion?.(node.name) ?? null }
  })
  return { pieces, flipped }
}

async function fetchGlb(url: string): Promise<Glb> {
  const r = await fetch(url, { cache: "no-cache" })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return parseGlb(await r.arrayBuffer())
}

/**
 * A jet from the game's model registry (plane-glb.ts) as viewer pieces in model space: body, canopy, stabilisers,
 * tailhook, bay doors and stores at their pivots, plus the gear when `gear`. Team-accent faces wear team 0's colour.
 */
function jetPieces(m: PlaneModel, gear: boolean): PieceSrc[] {
  const accent = teamColor(0).map((c) => c ** (1 / 2.2))
  const paint = (v: number[]) => {
    const out = v.slice()
    for (let i = 0; i < out.length; i += FLOATS_PER_VERT)
      if (Math.round(out[i + 9]!) === ACCENT) {
        out[i + 6] = accent[0]!
        out[i + 7] = accent[1]!
        out[i + 8] = accent[2]!
        out[i + 9] = MAT.lit
      }
    return out
  }
  const at = (name: string, v: number[], base: Float32Array, motion: Motion = null): PieceSrc => ({ name, geo: geoOf(paint(v), name), base, motion })
  const piece = (name: string, pc: PlanePiece, motion: Motion = null) => at(name, pc.verts, mat4.translation(pc.pivot), motion)
  const out = [at("body", m.body, mat4.identity()), at("canopy", m.canopy, mat4.identity()), piece("stab_L", m.stabL, "stab"), piece("stab_R", m.stabR, "stab"), piece("tailhook", m.hook)]
  if (m.doorL) out.push(piece("bay_door_L", m.doorL, "doorL"))
  if (m.doorR) out.push(piece("bay_door_R", m.doorR, "doorR"))
  m.stores.forEach((st, i) => out.push(piece(`store_${i}`, st)))
  if (gear) out.push(at("gear", m.gear, mat4.identity()))
  return out
}

/** The boat (boat-glb.ts) as viewer pieces: body, the radar bar (spinning), turret, gun and waterjets at their pivots,
 *  its accent faces in team 0's colour. */
function boatPieces(m: BoatModel): PieceSrc[] {
  const accent = teamColor(0).map((c) => c ** (1 / 2.2))
  const paint = (v: number[]) => {
    const out = v.slice()
    for (let i = 0; i < out.length; i += FLOATS_PER_VERT)
      if (Math.round(out[i + 9]!) === ACCENT) {
        out[i + 6] = accent[0]!
        out[i + 7] = accent[1]!
        out[i + 8] = accent[2]!
        out[i + 9] = MAT.lit
      }
    return out
  }
  const turret = mat4.translation(m.turret.pivot)
  const at = (name: string, v: number[], base: Float32Array, motion: Motion = null): PieceSrc => ({ name, geo: geoOf(paint(v), name), base, motion })
  return [
    at("hull", m.body, mat4.identity()),
    at("radar", m.radar.verts, mat4.translation(m.radar.pivot), "radar"),
    at("turret", m.turret.verts, turret),
    at("gun", m.gun.verts, mat4.multiply(turret, mat4.translation(m.gun.pivot))),
    at("waterjet_L", m.jetL.verts, mat4.translation(m.jetL.pivot)),
    at("waterjet_R", m.jetR.verts, mat4.translation(m.jetR.pivot)),
  ]
}

// ---- picking ------------------------------------------------------------------------------------------------------------

type Hit = { t: number; point: Vec3; local: Vec3; normal: Vec3; model: ModelId; part: string }

/** Nearest triangle hit (both faces) along o + t d, t in (0, tMax). Möller–Trumbore over the whole soup. */
function rayTris(tris: Float32Array, o: Vec3, d: Vec3, tMax: number): { t: number; i: number } | null {
  let best = tMax
  let bi = -1
  const [ox, oy, oz] = o
  const [dx, dy, dz] = d
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i]!
    const ay = tris[i + 1]!
    const az = tris[i + 2]!
    const e1x = tris[i + 3]! - ax
    const e1y = tris[i + 4]! - ay
    const e1z = tris[i + 5]! - az
    const e2x = tris[i + 6]! - ax
    const e2y = tris[i + 7]! - ay
    const e2z = tris[i + 8]! - az
    const px = dy * e2z - dz * e2y
    const py = dz * e2x - dx * e2z
    const pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -1e-9 && det < 1e-9) continue
    const inv = 1 / det
    const sx = ox - ax
    const sy = oy - ay
    const sz = oz - az
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (t > 1e-4 && t < best) {
      best = t
      bi = i / 9
    }
  }
  return bi < 0 ? null : { t: best, i: bi }
}

function triNormal(tris: Float32Array, i: number): Vec3 {
  const o = i * 9
  const e1 = [tris[o + 3]! - tris[o]!, tris[o + 4]! - tris[o + 1]!, tris[o + 5]! - tris[o + 2]!]
  const e2 = [tris[o + 6]! - tris[o]!, tris[o + 7]! - tris[o + 1]!, tris[o + 8]! - tris[o + 2]!]
  const n: Vec3 = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
  const l = Math.hypot(...n) || 1
  return [n[0] / l, n[1] / l, n[2] / l]
}

const thirdOf = (z: number, b: Bounds) => {
  const len = b[5] - b[2]
  return z > b[2] + (len * 2) / 3 ? "fwd" : z < b[2] + len / 3 ? "aft" : "mid"
}

const inRect = (r: Rect | undefined, x: number, z: number, pad = 0) => !!r && x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad

/** Hull hits refined with the deck layout from carrier-spec.ts, so a note says where on the ship it is. */
function hullPart(p: Vec3, n: Vec3, b: Bounds, deckY: number, island = true): string {
  const [x, y, z] = p
  const third = thirdOf(z, b)
  if (island && y > deckY + 0.3 && inRect(spec.ISLAND, x, z, 1.5)) return "hull · island"
  if (Math.abs(y - deckY) < 0.8 && n[1] > 0.7) {
    if (inRect(spec.ELEVATOR, x, z)) return "hull · elevator"
    if (inRect(spec.RUNWAY, x, z)) return `hull · deck · runway · ${third}`
    if (inRect(spec.APRON, x, z)) return `hull · deck · apron · ${third}`
    return `hull · deck · ${third}`
  }
  if (y > deckY + 0.3) return `hull · above deck · ${third}`
  if (inRect(spec.ELEVATOR, x, z) && y > deckY - 3) return "hull · elevator"
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const face = ax >= ay && ax >= az ? (n[0] < 0 ? "starboard side" : "port side") : az >= ay ? (n[2] > 0 ? "bow face" : "stern face") : n[1] < 0 ? "underside" : "upward face"
  return `hull · ${face} · ${third}${y < 0 ? " · below waterline" : ""}`
}

// ---- camera -------------------------------------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const xform = (m: Float32Array, v: Vec3, w: number): Vec3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]! * w,
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]! * w,
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]! * w,
]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Orbit basis for yaw/pitch in degrees: `back` points from the target to the eye. Yaw 0 = off the bow, 90 = port (+X). */
function basis(yawDeg: number, pitchDeg: number): { back: Vec3; right: Vec3; up: Vec3 } {
  const y = yawDeg * DEG
  const p = pitchDeg * DEG
  const back: Vec3 = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)]
  const right: Vec3 = [Math.cos(y), 0, -Math.sin(y)]
  return { back, right, up: cross(right, [-back[0], -back[1], -back[2]]) }
}

/** Orbit camera that also handles straight-down views (the basis comes from yaw, never from a world up vector). */
class View {
  target: Vec3 = [0, 14, 0]
  yaw = 0
  pitch = 25
  dist = 700
  ortho = false
  preset: string | null = null
  w = 1
  h = 1
  eye: Vec3 = [0, 0, 0]
  fwd: Vec3 = [0, 0, -1]
  right: Vec3 = [1, 0, 0]
  up: Vec3 = [0, 1, 0]
  readonly vp = new Float32Array(16)
  readonly skyInv: Float32Array<ArrayBuffer> = new Float32Array(16)
  private view = new Float32Array(16)
  private proj = new Float32Array(16)

  get aspect(): number {
    return this.w / this.h
  }

  pose(): CameraPose {
    return { target: [...this.target], yaw: this.yaw, pitch: this.pitch, dist: this.dist, ortho: this.ortho, preset: this.preset }
  }

  set(p: CameraPose): void {
    this.target = [...p.target]
    this.yaw = p.yaw
    this.pitch = p.pitch
    this.dist = p.dist
    this.ortho = p.ortho
    this.preset = p.preset
  }

  compute(): void {
    const { back, right, up } = basis(this.yaw, this.pitch)
    this.eye = add(this.target, back, this.dist)
    this.fwd = [-back[0], -back[1], -back[2]]
    this.right = right
    this.up = up
    const e = this.eye
    const v = this.view
    v.set([right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0, -dot(right, e), -dot(up, e), -dot(back, e), 1])
    const hh = this.dist * TAN
    const hw = hh * this.aspect
    // Reversed Z either way: ortho gets near/far swapped (a slab well behind the eye to far beyond the target).
    if (this.ortho) mat4.ortho(-hw, hw, -hh, hh, this.dist + 30000, -30000, this.proj)
    else mat4.perspectiveReverseZ(FOV, this.aspect, 0.5, 60000, this.proj)
    mat4.multiply(this.proj, v, this.vp)
    const rot = new Float32Array(v)
    rot[12] = rot[13] = rot[14] = 0
    mat4.inverse(mat4.multiply(mat4.perspectiveReverseZ(FOV, this.aspect, 1, 60000), rot), this.skyInv)
  }

  /** Ray through a point in canvas CSS pixels. */
  ray(px: number, py: number): { o: Vec3; d: Vec3 } {
    const nx = (px / this.w) * 2 - 1
    const ny = 1 - (py / this.h) * 2
    if (this.ortho) {
      const hh = this.dist * TAN
      const o = add(add(add(this.eye, this.right, nx * hh * this.aspect), this.up, ny * hh), this.fwd, -20000)
      return { o, d: this.fwd }
    }
    return { o: this.eye, d: norm(add(add(this.fwd, this.right, nx * TAN * this.aspect), this.up, ny * TAN)) }
  }

  /** World point to canvas CSS pixels, or null behind the camera. */
  project(p: Vec3): { x: number; y: number } | null {
    const m = this.vp
    const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!
    if (w <= 1e-6) return null
    const x = (m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / w
    const y = (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / w
    return { x: (x * 0.5 + 0.5) * this.w, y: (0.5 - y * 0.5) * this.h }
  }
}

type Preset = { name: string; key?: string; yaw: number; pitch: number; ortho?: boolean; fill?: number; lift?: number }
type PresetSet = { main: Preset[]; yaw: Preset[]; pitch: Preset[] }

const yawRing = (pitch: number, fill: number): Preset[] => [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ name: `${a}°`, yaw: a, pitch, fill }))

/** Camera presets per subject: the carrier sheets (carrier-*.png) and the Hornet sheets (hornet-v2-*.png). */
const PRESET_SETS: Record<Subject, PresetSet> = {
  carrier: {
    main: [
      { name: "HERO", key: "1", yaw: -12, pitch: 27, fill: 1.1, lift: -6 },
      { name: "CHASE 35°", key: "2", yaw: -8, pitch: 35, fill: 1 },
      { name: "WATERLINE", key: "3", yaw: -9, pitch: 5, fill: 0.92 },
      { name: "TOP", key: "4", yaw: 270, pitch: 90, ortho: true, fill: 0.94 },
      { name: "PORT", key: "5", yaw: 90, pitch: 0, ortho: true, fill: 0.94 },
      { name: "STARBOARD", key: "6", yaw: 270, pitch: 0, ortho: true, fill: 0.94 },
      { name: "BOW", key: "7", yaw: 0, pitch: 0, ortho: true, fill: 0.9 },
      { name: "STERN", key: "8", yaw: 180, pitch: 0, ortho: true, fill: 0.9 },
    ],
    yaw: yawRing(25, 1),
    pitch: [
      { name: "LOW 15°", yaw: -8, pitch: 15, fill: 0.9 },
      { name: "HIGH 60°", yaw: -4, pitch: 60, fill: 0.9 },
      { name: "OVERHEAD", yaw: 0, pitch: 90, fill: 0.94 },
    ],
  },
  // Solved hero camera in art/f35-README.md: yaw 27°, 19° down.
  f35: {
    main: [
      { name: "HERO", key: "1", yaw: 27, pitch: 19, fill: 0.95 },
      { name: "TOP", key: "2", yaw: 180, pitch: 90, ortho: true, fill: 0.92 },
      { name: "SIDE", key: "3", yaw: 90, pitch: 0, ortho: true, fill: 0.92 },
      { name: "FRONT", key: "4", yaw: 0, pitch: 0, ortho: true, fill: 0.9 },
      { name: "REAR", key: "5", yaw: 180, pitch: 0, ortho: true, fill: 0.9 },
    ],
    yaw: yawRing(25, 0.9),
    pitch: [],
  },
  // Solved hero camera in art/boat-README.md: yaw 39°, 15° down. The boat sits on its waterline (y = 0).
  boat: {
    main: [
      { name: "HERO", key: "1", yaw: 39, pitch: 15, fill: 0.95 },
      { name: "TOP", key: "2", yaw: 180, pitch: 90, ortho: true, fill: 0.92 },
      { name: "SIDE", key: "3", yaw: 90, pitch: 0, ortho: true, fill: 0.92 },
      { name: "FRONT", key: "4", yaw: 0, pitch: 0, ortho: true, fill: 0.9 },
      { name: "REAR", key: "5", yaw: 180, pitch: 0, ortho: true, fill: 0.9 },
    ],
    yaw: yawRing(25, 0.9),
    pitch: [],
  },
  // Angles are the solved reference cameras in art/hornet-README.md (hero: yaw 20°, 16° down; nose up in TOP like the sheet).
  hornet: {
    main: [
      { name: "HERO", key: "1", yaw: 20, pitch: 16, fill: 0.95 },
      { name: "TOP", key: "2", yaw: 180, pitch: 90, ortho: true, fill: 0.92 },
      { name: "SIDE", key: "3", yaw: 90, pitch: 0, ortho: true, fill: 0.92 },
      { name: "FRONT", key: "4", yaw: 0, pitch: 0, ortho: true, fill: 0.9 },
      { name: "REAR", key: "5", yaw: 180, pitch: 0, ortho: true, fill: 0.9 },
    ],
    yaw: yawRing(25, 0.9),
    pitch: [],
  },
}
const allPresets = (s: Subject): Preset[] => [...PRESET_SETS[s].main, ...PRESET_SETS[s].yaw, ...PRESET_SETS[s].pitch]

/** A pose that frames the bounds for a preset's direction in the current aspect. */
function presetPose(p: Preset, b: Bounds, aspect: number): CameraPose {
  const { back, right, up } = basis(p.yaw, p.pitch)
  const c: Vec3 = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2 + (p.lift ?? 0), (b[2] + b[5]) / 2]
  const fill = p.fill ?? 0.9
  let dist = 1
  let hh = 1
  for (let i = 0; i < 8; i++) {
    const q: Vec3 = [(i & 1 ? b[3] : b[0]) - c[0], (i & 2 ? b[4] : b[1]) - c[1], (i & 4 ? b[5] : b[2]) - c[2]]
    const x = Math.abs(dot(q, right))
    const y = Math.abs(dot(q, up))
    const z = dot(q, back)
    hh = Math.max(hh, y / fill, x / (aspect * fill))
    dist = Math.max(dist, z + y / (TAN * fill), z + x / (TAN * aspect * fill))
  }
  return { target: c, yaw: p.yaw, pitch: p.pitch, dist: p.ortho ? hh / TAN : dist, ortho: !!p.ortho, preset: p.name }
}

// ---- references ---------------------------------------------------------------------------------------------------------

type Crop = [x0: number, y0: number, x1: number, y1: number]
/** `solved`: the camera the panel was really drawn from, when it differs from its label (hornet-README.md). */
type RefView = { label: string; preset: string | null; crop: Crop; solved?: { yaw: number; pitch: number } }
type Ref = { file: string; url: string; subject: Subject; views: RefView[] }

const cols = (n: number, y0: number, y1: number, labels: [string, string][]): RefView[] =>
  labels.map(([label, preset], i) => ({ label, preset, crop: [i / n + 0.002, y0, (i + 1) / n - 0.002, y1] }))

/** The Hornet yaw sheet's panels, at their solved cameras (135°, 225° and 315° are not drawn at their labels). */
const hornetYaw = (rows: [number, number][]): RefView[] => {
  const solved: [number, number][] = [[1, 22], [40, 29], [90, 32], [217, 23], [180, 19], [147, 21], [270, 30], [32, 29]]
  return [0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => {
    const [y0, y1] = rows[i >> 2]!
    const c = i % 4
    return { label: `${a}°`, preset: `${a}°`, crop: [c / 4 + 0.002, y0, (c + 1) / 4 - 0.002, y1] as Crop, solved: { yaw: solved[i]![0], pitch: solved[i]![1] } }
  })
}

/** Panels of the concept sheets, cropped so an overlay lines up with one camera preset. */
const REF_VIEWS: Record<string, RefView[]> = {
  "carrier-1-hero.png": [{ label: "HERO", preset: "HERO", crop: [0, 0, 1, 1] }],
  "carrier-2-turnaround.png": [
    { label: "TOP", preset: "TOP", crop: [0.02, 0.06, 0.99, 0.37] },
    { label: "PORT", preset: "PORT", crop: [0.02, 0.39, 0.8, 0.66] },
    { label: "STARBOARD", preset: "STARBOARD", crop: [0.01, 0.66, 0.66, 0.93] },
    { label: "BOW", preset: "BOW", crop: [0.66, 0.66, 0.83, 0.94] },
    { label: "STERN", preset: "STERN", crop: [0.82, 0.66, 0.99, 0.94] },
  ],
  "carrier-3-yaw-strip.png": [
    ...cols(4, 0.06, 0.41, [["0°", "0°"], ["45°", "45°"], ["90°", "90°"], ["135°", "135°"]]),
    ...cols(4, 0.48, 0.84, [["180°", "180°"], ["225°", "225°"], ["270°", "270°"], ["315°", "315°"]]),
  ],
  "carrier-4-pitch-strip.png": cols(5, 0, 0.935, [["WATERLINE", "WATERLINE"], ["LOW 15°", "LOW 15°"], ["CHASE 35°", "CHASE 35°"], ["HIGH 60°", "HIGH 60°"], ["OVERHEAD", "OVERHEAD"]]),
  "carrier-5-deck-plan.png": [{ label: "TOP", preset: "TOP", crop: [0, 0, 1, 1] }],
  "hornet-v2-1-hero.png": [{ label: "HERO", preset: "HERO", crop: [0, 0, 1, 1] }],
  "hornet-v2-2-turnaround.png": [
    { label: "TOP", preset: "TOP", crop: [0, 0.01, 0.47, 0.94] },
    { label: "SIDE", preset: "SIDE", crop: [0.41, 0.03, 1, 0.31] },
    { label: "FRONT", preset: "FRONT", crop: [0.46, 0.34, 0.96, 0.62] },
    { label: "REAR", preset: "REAR", crop: [0.45, 0.65, 0.97, 0.94] },
  ],
  "hornet-v2-3-yaw-strip.png": hornetYaw([[0.05, 0.42], [0.52, 0.88]]),
  "hornet-blender-overlay-hero.png": [{ label: "HERO", preset: "HERO", crop: [0, 0, 1, 1] }],
  "hornet-blender-overlay-yaw.png": hornetYaw([[0, 0.5], [0.5, 1]]),
  "f35-v4-1-hero.png": [{ label: "HERO", preset: "HERO", crop: [0, 0, 1, 1] }],
  "f35-blender-overlay-hero.png": [{ label: "HERO", preset: "HERO", crop: [0, 0, 1, 1] }],
}

const REFS: Ref[] = Object.entries(conceptUrls)
  .map(([path, url]) => {
    const file = path.slice(path.lastIndexOf("/") + 1)
    const subject: Subject = file.startsWith("hornet") ? "hornet" : file.startsWith("f35") ? "f35" : "carrier"
    return { file, url, subject, views: REF_VIEWS[file] ?? [{ label: "FULL", preset: null, crop: [0, 0, 1, 1] as Crop }] }
  })
  .sort((a, b) => a.file.localeCompare(b.file))

// ---- GPU passes ---------------------------------------------------------------------------------------------------------

const VIEW_DIR_WGSL = /* wgsl */ `
fn viewDir(world: vec3f) -> vec3f {
  if (F.extra.x > 0.5) { return -F.forward.xyz; }
  return normalize(F.eye.xyz - world);
}
`

/** The ship: lit like the static world (lit.ts) but with a model matrix per object, so the radar can turn. */
const SHIP_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${VIEW_DIR_WGSL}
struct Obj { model: mat4x4f, flags: vec4f }
@group(1) @binding(0) var<uniform> O: Obj;

struct VIn { @location(0) pos: vec3f, @location(1) normal: vec4f, @location(2) color: vec4f, @location(3) matAux: vec2f }
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) aux: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  let w = O.model * vec4f(v.pos, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.normal = (O.model * vec4f(v.normal.xyz, 0.0)).xyz;
  o.color = pow(v.color.rgb, vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  return o;
}

fn lightSurface(albedo: vec3f, n: vec3f, world: vec3f) -> vec3f {
  let sun = F.sunDir.xyz;
  let ndl = max(dot(n, sun), 0.0);
  let direct = F.sunColor.rgb * F.sunDir.w * ndl;
  let sky = mix(F.horizon.rgb, F.zenith.rgb, max(n.y, 0.0) * 0.6);
  let bounce = F.horizon.rgb * vec3f(0.22, 0.32, 0.4);
  let ambient = mix(bounce, sky, n.y * 0.5 + 0.5) * F.sunColor.w;
  let v = viewDir(world);
  let rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * smoothstep(-0.2, 0.6, dot(n, sun)) * 0.45;
  return albedo * (direct + ambient + F.sunColor.rgb * rim);
}

@fragment fn fs(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  if (!front && O.flags.x > 0.5) { return vec4f(3.0, 0.0, 2.4, 1.0); }
  var n = normalize(o.normal);
  n = select(-n, n, front);
  var c: vec3f;
  if (o.mat > 0.5 && o.mat < 1.5) { c = o.color * (2.0 + o.aux * 4.0); } else { c = lightSurface(o.color, n, o.world); }
  return vec4f(applyFog(c, o.world), 1.0);
}
`

const SLOT = 256
const SLOT_FLOATS = SLOT / 4

/** One vertex buffer drawn with its own model matrix. */
type DrawObj = { buf: GPUBuffer; verts: number; matrix: Float32Array; visible: boolean }

class ShipPass implements ScenePass {
  backfaces = false
  private objs: DrawObj[] = []
  private capacity = 0
  private uniform: GPUBuffer | null = null
  private group: GPUBindGroup | null = null
  private layout: GPUBindGroupLayout
  private culled: GPURenderPipeline
  private both: GPURenderPipeline
  private staging = new Float32Array(0)

  constructor(private r: Renderer) {
    const ctx = r.context
    const d = ctx.device
    this.layout = d.createBindGroupLayout({ label: "ship-obj", entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 } }] })
    const module = r.module(SHIP_WGSL, "ship-viewer")
    const pl = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, this.layout] })
    const make = (cullMode: GPUCullMode) =>
      d.createRenderPipeline({
        label: `ship-${cullMode}`,
        layout: pl,
        vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
        fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
        primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
        depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
        multisample: { count: ctx.samples },
      })
    this.culled = make("back")
    this.both = make("none")
  }

  add(geo: Geo, label: string): DrawObj {
    const d = this.r.context.device
    const buf = d.createBuffer({ label: `ship-${label}`, size: Math.max(4, geo.data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    if (geo.data.byteLength) d.queue.writeBuffer(buf, 0, geo.data)
    const obj: DrawObj = { buf, verts: geo.verts, matrix: mat4.identity(), visible: true }
    this.objs.push(obj)
    return obj
  }

  /** Uploads the model matrices; call before each render. */
  upload(): void {
    const d = this.r.context.device
    if (this.objs.length > this.capacity) {
      this.capacity = Math.max(8, this.objs.length * 2)
      this.uniform?.destroy()
      this.uniform = d.createBuffer({ label: "ship-obj", size: SLOT * this.capacity, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      this.group = d.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.uniform, size: 80 } }] })
      this.staging = new Float32Array(SLOT_FLOATS * this.capacity)
    }
    if (!this.uniform) return
    this.objs.forEach((o, i) => {
      this.staging.set(o.matrix, i * SLOT_FLOATS)
      this.staging[i * SLOT_FLOATS + 16] = this.backfaces ? 1 : 0
    })
    d.queue.writeBuffer(this.uniform, 0, this.staging, 0, this.objs.length * SLOT_FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.group) return
    pass.setPipeline(this.backfaces ? this.both : this.culled)
    this.objs.forEach((o, i) => {
      if (!o.visible || !o.verts) return
      pass.setBindGroup(1, this.group!, [i * SLOT])
      pass.setVertexBuffer(0, o.buf)
      pass.draw(o.verts)
    })
  }
}

/** Sky for the SEA backdrop: a full-screen triangle at the far plane, shaded with the shared skyColor. */
class SkyPass implements ScenePass {
  enabled = false
  private pipe: GPURenderPipeline
  private buf: GPUBuffer
  private group: GPUBindGroup

  constructor(private r: Renderer) {
    const ctx = r.context
    const d = ctx.device
    const module = r.module(
      /* wgsl */ `${FRAME_BINDING_WGSL}${ATMOSPHERE_WGSL}
@group(1) @binding(0) var<uniform> S: mat4x4f;
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let h = S * vec4f(o.ndc, 0.5, 1.0);
  return vec4f(skyColor(normalize(h.xyz / h.w)), 1.0);
}`,
      "ship-viewer-sky",
    )
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    this.buf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.buf } }] })
    this.pipe = d.createRenderPipeline({
      label: "ship-viewer-sky",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: ctx.samples },
    })
  }

  upload(inv: Float32Array<ArrayBuffer>): void {
    this.r.context.device.queue.writeBuffer(this.buf, 0, inv)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.enabled) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.draw(3)
  }
}

/**
 * Simple turquoise water at y = 0, like the plinths of carrier-3-yaw-strip.png. HOOK: once src/render/ocean.ts exists,
 * build its ScenePass here instead (see `makeWater` below) and keep the `enabled` gate.
 */
function simpleWater(r: Renderer): ScenePass {
  const ctx = r.context
  const d = ctx.device
  const module = r.module(
    /* wgsl */ `${FRAME_BINDING_WGSL}${ATMOSPHERE_WGSL}${VIEW_DIR_WGSL}
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var corners = array(vec2f(-1, -1), vec2f(1, 1), vec2f(1, -1), vec2f(-1, -1), vec2f(-1, 1), vec2f(1, 1));
  let c = corners[i];
  let p = vec3f(F.eye.x + c.x * 30000.0, 0.0, F.eye.z + c.y * 30000.0);
  var o: VO;
  o.pos = F.viewProj * vec4f(p, 1.0);
  o.world = p;
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let t = F.eye.w;
  let p = o.world.xz;
  let g = vec2f(cos(p.x * 0.11 + p.y * 0.05 - t * 1.2), cos(p.y * 0.09 - p.x * 0.04 - t * 1.0)) * 0.05
        + vec2f(cos(p.x * 0.37 - p.y * 0.21 + t * 2.4), cos(p.y * 0.41 + p.x * 0.17 - t * 2.2)) * 0.025;
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  let v = viewDir(o.world);
  let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  let body = vec3f(0.012, 0.2, 0.25) * (F.sunColor.w + F.sunDir.w * max(F.sunDir.y, 0.0) * 0.45);
  let r = reflect(-v, n);
  let spec = pow(max(dot(r, F.sunDir.xyz), 0.0), 1200.0) * F.sunDir.w * 4.0;
  let c = mix(body, skyColor(r), fres * 0.8) + F.sunColor.rgb * spec;
  return vec4f(applyFog(c, o.world), 1.0);
}`,
    "ship-viewer-water",
  )
  const pipe = d.createRenderPipeline({
    label: "ship-viewer-water",
    layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
    multisample: { count: ctx.samples },
  })
  return {
    draw(pass) {
      pass.setPipeline(pipe)
      pass.draw(6)
    },
  }
}

/** The sea surface for the SEA backdrop. Swap point for the real ocean pass. */
const makeWater: (r: Renderer) => ScenePass = simpleWater

const gated = (inner: ScenePass) => ({
  enabled: false,
  draw(pass: GPURenderPassEncoder) {
    if (this.enabled) inner.draw(pass)
  },
  prepare(enc: GPUCommandEncoder) {
    if (this.enabled) inner.prepare?.(enc)
  },
})

const STUDIO_GREY: [number, number, number] = [0.6, 0.61, 0.64]
/** Even grey cyclorama with a high key light off the port bow (+X), so every preset reads. */
const STUDIO: Atmosphere = {
  sunDir: norm([0.45, 0.78, 0.43]),
  sunIntensity: 2.4,
  sunColor: [1, 0.97, 0.93],
  ambient: 0.85,
  zenith: STUDIO_GREY,
  horizon: STUDIO_GREY,
  fog: 0,
}
const GRADES: Record<Env, Grade> = {
  studio: { ...DEFAULT_GRADE, vignette: 0.06, grain: 0, warmth: 0.15 },
  sea: { ...DEFAULT_GRADE, grain: 0 },
}

// ---- state --------------------------------------------------------------------------------------------------------------

type Env = "studio" | "sea"
type RefMode = "side" | "over"
type Settings = {
  pose: CameraPose | null
  env: Env
  vehicles: boolean
  spin: boolean
  backfaces: boolean
  showDone: boolean
  ref: { file: string; view: number } | null
  refMode: RefMode
  refOpacity: number
  collapsed: Record<string, boolean>
  ui: boolean
  model: Mode
  deckHornet: boolean
  wiggle: boolean
  /** The procedural carrier's weapons (render/ship-weapons.ts), at their rest pose. */
  weapons: boolean
}
/** `point` is ship-local; `model` says which carrier it is on. */
type Draft = { text: string; point: Vec3 | null; normal: Vec3 | null; part: string | null; model?: ModelId }

const DEFAULTS: Settings = { model: "side", deckHornet: false, wiggle: false, weapons: true, pose: null, env: "studio", vehicles: true, spin: true, backfaces: false, showDone: false, ref: null, refMode: "side", refOpacity: 0.5, collapsed: {}, ui: true }

function loadJson<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null
  } catch {
    return null
  }
}

function saveJson(key: string, v: unknown): void {
  try {
    if (v === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(v))
  } catch {
    // Storage full or disabled: the viewer still works, it just forgets on reload.
  }
}

// ---- page ---------------------------------------------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

const UI_HTML = /* html */ `
<div class="panel" id="title"><div class="brand">CARRIER · SHIP</div><div class="stats" id="stats"></div></div>
<div class="panel" id="controls">
  <h2 data-collapse="controls"><span>VIEW</span><span class="caret"></span></h2>
  <div class="body">
    <div class="label">MODEL <kbd>M</kbd></div>
    <div class="grid g2"><button data-act="procedural">PROCEDURAL</button><button data-act="blender">BLENDER</button><button data-act="side">SIDE BY SIDE</button><button data-act="hornet">HORNET</button><button data-act="f35">F-35C</button><button data-act="boat">BOAT</button></div>
    <div class="label">CAMERA</div><div class="grid g2" id="p-main"></div>
    <div class="label">YAW · 25° DOWN <kbd>9</kbd></div><div class="grid g4" id="p-yaw"></div>
    <div class="label" id="l-pitch">PITCH</div><div class="grid g3" id="p-pitch"></div>
    <div class="label">PROJECTION</div>
    <div class="grid g2"><button data-act="persp">PERSP</button><button data-act="ortho">ORTHO<kbd>O</kbd></button></div>
    <div class="label">SCENE</div>
    <div class="grid g2">
      <button data-act="studio">STUDIO<kbd>E</kbd></button><button data-act="sea">SEA</button>
      <button data-act="vehicles" data-subject="carrier">VEHICLES<kbd>V</kbd></button><button data-act="spin" data-subject="carrier">RADAR<kbd>R</kbd></button>
      <button data-act="deckHornet" data-subject="carrier" class="wide">JETS ON DECK<kbd>J</kbd></button>
      <button data-act="weapons" data-subject="carrier" class="wide">WEAPONS<kbd>G</kbd></button>
      <button data-act="wiggle" class="wide">WIGGLE STABS<kbd>W</kbd></button>
      <button data-act="backfaces">BACKFACES<kbd>B</kbd></button><button data-act="hide">HIDE UI<kbd>H</kbd></button>
    </div>
  </div>
</div>
<div class="panel" id="feedback">
  <h2 data-collapse="feedback"><span>FEEDBACK <span id="fb-count"></span></span><span class="caret"></span></h2>
  <div class="body">
    <div class="actions"><button data-act="note">NOTE<kbd>N</kbd></button><button data-act="done">DONE</button><button data-act="copy">COPY ALL</button></div>
    <div id="notes"></div>
    <div class="store" id="store"></div>
  </div>
</div>
<div class="panel" id="refs"><div class="thumbs"></div><div class="ref-ctl"></div></div>
<div class="panel" id="notice"></div>
<div class="panel" id="editor">
  <div class="head"></div>
  <textarea rows="3" spellcheck="false"></textarea>
  <div class="foot"><span><kbd>↵</kbd> SAVE · <kbd>ESC</kbd></span><span class="err"></span></div>
</div>
<div class="panel" id="toast"></div>
`

async function main() {
  const canvas = $<HTMLCanvasElement>("#view")
  const ui = $("#ui")
  const pinsEl = $("#pins")
  const refView = $("#ref-view")
  const refCrop = $(".crop", refView)
  ui.innerHTML = UI_HTML
  const notice = $("#notice")
  const showNotice = (big: string, small = "") => {
    notice.innerHTML = `<div class="big">${esc(big)}</div>${small ? `<div class="small">${esc(small)}</div>` : ""}`
    notice.classList.add("show")
  }
  const hideNotice = () => notice.classList.remove("show")

  if (!navigator.gpu) return showNotice("NO WEBGPU", "use a recent chrome, edge or safari over https or localhost")
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return showNotice("NO WEBGPU ADAPTER")
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  void device.lost.then((info) => {
    console.error(`[gpu lost] ${info.reason} ${info.message}`)
    showNotice("GPU DEVICE LOST", "reload the page")
  })
  const context = canvas.getContext("webgpu")
  if (!context) return showNotice("WEBGPU COULD NOT START")
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)

  const params = new URLSearchParams(location.search)
  const settings: Settings = { ...DEFAULTS, ...loadJson<Partial<Settings>>(SETTINGS_KEY) }
  if (params.get("env") === "sea" || params.get("env") === "studio") settings.env = params.get("env") as Env
  if (params.get("ui") === "0") settings.ui = false

  const view = new View()
  const ship = new ShipPass(renderer)
  const sky = new SkyPass(renderer)
  const water = gated(makeWater(renderer))
  renderer.addPass("sky", sky)
  renderer.addPass("opaque", ship)
  renderer.addPass("opaque", water)
  const frame = new Float32Array(FRAME_FLOATS)

  // ---- models ----
  /** `group` gates visibility: procedural vehicles (VEHICLES), the jets parked on deck and the procedural jets they
   *  replace. */
  type Group = "main" | "vehicles" | "spotJet" | "deckHornet" | "weapons"
  type Piece = PieceSrc & { obj: DrawObj; group: Group; namer: (tri: number, p: Vec3, n: Vec3) => string }
  type PieceIn = PieceSrc & { group?: Group; namer: Piece["namer"] }
  type Variant = { pieces: Piece[]; bounds: Bounds; deckY: number; buildMs: number; status: [big: string, small: string] | null }
  const variants: Record<ModelId, Variant> = {
    procedural: { pieces: [], bounds: FALLBACK_BOUNDS, deckY: DECK_Y, buildMs: 0, status: ["WAITING FOR SHIP MODEL", "src/render/carrier-mesh.ts"] },
    blender: { pieces: [], bounds: FALLBACK_BOUNDS, deckY: DECK_Y, buildMs: 0, status: ["WAITING FOR BLENDER MODEL", "art/carrier.glb"] },
    hornet: { pieces: [], bounds: [-7, 0, -9, 7, 5, 9], deckY: 0, buildMs: 0, status: ["WAITING FOR HORNET MODEL", "art/hornet.glb"] },
    f35: { pieces: [], bounds: [-6.6, 0, -7.8, 6.6, 3.6, 7.9], deckY: 0, buildMs: 0, status: ["WAITING FOR F-35C MODEL", "art/f35.glb"] },
    boat: { pieces: [], bounds: [-2.8, -0.6, -9, 2.8, 4.9, 9], deckY: 0, buildMs: 0, status: ["WAITING FOR BOAT MODEL", "art/boat.glb"] },
  }
  let radarAngle = 0
  let stabAngle = 0
  let doorAngle = 0
  let ready = false

  const toPiece = (id: ModelId, src: PieceIn): Piece => ({ ...src, group: src.group ?? "main", obj: ship.add(src.geo, `${id}-${src.name}`) })

  function install(id: ModelId, srcs: PieceIn[], ms: number): void {
    const v = variants[id]
    v.pieces = srcs.map((src) => toPiece(id, src))
    v.bounds = boundsOf(v.pieces.map((p) => ({ tris: p.geo.tris, m: p.base })))
    v.buildMs = ms
    v.status = null
  }

  /** The jet parking spots in carrier-spec.ts where JETS ON DECK parks the Hornet (first) and the F-35C (second). */
  const jetSpots = spec.PARKING?.filter((p) => p.kind === "jet") ?? []
  const deckSpots: Record<VehicleKind, { x: number; z: number; yaw: number }> = {
    hornet: jetSpots[0] ?? { x: -25, z: 36, yaw: 0.55 },
    f35: jetSpots[1] ?? { x: -25.6, z: 92, yaw: 0.55 },
  }

  async function loadProcedural(): Promise<void> {
    const v = variants.procedural
    const loader = carrierModule["../render/carrier-mesh.ts"]
    if (!loader) return
    let mod: { buildCarrier?: () => unknown }
    try {
      mod = await loader()
    } catch (e) {
      v.status = ["SHIP MODEL FAILED TO LOAD", e instanceof Error ? e.message : String(e)]
      if (import.meta.env.DEV) retryImport()
      return
    }
    if (typeof mod.buildCarrier !== "function") {
      v.status = ["WAITING FOR SHIP MODEL", "carrier-mesh.ts has no buildCarrier()"]
      return
    }
    let model: CarrierModel
    const t0 = performance.now()
    try {
      model = decodeModel(mod.buildCarrier())
    } catch (e) {
      console.error(e)
      v.status = ["SHIP MODEL ERROR", e instanceof Error ? e.message : String(e)]
      return
    }
    const ms = performance.now() - t0
    // The procedural jets on the parked jets' spots are their own piece, hidden while the real jets are parked there.
    const near = (veh: ShipVehicle) => veh.kind === "jet" && JETS.some((k) => Math.hypot(veh.x - deckSpots[k].x, veh.z - deckSpots[k].z) < 2)
    const spot = vehiclesGeo(model.vehicles.filter(near))
    const rest = vehiclesGeo(model.vehicles.filter((veh) => !near(veh)))
    const vehName = (g: Geo) => (i: number) => g.parts.find((p) => i < p.end)?.name ?? "vehicle"
    install(
      "procedural",
      [
        { name: "hull", geo: geoOf(model.hull.v, "hull"), base: mat4.identity(), motion: null, namer: (_i, p, n) => hullPart(p, n, v.bounds, DECK_Y) },
        { name: "radar", geo: geoOf(model.radar.v, "radar"), base: mat4.translation(model.radarPivot), motion: "radar", namer: () => "radar" },
        { name: "vehicles", geo: rest, base: mat4.identity(), motion: null, group: "vehicles", namer: vehName(rest) },
        { name: "spot-jet", geo: spot, base: mat4.identity(), motion: null, group: "spotJet", namer: vehName(spot) },
        ...weaponPieces(),
      ],
      ms,
    )
    v.deckY = DECK_Y
  }

  /** Each weapon as mount, turret and barrel pieces at its rest pose (turret about +Y at the yaw pivot, barrel about
   *  +X at the pitch pivot, as the game will aim them). */
  function weaponPieces(): PieceIn[] {
    return buildShipWeapons().flatMap((w) => {
      const label = `weapon · ${w.kind} · ${w.side}`
      const turret = mat4.multiply(mat4.translation(w.yawPivot), mat4.rotationY(w.restYaw))
      const barrel = mat4.multiply(mat4.multiply(turret, mat4.translation(w.pitchPivot)), mat4.rotationX(-w.restPitch))
      const piece = (part: string, v: number[], base: Float32Array): PieceIn => ({ name: `${w.kind}-${w.index}-${part}`, geo: geoOf(v, part), base, motion: null, group: "weapons", namer: () => `${label} · ${part}` })
      return [piece("mount", w.mount.v, mat4.identity()), piece("turret", w.turret.v, turret), piece("barrel", w.barrel.v, barrel)]
    })
  }

  /** The Blender carrier, re-fetched on every page load (an edit to the .glb reloads the page through the ?url import). */
  async function loadBlender(): Promise<void> {
    const v = variants.blender
    if (!carrierGlbUrl) return
    try {
      const t0 = performance.now()
      // The GLB was modelled with the island on +X; the engine's starboard is −X (carrier-spec.ts), so mirror it.
      const { pieces, flipped } = glbPieces(await fetchGlb(carrierGlbUrl), { mirrorX: true, motion: (n) => (/radar/i.test(n) ? "radar" : null) })
      if (flipped) console.warn(`[blender] ${flipped} faces wound against their normals were flipped`)
      const hull = pieces.find((p) => p.name.toLowerCase() === "hull")
      const deckY = hull ? boundsOf([{ tris: hull.geo.tris, m: hull.base }])[4] : DECK_Y
      const namer = (name: string): Piece["namer"] => {
        const key = name.toLowerCase()
        if (key === "hull") return (_i, p, n) => hullPart(p, n, v.bounds, deckY, false)
        if (key === "markings")
          return (_i, p) => `markings · ${inRect(spec.RUNWAY, p[0], p[2]) ? "runway" : inRect(spec.APRON, p[0], p[2]) ? "apron" : "deck"} · ${thirdOf(p[2], v.bounds)}`
        return () => name
      }
      install("blender", pieces.map((p) => ({ ...p, namer: namer(p.name) })), performance.now() - t0)
      v.deckY = deckY
    } catch (e) {
      console.error(e)
      v.status = ["BLENDER MODEL ERROR", e instanceof Error ? e.message : String(e)]
    }
  }

  /**
   * A jet through the game's registry (plane-glb.ts), as the game draws it: glTF's +X = pilot's left is the same
   * handedness as this renderer (seen from ahead of the nose, +X is on screen right), so it is never mirrored. Also
   * parked on its gear on each carrier's deck spot for JETS ON DECK.
   */
  async function loadJet(kind: VehicleKind): Promise<void> {
    const v = variants[kind]
    const url = jetGlbUrls[kind]
    if (!url) return
    try {
      const t0 = performance.now()
      const model = buildPlaneModel(await fetchGlb(url), kind)
      install(kind, jetPieces(model, false).map((p) => ({ ...p, namer: () => p.name })), performance.now() - t0)
      const spot = deckSpots[kind]
      for (const id of CARRIERS) {
        const c = variants[id]
        if (c.status) continue
        const park = mat4.multiply(mat4.translation([spot.x, c.deckY + VEHICLES[kind].gear, spot.z]), mat4.rotationY(spot.yaw))
        for (const p of jetPieces(model, true)) c.pieces.push(toPiece(id, { ...p, base: mat4.multiply(park, p.base), group: "deckHornet", namer: () => `${kind} · ${p.name}` }))
      }
    } catch (e) {
      console.error(e)
      v.status = [`${MODE_LABEL[kind]} MODEL ERROR`, e instanceof Error ? e.message : String(e)]
    }
  }

  /** The interceptor boat through the game's loader (boat-glb.ts), as the game draws it, its parts at their pivots. */
  async function loadBoat(): Promise<void> {
    const v = variants.boat
    if (!boatGlbUrl) return
    try {
      const t0 = performance.now()
      install("boat", boatPieces(buildBoatModel(await fetchGlb(boatGlbUrl))).map((p) => ({ ...p, namer: () => `boat · ${p.name}` })), performance.now() - t0)
    } catch (e) {
      console.error(e)
      v.status = ["BOAT MODEL ERROR", e instanceof Error ? e.message : String(e)]
    }
  }

  function updateNotice(): void {
    const bad = modelsIn(settings.model).map((m) => variants[m].status).find((s) => s)
    if (bad) showNotice(bad[0], bad[1])
    else hideNotice()
  }

  /** Bounds of what is on screen, so presets frame one carrier, both, or the jet. */
  function sceneBounds(): Bounds {
    return modelsIn(settings.model)
      .map((m) => shiftBounds(variants[m].bounds, placement(m, settings.model)))
      .reduce(unionBounds)
  }

  /** The model a note's point belongs to, from the first word of its part. */
  const noteModel = (part: string | null): ModelId => {
    const first = part?.split(" ")[0]
    return first === "blender" || first === "boat" || (first !== undefined && isJet(first)) ? (first as ModelId) : "procedural"
  }
  const isShown = (m: ModelId) => modelsIn(settings.model).includes(m)
  const subject = () => subjectOf(settings.model)
  /** Notes keep model-local points; this is where the point is in the scene for the current mode. */
  const toWorld = (p: Vec3, m: ModelId): Vec3 => add(p, placement(m, settings.model))
  const pieceVisible = (p: Piece) =>
    p.group === "main" || (p.group === "weapons" && settings.weapons) || (p.group === "vehicles" && settings.vehicles) || (p.group === "spotJet" && settings.vehicles && !settings.deckHornet) || (p.group === "deckHornet" && settings.deckHornet)

  /** A failed import (say, a missing dependency) is not in Vite's graph, so poll a fresh copy and reload once it works. */
  function retryImport(): void {
    const url = "/src/render/carrier-mesh.ts"
    setTimeout(() => {
      import(/* @vite-ignore */ `${url}?retry=${Date.now()}`).then(
        () => location.reload(),
        () => retryImport(),
      )
    }, 2500)
  }

  // ---- layout: full window, or beside / under a reference ----
  let canvasRect = { x: 0, y: 0, w: innerWidth, h: innerHeight }
  let layoutKey = ""
  const activeRef = (): { ref: Ref; view: RefView; index: number } | null => {
    if (!settings.ref) return null
    const ref = REFS.find((r) => r.file === settings.ref!.file)
    const v = ref?.views[settings.ref.view]
    return ref && v ? { ref, view: v, index: settings.ref.view } : null
  }
  const imgSize = new Map<string, [number, number]>()
  const sizeOf = (r: Ref): [number, number] => {
    const s = imgSize.get(r.file)
    if (s) return s
    const img = new Image()
    img.onload = () => {
      imgSize.set(r.file, [img.naturalWidth, img.naturalHeight])
      layoutKey = ""
    }
    img.src = r.url
    return [1536, 1024]
  }

  function layout(): void {
    const W = innerWidth
    const H = innerHeight
    const a = activeRef()
    const [iw, ih] = a ? sizeOf(a.ref) : [1, 1]
    const key = `${W}x${H}:${a?.ref.file}:${a?.index}:${settings.refMode}:${iw}`
    if (key === layoutKey) return
    layoutKey = key
    let refRect = { x: 0, y: 0, w: 0, h: 0 }
    if (!a) canvasRect = { x: 0, y: 0, w: W, h: H }
    else {
      const [x0, y0, x1, y1] = a.view.crop
      const cw = (x1 - x0) * iw
      const ch = (y1 - y0) * ih
      if (settings.refMode === "side") {
        canvasRect = { x: 0, y: 0, w: Math.floor(W / 2), h: H }
        refRect = { x: Math.floor(W / 2), y: 0, w: W - Math.floor(W / 2), h: H }
      } else {
        const s = Math.min(W / cw, H / ch)
        refRect = { x: Math.round((W - cw * s) / 2), y: Math.round((H - ch * s) / 2), w: Math.round(cw * s), h: Math.round(ch * s) }
        canvasRect = { ...refRect }
      }
      // Fit the crop inside the reference rect (contain) by sizing and offsetting the whole sheet as a background.
      const s = Math.min(refRect.w / cw, refRect.h / ch)
      Object.assign(refCrop.style, {
        left: `${(refRect.w - cw * s) / 2}px`,
        top: `${(refRect.h - ch * s) / 2}px`,
        width: `${cw * s}px`,
        height: `${ch * s}px`,
        backgroundImage: `url("${a.ref.url}")`,
        backgroundSize: `${iw * s}px ${ih * s}px`,
        backgroundPosition: `${-x0 * iw * s}px ${-y0 * ih * s}px`,
      })
    }
    const place = (el: HTMLElement, r: { x: number; y: number; w: number; h: number }) =>
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    place(canvas, canvasRect)
    place(pinsEl, canvasRect)
    place(refView, refRect)
    refView.style.opacity = a && settings.refMode === "over" ? String(settings.refOpacity) : "1"
    document.body.classList.toggle("ref-side", !!a && settings.refMode === "side")
    document.body.classList.toggle("ref-over", !!a && settings.refMode === "over")
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(canvasRect.w * dpr))
    canvas.height = Math.max(1, Math.floor(canvasRect.h * dpr))
    renderer.resize(canvas.width, canvas.height)
    view.w = Math.max(1, canvasRect.w)
    view.h = Math.max(1, canvasRect.h)
  }

  // ---- camera control ----
  let tween: { from: CameraPose; to: CameraPose; t0: number; dur: number } | null = null
  const goTo = (to: CameraPose, dur = 450) => {
    view.ortho = to.ortho
    view.preset = to.preset
    tween = { from: view.pose(), to, t0: performance.now(), dur }
  }
  const stepTween = (now: number) => {
    if (!tween) return
    const k = Math.min(1, (now - tween.t0) / tween.dur)
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
    const { from: a, to: b } = tween
    const dy = ((((b.yaw - a.yaw) % 360) + 540) % 360) - 180
    view.yaw = a.yaw + dy * e
    view.pitch = a.pitch + (b.pitch - a.pitch) * e
    view.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * e)
    view.target = [0, 1, 2].map((i) => a.target[i]! + (b.target[i]! - a.target[i]!) * e) as Vec3
    if (k >= 1) tween = null
  }
  const findPreset = (name: string) => allPresets(subject()).find((p) => p.name === name)
  function setPreset(name: string, opts: { syncRef?: boolean; instant?: boolean } = {}): void {
    const p = findPreset(name)
    if (!p) return
    if (opts.syncRef !== false) syncRefToPreset(name)
    layout()
    const pose = presetPose(p, sceneBounds(), view.aspect)
    if (opts.instant) {
      view.set(pose)
      tween = null
    } else goTo(pose)
    refreshButtons()
  }
  function cycleYaw(): void {
    const ring = PRESET_SETS[subject()].yaw
    const i = ring.findIndex((p) => p.name === view.preset)
    setPreset(ring[(i + 1) % ring.length]!.name)
  }

  // ---- picking ----
  function pick(o: Vec3, d: Vec3, tMax = Infinity): Hit | null {
    let best: Hit | null = null
    for (const id of modelsIn(settings.model)) {
      const off = placement(id, settings.model)
      for (const p of variants[id].pieces) {
        if (!p.obj.visible) continue
        const inv = mat4.inverse(p.obj.matrix)
        const h = rayTris(p.geo.tris, xform(inv, o, 1), xform(inv, d, 0), best?.t ?? tMax)
        if (!h) continue
        let n = norm(xform(p.obj.matrix, triNormal(p.geo.tris, h.i), 0))
        if (dot(n, d) > 0) n = [-n[0], -n[1], -n[2]]
        const point = add(o, d, h.t)
        const local: Vec3 = [point[0] - off[0], point[1] - off[1], point[2] - off[2]]
        best = { t: h.t, point, local, normal: n, model: id, part: `${id} · ${p.namer(h.i, local, n)}` }
      }
    }
    return best
  }

  // ---- feedback ----
  const store: FeedbackStore = await openFeedback(new URL(".", location.href).href)
  let notes: Note[] = []
  let notesKey = ""
  let hot: string | null = null
  const occluded = new Map<string, boolean>()
  const pinEls = new Map<string, HTMLElement>()
  const notesEl = $("#notes")
  const editor = $("#editor")
  const editorText = $<HTMLTextAreaElement>("textarea", editor)
  let draft: (Draft & { at: { x: number; y: number } | null }) | null = null
  const draftPin = document.createElement("div")
  draftPin.className = "pin draft"
  draftPin.textContent = "+"
  draftPin.style.display = "none"
  pinsEl.append(draftPin)
  const labelEl = (m: ModelId) => {
    const el = document.createElement("div")
    el.className = "model-label"
    el.textContent = MODE_LABEL[m]
    el.style.display = "none"
    pinsEl.append(el)
    return el
  }
  const labelEls: Record<(typeof CARRIERS)[number], HTMLElement> = { procedural: labelEl("procedural"), blender: labelEl("blender") }
  $("#store").textContent = store.kind === "server" ? "feedback/ship.md" : "local only · copy all to share"

  const toast = (msg: string) => {
    const t = $("#toast")
    t.textContent = msg
    t.classList.add("show")
    clearTimeout((t as HTMLElement & { timer?: number }).timer)
    ;(t as HTMLElement & { timer?: number }).timer = window.setTimeout(() => t.classList.remove("show"), 1600)
  }

  async function refreshNotes(): Promise<void> {
    try {
      const list = await store.list(true)
      const key = JSON.stringify(list.map((n) => [n.id, n.resolved?.at ?? null]))
      if (key === notesKey) return
      notesKey = key
      notes = list
      renderNotes()
    } catch (e) {
      console.warn("[feedback]", e)
    }
  }

  const shown = () => notes.filter((n) => settings.showDone || !n.resolved).sort((a, b) => a.n - b.n)

  function renderNotes(): void {
    const open = notes.filter((n) => !n.resolved).length
    $("#fb-count").textContent = open ? `· ${open}` : ""
    const list = shown()
    notesEl.innerHTML = list.length ? "" : `<div class="empty">NO NOTES</div>`
    for (const n of list) {
      const row = document.createElement("div")
      row.className = `note${n.resolved ? " done" : ""}${hot === n.id ? " hot" : ""}`
      row.dataset.id = n.id
      const shot = store.shotUrl(n)
      row.innerHTML = `<div class="n${n.point ? "" : " general"}">${n.n}</div>
        <div><div class="text"></div><div class="meta"></div>${n.resolved?.reply ? `<div class="reply"></div>` : ""}</div>
        <div class="btns">${shot ? `<button data-x="shot" title="screenshot">▣</button>` : ""}${n.resolved ? "" : `<button data-x="resolve" title="done">✓</button>`}<button data-x="delete" title="delete">×</button></div>`
      $(".text", row).textContent = n.text
      $(".meta", row).textContent = `${n.part ?? "general"} · ${n.camera.preset ?? "free"} · ${new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      if (n.resolved?.reply) $(".reply", row).textContent = `↳ ${n.resolved.reply}`
      notesEl.append(row)
    }
    // Pins.
    const want = new Set(list.filter((n) => n.point).map((n) => n.id))
    for (const [id, el] of pinEls)
      if (!want.has(id)) {
        el.remove()
        pinEls.delete(id)
      }
    for (const n of list) {
      if (!n.point) continue
      let el = pinEls.get(n.id)
      if (!el) {
        el = document.createElement("div")
        el.dataset.id = n.id
        pinsEl.append(el)
        pinEls.set(n.id, el)
      }
      el.className = `pin${n.resolved ? " done" : ""}${hot === n.id ? " hot" : ""}`
      el.textContent = String(n.n)
    }
    occlusionDirty = true
    refreshButtons()
  }

  function restoreNote(n: Note): void {
    hot = n.id
    if (n.reference) {
      const file = n.reference.split(" ")[0]!
      const label = /\((.*)\)$/.exec(n.reference)?.[1]
      const ref = REFS.find((r) => r.file === file)
      if (ref) {
        const vi = Math.max(0, ref.views.findIndex((v) => v.label === label))
        settings.ref = { file, view: vi }
        renderRefs()
        layout()
      }
    }
    if (n.env !== settings.env) setEnv(n.env)
    const mode = n.mode && (MODES as string[]).includes(n.mode) ? (n.mode as Mode) : null
    if (mode && mode !== settings.model) setMode(mode, false)
    goTo(n.camera)
    renderNotes()
  }

  notesEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>(".note")
    const n = notes.find((x) => x.id === row?.dataset.id)
    if (!n) return
    const act = target.closest<HTMLElement>("[data-x]")?.dataset.x
    if (act === "shot") window.open(store.shotUrl(n)!, "_blank")
    else if (act === "resolve") void store.resolve(n.id, "").then(refreshNotes, (err) => toast(String(err)))
    else if (act === "delete") void store.remove(n.id).then(refreshNotes, (err) => toast(String(err)))
    else restoreNote(n)
  })
  pinsEl.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".pin")?.dataset.id
    if (!id) return
    hot = hot === id ? null : id
    renderNotes()
    notesEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" })
  })

  const saveDraft = () => saveJson(DRAFT_KEY, draft && { text: editorText.value, point: draft.point, normal: draft.normal, part: draft.part, model: draft.model })

  function openEditor(d: Draft, at: { x: number; y: number } | null): void {
    draft = { ...d, at }
    editorText.value = d.text
    $(".head", editor).textContent = d.point ? `${d.part ?? "ship"} · ${fmtPoint(d.point)}` : "GENERAL NOTE"
    $(".err", editor).textContent = ""
    editor.classList.add("open")
    positionEditor()
    editorText.focus()
    editorText.setSelectionRange(editorText.value.length, editorText.value.length)
    saveDraft()
  }

  function positionEditor(): void {
    if (!draft) return
    const ew = editor.offsetWidth || 260
    const eh = editor.offsetHeight || 120
    let x = innerWidth / 2 - ew / 2
    let y = innerHeight / 2 - eh / 2
    const s = draft.point && view.project(toWorld(draft.point, draft.model ?? "procedural"))
    if (s) {
      x = canvasRect.x + s.x + 18
      y = canvasRect.y + s.y - 20
      if (x + ew > innerWidth - 8) x = canvasRect.x + s.x - ew - 18
    }
    editor.style.left = `${Math.max(8, Math.min(innerWidth - ew - 8, x))}px`
    editor.style.top = `${Math.max(8, Math.min(innerHeight - eh - 8, y))}px`
  }

  function closeEditor(): void {
    draft = null
    editor.classList.remove("open")
    draftPin.style.display = "none"
    saveJson(DRAFT_KEY, null)
    canvas.focus()
  }

  async function submit(): Promise<void> {
    if (!draft) return
    const text = editorText.value.trim()
    if (!text) return closeEditor()
    const d = draft
    $(".err", editor).textContent = "SAVING"
    try {
      const nextN = notes.reduce((m, n) => Math.max(m, n.n), 0) + 1
      const shot = await capture(d.point ? { n: nextN, p: toWorld(d.point, d.model ?? "procedural") } : null)
      const a = activeRef()
      const input: NoteInput = {
        text,
        point: d.point,
        normal: d.normal,
        part: d.part,
        camera: view.pose(),
        reference: a ? `${a.ref.file}${a.ref.views.length > 1 ? ` (${a.view.label})` : ""}` : null,
        env: settings.env,
        mode: settings.model,
        shot,
      }
      const note = await store.add(input)
      closeEditor()
      hot = note.id
      await refreshNotes()
      toast(`SAVED #${note.n}`)
    } catch (e) {
      $(".err", editor).textContent = e instanceof Error ? e.message : String(e)
    }
  }

  editorText.addEventListener("input", saveDraft)
  editorText.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === "Escape") closeEditor()
  })

  // ---- screenshot: one fresh frame read back before it is presented, with the pins drawn on top ----
  let paused = false
  async function capture(extra: { n: number; p: Vec3 } | null): Promise<string | null> {
    paused = true
    try {
      await device.queue.onSubmittedWorkDone()
      return await new Promise<string | null>((resolve) => {
        requestAnimationFrame(() => {
          renderFrame(performance.now())
          queueMicrotask(() => {
            try {
              const s = Math.min(1, SHOT_MAX_W / canvas.width)
              const c = document.createElement("canvas")
              c.width = Math.round(canvas.width * s)
              c.height = Math.round(canvas.height * s)
              const g = c.getContext("2d")!
              g.drawImage(canvas, 0, 0, c.width, c.height)
              const k = c.width / view.w
              const pins: { n: string; p: Vec3; fill: string; alpha: number }[] = shown()
                .filter((n) => n.point && !n.resolved && isShown(noteModel(n.part)))
                .map((n) => ({ n: String(n.n), p: toWorld(n.point!, noteModel(n.part)), fill: "#ffcf3a", alpha: occluded.get(n.id) ? 0.4 : 1 }))
              if (extra) pins.push({ n: String(extra.n), p: extra.p, fill: "#ffffff", alpha: 1 })
              g.font = `400 ${Math.round(11 * k)}px "IBM Plex Mono", monospace`
              g.textAlign = "center"
              g.textBaseline = "middle"
              for (const pin of pins) {
                const q = view.project(pin.p)
                if (!q) continue
                g.globalAlpha = pin.alpha
                g.beginPath()
                g.arc(q.x * k, q.y * k, 11 * k, 0, Math.PI * 2)
                g.fillStyle = pin.fill
                g.fill()
                g.lineWidth = 2 * k
                g.strokeStyle = "#111"
                g.stroke()
                g.fillStyle = "#111"
                g.fillText(pin.n, q.x * k, q.y * k + 0.5 * k)
              }
              resolve(c.toDataURL("image/png"))
            } catch (e) {
              console.warn("[feedback] screenshot failed", e)
              resolve(null)
            }
          })
        })
      })
    } finally {
      paused = false
    }
  }

  // ---- references strip ----
  const refsEl = $("#refs")
  const thumbs = $(".thumbs", refsEl)
  const refCtl = $(".ref-ctl", refsEl)

  function syncRefToPreset(name: string): void {
    const a = activeRef()
    if (!a) return
    const i = a.ref.views.findIndex((v) => v.preset === name)
    if (i >= 0) {
      settings.ref = { file: a.ref.file, view: i }
      renderRefs()
      return
    }
    const other = REFS.find((r) => r.subject === subject() && r.views.some((v) => v.preset === name))
    if (other) {
      settings.ref = { file: other.file, view: other.views.findIndex((v) => v.preset === name) }
      renderRefs()
    }
  }

  function renderRefs(): void {
    const a = activeRef()
    for (const img of thumbs.querySelectorAll<HTMLImageElement>("img")) img.classList.toggle("on", img.dataset.file === a?.ref.file)
    refsEl.classList.toggle("closed", !a)
    if (!a) {
      refCtl.innerHTML = ""
      return
    }
    const views = a.ref.views.length > 1 ? a.ref.views.map((v, i) => `<button data-view="${i}" class="${i === a.index ? "on" : ""}">${esc(v.label)}</button>`).join("") : ""
    refCtl.innerHTML = `<div class="views">${views}</div>
      <button data-mode="side" class="${settings.refMode === "side" ? "on" : ""}">SIDE</button>
      <button data-mode="over" class="${settings.refMode === "over" ? "on" : ""}">OVER</button>
      <input type="range" min="0" max="1" step="0.01" value="${settings.refOpacity}" ${settings.refMode === "over" ? "" : "disabled"} />
      <button data-close="1">×</button>`
  }

  function selectRef(file: string, viewIndex: number): void {
    settings.ref = { file, view: viewIndex }
    renderRefs()
    layout()
    const v = activeRef()?.view
    const base = v?.preset ? findPreset(v.preset) : undefined
    if (!v || !base) return
    // Panels drawn from another angle than their label get the solved camera, so the overlay lines up.
    if (v.solved) goTo(presetPose({ ...base, yaw: v.solved.yaw, pitch: v.solved.pitch }, sceneBounds(), view.aspect))
    else setPreset(base.name, { syncRef: false })
    refreshButtons()
  }

  thumbs.addEventListener("click", (e) => {
    const file = (e.target as HTMLElement).closest<HTMLImageElement>("img")?.dataset.file
    if (!file) return
    if (settings.ref?.file === file) {
      settings.ref = null
      renderRefs()
      layout()
      return
    }
    const ref = REFS.find((r) => r.file === file)!
    const match = ref.views.findIndex((v) => v.preset === view.preset)
    selectRef(file, Math.max(0, match))
  })
  refCtl.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("button")
    if (!el) return
    if (el.dataset.view !== undefined && settings.ref) selectRef(settings.ref.file, Number(el.dataset.view))
    else if (el.dataset.mode) {
      settings.refMode = el.dataset.mode as RefMode
      renderRefs()
      layout()
      if (view.preset) setPreset(view.preset, { syncRef: false })
    } else if (el.dataset.close) {
      settings.ref = null
      renderRefs()
      layout()
    }
  })
  refCtl.addEventListener("input", (e) => {
    settings.refOpacity = Number((e.target as HTMLInputElement).value)
    refView.style.opacity = String(settings.refOpacity)
  })

  // ---- buttons ----
  const presetButtons = (el: HTMLElement, list: Preset[]) => {
    el.innerHTML = list.map((p) => `<button data-preset="${esc(p.name)}">${esc(p.name)}${p.key ? `<kbd>${p.key}</kbd>` : ""}</button>`).join("")
  }
  let shownSubject: Subject | null = null
  /** Preset buttons and the reference strip follow the subject (carrier or Hornet). */
  function renderSubject(): void {
    const sub = subject()
    if (sub === shownSubject) return
    shownSubject = sub
    const set = PRESET_SETS[sub]
    presetButtons($("#p-main"), set.main)
    presetButtons($("#p-yaw"), set.yaw)
    presetButtons($("#p-pitch"), set.pitch)
    $("#l-pitch").style.display = $("#p-pitch").style.display = set.pitch.length ? "" : "none"
    for (const el of ui.querySelectorAll<HTMLElement>("[data-subject]")) el.style.display = el.dataset.subject === sub ? "" : "none"
    const refs = REFS.filter((r) => r.subject === sub)
    thumbs.innerHTML = refs.map((r) => `<img src="${r.url}" data-file="${r.file}" title="${r.file}" alt="" draggable="false" />`).join("")
    refsEl.style.display = refs.length ? "" : "none"
    if (settings.ref && !refs.some((r) => r.file === settings.ref!.file)) settings.ref = null
    renderRefs()
    layout()
  }

  /** Switches which carriers are shown; a preset view is re-framed so it fits one carrier or both. */
  function setMode(mode: Mode, reframe = true): void {
    const before = subject()
    settings.model = mode
    renderSubject()
    updateNotice()
    if (reframe && before !== subject()) view.preset = findPreset(view.preset ?? "") ? view.preset : "HERO"
    occlusionDirty = true
    if (reframe && view.preset) setPreset(view.preset, { syncRef: false })
    refreshButtons()
  }

  function setEnv(env: Env): void {
    settings.env = env
    sky.enabled = env === "sea"
    water.enabled = env === "sea"
    document.body.classList.toggle("sea", env === "sea")
    refreshButtons()
  }

  function refreshButtons(): void {
    for (const b of ui.querySelectorAll<HTMLElement>("[data-preset]")) b.classList.toggle("on", b.dataset.preset === view.preset)
    const on: Record<string, boolean> = {
      [settings.model]: true,
      deckHornet: settings.deckHornet,
      wiggle: settings.wiggle,
      weapons: settings.weapons,
      persp: !view.ortho,
      ortho: view.ortho,
      studio: settings.env === "studio",
      sea: settings.env === "sea",
      vehicles: settings.vehicles,
      spin: settings.spin,
      backfaces: settings.backfaces,
      done: settings.showDone,
    }
    for (const b of ui.querySelectorAll<HTMLElement>("[data-act]")) b.classList.toggle("on", !!on[b.dataset.act!])
    for (const [id, c] of Object.entries(settings.collapsed)) document.getElementById(id)?.classList.toggle("collapsed", c)
    document.body.classList.toggle("hide-ui", !settings.ui)
  }

  function act(name: string): void {
    switch (name) {
      case "persp":
      case "ortho":
        view.ortho = name === "ortho"
        break
      case "studio":
      case "sea":
        setEnv(name)
        break
      case "vehicles":
        settings.vehicles = !settings.vehicles
        break
      case "spin":
        settings.spin = !settings.spin
        break
      case "backfaces":
        settings.backfaces = !settings.backfaces
        break
      case "hide":
        settings.ui = !settings.ui
        break
      case "done":
        settings.showDone = !settings.showDone
        renderNotes()
        break
      case "note":
        draftPin.style.display = "none"
        openEditor({ text: "", point: null, normal: null, part: null }, null)
        break
      case "procedural":
      case "blender":
      case "side":
      case "hornet":
      case "f35":
      case "boat":
        setMode(name)
        break
      case "deckHornet":
        settings.deckHornet = !settings.deckHornet
        occlusionDirty = true
        break
      case "wiggle":
        settings.wiggle = !settings.wiggle
        break
      case "weapons":
        settings.weapons = !settings.weapons
        occlusionDirty = true
        break
      case "copy":
        void store.exportText().then(copyText, (e) => toast(String(e)))
        break
    }
    ship.backfaces = settings.backfaces
    refreshButtons()
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const t = document.createElement("textarea")
      t.value = text
      document.body.append(t)
      t.select()
      document.execCommand("copy")
      t.remove()
    }
    toast("COPIED")
  }

  ui.addEventListener("click", (e) => {
    const el = e.target as HTMLElement
    const preset = el.closest<HTMLElement>("[data-preset]")?.dataset.preset
    if (preset) return setPreset(preset)
    const a = el.closest<HTMLElement>("[data-act]")?.dataset.act
    if (a) return act(a)
    const c = el.closest<HTMLElement>("[data-collapse]")?.dataset.collapse
    if (c) {
      settings.collapsed[c] = !settings.collapsed[c]
      refreshButtons()
    }
  })

  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    const p = PRESET_SETS[subject()].main.find((x) => x.key === e.key)
    if (p) setPreset(p.name)
    else if (k === "9") cycleYaw()
    else if (k === "m") setMode(MODES[(MODES.indexOf(settings.model) + 1) % MODES.length]!)
    else if (k === "o") act(view.ortho ? "persp" : "ortho")
    else if (k === "e") act(settings.env === "sea" ? "studio" : "sea")
    else if (k === "v") act("vehicles")
    else if (k === "r") act("spin")
    else if (k === "j") act("deckHornet")
    else if (k === "w") act("wiggle")
    else if (k === "g") act("weapons")
    else if (k === "b") act("backfaces")
    else if (k === "h") act("hide")
    else if (k === "n") act("note")
    else if (e.key === "Escape") {
      if (draft) closeEditor()
      else if (settings.ref) {
        settings.ref = null
        renderRefs()
        layout()
      }
    } else return
    e.preventDefault()
  })

  // ---- pointer: drag orbits, right/shift drag pans, wheel zooms toward the cursor, a click drops a pin ----
  let press: { x: number; y: number; button: number; pan: boolean; moved: boolean; id: number } | null = null
  canvas.addEventListener("contextmenu", (e) => e.preventDefault())
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus()
    press = { x: e.clientX, y: e.clientY, button: e.button, pan: e.button !== 0 || e.shiftKey, moved: false, id: e.pointerId }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return
    if (!press.moved) {
      press.moved = true
      canvas.classList.add("dragging")
      tween = null
    }
    const dx = e.movementX
    const dy = e.movementY
    if (press.pan) {
      const wpp = (2 * view.dist * TAN) / view.h
      view.target = add(add(view.target, view.right, -dx * wpp), view.up, dy * wpp)
    } else {
      view.yaw -= dx * 0.3
      view.pitch = Math.max(-89.9, Math.min(90, view.pitch + dy * 0.3))
    }
    view.preset = null
  })
  const release = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return
    const p = press
    press = null
    canvas.classList.remove("dragging")
    if (p.moved) return refreshButtons()
    if (p.button !== 0 || e.type === "pointercancel") return
    const r = canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const ray = view.ray(x, y)
    const hit = pick(ray.o, ray.d)
    if (!hit) {
      if (draft) closeEditor()
      return
    }
    openEditor({ text: draft?.text ?? "", point: hit.local, normal: hit.normal, part: hit.part, model: hit.model }, { x, y })
  }
  canvas.addEventListener("pointerup", release)
  canvas.addEventListener("pointercancel", release)
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault()
      tween = null
      const f = Math.exp(Math.max(-200, Math.min(200, e.deltaY * (e.deltaMode ? 33 : 1))) * 0.0015)
      const next = Math.max(4, Math.min(20000, view.dist * f))
      const r = canvas.getBoundingClientRect()
      const ray = view.ray(e.clientX - r.left, e.clientY - r.top)
      const hit = pick(ray.o, ray.d)
      if (hit) view.target = add(view.target, [hit.point[0] - view.target[0], hit.point[1] - view.target[1], hit.point[2] - view.target[2]], 1 - next / view.dist)
      view.dist = next
      view.preset = null
      refreshButtons()
    },
    { passive: false },
  )

  // ---- per frame ----
  let occlusionDirty = true
  let lastVp = ""
  let settleAt = 0

  function updatePins(now: number): void {
    const vpKey = Array.from(view.vp.subarray(0, 16), (v) => v.toFixed(4)).join()
    if (vpKey !== lastVp) {
      lastVp = vpKey
      settleAt = now + 150
      occlusionDirty = true
    }
    // Occlusion is a ray per pin against every triangle, so only once the camera rests.
    if (occlusionDirty && now >= settleAt) {
      occlusionDirty = false
      for (const n of notes) {
        if (!n.point) continue
        const w = toWorld(n.point, noteModel(n.part))
        const o = view.ortho ? add(w, view.fwd, -20000) : view.eye
        const to: Vec3 = [w[0] - o[0], w[1] - o[1], w[2] - o[2]]
        const len = Math.hypot(...to)
        const hit = pick(o, norm(to), len - 0.25)
        occluded.set(n.id, !!hit)
      }
    }
    for (const n of notes) {
      const el = pinEls.get(n.id)
      if (!el || !n.point) continue
      const s = isShown(noteModel(n.part)) ? view.project(toWorld(n.point, noteModel(n.part))) : null
      if (!s || s.x < -20 || s.y < -20 || s.x > view.w + 20 || s.y > view.h + 20) {
        el.style.display = "none"
        continue
      }
      el.style.display = ""
      el.style.transform = `translate(${s.x}px, ${s.y}px)`
      el.classList.toggle("back", !!occluded.get(n.id))
    }
    for (const m of CARRIERS) {
      const el = labelEls[m]
      const v = variants[m]
      const b = v.bounds
      const s = settings.model === "side" && !v.status ? view.project(toWorld([(b[0] + b[3]) / 2, b[4] + 14, (b[2] + b[5]) / 2], m)) : null
      el.style.display = s ? "" : "none"
      if (s) el.style.transform = `translate(${s.x}px, ${s.y}px)`
    }
    if (draft?.point) {
      const s = view.project(toWorld(draft.point, draft.model ?? "procedural"))
      draftPin.style.display = s ? "" : "none"
      if (s) draftPin.style.transform = `translate(${s.x}px, ${s.y}px)`
      positionEditor()
    }
  }

  function renderFrame(now: number): void {
    view.compute()
    const motions: Record<NonNullable<Motion>, Float32Array> = {
      radar: mat4.rotationY(radarAngle),
      stab: mat4.rotationX(stabAngle),
      doorL: mat4.rotationZ(doorAngle),
      doorR: mat4.rotationZ(-doorAngle),
    }
    for (const id of MODELS) {
      const shown = isShown(id)
      const place = mat4.translation(placement(id, settings.model))
      for (const p of variants[id].pieces) {
        p.obj.visible = shown && pieceVisible(p)
        mat4.multiply(place, p.base, p.obj.matrix)
        if (p.motion) mat4.multiply(p.obj.matrix, motions[p.motion], p.obj.matrix)
      }
    }
    ship.upload()
    sky.upload(view.skyInv)
    frame.set(view.vp, FRAME.viewProj)
    frame.set(view.eye, FRAME.eye)
    frame[FRAME.eye + 3] = (now / 1000) % TIME_WRAP
    fillAtmosphere(frame, settings.env === "sea" ? ATMOSPHERE : STUDIO)
    frame[FRAME.viewport] = canvas.width
    frame[FRAME.viewport + 1] = canvas.height
    frame[FRAME.viewport + 2] = 1 / canvas.width
    frame[FRAME.viewport + 3] = 1 / canvas.height
    frame.set(view.fwd, FRAME.forward)
    frame[FRAME.extra] = view.ortho ? 1 : 0
    renderer.render(frame, GRADES[settings.env])
  }

  let last = performance.now()
  let fps = 60
  let statsAt = 0
  let savedSettings = ""
  const statsEl = $("#stats")
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05
    if (settings.spin) radarAngle = (radarAngle + dt * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    stabAngle = settings.wiggle ? Math.sin((now / 1000) * Math.PI * 2 * STAB_HZ) * STAB_AMP : 0
    doorAngle = settings.wiggle ? (0.5 - 0.5 * Math.cos((now / 1000) * Math.PI * 2 * STAB_HZ * 0.5)) * DOOR_OPEN : 0
    layout()
    stepTween(now)
    if (!paused) renderFrame(now)
    updatePins(now)
    if (now > statsAt) {
      statsAt = now + 500
      const fmt = (n: number) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ")
      const counts = MODELS.map((m) => {
        const v = variants[m]
        const tris = v.pieces.reduce((n, p) => n + (pieceVisible(p) && p.group !== "deckHornet" ? p.geo.verts / 3 : 0), 0)
        return `<span class="${isShown(m) ? "" : "off"}">${MODE_LABEL[m]} ${v.status ? "—" : `${fmt(tris)} TRIS`}</span>`
      }).join(" · ")
      const camera = `${view.preset ?? "FREE"}${view.ortho ? " · ORTHO" : ""} · YAW ${Math.round((((view.yaw % 360) + 360) % 360))}° · PITCH ${Math.round(view.pitch)}° · ${Math.round(view.dist)} M`
      statsEl.innerHTML = `${counts} · ${Math.round(fps)} FPS<br>${esc(camera)}`
      settings.pose = view.pose()
      const s = JSON.stringify(settings)
      if (s !== savedSettings) {
        savedSettings = s
        saveJson(SETTINGS_KEY, settings)
      }
    }
    requestAnimationFrame(tick)
  }

  // ---- start ----
  await Promise.all([loadProcedural(), loadBlender()])
  await Promise.all([...JETS.map(loadJet), loadBoat()])
  ready = true
  const urlModel = params.get("model")
  if (urlModel && (MODES as string[]).includes(urlModel)) settings.model = urlModel as Mode
  if (params.has("deck")) settings.deckHornet = params.get("deck") !== "0"
  if (params.has("wiggle")) settings.wiggle = params.get("wiggle") !== "0"
  if (params.has("weapons")) settings.weapons = params.get("weapons") !== "0"
  updateNotice()
  setEnv(settings.env)
  ship.backfaces = settings.backfaces
  renderSubject()
  renderRefs()
  layout()
  const urlPreset = params.get("preset")
  if (urlPreset && findPreset(urlPreset.toUpperCase())) setPreset(urlPreset.toUpperCase(), { instant: true, syncRef: false })
  else if (settings.pose) view.set(settings.pose)
  else setPreset("HERO", { instant: true, syncRef: false })
  // The view now lives in sessionStorage; drop one-shot params so a model reload keeps the current view.
  const ONE_SHOT = ["preset", "env", "ui", "model", "deck", "wiggle", "weapons"]
  if (ONE_SHOT.some((k) => params.has(k))) {
    for (const k of ONE_SHOT) params.delete(k)
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`)
  }
  refreshButtons()
  await refreshNotes()
  renderNotes()
  const saved = loadJson<Draft>(DRAFT_KEY)
  if (saved) openEditor(saved, null)
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshNotes()
  }, 4000)
  Object.assign(globalThis, {
    shipViewer: {
      renderer,
      view,
      settings,
      setPreset,
      pick,
      /** PNG data URL of the current view with the open pins, as stored with a note. */
      shot: () => capture(null),
      variants,
      setMode,
      get ready() {
        return ready
      },
      get notes() {
        return notes
      },
    },
  })
  requestAnimationFrame(tick)
}

void main()
