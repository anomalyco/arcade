import * as THREE from "three/webgpu"
import { abs, attribute, float, floor, fract, fwidth, hash, max, mix, normalWorldGeometry, positionWorld, pow, sin, smoothstep, step, time, uniform, uv, vec2, vec3 } from "three/tsl"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import type { Lamp, WorldContext } from "../context"
import { BUILDING } from "../layout"
import { material, materialFor, type MaterialName } from "../../render/materials"

/*
 * INTERIOR KIT — the shared construction API for storey agents. Storey files import everything from `./api`:
 *   plan.ts (program coordinates), partition.ts (partition / studWall / column), doorway.ts (doorway + states),
 *   room.ts (room surfaces, windows, lit troffers), spine.ts (corridor), services.ts (service stack, riser W-1),
 *   lights.ts (every fixture with its lamp), fixtures.ts (furniture), props.ts (placeModels), registry.ts.
 *   storeys/kitdemo.ts is a worked example of all of them (automation: `?kitdemo=<storey>`).
 * This file holds the low-level primitives below.
 *
 * COORDINATES
 *   Metres, Y up, +Z south. Author every storey in GROUND-FLOOR coordinates: finished floor FLOOR_Y = 0.16, ceiling
 *   CEIL_Y = 3.1. `new Builder(ctx, name, storey)` lifts everything it emits (meshes, colliders, floors, lamps) by
 *   storey × STOREY_H (3.8 m); `b.oy` is that lift if you ever need a world height. Thin layers (stripes, decals) go
 *   ≥ LAYER (4 mm) above the surface they sit on; never put two faces in one plane (z-fighting, see below).
 *
 * BUILDER (one per storey, created for you by interior.ts and passed to your storey module)
 *   b.box(mat, x0,y0,z0, x1,y1,z1, { cast?, skip? })   axis-aligned box; `skip` drops faces ("X"/"x" = +/−X face…)
 *   b.boxM(mat, m, w,h,d, ox,oy,oz)                    box in a local frame `m` (build with T(x,y,z, yaw, pitch, roll))
 *   b.rbox(mat, m, w,h,d, radius, ox,oy,oz)            bevelled box: use for anything you see up close
 *   b.cyl(mat, m, rTop, rBot, h, seg, { open? }) · b.rod(mat, p0, p1, r, seg) · b.quad(mat, m, w, h) (keeps 0..1 UVs)
 *   b.add(mat, geometry)                               any BufferGeometry (consumed); world UVs in metres by default
 *   b.collide(x0,y0,z0, x1,y1,z1) · b.collideLocal(m, min, max)   player colliders (AABBs, storey-lifted)
 *   b.floor(mat, x0,z0, x1,z1)                         finish at FLOOR_Y + walkable floor · b.walk(...) floor only
 *   b.lamp(lamp)                                       registers a light (storey-lifted, tagged zone "interior:<n>")
 *   b.mesh(material, geometry)                         an unmerged mesh (per-instance animated materials only)
 *   Static geometry is merged per material per storey at flush, so draw calls don't grow with detail.
 *
 * MATERIALS
 *   Mat = a library name ("tile_green", "linoleum", "terrazzo", "ceiling_tile", "door_steel", …: render/materials.ts),
 *   a shared Paint (`paint(hex, roughness, metalness)`: every Paint draws with ONE vertex-colour shader — use it for
 *   all flat colours), or a THREE.Material. Glows: `glow(color, emissive, intensity, name)` (shared flat class).
 *   `M` holds the kit's palette (M.frame, M.steel, M.darkSteel, M.carpet, M.block, M.hazard, M.glass, …). Don't
 *   create per-object node materials: each new node graph is a shader compile (boot cost). Procedural patterns must
 *   be filtered (aaStep / aaWindow / aaLines / aaFade below) or they crawl under TAA.
 *
 * WALLS · OPENINGS · WINDOWS
 *   wall(b, "x"|"z", a0, a1, c0, c1, bands, openings?, extent?)   straight wall along x (z thickness c0..c1) or z.
 *     bands: [[y0, y1, mat], …] heights above the floor (corridorBands, lobbyBands, closetBands, or STYLES[n].bands).
 *     openings: doorOpening(centre, width?) for doors; { a0, a1, top, bottom? } for windows/hatches (bottom = sill).
 *     extent: { y0, y1, collide? } for walls that aren't floor-to-ceiling. Colliders cover solid spans and sills.
 *     Wall ends are recessed 2 mm so a wall can butt into another without fighting.
 *
 * DOORS (all doors open: shared door system, KeyE)
 *   door(b, x, z, { rot, wallT?, width?, leaves?, open?, angle?, swing?, locked?, glass?, leaf?, panic?, plate?, sound? })
 *     Centre (x, z) on the WHOLE wall assembly including any finish layer, and pass that full thickness as wallT, so
 *     frame, casings and plates sit proud of every face. rot 0 = front (+z local) faces +z; rot π for the other side.
 *     open = start angle (rad, sign = side); angle = full swing; swing "fixed" where one side is blocked; leaves 2 for
 *     pairs; glass null for solid leaves (default wire glass); leaf: M.veneer etc. The opening must follow the
 *     doorway rule in world/doors.ts (no collider across it, floor through it). Check with
 *     `bun scripts/doors-check.ts --all --q "only=interior,facility" --view corridor`.
 *
 * CEILINGS · LIGHTS
 *   ceiling(b, x0, z0, x1, z1, missing?, seed?, fallen?)   drop ceiling + T-bar grid on the global 0.6 × 1.2 m module
 *     (X lines at 0.3 + 0.6k, Z lines at 0.6 + 1.2k); `missing` 0..1 leaves tiles out (decay).
 *   troffer(b, x, z, "on" | "off" | flicker, PANEL_ON)  recessed 0.6 × 1.2 fitting at a grid cell centre
 *     (x = 0.6k, z = 1.2k); louvre(b, x, z) adds a parabolic louvre. PANEL_WARM for the lobby tint.
 *   Real light: b.lamp(fluoro(x, z, flicker?, intensity?)) (`./api`) — a downward spot just above the panel. Rule: a
 *     lit room gets ~1 real lamp per 15–25 m² (intensity 8–30 cd at current exposure); the rest of its panels are
 *     emissive only. Lamps on storey n carry zone "interior:n"; the lighting rig culls other storeys.
 *     Flicker: fluorescentPanel(level) gives a material + level uniform; drive it from rigLevel(lamp) in update().
 *
 * FINISHES PER STOREY
 *   STYLES[n] (`./styles`): floor, wall bands, floor stripe, door leaf, ceiling decay, louvres. The core hall and lift
 *   lobby use the same STYLES[n], so a storey that changes its corridor finish should change it there.
 *
 * FURNITURE (real models)
 *   placeModels(b, name, [{ position, yaw, scale?, collide?, inset?, blob?, tilt? }], { cast? })  (`./api`)
 *     Library models (render/models.ts MODELS: size, front faces −Z, pivot at base centre; yawToward(dx, dz)).
 *     Positions in ground-floor coordinates. Adds colliders (modelCollider with `inset`) and a soft contact shadow
 *     for floor props now; after the storey flushes, every placement is baked into a few merged meshes per material
 *     (no InstancedMesh: small instanced groups each compile a shader). Desk-top props are drawn only on the camera's
 *     storey; chairs/stools too; LOD1 copies are drawn from outside and from other storeys automatically.
 *   For procedural pieces: bevel (rbox), real thickness, every part touching what holds it (no floating brackets, no
 *   rods through surfaces); wastebasket(b, x, z) is the shared bin.
 *
 * CULLING · ZONES · LOD (handled by interior.ts; know the rules)
 *   Indoors: storeys n−1..n+1 are drawn, full furniture only on n. Outdoors within 18 m of the block: LOD1 furniture
 *   for storeys level with the camera, per 22.5 m stretch; small props within 8 m. Your module's `proxy` group is
 *   shown wherever its furniture is hidden (lit rooms: a desk silhouette is enough).
 *
 * STOREY MODULES
 *   src/world/interior/storeys/sN.ts exports `build(b, { storey, pause }): Promise<{ update?, proxy? }>` (types.ts).
 *   Call `await pause()` every few rooms. Leave the core hall opening and (storeys 1–4) the fire-escape door opening
 *   at x −54.65, z 0. Register the module in storeys/index.ts.
 *
 * Z-FIGHTING
 *   Never two coplanar faces: drop hidden faces with `skip`, offset layers ≥ 4 mm, keep trims/plates proud of every
 *   finish layer. Check with the coplanar audit (ask the kit owner) or a stand-still flicker map.
 */

export type Mat = MaterialName | THREE.Material | Paint
export type Band = readonly [y0: number, y1: number, mat: Mat]

export const FLOOR_Y = 0.16
/** Thin floor layers (stripes, markings) sit this far above the finish: ≥ 4 mm so the depth buffer separates them
 *  at corridor distances (1–2 mm layers fought at 20–40 m). */
export const LAYER = 0.004
export const STOREY_H = BUILDING.main.storeyHeight
export const CEIL_Y = 3.1
export const DOOR_W = 0.92
export const DOOR_H = 2.12

/** A material with its own node graph (one shader each; only for the few procedural surfaces). */
const nodeMat = (color: number, roughness: number, metalness = 0, name = "") => {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness })
  m.name = `interior_${name}`
  return m
}

/** Shared-class glow (render/materials.ts `flat` class: one shader for every flat colour and glow). */
export const glow = (color: number, emissiveColor: number, intensity: number, name: string) =>
  materialFor("flat", { color, roughness: 0.5, emissive: emissiveColor, intensity, name: `interior_${name}` })

// ---- filtered pattern helpers: every hard threshold integrated over the pixel footprint (fwidth), so patterns fade
// to their average when sub-pixel instead of crawling under TAA jitter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
/** Antialiased step(edge, x). */
export const aaStep = (edge: N, x: N): N => {
  const w = fwidth(x).mul(0.75).max(1e-5)
  return smoothstep(float(edge).sub(w), float(edge).add(w), x)
}
/** Inside-[a, b] window on x, antialiased. */
export const aaWindow = (x: N, a: number, b: number): N => aaStep(a, x).mul(float(1).sub(aaStep(b, x)))
/** Box-filtered coverage of lines of width `wl` (fraction of the period) at the start of every period of t. */
const lineInt = (x: N, wl: number): N => floor(x).mul(wl).add(fract(x).min(wl))
export const aaLines = (t: N, wl: number): N => {
  const w = fwidth(t).max(1e-4)
  return lineInt(t.add(w.mul(0.5)), wl).sub(lineInt(t.sub(w.mul(0.5)), wl)).div(w).clamp(0, 1)
}
/** Fade factor for detail at frequency `t` (cycles per unit): 1 when well resolved, 0 below ~2 pixels a cycle. */
export const aaFade = (t: N): N => float(1).sub(smoothstep(0.25, 0.5, fwidth(t)))

/** Wire glass: dark frosted pane with a square wire mesh, in the pane's local 0..1 UVs. */
function wireGlass() {
  const m = nodeMat(0x2a3431, 0.22, 0, "wire_glass")
  const g = uv().mul(vec2(12, 18))
  const wire = max(aaLines(g.x, 0.07), aaLines(g.y, 0.07))
  m.colorNode = mix(vec3(0.05, 0.07, 0.066), vec3(0.2, 0.21, 0.2), wire)
  return m
}

/** Old tubes behind yellowed diffusers: warm green-white, dim (concept r3-02), shared by lamps and emitters. */
export const TUBE: [number, number, number] = [0.86, 0.95, 0.62]
/** The lobby's one panel: a warmer, yellower tube (concept r5-02). */
export const TUBE_WARM: [number, number, number] = [1.0, 0.86, 0.55]

/** Fluorescent diffuser lens with four tubes showing through (stripes across the short side of the panel). Tint and
 *  level are uniforms, so every panel shares one shader. Brightness is kept near the lamp it stands for. */
export function fluorescentPanel(level = 1, tint: readonly [number, number, number] = TUBE) {
  const m = nodeMat(0x101210, 0.4, 0, "fluorescent_panel")
  const u = uniform(level)
  // Tube stripes fade to their mean (0.45 + 0.55 × ~0.5) when they get sub-pixel; the lit edge is a filtered window.
  const tubes = uv().x.mul(2)
  // Soft humps (a diffuser blurs the tubes): steep pow-sine flanks were bright gradients that shimmered under jitter.
  const stripes = mix(float(0.86), abs(sin(tubes.mul(Math.PI * 2))).mul(0.22).add(0.72), aaFade(tubes.mul(4)))
  // The diffuser dims towards its frame over a few cm (a real lens does): a hard bright→black edge is what TAA
  // couldn't settle, the HDR contrast across one pixel swinging with every jitter offset.
  const soft = (t: N, a: number, b: number) => smoothstep(a, b, t.min(float(1).sub(t)))
  const edge = soft(uv().x, 0.01, 0.12).mul(soft(uv().y, 0.005, 0.06)).mul(aaWindow(uv().x, 0.01, 0.99))
  m.emissiveNode = uniform(new THREE.Color(...tint)).mul(stripes).mul(edge).mul(u).mul(1.9)
  return { material: m, level: u }
}

export const PANEL_ON = fluorescentPanel(1).material
export const PANEL_WARM = fluorescentPanel(1, TUBE_WARM).material

/** Frosted pane lit from behind by something like a television tuned to nothing: coarse flickering white static. */
function staticGlass() {
  const m = nodeMat(0x101414, 0.3, 0, "static_glass")
  const u = uniform(1)
  const cell = floor(uv().mul(vec2(46, 64)))
  const frame = floor(time.mul(22))
  const n = hash(cell.x.add(cell.y.mul(157)).add(frame.mul(911)))
  const roll = sin(uv().y.mul(9).add(time.mul(3.1))).mul(0.12).add(0.88)
  const g = uv().mul(vec2(12, 18))
  const wire = max(aaLines(g.x, 0.07), aaLines(g.y, 0.07))
  // Static cells fade to mid-grey when they get sub-pixel.
  const grain = mix(float(0.7), n.mul(0.6).add(0.4), aaFade(uv().x.mul(46)))
  m.emissiveNode = vec3(0.82, 0.9, 1.0).mul(grain).mul(roll).mul(u).mul(float(1).sub(wire.mul(0.7))).mul(1.3)
  return { material: m, level: u }
}

/** A flat-coloured surface drawn with the shared vertex-colour material (one shader, merged per storey). */
export type Paint = { readonly paint: true; readonly c: readonly [number, number, number]; readonly r: number; readonly m: number }
const col = new THREE.Color()
export const paint = (hex: number, roughness: number, metalness = 0): Paint => {
  col.setHex(hex)
  return { paint: true, c: [col.r, col.g, col.b], r: roughness, m: metalness }
}

/** The one material every Paint shares: albedo from the vertex colour, roughness/metalness from the `rm` attribute,
 *  with a faint world-space mottling so large flat-painted planes don't read as CG. */
const vcMaterial = (() => {
  const m = new THREE.MeshStandardNodeMaterial()
  const rm = attribute<"vec2">("rm", "vec2")
  const mottle = hash(floor(positionWorld.mul(9)).dot(vec3(1, 57, 113))).mul(0.06).add(0.97)
  m.colorNode = attribute<"vec3">("color", "vec3").mul(mottle)
  m.roughnessNode = rm.x
  m.metalnessNode = rm.y
  m.name = "interior_paint"
  return m
})()

/** Carpet tiles (50 cm, laid quarter-turned so alternate tiles read lighter), seams and fibre noise; one shader. */
function carpetTiles() {
  const m = nodeMat(0x3a3832, 0.98, 0, "carpet_tiles")
  const p = positionWorld.xz.mul(2)
  const c = floor(p)
  const checker = mix(float(0.5), fract(c.x.add(c.y).mul(0.5)).mul(2), aaFade(p.x))
  const seam = max(aaLines(p.x, 0.024), aaLines(p.y, 0.024))
  const fibre = hash(floor(positionWorld.xz.mul(220)).dot(vec2(1, 157))).mul(0.12).mul(aaFade(positionWorld.x.mul(220))).add(float(0.06).mul(float(1).sub(aaFade(positionWorld.x.mul(220)))))
  const wear = hash(c.dot(vec2(7, 113))).mul(0.06)
  m.colorNode = vec3(0.105, 0.1, 0.088).mul(float(0.92).add(checker.mul(0.12)).add(fibre).sub(wear)).mul(float(1).sub(seam.mul(0.45)))
  return m
}

/** Painted concrete block (40 × 20 cm running bond) in two-tone epoxy, darker below 1.2 m; one shader for any wall. */
function blockWall() {
  const m = nodeMat(0xc9c4ad, 0.32, 0, "epoxy_block")
  const n = normalWorldGeometry
  const along = mix(positionWorld.x, positionWorld.z, step(abs(n.z), abs(n.x)))
  const y = positionWorld.y.sub(FLOOR_Y)
  const yy = fract(y.div(STOREY_H)).mul(STOREY_H)
  const course = floor(yy.div(0.2))
  const ut = along.div(0.4).add(fract(course.mul(0.5)))
  const joint = max(aaLines(ut, 0.025), aaLines(yy.div(0.2), 0.05))
  const low = float(1).sub(aaStep(1.2, yy))
  const band = aaWindow(yy, 1.2, 1.3)
  const base = mix(vec3(0.5, 0.49, 0.42), vec3(0.17, 0.22, 0.19), low)
  m.colorNode = mix(base, vec3(0.09, 0.13, 0.12), band).mul(float(1).sub(joint.mul(0.3)))
  m.roughnessNode = float(0.28).add(joint.mul(0.5))
  return m
}

/** Yellow/black diagonal hazard stripes in world XZ (floor markings) or XY/ZY (walls); one shader. */
function hazardStripes() {
  const m = nodeMat(0x8a7010, 0.55, 0, "hazard_stripes")
  const p = positionWorld
  const d = p.x.add(p.z).add(p.y).mul(3.5)
  m.colorNode = mix(vec3(0.02, 0.02, 0.018), vec3(0.62, 0.46, 0.04), aaLines(d, 0.5))
  return m
}

export const M = {
  frame: paint(0x16211b, 0.5, 0.35),
  tbar: paint(0x6e6f68, 0.7, 0.1),
  housing: paint(0x5a5b56, 0.7, 0.2),
  diffuserOff: paint(0x8d9290, 0.35, 0),
  stripe: paint(0x1e3b2c, 0.18, 0),
  kick: paint(0x8c8e8a, 0.35, 0.85),
  plate: paint(0x3a3d38, 0.5, 0.6),
  wireGlass: wireGlass(),
  laminate: paint(0x231d18, 0.5, 0),
  laminateTop: paint(0x34302a, 0.35, 0),
  paper: paint(0xcfcbbb, 0.9, 0),
  clipboard: paint(0x5a3e22, 0.6, 0),
  felt: paint(0x0f1110, 0.95, 0),
  feltText: paint(0x9a9a92, 0.7, 0),
  cork: paint(0x5e4329, 0.95, 0),
  potClay: paint(0x3e3127, 0.8, 0),
  leaf: paint(0x1b2e1d, 0.65, 0),
  soil: paint(0x15110d, 1, 0),
  red: paint(0x7a1610, 0.45, 0.1),
  hazardRed: glow(0x2a0806, 0xff2a12, 1.4, "hazard_red"),
  hazardOff: paint(0x3a1410, 0.4, 0),
  exitSign: glow(0x1a0404, 0xff1a0c, 2.2, "exit_sign"),
  cabinet: paint(0x5d665e, 0.5, 0.35),
  epoxy: paint(0x161817, 0.3, 0),
  steel: paint(0x9a9c98, 0.32, 0.9),
  darkSteel: paint(0x2c2e2d, 0.45, 0.8),
  stoolSeat: paint(0x121212, 0.55, 0),
  chalkboard: paint(0x1a2620, 0.88, 0),
  chalkSmear: paint(0x2a3832, 0.95, 0),
  wood: paint(0x4a3420, 0.6, 0),
  glass: materialFor("flat", { color: 0xcfe2dc, roughness: 0.04, transparent: 0.22, name: "interior_glass" }),
  bulbWarm: glow(0x332211, 0xffb060, 6, "bulb_warm"),
  bulbCool: glow(0x223030, 0xd8eeff, 5, "bulb_cool"),
  lampShade: paint(0xb8b4a4, 0.4, 0.6),
  yellow: paint(0x8f7212, 0.5, 0),
  jugWhite: paint(0xbcbcb0, 0.55, 0),
  jugBrown: paint(0x3a2412, 0.3, 0),
  cardboard: paint(0x6a5236, 0.9, 0),
  concreteSink: paint(0x6e6e66, 0.8, 0),
  rubber: paint(0x141414, 0.9, 0),
  carpet: carpetTiles(),
  block: blockWall(),
  hazard: hazardStripes(),
  vinylBeige: paint(0x8f8468, 0.82, 0),
  vinylSeam: paint(0x6f6650, 0.85, 0),
  veneer: paint(0x5a3b22, 0.45, 0),
  veneerDark: paint(0x3b2615, 0.5, 0),
  antistatic: paint(0x7b807e, 0.6, 0),
  raised: paint(0x8f918a, 0.5, 0.05),
  perf: paint(0x50534f, 0.6, 0.3),
  blue: paint(0x23324a, 0.25, 0),
  amberGlow: glow(0x2a1a04, 0xffa018, 1.6, "amber_glow"),
  tarp: paint(0x1f3f66, 0.55, 0),
  plywood: paint(0x8a6a42, 0.85, 0),
  vend: paint(0x6a1812, 0.4, 0.2),
  vendFront: glow(0x101010, 0xe8e0c8, 0.9, "vend_front"),
  sofa: paint(0x4a3a2a, 0.9, 0),
  beige: paint(0x9a927c, 0.55, 0),
  enamel: paint(0x7d8a7e, 0.4, 0.1),
  stencil: paint(0xb9b29a, 0.8, 0),
  safety: paint(0x9a7a1a, 0.6, 0.2),
  plaster: paint(0xb3b4a6, 0.9, 0),
  concrete: paint(0x5c5c56, 0.92, 0),
  debris: paint(0x8a877c, 0.95, 0),
  stain: paint(0x6f6a5c, 0.95, 0),
}

export const corridorBands: Band[] = [
  [0, 0.3, "tile_green_dark"],
  [0.3, 1.02, "tile_green"],
  [1.02, 1.2, "tile_green_dark"],
  [1.2, DOOR_H + 0.05, "tile_green"],
  [DOOR_H + 0.05, CEIL_Y, "painted_wall"],
]

/** Lobby: the corridor's tile courses and dark band at the same heights (they meet at the link), painted above. */
export const lobbyBands: Band[] = [
  [0, 0.3, "tile_green_dark"],
  [0.3, 1.02, "tile_green"],
  [1.02, 1.2, "tile_green_dark"],
  [1.2, CEIL_Y, "painted_wall"],
]

export const closetBands: Band[] = [
  [0, 0.2, "tile_green_dark"],
  [0.2, CEIL_Y, "painted_wall"],
]

const tmpV = new THREE.Vector3()
const tmpN = new THREE.Vector3()

/** Planar world UV (metres) for a point with normal n, projected along the dominant normal axis. */
function uvFor(x: number, y: number, z: number, nx: number, ny: number, nz: number, out: number[]) {
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) out.push(x, z)
  else if (ax >= az) out.push(nx > 0 ? -z : z, y)
  else out.push(nz > 0 ? x : -x, y)
}

const mat4 = new THREE.Matrix4()
const quat = new THREE.Quaternion()
const euler = new THREE.Euler()
const one = new THREE.Vector3(1, 1, 1)

/** Translation then rotation (Euler YXZ order by default), as a fresh matrix. */
export function T(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, order: THREE.EulerOrder = "YXZ") {
  euler.set(rx, ry, rz, order)
  quat.setFromEuler(euler)
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), quat, one)
}

type AddOpts = { worldUV?: boolean; cast?: boolean }
type Part = { mat: THREE.Material; cast: boolean; vc: boolean; pos: number[]; nor: number[]; uv: number[]; col: number[]; rm: number[] }


// Box faces: normal, then the four corners as (x, y, z) picks from [min, max] (0 = min, 1 = max), counter-clockwise.
const FACES: [number, number, number, number[][]][] = [
  [1, 0, 0, [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
  [-1, 0, 0, [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  [0, 1, 0, [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  [0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  [0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
  [0, 0, -1, [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
]

/**
 * Collects static geometry per material (Paint surfaces all share one vertex-colour material) and emits one merged
 * mesh each into its own group. Geometry is authored in ground-floor coordinates; `storey` lifts everything (meshes,
 * colliders, floors, lamps) by whole storeys, so the same code builds every floor. UVs are computed before the lift so
 * tile courses line up the same way on every storey.
 */
const QUAD = [0, 1, 2, 0, 2, 3]

export class Builder {
  private parts = new Map<string, Part>()
  readonly group = new THREE.Group()
  /** Streamed furniture models (drawn only near the camera's storey, see interior.ts). */
  readonly props = new THREE.Group()
  /** Small desk and bench props (drawn only on the camera's own storey, indoors). */
  readonly small = new THREE.Group()
  /** LOD1 copies of the furniture and small props, drawn instead of them from other storeys and from outside. */
  readonly propsLod = new THREE.Group()
  readonly smallLod = new THREE.Group()
  oy = 0
  zone = "interior:0"
  private storeyIndex = 0

  constructor(
    readonly ctx: WorldContext,
    name: string,
    storey = 0,
  ) {
    this.group.name = `interior:${name}`
    this.props.name = `interior:${name}:props`
    this.small.name = `interior:${name}:small`
    this.propsLod.name = `interior:${name}:props-lod1`
    this.smallLod.name = `interior:${name}:small-lod1`
    this.group.add(this.props, this.small, this.propsLod, this.smallLod)
    this.storey = storey
  }

  get storey() {
    return this.storeyIndex
  }
  set storey(i: number) {
    this.storeyIndex = i
    this.oy = i * STOREY_H
    this.zone = `interior:${Math.min(i, BUILDING.main.storeys - 1)}`
  }

  private part(mat: Mat, cast: boolean): Part {
    const isPaint = typeof mat === "object" && "paint" in mat
    const m = isPaint ? vcMaterial : typeof mat === "string" ? material(mat) : (mat as THREE.Material)
    const key = `${m.uuid}:${cast}`
    let p = this.parts.get(key)
    if (!p) this.parts.set(key, (p = { mat: m, cast, vc: isPaint, pos: [], nor: [], uv: [], col: [], rm: [] }))
    return p
  }

  private paintVerts(p: Part, mat: Mat, n: number) {
    if (!p.vc) return
    const c = (mat as Paint).c
    for (let i = 0; i < n; i++) {
      p.col.push(c[0], c[1], c[2])
      p.rm.push((mat as Paint).r, (mat as Paint).m)
    }
  }

  add(mat: Mat, g: THREE.BufferGeometry, opts: AddOpts = {}) {
    const p = this.part(mat, opts.cast ?? true)
    if (!g.getAttribute("normal")) g.computeVertexNormals()
    const pos = g.getAttribute("position")
    const nor = g.getAttribute("normal")
    const uv = g.getAttribute("uv")
    const index = g.index
    const n = index ? index.count : pos.count
    const world = opts.worldUV ?? true
    const oy = this.oy
    for (let k = 0; k < n; k++) {
      const i = index ? index.getX(k) : k
      tmpV.fromBufferAttribute(pos, i)
      tmpN.fromBufferAttribute(nor, i)
      p.pos.push(tmpV.x, tmpV.y + oy, tmpV.z)
      p.nor.push(tmpN.x, tmpN.y, tmpN.z)
      if (world || !uv) uvFor(tmpV.x, tmpV.y, tmpV.z, tmpN.x, tmpN.y, tmpN.z, p.uv)
      else p.uv.push(uv.getX(i), uv.getY(i))
    }
    this.paintVerts(p, mat, n)
    g.dispose()
  }

  /** Axis-aligned box from min to max corners (emitted directly: the interior has thousands of them). */
  /** `skip` lists faces to leave out: X/Y/Z = the + faces, x/y/z = the - faces. */
  box(mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: AddOpts & { skip?: string }) {
    const p = this.part(mat, opts?.cast ?? true)
    const lo = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)]
    const hi = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]
    const oy = this.oy
    let n = 0
    for (let f = 0; f < 6; f++) {
      if (opts?.skip && opts.skip.includes("XxYyZz"[f]!)) continue
      const [nx, ny, nz, cs] = FACES[f]!
      const v = cs.map(([a, b, c]) => [a ? hi[0]! : lo[0]!, b ? hi[1]! : lo[1]!, c ? hi[2]! : lo[2]!])
      for (const k of QUAD) {
        const [x, y, z] = v[k]!
        p.pos.push(x!, y! + oy, z!)
        p.nor.push(nx, ny, nz)
        uvFor(x!, y!, z!, nx, ny, nz, p.uv)
      }
      n += 6
    }
    this.paintVerts(p, mat, n)
  }

  /** Box of size w×h×d centred at the origin of `m` (plus a local offset), written straight into the batch. */
  boxM(mat: Mat, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oy = 0, oz = 0, opts?: AddOpts) {
    const p = this.part(mat, opts?.cast ?? true)
    const e = m.elements
    const lo = [ox - w / 2, oy - h / 2, oz - d / 2]
    const hi = [ox + w / 2, oy + h / 2, oz + d / 2]
    const yo = this.oy
    for (let f = 0; f < 6; f++) {
      const [lx, ly, lz, cs] = FACES[f]!
      // Rotation-only normal (no scale in these matrices).
      const nx = e[0]! * lx + e[4]! * ly + e[8]! * lz
      const ny = e[1]! * lx + e[5]! * ly + e[9]! * lz
      const nz = e[2]! * lx + e[6]! * ly + e[10]! * lz
      for (const k of QUAD) {
        const c = cs[k]!
        const x = c[0] ? hi[0]! : lo[0]!
        const y = c[1] ? hi[1]! : lo[1]!
        const z = c[2] ? hi[2]! : lo[2]!
        const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
        const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
        const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!
        p.pos.push(wx, wy + yo, wz)
        p.nor.push(nx, ny, nz)
        uvFor(wx, wy, wz, nx, ny, nz, p.uv)
      }
    }
    this.paintVerts(p, mat, 36)
  }

  /** Bevelled box (rounded edges) of size w×h×d centred at the origin of `m` plus an offset. */
  rbox(mat: Mat, m: THREE.Matrix4, w: number, h: number, d: number, r = 0.02, ox = 0, oy = 0, oz = 0, opts?: AddOpts) {
    const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3))
    g.translate(ox, oy, oz)
    g.applyMatrix4(m)
    this.add(mat, g, opts)
  }

  cyl(mat: Mat, m: THREE.Matrix4, rTop: number, rBot: number, h: number, seg = 12, opts?: AddOpts & { open?: boolean }) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, opts?.open ?? false)
    g.applyMatrix4(m)
    this.add(mat, g, opts)
  }

  /** Flat quad of w×h in the local XY plane facing local +Z, keeping its own 0..1 UVs. */
  quad(mat: Mat, m: THREE.Matrix4, w: number, h: number, opts?: AddOpts) {
    const g = new THREE.PlaneGeometry(w, h)
    g.applyMatrix4(m)
    this.add(mat, g, { worldUV: false, ...opts })
  }

  /** Cylinder rod between two points. */
  rod(mat: Mat, p0: readonly number[], p1: readonly number[], r: number, seg = 8, opts?: AddOpts) {
    tmpV.set(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!)
    const len = tmpV.length()
    quat.setFromUnitVectors(UP, tmpV.normalize())
    mat4.compose(tmpN.set((p0[0]! + p1[0]!) / 2, (p0[1]! + p1[1]!) / 2, (p0[2]! + p1[2]!) / 2), quat, one)
    this.cyl(mat, mat4, r, r, len, seg, opts)
  }

  collide(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.ctx.colliders.push({
      min: [Math.min(x0, x1), Math.min(y0, y1) + this.oy, Math.min(z0, z1)],
      max: [Math.max(x0, x1), Math.max(y0, y1) + this.oy, Math.max(z0, z1)],
    })
  }

  /** Collider for a local box (min/max in the frame of `m`), as the world AABB of its corners. */
  collideLocal(m: THREE.Matrix4, min: readonly [number, number, number], max: readonly [number, number, number]) {
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)).applyMatrix4(m)
    this.collide(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z)
  }

  /** Walkable surface at local height y (registers only; draw it separately). */
  walk(x0: number, z0: number, x1: number, z1: number, y = FLOOR_Y) {
    this.ctx.floors.push({ min: [Math.min(x0, x1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(z0, z1)], y: y + this.oy })
  }

  floor(mat: Mat, x0: number, z0: number, x1: number, z1: number) {
    // Top face only: the edges would be coplanar with the wall faces they tuck under.
    this.box(mat, x0, FLOOR_Y - 0.012, z0, x1, FLOOR_Y, z1, { cast: false, skip: "XxyZz" })
    this.walk(x0, z0, x1, z1)
  }

  /** Registers a lamp (local position) in this storey's zone and returns the registered object. */
  lamp(l: Lamp): Lamp {
    const out: Lamp = { ...l, position: [l.position[0], l.position[1] + this.oy, l.position[2]], zone: this.zone }
    this.ctx.lamps.push(out)
    return out
  }

  /** Separate mesh (not merged) for parts whose material animates per instance. */
  mesh(mat: THREE.Material, g: THREE.BufferGeometry) {
    g.translate(0, this.oy, 0)
    const mesh = new THREE.Mesh(g, mat)
    mesh.matrixAutoUpdate = false
    this.group.add(mesh)
    return mesh
  }

  flush(parent: THREE.Object3D = this.ctx.scene) {
    for (const p of this.parts.values()) {
      if (!p.pos.length) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3))
      g.setAttribute("normal", new THREE.Float32BufferAttribute(p.nor, 3))
      g.setAttribute("uv", new THREE.Float32BufferAttribute(p.uv, 2))
      if (p.vc) {
        g.setAttribute("color", new THREE.Float32BufferAttribute(p.col, 3))
        g.setAttribute("rm", new THREE.Float32BufferAttribute(p.rm, 2))
      }
      g.computeBoundingSphere()
      g.computeBoundingBox()
      const mesh = new THREE.Mesh(g, p.mat)
      mesh.name = `${this.group.name}:${p.mat.name}`
      mesh.castShadow = p.cast
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
    }
    this.parts.clear()
    parent.add(this.group)
  }
}

const UP = new THREE.Vector3(0, 1, 0)

/** A gap in a wall from `bottom` (default the floor) to `top`, both relative to the finished floor. */
export type Opening = { a0: number; a1: number; top: number; bottom?: number }

/**
 * A straight wall built from horizontal bands. `axis` "x" runs along X (c0..c1 is its Z thickness); "z" runs along Z.
 * Openings cut doorways and windows; colliders cover the solid segments (door leaves add their own).
 * `y0`/`y1` override the vertical extent (local heights) for walls that aren't floor-to-ceiling (stairwells).
 */
export function wall(
  b: Builder,
  axis: "x" | "z",
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  bands: readonly Band[],
  openings: Opening[] = [],
  extent?: { y0: number; y1: number; collide?: boolean },
) {
  const sorted = [...openings].sort((p, q) => p.a0 - q.a0)
  // End caps are recessed 2 mm: a wall's end usually butts into a perpendicular wall or the shell, where a flush cap is
  // coplanar with that wall's face and z-fights.
  const CAP = 0.002
  const seg = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return
    if (axis === "x") {
      b.box(mat, s0, y0, c0, s1, y1, c1, { skip: "Xx" })
      b.box(mat, s0 + CAP, y0, c0, s0 + CAP, y1, c1, { skip: "XYyZz" })
      b.box(mat, s1 - CAP, y0, c0, s1 - CAP, y1, c1, { skip: "xYyZz" })
    } else {
      b.box(mat, c0, y0, s0, c1, y1, s1, { skip: "Zz" })
      b.box(mat, c0, y0, s0 + CAP, c1, y1, s0 + CAP, { skip: "XxYyZ" })
      b.box(mat, c0, y0, s1 - CAP, c1, y1, s1 - CAP, { skip: "XxYyz" })
    }
  }
  const top = extent?.y1 ?? CEIL_Y + 0.02
  const base = extent?.y0 ?? FLOOR_Y - 0.01
  let mat: Mat = "painted_wall"
  let cursor = a0
  const spans: [number, number][] = []
  for (const o of sorted) {
    spans.push([cursor, o.a0])
    cursor = o.a1
  }
  spans.push([cursor, a1])
  bands.forEach(([y0r, y1r, m], bi) => {
    mat = m
    const y0 = bi === 0 ? base : Math.max(base, FLOOR_Y + y0r)
    const y1 = bi === bands.length - 1 || y1r >= CEIL_Y ? top : Math.min(top, FLOOR_Y + y1r)
    if (y1 <= y0) return
    for (const [s0, s1] of spans) seg(s0, s1, y0, y1)
    for (const o of sorted) {
      seg(o.a0, o.a1, Math.max(y0, FLOOR_Y + o.top), y1)
      if (o.bottom !== undefined) seg(o.a0, o.a1, y0, Math.min(y1, FLOOR_Y + o.bottom))
    }
  })
  if (extent?.collide === false) return
  for (const [s0, s1] of spans) {
    if (s1 - s0 < 1e-3) continue
    if (axis === "x") b.collide(s0, base, c0, s1, top, c1)
    else b.collide(c0, base, s0, c1, top, s1)
  }
  for (const o of sorted) {
    if (o.bottom === undefined) continue
    if (axis === "x") b.collide(o.a0, base, c0, o.a1, FLOOR_Y + o.bottom, c1)
    else b.collide(c0, base, o.a0, c1, FLOOR_Y + o.bottom, o.a1)
  }
}

/** Opening for a door frame centred at `a` (frame jambs included). */
export const doorOpening = (a: number, w = DOOR_W): Opening => ({ a0: a - w / 2 - 0.05, a1: a + w / 2 + 0.05, top: DOOR_H + 0.05 })

export type DoorOpts = {
  /** Frame rotation: local +X runs along the wall, local +Z points to the "front" (corridor) side. */
  rot: number
  wallT?: number
  width?: number
  leaves?: 1 | 2
  /** Initial opening in radians; positive swings the leaf to the back (-Z local) side. Becomes `startOpen`. */
  open?: number
  /** Full swing in radians (default max(1.6, |open|)). */
  angle?: number
  /** "fixed" where one side of the opening is blocked: the leaf only swings to the side `open`/`angle` gives. */
  swing?: "auto" | "fixed"
  locked?: boolean
  glass?: THREE.Material | null
  plate?: boolean
  /** Horizontal push bar instead of levers (fire exits). */
  panic?: boolean
  /** Leaf finish (default institutional green steel). */
  leaf?: Mat
  sound?: "steel" | "wood" | "glass"
  /** Stable door id (pairs get `${id}` and `${id}:b`). Default: auto. */
  id?: string
  /** Leaf thickness (default 45 mm; insulated cold-room doors ~0.1). */
  thickness?: number
}

const leafTemplates = new Map<string, THREE.Object3D[]>()
let doorSeq = 0

/** Leaf geometry in its own frame (hinge at the origin, panel along +x, faces ±z), built once per variant. */
function leafTemplate(ctx: WorldContext, lw: number, glass: THREE.Material | null, leafMat: Mat, panic: boolean, pair: boolean) {
  const key = `${lw.toFixed(3)}|${glass?.uuid ?? "-"}|${typeof leafMat === "string" ? leafMat : "paint" in leafMat ? leafMat.c.join() : leafMat.uuid}|${panic}|${pair}`
  const hit = leafTemplates.get(key)
  if (hit) return hit
  const t = 0.045
  const b = new Builder(ctx, "door-leaf")
  const L = new THREE.Matrix4()
  const cx = lw / 2
  b.boxM(leafMat, L, lw, DOOR_H - 0.01, t, cx, (DOOR_H - 0.01) / 2 + 0.005, 0)
  for (const s of [1, -1]) {
    const fz = s * (t / 2 + 0.002)
    b.boxM(M.kick, L, lw - 0.04, 0.25, 0.003, cx, 0.14, fz)
    if (panic && s > 0) {
      b.boxM(M.kick, L, 0.05, 0.08, 0.07, 0.08, 1.0, t / 2 + 0.035)
      b.boxM(M.kick, L, 0.05, 0.08, 0.07, lw - 0.08, 1.0, t / 2 + 0.035)
      b.rbox(M.darkSteel, L, lw - 0.16, 0.06, 0.05, 0.02, lw / 2, 1.0, t / 2 + 0.07)
    } else {
      b.boxM(M.kick, L, 0.05, 0.05, 0.05, lw - 0.07, 1.04, s * (t / 2 + 0.025))
      b.boxM(M.kick, L, 0.13, 0.022, 0.022, lw - 0.12, 1.04, s * (t / 2 + 0.05))
    }
    if (glass) {
      const gw = pair ? 0.2 : 0.3
      const gh = pair ? 0.7 : 0.46
      const gx = pair ? lw / 2 : lw * 0.56
      const gy = pair ? 1.45 : 1.6
      b.quad(glass, T(gx, gy, s * (t / 2 + 0.003), s > 0 ? 0 : Math.PI), gw, gh, { cast: false })
      b.boxM(leafMat, L, gw + 0.06, 0.03, 0.012, gx, gy + gh / 2 + 0.015, s * (t / 2 + 0.006))
      b.boxM(leafMat, L, gw + 0.06, 0.03, 0.012, gx, gy - gh / 2 - 0.015, s * (t / 2 + 0.006))
      b.boxM(leafMat, L, 0.03, gh, 0.012, gx - gw / 2 - 0.015, gy, s * (t / 2 + 0.006))
      b.boxM(leafMat, L, 0.03, gh, 0.012, gx + gw / 2 + 0.015, gy, s * (t / 2 + 0.006))
    }
  }
  const holder = new THREE.Group()
  b.flush(holder)
  const meshes = b.group.children.filter((c) => (c as THREE.Mesh).isMesh)
  leafTemplates.set(key, meshes)
  return meshes
}

/**
 * Institutional door: static frame and casings in the builder's batch; each leaf its own object registered with the
 * shared door system (`ctx.doors`, KeyE), which owns its swing and collider. Leaves of the same variant share
 * geometry.
 */
export function door(b: Builder, x: number, z: number, o: DoorOpts): string[] {
  const w = o.width ?? DOOR_W
  const t = o.thickness ?? 0.045
  const wallT = o.wallT ?? 0.15
  const leaves = o.leaves ?? 1
  const open = o.open ?? 0
  const y = FLOOR_Y
  const F = T(x, y, z, o.rot)
  const fd = wallT + 0.04
  // Frame
  // Jambs stop under the head and the casing legs under the casing head: overlapping pieces put coplanar faces on the
  // frame front at the top corners (z-fighting squares).
  b.boxM(M.frame, F, 0.05, DOOR_H, fd, -w / 2 - 0.025, DOOR_H / 2, 0)
  b.boxM(M.frame, F, 0.05, DOOR_H, fd, w / 2 + 0.025, DOOR_H / 2, 0)
  b.boxM(M.frame, F, w + 0.1, 0.05, fd, 0, DOOR_H + 0.025, 0)
  // Face casings: a 6 cm dark steel return on both wall faces, so the jamb reads as a heavy frame.
  for (const s of [1, -1]) {
    const zc = s * (fd / 2 + 0.006)
    b.boxM(M.frame, F, 0.06, DOOR_H + 0.05, 0.012, -w / 2 - 0.08, (DOOR_H + 0.05) / 2, zc)
    b.boxM(M.frame, F, 0.06, DOOR_H + 0.05, 0.012, w / 2 + 0.08, (DOOR_H + 0.05) / 2, zc)
    b.boxM(M.frame, F, w + 0.28, 0.06, 0.012, 0, DOOR_H + 0.08, zc)
  }
  if (o.plate ?? true) {
    b.boxM(M.plate, F, 0.16, 0.1, 0.012, w / 2 + 0.22, 1.5, wallT / 2 + 0.006)
    b.boxM(M.plate, F, 0.16, 0.1, 0.012, w / 2 + 0.22, 1.5, -wallT / 2 - 0.006)
  }
  const lw = w / leaves - (leaves === 2 ? 0.004 : 0.006)
  const glass = o.glass === undefined ? M.wireGlass : o.glass
  const tpl = leafTemplate(b.ctx, lw, glass, o.leaf ?? "door_steel", !!o.panic, leaves === 2)
  const angle = Math.max(o.angle ?? 1.6, Math.abs(open))
  const sign = open < 0 || (o.angle ?? 0) < 0 ? -1 : 1
  const ids = o.id ? (leaves === 2 ? [o.id, `${o.id}:b`] : [o.id]) : Array.from({ length: leaves }, () => `${b.group.name}:door${doorSeq++}`)
  const v = new THREE.Vector3()
  for (let i = 0; i < leaves; i++) {
    const mirror = i === 1
    const hingeX = mirror ? w / 2 - 0.003 : -w / 2 + 0.003
    v.set(hingeX, 0, 0).applyMatrix4(F)
    const leaf = new THREE.Group()
    leaf.name = ids[i]!
    for (const m of tpl) {
      const c = (m as THREE.Mesh).clone()
      c.matrixAutoUpdate = true
      leaf.add(c)
    }
    leaf.rotation.y = o.rot + (mirror ? Math.PI : 0)
    b.group.add(leaf)
    b.ctx.doors.add({
      id: ids[i],
      leaf,
      hinge: [v.x, v.y + b.oy, v.z],
      width: lw,
      height: DOOR_H,
      thickness: t,
      openAngle: (mirror ? -1 : 1) * sign * angle,
      startOpen: Math.min(1, Math.abs(open) / angle),
      swing: o.swing ?? "auto",
      locked: o.locked ?? false,
      sound: o.sound ?? (o.leaf === M.veneer ? "wood" : "steel"),
      ...(leaves === 2 ? { double: ids[1 - i] } : {}),
    })
  }
  return ids
}

/**
 * Drop ceiling with an exposed 0.6 × 1.2 m T-bar grid (global alignment: X lines at 0.3+0.6k, Z lines at 0.6+1.2k).
 * With `missing` > 0 the tiles are laid one by one and that fraction is left out (or lies on the floor, see `fallen`),
 * showing the plenum and the slab above.
 */
export function ceiling(b: Builder, x0: number, z0: number, x1: number, z1: number, missing = 0, seed = 1, fallen?: (x: number, z: number) => void) {
  const y0 = CEIL_Y - 0.006
  if (missing <= 0) b.box("ceiling_tile", x0, CEIL_Y, z0, x1, CEIL_Y + 0.03, z1, { cast: false, skip: "XxYZz" })
  else {
    let s = seed * 9973 + 7
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const xs = [x0]
    for (let k = Math.ceil((x0 - 0.3) / 0.6); 0.3 + k * 0.6 < x1; k++) if (0.3 + k * 0.6 - x0 > 0.05) xs.push(0.3 + k * 0.6)
    xs.push(x1)
    const zs = [z0]
    for (let k = Math.ceil((z0 - 0.6) / 1.2); 0.6 + k * 1.2 < z1; k++) if (0.6 + k * 1.2 - z0 > 0.05) zs.push(0.6 + k * 1.2)
    zs.push(z1)
    for (let i = 0; i < xs.length - 1; i++)
      for (let j = 0; j < zs.length - 1; j++) {
        const r = rnd()
        const cx = (xs[i]! + xs[i + 1]!) / 2
        const cz = (zs[j]! + zs[j + 1]!) / 2
        if (r < missing) {
          if (fallen && r < missing * 0.45) fallen(cx, cz)
          continue
        }
        // Water-stained or sagging tiles sit a little lower and darker.
        const sag = r > 0.93 ? 0.015 : 0
        b.box(r > 0.88 ? M.stain : "ceiling_tile", xs[i]!, CEIL_Y - sag, zs[j]!, xs[i + 1]!, CEIL_Y + 0.02 - sag, zs[j + 1]!, { cast: false, skip: "Y" })
      }
  }
  for (let k = Math.ceil((x0 - 0.3) / 0.6); 0.3 + k * 0.6 < x1; k++) {
    const x = 0.3 + k * 0.6
    if (x - x0 < 0.05) continue
    b.box(M.tbar, x - 0.012, y0, z0, x + 0.012, CEIL_Y, z1, { cast: false, skip: "YZz" })
  }
  for (let k = Math.ceil((z0 - 0.6) / 1.2); 0.6 + k * 1.2 < z1; k++) {
    const z = 0.6 + k * 1.2
    if (z - z0 < 0.05) continue
    // Cross tees hang 3 mm lower than the mains, so their undersides don't fight at every crossing.
    b.box(M.tbar, x0, y0 - 0.003, z - 0.012, x1, CEIL_Y, z + 0.012, { cast: false, skip: "XxY" })
  }
}

export type TrofferState = "on" | "off" | { flicker: number; level: THREE.UniformNode<"float", number>; material: THREE.Material }

/** Recessed 0.6 × 1.2 m troffer (long side along Z) at grid-aligned (x, z). */
export function troffer(b: Builder, x: number, z: number, state: TrofferState, on: THREE.Material) {
  const y = CEIL_Y - 0.004
  b.box(M.housing, x - 0.31, y - 0.02, z - 0.61, x + 0.31, y, z - 0.585, { cast: false })
  b.box(M.housing, x - 0.31, y - 0.02, z + 0.585, x + 0.31, y, z + 0.61, { cast: false })
  b.box(M.housing, x - 0.31, y - 0.02, z - 0.585, x - 0.285, y, z + 0.585, { cast: false })
  b.box(M.housing, x + 0.285, y - 0.02, z - 0.585, x + 0.31, y, z + 0.585, { cast: false })
  const pm = T(x, y - 0.006, z, 0, Math.PI / 2)
  if (state === "off") b.quad(M.diffuserOff, pm, 0.57, 1.17, { cast: false })
  else if (state === "on") b.quad(on, pm, 0.57, 1.17, { cast: false })
  else {
    const g = new THREE.PlaneGeometry(0.57, 1.17)
    g.applyMatrix4(pm)
    b.mesh(state.material, g)
  }
}

/** Parabolic louvre over a troffer: specular aluminium blades in a 3 × 8 cell grid (1980s office fittings). */
export function louvre(b: Builder, x: number, z: number) {
  const y1 = CEIL_Y - 0.012
  const y0 = y1 - 0.055
  for (let k = 1; k < 3; k++) b.box(M.steel, x - 0.285 + k * 0.19 - 0.004, y0, z - 0.58, x - 0.285 + k * 0.19 + 0.004, y1, z + 0.58, { cast: false })
  for (let k = 1; k < 8; k++) b.box(M.steel, x - 0.285, y0, z - 0.585 + k * 0.146 - 0.004, x + 0.285, y1, z - 0.585 + k * 0.146 + 0.004, { cast: false })
}

/** Cheap deterministic flicker: mostly on, with stuttering bursts. Returns 0..1. */
export function flicker(t: number, seed: number, amount: number) {
  const slow = Math.sin(t * 0.9 + seed * 1.3) * Math.sin(t * 0.37 + seed * 2.1)
  const frame = Math.floor(t * 18)
  const n = fract1(Math.sin((frame + seed * 131) * 12.9898) * 43758.5453)
  const burst = slow > 0.35
  const on = burst ? (n > 0.5 ? 1 : n > 0.3 ? 0.35 : 0.05) : n > 0.02 ? 1 : 0.4
  return 1 - amount * (1 - on)
}

const fract1 = (v: number) => v - Math.floor(v)

export { staticGlass }
