// Aircraft rendering: lazy GLB loading, per-kind template baking (material dedupe + geometry merge into a
// rigid-skinned mesh per material), toon shading, team livery and per-frame animation.
//
// Every aircraft instance is one SkinnedMesh per distinct material (+1 outline), sharing geometry. Animated
// parts (rotors, turrets, gear, pilots, stores, afterburners, fins...) are bones with rigid weights, so
// spinning/aiming/hiding (scale 0) costs no extra draw calls.
import {
  AdditiveBlending,
  BackSide,
  CustomBlending,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  Bone,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DetachedBindMode,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Uint16BufferAttribute,
  Vector3,
  type Camera,
  type Material,
  type MeshStandardMaterial,
} from "three/webgpu"
import { abs, dot, float, mix, modelViewMatrix, normalLocal, normalView, normalize, positionLocal, positionViewDirection, smoothstep, uniform, vec4, max as tslMax, modelScale } from "three/tsl"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { mergeGeometries, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js"
import type { PlayerInfo, Quality, SeatIndex, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { groundHeight } from "../sim/geography"
import { SUN_DIRECTION } from "./world/settings"
import { createBlobShadow } from "./aircraft-shadow"
import { createGlassMaterial, createGlowMaterial, createPaintMaterial, paintColor } from "./toon"
export { setAircraftEnvironment } from "./toon"

/** Muted team colors ("Muted Tactical" palette): blue, orange, green, red. Used by HUD/UI too. */
export const TEAM_COLORS = ["#3c6ea8", "#c98a2e", "#4e8a5a", "#b04a44"] as const
/** Team marking paint (fins, wingtips, nose stripe only). */
export const TEAM_LIVERY = TEAM_COLORS

export interface AircraftView {
  root: Object3D
  /** Called every render frame with the interpolated entity. Animates rotors/props/turrets/gear/afterburners. */
  update(vehicle: VehicleEntity, players: PlayerInfo[], dt: number, camera: Camera): void
  dispose(): void
  /** Firing hint from the client (e.g. spins the GAU-8 barrels while held). */
  setFiring(seat: SeatIndex, slot: number, on: boolean): void
  /** Afterburner/boost hint. Without it, boost is inferred from throttle > 0.95. */
  setBoost(on: boolean): void
  /**
   * Named attachment points that follow the model (world transforms valid after update()).
   * Always present: "gun" (primary gun muzzle). Others per kind, e.g. "afterburner_L", "exhaust_L",
   * "turret_chin_barrel", "targeting_pod_head", "flares_L", "rocket_pod_L".
   */
  anchors: Map<string, Object3D>
  /** True once the real model replaced the placeholder. */
  readonly ready: boolean
  /**
   * Mark the local player's own aircraft. Call `view.setLocal(true)` right after creating the view for
   * the vehicle the player occupies (and `false` when they leave it). Local aircraft are never
   * distance-scaled; remote aircraft grow up to 1.6x between 500 m and 1.5 km for readability.
   */
  setLocal(local: boolean): void
  /**
   * Recon "spotted" highlight: a thin safety-orange silhouette rim that stays visible through terrain and
   * clouds (occluded parts show as a faint orange x-ray fill). Call `view.setSpotted(true)` while the
   * local player's team has this enemy spotted (`vehicle.spottedUntil > roomTime`), `false` otherwise.
   * Fades in/out over 0.3 s; costs one extra draw call only while visible.
   */
  setSpotted(on: boolean): void
}

let groundQuery: (x: number, z: number) => number = groundHeight

/** Override the surface height used for ground shadows (e.g. dev previews with a flat ground). */
export function setAircraftGroundQuery(fn: (x: number, z: number) => number): void {
  groundQuery = fn
}

export interface AircraftStats {
  drawCalls: number
  /** Opaque + transparent model triangles (excluding outline). */
  triangles: number
  outlineTriangles: number
  bones: number
  materials: number
  sourceNodes: number
  sourceMeshes: number
  sourceMaterials: number
}

// ---------------------------------------------------------------------------------------------------------
// Per-kind rig configuration

type Axis = "x" | "y" | "z"

interface StoreGroup {
  /** weapons[seat][slot] entries whose summed ammo maps onto these stores. */
  weapons: [SeatIndex, number][]
  /** Store node names in firing order (first one disappears first). */
  order: string[]
}

interface Spinner {
  name: string
  axis: Axis
  /** rad/s at full speed (sign = direction). */
  speed: number
  driver: "rotor" | "engine" | "gun"
}

interface Afterburner {
  name: string
  /** Bone-local axis along which the flame stretches. */
  axis: Axis
  /** Generate an additive flame cone behind the disc (bone-local direction of the cone). */
  cone?: { dir: Axis; sign: 1 | -1; length: number }
}

interface AnchorDef {
  key: string
  node: string
  /** Place at the front-most point (min local -Z) of the node's subtree instead of its origin. */
  tip?: boolean
}

interface KindConfig {
  file: string
  pivots: string[]
  /** Mesh name → pivot name overrides (for siblings that should move with a pivot). */
  attach?: Record<string, string>
  stores: StoreGroup[]
  spinners: Spinner[]
  afterburners: Afterburner[]
  turret?: { yaw: string; pitch: string; seat: SeatIndex; yawMax: number; pitchMin: number; pitchMax: number }
  ballPod?: { name: string; seat: SeatIndex; maxUp: number }
  rollPod?: { name: string; seat: SeatIndex }
  rudders?: { names: string[]; gain: number; max: number }
  /** Hinged doors (bomb bay) that swing open while `seat` is firing/aiming: bone-local axis, open angle per door. */
  doors?: { names: [string, number][]; axis: Axis; seat: SeatIndex }
  anchors: AnchorDef[]
  placeholder: { length: number; span: number; heli: boolean }
  /** Ground blob size [span, length] in meters. */
  shadow: [number, number]
}

const CONFIG: Record<VehicleKind, KindConfig> = {
  fighter: {
    file: "fa18",
    pivots: [
      "gear", "pilot_1", "pilot_2", "targeting_pod_head", "afterburner_L", "afterburner_R",
      "missile_L1", "missile_L2", "missile_R1", "missile_R2", "wingtip_missile_L", "wingtip_missile_R",
    ],
    stores: [
      { weapons: [[0, 1]], order: ["missile_L2", "missile_R2", "wingtip_missile_L", "wingtip_missile_R"] },
      { weapons: [[1, 0], [1, 1]], order: ["missile_L1", "missile_R1"] },
    ],
    spinners: [],
    afterburners: [
      { name: "afterburner_L", axis: "y", cone: { dir: "y", sign: -1, length: 1.5 } },
      { name: "afterburner_R", axis: "y", cone: { dir: "y", sign: -1, length: 1.5 } },
    ],
    ballPod: { name: "targeting_pod_head", seat: 1, maxUp: 0.15 },
    anchors: [
      { key: "gun", node: "gun_muzzle" },
      { key: "afterburner_L", node: "afterburner_L" },
      { key: "afterburner_R", node: "afterburner_R" },
      { key: "targeting_pod_head", node: "targeting_pod_head" },
    ],
    placeholder: { length: 17.5, span: 13, heli: false },
    shadow: [14, 18],
  },
  apache: {
    file: "apache",
    pivots: [
      "main_rotor", "tail_rotor", "turret_chin", "turret_chin_pitch", "pilot_1", "pilot_2", "gear",
      "hellfire_L1", "hellfire_L2", "hellfire_L3", "hellfire_L4", "hellfire_R1", "hellfire_R2", "hellfire_R3", "hellfire_R4",
    ],
    stores: [
      {
        weapons: [[1, 1]],
        order: ["hellfire_L4", "hellfire_R4", "hellfire_L3", "hellfire_R3", "hellfire_L2", "hellfire_R2", "hellfire_L1", "hellfire_R1"],
      },
    ],
    spinners: [
      { name: "main_rotor", axis: "y", speed: -30, driver: "rotor" },
      { name: "tail_rotor", axis: "x", speed: 70, driver: "rotor" },
    ],
    afterburners: [],
    turret: { yaw: "turret_chin", pitch: "turret_chin_pitch", seat: 1, yawMax: 1.92, pitchMin: -1.05, pitchMax: 0.19 },
    anchors: [
      { key: "gun", node: "turret_chin_barrel", tip: true },
      { key: "turret_chin_barrel", node: "turret_chin_barrel", tip: true },
      { key: "rocket_pod_L", node: "rocket_pod_L", tip: true },
      { key: "rocket_pod_R", node: "rocket_pod_R", tip: true },
      { key: "exhaust_L", node: "exhaust_L" },
      { key: "exhaust_R", node: "exhaust_R" },
      { key: "main_rotor", node: "main_rotor" },
    ],
    placeholder: { length: 16, span: 5.2, heli: true },
    shadow: [13, 16],
  },
  warthog: {
    file: "a10",
    pivots: ["gau8_barrels", "engine_fan_L", "engine_fan_R", "pilot_1", "pilot_2", "gear", "missile_L1", "missile_R1", "targeting_pod_head"],
    attach: { targeting_pod_window: "targeting_pod_head" },
    stores: [{ weapons: [[1, 0], [1, 1]], order: ["missile_R1", "missile_L1"] }],
    spinners: [
      { name: "gau8_barrels", axis: "z", speed: 45, driver: "gun" },
      { name: "engine_fan_L", axis: "z", speed: 40, driver: "engine" },
      { name: "engine_fan_R", axis: "z", speed: -40, driver: "engine" },
    ],
    afterburners: [],
    rollPod: { name: "targeting_pod_head", seat: 1 },
    anchors: [
      { key: "gun", node: "gau8_barrels", tip: true },
      { key: "exhaust_L", node: "engine_exhaust_cone_L" },
      { key: "exhaust_R", node: "engine_exhaust_cone_R" },
      { key: "rocket_pod_L", node: "rocket_pod_L1", tip: true },
      { key: "rocket_pod_R", node: "rocket_pod_R1", tip: true },
      { key: "flares_L", node: "flares_L" },
      { key: "flares_R", node: "flares_R" },
      { key: "targeting_pod_head", node: "targeting_pod_head" },
    ],
    placeholder: { length: 16.3, span: 17.5, heli: false },
    shadow: [18.5, 16.5],
  },
  blackbird: {
    file: "yf12",
    pivots: ["afterburner_L", "afterburner_R", "fin_L", "fin_R", "missile_1", "missile_2", "missile_3", "pilot_1", "pilot_2", "gear"],
    stores: [{ weapons: [[0, 0], [0, 1]], order: ["missile_3", "missile_2", "missile_1"] }],
    spinners: [],
    afterburners: [
      { name: "afterburner_L", axis: "z", cone: { dir: "z", sign: 1, length: 2.4 } },
      { name: "afterburner_R", axis: "z", cone: { dir: "z", sign: 1, length: 2.4 } },
    ],
    rudders: { names: ["fin_L", "fin_R"], gain: -0.9, max: 0.4 },
    anchors: [
      { key: "gun", node: "pitot_tube" },
      { key: "afterburner_L", node: "afterburner_L" },
      { key: "afterburner_R", node: "afterburner_R" },
      { key: "missile_bay_L", node: "missile_bay_L" },
      { key: "missile_bay_R", node: "missile_bay_R" },
    ],
    placeholder: { length: 31, span: 17, heli: false },
    shadow: [17, 30],
  },
  bomber: {
    file: "b2",
    pivots: [
      "pilot_1", "pilot_2", "gear", "bomb_bay_doors_L", "bomb_bay_doors_R",
      "bomb_1", "bomb_2", "bomb_3", "bomb_4", "bomb_5", "bomb_6", "bomb_7", "bomb_8",
    ],
    stores: [{ weapons: [[1, 0]], order: ["bomb_8", "bomb_7", "bomb_6", "bomb_5", "bomb_4", "bomb_3", "bomb_2", "bomb_1"] }],
    spinners: [],
    // No afterburner: the four buried exhausts are dim glow parts (role "glow" via their exhaust_* names).
    afterburners: [],
    doors: { names: [["bomb_bay_doors_L", 1.45], ["bomb_bay_doors_R", -1.45]], axis: "z", seat: 1 },
    anchors: [
      { key: "gun", node: "b2", tip: true },
      { key: "exhaust_L", node: "exhaust_1" },
      { key: "exhaust_R", node: "exhaust_4" },
      { key: "bomb_bay", node: "bombs" },
    ],
    placeholder: { length: 21, span: 52, heli: false },
    shadow: [52, 21],
  },
}

// ---------------------------------------------------------------------------------------------------------
// Template baking

type MatRole = "toon" | "livery" | "glass" | "afterburner" | "flame" | "nav" | "strobe" | "glow"

interface TemplateMesh {
  geometry: BufferGeometry
  role: MatRole
  /** Shared material (toon/glass) or source description for per-instance/team materials. */
  shared: Material | null
  glowColor: Color
}

interface TemplateBone {
  name: string
  parent: number
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
  /** Rest rotation of the bone relative to the aircraft root. */
  restToRootQ: Quaternion
}

interface TemplateAnchor {
  key: string
  bone: number
  matrix: Matrix4
}

interface Template {
  kind: VehicleKind
  bones: TemplateBone[]
  boneIndex: Map<string, number>
  boneInverses: Matrix4[]
  meshes: TemplateMesh[]
  outline: BufferGeometry | null
  /** Lazily built silhouette hull (shape + skin attributes, smoothed normals) for the spotted highlight. */
  silhouette?: BufferGeometry
  sphere: Sphere
  anchors: TemplateAnchor[]
  stats: AircraftStats
}

const templates = new Map<VehicleKind, Template>()
const loading = new Map<VehicleKind, Promise<Template | null>>()
const readyListeners = new Map<VehicleKind, Set<(t: Template) => void>>()
let baseUrlDefault = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL) ?? "/"

const paintCache = new Map<string, Material>()
const liveryCache = new Map<number, Material>()

/** Group whose paint is the airframe's top color. */
const TOP_PAINT = /^(fuselage|fuselage_top|fuselage_upper)$/

/** Per-mesh color overrides (baked into vertex colors; free). */
const PART_COLORS: [RegExp, string, VehicleKind[]?][] = [
  [/^spine_band$/, "#8f979d", ["fighter"]],
  [/^(flap|aileron|stab)_line_[LR]$/, "#5c656c", ["fighter"]],
  [/^panel_band_(aft|tail)$|^engine_panel_band_[LR]$/, "#4f5649", ["warthog"]],
  [/^tail_boom_band_(front|rear)$|^nacelle_band_[LR]$/, "#4a5040", ["apache"]],
  [/^livery_rotor_tip_\d$/, "#c7c9c4", ["apache"]], // rotor tips: light gray, not team color
  [/^pilot_\d_helmet$/, "#d9dbd7"],
  [/^pilot_\d_visor$/, "#1e2124"],
]

/** Group color overrides (recolor a whole deduped material group; free). "Muted Tactical" base colors. */
const COLOR_OVERRIDES: [RegExp, string, VehicleKind[]?][] = [
  [/^pilot_\d_torso$/, "#5c6448", ["fighter", "apache", "warthog"]], // flight suit
  [/^pilot_\d_torso$/, "#9a8a5c", ["blackbird"]], // muted pressure suit
  [/^fuselage$/, "#6b7782", ["fighter"]], // muted blue-gray
  [/^fuselage_belly$/, "#c3c7c5", ["fighter"]],
  [/^fuselage_top$/, "#5e6658", ["warthog"]], // base olive
  [/^fuselage_belly$/, "#b5b9b0", ["warthog"]],
  [/^fuselage_upper$/, "#565d47", ["apache"]], // darker olive drab
  [/^fuselage_belly$/, "#8d927f", ["apache"]],
  [/^fuselage$/, "#2e3135", ["blackbird"]], // charcoal
  [/^fuselage_belly$/, "#4c5054", ["blackbird"]],
]

/** Paint for painted parts vs bare metal (gunmetal, exhausts, gear), both baked into vertex colors. */
function bodyMaterial(metal: boolean): Material {
  const key = metal ? "body-metal" : "body-paint"
  let m = paintCache.get(key)
  if (!m) {
    m = metal
      ? createPaintMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.48, metalness: 0.55, wet: 0.4, envIntensity: 1.0 })
      : createPaintMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.68, metalness: 0.05, wet: 0.55 })
    paintCache.set(key, m)
  }
  return m
}

function liveryMaterial(team: TeamId): Material {
  let m = liveryCache.get(team)
  if (!m) {
    m = createPaintMaterial({ color: TEAM_LIVERY[team], roughness: 0.66, metalness: 0.05, wet: 0.55 })
    liveryCache.set(team, m)
  }
  return m
}

function nameChain(o: Object3D, stop: Object3D): string[] {
  const out: string[] = []
  let n: Object3D | null = o
  while (n && n !== stop) {
    out.push(n.name)
    n = n.parent
  }
  return out
}

/** Copies position/normal into fresh non-interleaved arrays, bakes the matrix and adds rigid skin weights. */
function prepGeometry(source: BufferGeometry, m: Matrix4, bone: number, smooth = false): BufferGeometry {
  // Smooth curved primitives (lathes, capsules) while keeping hard edges on boxes/wing edges.
  const src = smooth ? toCreasedNormals(source.index ? source.toNonIndexed() : source, CREASE_ANGLE) : source
  const pos = src.getAttribute("position")
  const nrm = src.getAttribute("normal")
  const n = pos.count
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    p[i * 3] = pos.getX(i)
    p[i * 3 + 1] = pos.getY(i)
    p[i * 3 + 2] = pos.getZ(i)
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new Float32BufferAttribute(p, 3))
  if (src.index) {
    const idx = new Uint32Array(src.index.count)
    for (let i = 0; i < idx.length; i++) idx[i] = src.index.getX(i)
    g.setIndex(Array.from(idx))
  } else {
    const idx: number[] = []
    for (let i = 0; i < n; i++) idx.push(i)
    g.setIndex(idx)
  }
  if (nrm) {
    const q = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      q[i * 3] = nrm.getX(i)
      q[i * 3 + 1] = nrm.getY(i)
      q[i * 3 + 2] = nrm.getZ(i)
    }
    g.setAttribute("normal", new Float32BufferAttribute(q, 3))
  } else {
    g.computeVertexNormals()
  }
  g.applyMatrix4(m)
  if (m.determinant() < 0) {
    const index = g.index!
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i + 1)
      index.setX(i + 1, index.getX(i + 2))
      index.setX(i + 2, a)
    }
  }
  const si = new Uint16Array(n * 4)
  const sw = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    si[i * 4] = bone
    sw[i * 4] = 1
  }
  g.setAttribute("skinIndex", new Uint16BufferAttribute(si, 4))
  g.setAttribute("skinWeight", new Float32BufferAttribute(sw, 4))
  return g
}

/** Base (unscaled) emissive colors; intensities above 1 are applied per frame for bloom. */
function softGlow(role: MatRole, c: Color): Color {
  if (role === "nav" || role === "strobe" || role === "glow") return c.lerp(new Color(1, 1, 1), 0.15)
  if (role === "afterburner" || role === "flame") return new Color(AFTERBURNER_CORE)
  return c
}

function hex(c: Color): string {
  return c.getHexString()
}

function buildTemplate(kind: VehicleKind, scene: Object3D): Template {
  const cfg = CONFIG[kind]
  const root = scene.getObjectByName(cfg.file) ?? scene
  root.updateMatrixWorld(true)
  const rootInv = new Matrix4().copy(root.matrixWorld).invert()
  const toRoot = (o: Object3D) => new Matrix4().multiplyMatrices(rootInv, o.matrixWorld)
  /** Front-center (center X/Y, front-most Z in aircraft space) of a subtree, in the node's local frame. */
  const subtreeCenter = (node: Object3D): Vector3 | null => {
    const box = new Box3()
    const v = new Vector3()
    node.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      const m = toRoot(mesh)
      const pos = mesh.geometry.getAttribute("position")
      for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m))
    })
    if (box.isEmpty()) return null
    const p = new Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z)
    return p.applyMatrix4(toRoot(node).invert())
  }

  let sourceNodes = 0
  let sourceMeshes = 0
  const sourceMats = new Set<Material>()
  root.traverse((o) => {
    sourceNodes++
    const mesh = o as Mesh
    if (mesh.isMesh) {
      sourceMeshes++
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) sourceMats.add(m)
    }
  })

  // Bones: root + configured pivots, parented to the nearest pivot ancestor.
  const pivotSet = new Set(cfg.pivots)
  const bones: TemplateBone[] = []
  const boneIndex = new Map<string, number>()
  const boneToRoot: Matrix4[] = []
  const boneObj: Object3D[] = []
  bones.push({ name: "__root", parent: -1, position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1), restToRootQ: new Quaternion() })
  boneToRoot.push(new Matrix4())
  boneObj.push(root)
  const nearestPivot = (o: Object3D | null): number => {
    let n = o
    while (n && n !== root) {
      const idx = boneIndex.get(n.name)
      if (idx !== undefined && boneObj[idx] === n) return idx
      n = n.parent
    }
    return 0
  }
  root.traverse((o) => {
    if (o === root || !pivotSet.has(o.name) || boneIndex.has(o.name)) return
    const parent = nearestPivot(o.parent)
    const m = toRoot(o)
    if (cfg.afterburners.some((a) => a.name === o.name)) {
      // Scale afterburners about their geometry center, not the (possibly distant) node origin.
      const c = subtreeCenter(o)
      if (c) m.multiply(new Matrix4().makeTranslation(c.x, c.y, c.z))
    }
    const local = new Matrix4().copy(boneToRoot[parent]).invert().multiply(m)
    const b: TemplateBone = { name: o.name, parent, position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(), restToRootQ: new Quaternion() }
    local.decompose(b.position, b.quaternion, b.scale)
    const tmpP = new Vector3()
    const tmpS = new Vector3()
    m.decompose(tmpP, b.restToRootQ, tmpS)
    boneIndex.set(o.name, bones.length)
    bones.push(b)
    boneToRoot.push(m)
    boneObj.push(o)
  })
  for (const p of cfg.pivots) if (!boneIndex.has(p)) console.warn(`[aircraft] ${kind}: pivot "${p}" not found`)
  const boneInverses = boneToRoot.map((m) => new Matrix4().copy(m).invert())

  // Group meshes by material value.
  interface Bucket {
    role: MatRole
    shared: Material | null
    glowColor: Color
    geoms: BufferGeometry[]
    names: string[]
    srcColor: Color
    key: string
    metal?: boolean
  }
  const buckets = new Map<string, Bucket>()
  const attach = cfg.attach ?? {}

  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    const chain = nameChain(mesh, root)
    let bone = nearestPivot(mesh)
    const override = attach[mesh.name]
    if (override && boneIndex.has(override)) bone = boneIndex.get(override)!
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial
    // Team markings on fins/wingtips/nose only; rotor tips are painted like the airframe.
    const isLivery = chain.some((n) => n.startsWith("livery_")) && !/rotor_tip/.test(mesh.name)
    const emissive = src.emissive ? src.emissive.clone() : new Color(0)
    const isGlow = emissive.r + emissive.g + emissive.b > 0.05
    const isGlass = !isGlow && (src.transparent || src.opacity < 0.99)
    let role: MatRole = "toon"
    if (isLivery) role = "livery"
    else if (isGlass) role = "glass"
    else if (isGlow) {
      if (chain.some((n) => n.startsWith("afterburner"))) role = cfg.afterburners.some((a) => a.cone) ? "afterburner" : "flame"
      else if (chain.some((n) => n === "navlight_tail")) role = "strobe"
      else if (chain.some((n) => n.startsWith("navlight"))) role = "nav"
      else role = "glow"
      // Buried stealth exhausts (B-2): a faint warm glow, not an afterburner.
      if (role === "glow" && chain.some((n) => n.startsWith("exhaust_"))) emissive.multiplyScalar(0.35)
    }
    const color = src.color ? src.color : new Color(1, 1, 1)
    const rough = src.roughness ?? 0.55
    const metal = src.metalness ?? 0
    const key =
      role === "toon" || role === "glass"
        ? `${role}:${hex(color)}:${rough.toFixed(2)}:${metal.toFixed(2)}:${src.opacity.toFixed(2)}`
        : role === "livery" || role === "nav"
          ? role
          : `${role}:${hex(emissive)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      const shared: Material | null = null
      const glowColor = isGlow ? softGlow(role, emissive.clone().lerp(color, 0.25)) : color.clone()
      bucket = { role, shared, glowColor, geoms: [], names: [], srcColor: color.clone(), key, metal: metal >= 0.4 }
      buckets.set(key, bucket)
    }
    const g = prepGeometry(mesh.geometry, toRoot(mesh), bone, role === "toon" || role === "livery" || role === "glass")
    if (role === "nav") {
      // Red and green nav lights share one mesh: their color lives in vertex colors.
      const c = softGlow(role, emissive.clone().lerp(color, 0.25))
      const n = g.getAttribute("position").count
      const col = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3)
      g.setAttribute("color", new Float32BufferAttribute(col, 3))
      bucket.glowColor.set(1, 1, 1)
    }
    bucket.geoms.push(g)
    bucket.names.push(mesh.name)
  })

  // Opaque parts: every deduped group gets its paint color (or a group override) baked into vertex
  // colors, then merged into two meshes: painted surfaces and bare metal. Per-part recolors are free.
  const paint: Bucket = { role: "toon", shared: bodyMaterial(false), glowColor: new Color(1, 1, 1), geoms: [], names: [], srcColor: new Color(1, 1, 1), key: "paint", metal: false }
  const metal: Bucket = { role: "toon", shared: bodyMaterial(true), glowColor: new Color(1, 1, 1), geoms: [], names: [], srcColor: new Color(1, 1, 1), key: "metal", metal: true }
  const kindMatch = (kinds?: VehicleKind[]) => !kinds || kinds.includes(kind)
  for (const [key, b] of [...buckets]) {
    if (b.role !== "toon") continue
    const override = COLOR_OVERRIDES.find(([re, , kinds]) => kindMatch(kinds) && b.names.some((n) => re.test(n)))?.[1]
    const isTop = b.names.some((n) => TOP_PAINT.test(n))
    const target = b.metal && !isTop ? metal : paint
    const groupColor = override ? new Color(override) : paintColor(b.srcColor, target === metal ? "metal" : "hull")
    b.geoms.forEach((g, i) => {
      const name = b.names[i]
      const partHex = PART_COLORS.find(([re, , kinds]) => kindMatch(kinds) && re.test(name))?.[1]
      const c = partHex ? new Color(partHex) : groupColor
      const n = g.getAttribute("position").count
      const col = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) {
        col[k * 3] = c.r
        col[k * 3 + 1] = c.g
        col[k * 3 + 2] = c.b
      }
      g.setAttribute("color", new Float32BufferAttribute(col, 3))
      // Visors/helmets read best glossy: route them to the metal (glossier) mesh.
      const dest = /visor/.test(name) ? metal : target
      dest.geoms.push(g)
      dest.names.push(name)
    })
    buckets.delete(key)
  }
  if (paint.geoms.length) buckets.set("paint", paint)
  if (metal.geoms.length) buckets.set("metal", metal)

  for (const b of buckets.values()) {
    if (b.role !== "glass") continue
    let shared = paintCache.get("glass") ?? null
    if (!shared) {
      shared = createGlassMaterial()
      paintCache.set("glass", shared)
    }
    b.shared = shared
  }

  // Procedural flame cones (additive) behind afterburner discs.
  const flameGeoms: BufferGeometry[] = []
  for (const ab of cfg.afterburners) {
    if (!ab.cone) continue
    const bi = boneIndex.get(ab.name)
    if (bi === undefined) continue
    const obj = boneObj[bi]
    // Flame radius from the afterburner subtree's cross-section (aircraft X/Y extent).
    let radius = 0.4
    const box = new Box3()
    const v = new Vector3()
    obj.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      const m = toRoot(mesh)
      const pos = mesh.geometry.getAttribute("position")
      for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m))
    })
    if (!box.isEmpty()) radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 0.5 * 0.7
    const outer = new Color("#ff8a3a")
    const inner = new Color(AFTERBURNER_CORE)
    for (const [r, len, seg, col] of [[radius, ab.cone.length, 16, outer], [radius * 0.55, ab.cone.length * 0.6, 12, inner]] as const) {
      const cone = new ConeGeometry(r, len, seg, 4, true)
      // Additive blending: fade to black toward the tip.
      const cp = cone.getAttribute("position")
      const colors = new Float32Array(cp.count * 3)
      for (let i = 0; i < cp.count; i++) {
        // Clamp: float error at the apex can give 1 - 1.0000001 < 0, and pow(negative, 1.8) is NaN — a NaN vertex
        // color makes NaN HDR pixels that bloom smears over the whole frame (black flashes).
        const k = Math.pow(Math.max(0, 1 - (cp.getY(i) + len / 2) / len), 1.8)
        colors[i * 3] = col.r * k
        colors[i * 3 + 1] = col.g * k
        colors[i * 3 + 2] = col.b * k
      }
      cone.setAttribute("color", new Float32BufferAttribute(colors, 3))
      // ConeGeometry tip is +Y; point it along sign*dir and put the base at the origin.
      if (ab.cone.sign < 0) cone.rotateX(Math.PI)
      cone.translate(0, (ab.cone.sign * len) / 2, 0)
      if (ab.cone.dir === "z") cone.rotateX(Math.PI / 2)
      if (ab.cone.dir === "x") cone.rotateZ(-Math.PI / 2)
      const g = prepGeometry(cone, boneToRoot[bi], bi)
      g.setAttribute("color", cone.getAttribute("color"))
      flameGeoms.push(g)
    }
  }
  if (flameGeoms.length) {
    buckets.set("flame:procedural", { role: "flame", shared: null, glowColor: new Color(1, 1, 1), geoms: flameGeoms, names: [], srcColor: new Color(1, 1, 1), key: "flame:procedural" })
  }

  const meshes: TemplateMesh[] = []
  let triangles = 0
  const sphere = new Sphere()
  const order: MatRole[] = ["toon", "livery", "nav", "strobe", "glow", "afterburner", "glass", "flame"]
  const sorted = [...buckets.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  for (const b of sorted) {
    const merged = b.geoms.length === 1 ? b.geoms[0] : mergeGeometries(b.geoms, false)
    if (!merged) continue
    merged.computeBoundingSphere()
    if (sphere.isEmpty()) sphere.copy(merged.boundingSphere!)
    else sphere.union(merged.boundingSphere!)
    triangles += merged.index!.count / 3
    meshes.push({ geometry: merged, role: b.role, shared: b.shared, glowColor: b.glowColor })
  }
  sphere.radius += 1.5

  for (const b of buckets.values()) for (const g of b.geoms) if (!meshes.some((m) => m.geometry === g)) g.dispose()

  // Anchors.
  const anchors: TemplateAnchor[] = []
  for (const a of cfg.anchors) {
    const node = root.getObjectByName(a.node)
    if (!node) {
      console.warn(`[aircraft] ${kind}: anchor node "${a.node}" not found`)
      continue
    }
    const bone = nearestPivot(node)
    const nodeToRoot = toRoot(node)
    if (a.tip) {
      // Front-most point (min Z in the node frame) of the subtree, centered on its X/Y extent.
      const inv = new Matrix4().copy(node.matrixWorld).invert()
      const v = new Vector3()
      let minZ = Infinity
      let cx = 0
      let cy = 0
      let cnt = 0
      node.traverse((o) => {
        const mesh = o as Mesh
        if (!mesh.isMesh) return
        const pos = mesh.geometry.getAttribute("position")
        const m = new Matrix4().multiplyMatrices(inv, mesh.matrixWorld)
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m)
          if (v.z < minZ) minZ = v.z
          cx += v.x
          cy += v.y
          cnt++
        }
      })
      if (cnt) nodeToRoot.multiply(new Matrix4().makeTranslation(cx / cnt, cy / cnt, minZ))
    }
    anchors.push({ key: a.key, bone, matrix: new Matrix4().copy(boneInverses[bone]).multiply(nodeToRoot) })
  }

  const stats: AircraftStats = {
    drawCalls: meshes.length,
    triangles,
    outlineTriangles: 0,
    bones: bones.length,
    materials: meshes.length,
    sourceNodes,
    sourceMeshes,
    sourceMaterials: sourceMats.size,
  }
  return { kind, bones, boneIndex, boneInverses, meshes, outline: null, sphere, anchors, stats }
}

// ---------------------------------------------------------------------------------------------------------
// Loading

let loader: GLTFLoader | null = null

function joinUrl(base: string, path: string): string {
  return base.endsWith("/") ? base + path : `${base}/${path}`
}

function loadKind(kind: VehicleKind, baseUrl: string): Promise<Template | null> {
  let p = loading.get(kind)
  if (p) return p
  loader ??= new GLTFLoader()
  const l = loader
  p = l
    .loadAsync(joinUrl(baseUrl, VEHICLES[kind].model))
    .then((gltf) => {
      const t = buildTemplate(kind, gltf.scene)
      gltf.scene.traverse((o) => {
        const mesh = o as Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose()
      })
      templates.set(kind, t)
      const ls = readyListeners.get(kind)
      if (ls) {
        readyListeners.delete(kind)
        for (const fn of ls) fn(t)
      }
      return t
    })
    .catch((err: unknown) => {
      console.warn(`[aircraft] failed to load ${kind}`, err)
      loading.delete(kind)
      return null
    })
  loading.set(kind, p)
  return p
}

/** Start loading all aircraft GLBs (non-blocking). Resolves when all are ready. */
export function preloadAircraft(baseUrl: string): Promise<void> {
  baseUrlDefault = baseUrl
  const kinds = Object.keys(CONFIG) as VehicleKind[]
  return Promise.all(kinds.map((k) => loadKind(k, baseUrl))).then(() => undefined)
}

export function aircraftReady(kind: VehicleKind): boolean {
  return templates.has(kind)
}

/** Draw calls / triangle counts for a loaded kind (null until loaded). */
export function aircraftStats(kind: VehicleKind): AircraftStats | null {
  return templates.get(kind)?.stats ?? null
}

// ---------------------------------------------------------------------------------------------------------
// Placeholder

const placeholderGeoms = new Map<VehicleKind, BufferGeometry>()

function placeholderGeometry(kind: VehicleKind): BufferGeometry {
  let g = placeholderGeoms.get(kind)
  if (g) return g
  const { length: L, span: S, heli } = CONFIG[kind].placeholder
  const parts: BufferGeometry[] = []
  const r = heli ? 0.9 : L * 0.055
  const body = new CylinderGeometry(r, r * 0.7, L * 0.62, 12, 1)
  body.rotateX(Math.PI / 2)
  parts.push(body)
  const nose = new ConeGeometry(r, L * 0.22, 12, 1)
  nose.rotateX(-Math.PI / 2)
  nose.translate(0, 0, -L * 0.42)
  parts.push(nose)
  if (heli) {
    const boom = new CylinderGeometry(0.25, 0.4, L * 0.45, 8)
    boom.rotateX(Math.PI / 2)
    boom.translate(0, 0.5, L * 0.4)
    parts.push(boom)
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const blade = new BoxGeometry(L * 0.9, 0.08, 0.5)
      blade.rotateY(a)
      blade.translate(0, 1.9, 0)
      parts.push(blade)
    }
    const stub = new BoxGeometry(S, 0.15, 0.9)
    parts.push(stub)
  } else {
    const wing = new BoxGeometry(S, 0.22, L * 0.2)
    wing.translate(0, 0, L * 0.05)
    parts.push(wing)
    const tail = new BoxGeometry(S * 0.35, 0.15, L * 0.1)
    tail.translate(0, 0, L * 0.4)
    parts.push(tail)
    const fin = new BoxGeometry(0.15, L * 0.14, L * 0.1)
    fin.translate(0, L * 0.08, L * 0.4)
    parts.push(fin)
  }
  for (const p of parts) p.deleteAttribute("uv")
  g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  placeholderGeoms.set(kind, g)
  return g
}

// ---------------------------------------------------------------------------------------------------------
// Instances

const _v = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _rootQ = new Quaternion()
const _aimBody = new Vector3()
const _fwd = new Vector3(0, 0, -1)
const AXES: Record<Axis, Vector3> = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) }
const _axisQ = new Quaternion()

function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt))
}

function smooth01(x: number): number {
  const k = x < 0 ? 0 : x > 1 ? 1 : x
  return k * k * (3 - 2 * k)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

const FAR_DISTANCE = 1500
const SPOT_FADE_TIME = 0.3
/** Warm afterburner core (STORMFRONT); cones fade core → orange. */
const AFTERBURNER_CORE = "#ffb46a"
const SPOT_COLOR = "#ff7a2e"

/**
 * Spotted rim: an inverted hull drawn with depth test off just before the aircraft's own opaque parts
 * (renderOrder 1 vs 2). Visible parts of the aircraft paint over its interior, leaving a thin rim; where
 * terrain/clouds hide the aircraft the hull remains as a faint fill with a stronger edge. Uses custom
 * blending so it stays in the opaque queue (ordering relative to the body is what makes the rim work).
 */
function createSpotMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({
    color: SPOT_COLOR,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
    fog: false,
  })
  const fade = uniform(0)
  mat.userData.fade = fade
  // Inflate along the (smoothed, skinned) normal by ~2 px at any distance, with a small floor up close.
  const viewZ = modelViewMatrix.mul(vec4(positionLocal, 1)).z.negate()
  const scale = modelScale.x
  const width = tslMax(float(0.035), viewZ.mul(0.0026)).div(scale)
  mat.positionNode = positionLocal.add(normalize(normalLocal).mul(width))
  const edge = float(1).sub(abs(dot(normalize(normalView), positionViewDirection)))
  mat.opacityNode = mix(float(0.12), float(0.95), smoothstep(0.35, 0.85, edge)).mul(fade)
  return mat
}

/** Shape-only merge of the opaque meshes with normals averaged across coincident vertices (crack-free hull). */
function silhouetteGeometry(t: Template): BufferGeometry {
  if (t.silhouette) return t.silhouette
  const parts = t.meshes
    .filter((m) => m.role === "toon" || m.role === "livery")
    .map((m) => {
      const o = new BufferGeometry()
      for (const a of ["position", "normal", "skinIndex", "skinWeight"]) o.setAttribute(a, m.geometry.getAttribute(a))
      o.setIndex(m.geometry.index)
      return o
    })
  const g = mergeGeometries(parts, false)!
  const pos = g.getAttribute("position")
  const nrm = g.getAttribute("normal")
  const si = g.getAttribute("skinIndex")
  const acc = new Map<string, [number, number, number]>()
  const keys: string[] = new Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)},${si.getX(i)}`
    keys[i] = k
    let a = acc.get(k)
    if (!a) acc.set(k, (a = [0, 0, 0]))
    a[0] += nrm.getX(i)
    a[1] += nrm.getY(i)
    a[2] += nrm.getZ(i)
  }
  for (let i = 0; i < pos.count; i++) {
    const a = acc.get(keys[i])!
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    nrm.setXYZ(i, a[0] / l, a[1] / l, a[2] / l)
  }
  t.silhouette = g
  return g
}
const CREASE_ANGLE = (55 * Math.PI) / 180
const SHADOW_MAX_AGL = 150
const _sn = new Vector3()
const _sb = new Vector3()
const _sr = new Vector3()
const _v2 = new Vector3()
const _shadowM = new Matrix4()
const _rootM = new Matrix4()

interface Rig {
  t: Template
  model: Group
  rootBone: Bone
  bones: Bone[]
  skeleton: Skeleton
  meshes: SkinnedMesh[]
  outline: SkinnedMesh | null
  /** Per-instance materials to dispose. */
  owned: Material[]
  afterburnerMats: MeshBasicNodeMaterial[]
  flameMats: MeshBasicNodeMaterial[]
  navMats: MeshBasicNodeMaterial[]
  strobeMats: MeshBasicNodeMaterial[]
  spinAngles: number[]
  storeVisible: Map<number, boolean>
  gearScale: number
  rudder: number
  /** Bomb-bay door opening 0..1. */
  doors: number
  turretYaw: number
  turretPitch: number
  podQ: Quaternion
  podRoll: number
}

export function createAircraftView(kind: VehicleKind, team: TeamId, quality: Quality): AircraftView {
  const cfg = CONFIG[kind]
  const root = new Group()
  root.name = `aircraft_${kind}`
  const anchors = new Map<string, Object3D>()
  for (const a of cfg.anchors) {
    if (anchors.has(a.key)) continue
    const o = new Object3D()
    o.name = a.key
    o.matrixAutoUpdate = false
    anchors.set(a.key, o)
    root.add(o)
  }

  let placeholder: Mesh | null = new Mesh(placeholderGeometry(kind), liveryMaterial(team))
  placeholder.name = "placeholder"
  root.add(placeholder)
  const shadow = createBlobShadow()
  shadow.visible = false
  root.add(shadow)
  const shadowSize = CONFIG[kind].shadow
  let isLocal = false

  let rig: Rig | null = null
  let disposed = false
  const firing = [
    [false, false],
    [false, false],
  ]
  let boostHint: boolean | null = null
  let spool = 0
  let gunSpin = 0
  let throttleVis = 0
  let boostVis = 0
  let time = Math.random() * 10
  const blinkPhase = Math.random()
  // Real shadow-map shadows come from the world; the blob is only a Low-quality fallback height cue.
  const blobShadow = quality === "low"

  const build = (t: Template) => {
    if (disposed || rig) return
    const model = new Group()
    model.name = "model"
    const bones: Bone[] = t.bones.map((b) => {
      const bone = new Bone()
      bone.name = b.name
      bone.position.copy(b.position)
      bone.quaternion.copy(b.quaternion)
      bone.scale.copy(b.scale)
      return bone
    })
    t.bones.forEach((b, i) => {
      if (b.parent >= 0) bones[b.parent].add(bones[i])
    })
    const rootBone = bones[0]
    // Bones live outside the scene graph in aircraft-local space (detached bind mode), so skinning never
    // touches large world coordinates; matrices are refreshed in update().
    rootBone.updateMatrixWorld(true)
    const skeleton = new Skeleton(bones, t.boneInverses)
    const identity = new Matrix4()
    const owned: Material[] = []
    const afterburnerMats: MeshBasicNodeMaterial[] = []
    const flameMats: MeshBasicNodeMaterial[] = []
    const navMats: MeshBasicNodeMaterial[] = []
    const strobeMats: MeshBasicNodeMaterial[] = []
    const meshes: SkinnedMesh[] = []
    let renderOrder = 0
    for (const tm of t.meshes) {
      let mat: Material
      switch (tm.role) {
        case "toon":
        case "glass":
          mat = tm.shared!
          break
        case "livery":
          mat = liveryMaterial(team)
          break
        case "afterburner":
        case "flame": {
          const m = new MeshBasicNodeMaterial({
            color: tm.glowColor.clone(),
            transparent: true,
            blending: AdditiveBlending,
            depthWrite: false,
            vertexColors: tm.geometry.hasAttribute("color"),
          })
          m.userData.baseColor = tm.glowColor.clone()
          if (tm.role === "afterburner") afterburnerMats.push(m)
          else flameMats.push(m)
          owned.push(m)
          mat = m
          break
        }
        default: {
          const m = createGlowMaterial(tm.glowColor, 1)
          m.vertexColors = tm.geometry.hasAttribute("color")
          if (tm.role === "nav") navMats.push(m)
          else if (tm.role === "strobe") strobeMats.push(m)
          owned.push(m)
          mat = m
        }
      }
      const mesh = new SkinnedMesh(tm.geometry, mat)
      mesh.bindMode = DetachedBindMode
      mesh.bind(skeleton, identity)
      mesh.boundingSphere = t.sphere.clone()
      // Opaque parts draw after the spotted rim (renderOrder 1) so they cover its interior where visible.
      mesh.renderOrder = tm.role === "glass" || tm.role === "flame" ? 10 + renderOrder++ : 2
      mesh.name = tm.role
      mesh.castShadow = tm.role === "toon" || tm.role === "livery"
      model.add(mesh)
      meshes.push(mesh)
    }
    const outline: SkinnedMesh | null = null
    if (placeholder) {
      root.remove(placeholder)
      placeholder = null
    }
    root.add(model)
    rig = {
      t,
      model,
      rootBone,
      bones,
      skeleton,
      meshes,
      outline,
      owned,
      afterburnerMats,
      flameMats,
      navMats,
      strobeMats,
      spinAngles: t.bones.map(() => 0),
      storeVisible: new Map(),
      gearScale: 1,
      rudder: 0,
      doors: 0,
      turretYaw: 0,
      turretPitch: 0,
      podQ: new Quaternion(),
      podRoll: 0,
    }
    updateAnchors(rig)
  }

  const updateAnchors = (r: Rig) => {
    for (const a of r.t.anchors) {
      const o = anchors.get(a.key)
      if (!o) continue
      o.matrix.multiplyMatrices(r.bones[a.bone].matrixWorld, a.matrix)
      o.matrixWorldNeedsUpdate = true
    }
  }

  const existing = templates.get(kind)
  if (existing) build(existing)
  else {
    let ls = readyListeners.get(kind)
    if (!ls) readyListeners.set(kind, (ls = new Set()))
    ls.add(build)
    void loadKind(kind, baseUrlDefault)
  }

  const updateShadow = () => {
    if (!blobShadow) return
    // Cast along the world sun direction so the blob sits where the real shadow would.
    const agl0 = root.position.y - groundQuery(root.position.x, root.position.z)
    // Cap the cast offset to ~1.2x AGL so the blob stays a useful height cue under a low sun.
    const off = clamp(agl0, 0, SHADOW_MAX_AGL) * Math.min(1.2, 1 / Math.max(0.05, SUN_DIRECTION.y)) / Math.max(1e-3, Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z))
    const x = root.position.x - SUN_DIRECTION.x * off
    const z = root.position.z - SUN_DIRECTION.z * off
    const h = groundQuery(x, z)
    const agl = root.position.y - h
    if (!(agl < SHADOW_MAX_AGL) || agl < -5) {
      shadow.visible = false
      return
    }
    shadow.visible = true
    const fade = 1 - clamp(agl / SHADOW_MAX_AGL, 0, 1)
    ;(shadow.material as MeshBasicNodeMaterial).opacity = 0.38 * fade * (0.6 + 0.4 * fade)
    // Surface normal from a small height stencil so the blob lies on slopes.
    const d = 4
    _sn.set(groundQuery(x - d, z) - groundQuery(x + d, z), 2 * d, groundQuery(x, z - d) - groundQuery(x, z + d)).normalize()
    // Heading (nose = -Z) projected onto the surface.
    _sb.set(0, 0, 1).applyQuaternion(root.quaternion)
    _sb.addScaledVector(_sn, -_sb.dot(_sn))
    if (_sb.lengthSq() < 1e-6) _sb.set(0, 0, 1)
    _sb.normalize()
    _sr.crossVectors(_sn, _sb).normalize()
    _sb.crossVectors(_sr, _sn)
    const grow = 0.85 * (1 + (1 - fade) * 0.6) * root.scale.x
    _shadowM.makeBasis(_sr, _sn, _sb)
    _shadowM.scale(_v2.set(shadowSize[0] * grow, 1, shadowSize[1] * grow))
    _shadowM.setPosition(x, h + 0.3, z)
    _rootM.compose(root.position, root.quaternion, root.scale).invert()
    shadow.matrix.multiplyMatrices(_rootM, _shadowM)
    shadow.matrixWorldNeedsUpdate = true
  }

  let spottedTarget = false
  let spotFade = 0
  let spotMesh: SkinnedMesh | null = null
  let spotMat: MeshBasicNodeMaterial | null = null
  const updateSpotted = (r: Rig, dt: number) => {
    spotFade = clamp(spotFade + (spottedTarget ? dt : -dt) / SPOT_FADE_TIME, 0, 1)
    if (spotFade <= 0) {
      if (spotMesh) spotMesh.visible = false
      return
    }
    if (!spotMesh) {
      spotMat = createSpotMaterial()
      spotMesh = new SkinnedMesh(silhouetteGeometry(r.t), spotMat)
      spotMesh.bindMode = DetachedBindMode
      spotMesh.bind(r.skeleton, new Matrix4())
      spotMesh.boundingSphere = r.t.sphere.clone()
      spotMesh.renderOrder = 1
      spotMesh.name = "spotted"
      r.model.add(spotMesh)
    }
    spotMesh.visible = true
    ;(spotMat!.userData.fade as { value: number }).value = spotFade * spotFade * (3 - 2 * spotFade)
  }

  const boneAt = (r: Rig, name: string): number => r.t.boneIndex.get(name) ?? -1

  /** Bone local rotation = rest * axis rotation. */
  const setBoneAxis = (r: Rig, bi: number, axis: Axis, angle: number) => {
    _axisQ.setFromAxisAngle(AXES[axis], angle)
    r.bones[bi].quaternion.copy(r.t.bones[bi].quaternion).multiply(_axisQ)
  }

  const setBoneVisible = (r: Rig, bi: number, s: number) => {
    if (bi < 0) return
    const rest = r.t.bones[bi].scale
    const v = s < 1e-3 ? 1e-5 : s
    r.bones[bi].scale.set(rest.x * v, rest.y * v, rest.z * v)
  }

  const storeCount = (vehicle: VehicleEntity, g: StoreGroup): number => {
    let ammo = 0
    let max = 0
    for (const [seat, slot] of g.weapons) {
      const ids = VEHICLES[vehicle.kind].seatWeapons[seat]
      // Duplicate slots (e.g. tvmissile/tvmissile) share slot 0's ammo in combat; count it once.
      if (slot === 1 && ids[0] === ids[1]) continue
      const w = vehicle.weapons[seat]?.[slot]
      const id = ids[slot]
      if (!id) continue
      const cap = WEAPONS[id].ammo
      if (!w || !Number.isFinite(cap) || cap < 0) return g.order.length
      ammo += Math.max(0, w.ammo)
      max += cap
    }
    if (max <= 0) return g.order.length
    return clamp(Math.ceil((ammo / max) * g.order.length - 1e-6), 0, g.order.length)
  }

  const view: AircraftView = {
    root,
    anchors,
    get ready() {
      return rig !== null
    },
    setFiring(seat, slot, on) {
      if (firing[seat]) firing[seat][slot] = on
    },
    setBoost(on) {
      boostHint = on
    },
    setLocal(local) {
      isLocal = local
    },
    setSpotted(on) {
      spottedTarget = on
    },
    update(vehicle, _players, dt, camera) {
      const f = vehicle.flight
      root.position.set(f.position[0], f.position[1], f.position[2])
      root.quaternion.set(f.orientation[0], f.orientation[1], f.orientation[2], f.orientation[3])
      root.visible = vehicle.alive
      if (!vehicle.alive) return
      _v.setFromMatrixPosition(camera.matrixWorld)
      const dist = _v.distanceTo(root.position)
      // Remote aircraft grow up to 1.6x between 500 m and 1.5 km so they stay readable at gun range.
      const k = clamp((dist - 500) / 1000, 0, 1)
      root.scale.setScalar(isLocal ? 1 : 1 + 0.6 * k * k * (3 - 2 * k))
      updateShadow()
      if (!rig) return
      updateSpotted(rig, dt)
      const r = rig
      const t = r.t
      time += dt

      const far = dist > FAR_DISTANCE

      const boost = boostHint ?? f.throttle > 0.95
      const heli = VEHICLES[vehicle.kind].flight === "heli"
      const spoolTarget = heli ? (f.onGround ? 0.3 + 0.7 * f.throttle : 1) : 0.35 + 0.65 * f.throttle
      spool = approach(spool, spoolTarget, heli ? 0.8 : 1.5, dt)
      throttleVis = approach(throttleVis, f.throttle, 6, dt)
      boostVis = approach(boostVis, boost && vehicle.alive ? 1 : 0, boost ? 7 : 4, dt)
      const gunOn = firing[0][0]
      gunSpin = approach(gunSpin, gunOn ? 1 : 0, gunOn ? 6 : 1.6, dt)

      // Visibility: pilots, stores, gear.
      for (let s = 0; s < 2; s++) setBoneVisible(r, boneAt(r, `pilot_${s + 1}`), vehicle.seats[s] ? 1 : 0)
      for (const g of cfg.stores) {
        const n = storeCount(vehicle, g)
        const firstVisible = g.order.length - n
        for (let i = 0; i < g.order.length; i++) setBoneVisible(r, boneAt(r, g.order[i]), i >= firstVisible ? 1 : 0)
      }
      r.gearScale = far ? (f.gearDown ? 1 : 0) : approach(r.gearScale, f.gearDown ? 1 : 0, 7, dt)
      setBoneVisible(r, boneAt(r, "gear"), r.gearScale < 0.02 ? 0 : r.gearScale)

      if (!far) {
        for (const sp of cfg.spinners) {
          const bi = boneAt(r, sp.name)
          if (bi < 0) continue
          const k = sp.driver === "gun" ? gunSpin : spool
          r.spinAngles[bi] = (r.spinAngles[bi] + sp.speed * k * dt) % (Math.PI * 2)
          setBoneAxis(r, bi, sp.axis, r.spinAngles[bi])
        }

        // Afterburners: nozzle discs glow with throttle (HDR for bloom); flame cones appear at high
        // throttle and stretch on boost.
        const flicker = 1 + Math.sin(time * 47) * 0.07 + Math.sin(time * 31.7) * 0.05
        const bv = boostVis
        const thr = clamp(throttleVis, 0, 1)
        const cone = Math.max(smooth01((thr - 0.7) / 0.3) * 0.45, bv)
        for (const ab of cfg.afterburners) {
          const bi = boneAt(r, ab.name)
          if (bi < 0) continue
          const rest = t.bones[bi].scale
          const len = (0.35 + 0.35 * cone + 0.6 * bv) * flicker
          const wid = 0.85 + 0.15 * cone
          const b = r.bones[bi]
          b.scale.set(rest.x * (ab.axis === "x" ? len : wid), rest.y * (ab.axis === "y" ? len : wid), rest.z * (ab.axis === "z" ? len : wid))
        }
        const glow = (0.5 + 2.5 * thr + 4 * bv) * flicker
        for (const m of r.afterburnerMats) m.color.copy(m.userData.baseColor as Color).multiplyScalar(glow)
        const flame = (cone * 1.2 + bv * 1.6) * flicker
        for (const m of r.flameMats) m.color.copy(m.userData.baseColor as Color).multiplyScalar(flame)
        for (const m of r.meshes) if (m.name === "flame") m.visible = flame > 0.03

        // Aimed equipment (seat aim in body frame).
        _rootQ.copy(root.quaternion)
        const aimTurret = cfg.turret ? vehicle.aim[cfg.turret.seat] : null
        if (cfg.turret) {
          const yi = boneAt(r, cfg.turret.yaw)
          const pi = boneAt(r, cfg.turret.pitch)
          let yaw = 0
          let pitch = 0
          if (aimTurret && yi >= 0) {
            _q.copy(_rootQ).multiply(t.bones[yi].restToRootQ).invert()
            _aimBody.set(aimTurret[0], aimTurret[1], aimTurret[2]).applyQuaternion(_q)
            yaw = clamp(Math.atan2(-_aimBody.x, -_aimBody.z), -cfg.turret.yawMax, cfg.turret.yawMax)
            pitch = clamp(Math.atan2(_aimBody.y, Math.hypot(_aimBody.x, _aimBody.z)), cfg.turret.pitchMin, cfg.turret.pitchMax)
          }
          r.turretYaw = approach(r.turretYaw, yaw, 10, dt)
          r.turretPitch = approach(r.turretPitch, pitch, 10, dt)
          if (yi >= 0) setBoneAxis(r, yi, "y", r.turretYaw)
          if (pi >= 0) setBoneAxis(r, pi, "x", r.turretPitch)
        }
        if (cfg.ballPod) {
          const bi = boneAt(r, cfg.ballPod.name)
          const aim = vehicle.aim[cfg.ballPod.seat]
          if (bi >= 0) {
            if (aim) {
              _q.copy(_rootQ).multiply(t.bones[bi].restToRootQ).invert()
              _aimBody.set(aim[0], aim[1], aim[2]).applyQuaternion(_q)
              _aimBody.y = Math.min(_aimBody.y, cfg.ballPod.maxUp)
              _aimBody.normalize()
              _q2.setFromUnitVectors(_fwd, _aimBody)
            } else _q2.identity()
            r.podQ.slerp(_q2, 1 - Math.exp(-8 * dt))
            r.bones[bi].quaternion.copy(t.bones[bi].quaternion).multiply(r.podQ)
          }
        }
        if (cfg.rollPod) {
          const bi = boneAt(r, cfg.rollPod.name)
          const aim = vehicle.aim[cfg.rollPod.seat]
          if (bi >= 0) {
            let roll = r.podRoll
            if (aim) {
              _q.copy(_rootQ).invert()
              _aimBody.set(aim[0], aim[1], aim[2]).applyQuaternion(_q)
              if (Math.hypot(_aimBody.x, _aimBody.y) > 0.05) roll = Math.atan2(_aimBody.x, -_aimBody.y)
            } else roll = 0
            let d = roll - r.podRoll
            d = Math.atan2(Math.sin(d), Math.cos(d))
            r.podRoll += d * (1 - Math.exp(-6 * dt))
            // Roll about the parent Z axis: rot = Rz(roll) * rest.
            _axisQ.setFromAxisAngle(AXES.z, r.podRoll)
            r.bones[bi].quaternion.copy(_axisQ).multiply(t.bones[bi].quaternion)
          }
        }
        if (cfg.doors) {
          // Open while the bombardier is aiming/releasing (seat occupied and firing), close otherwise.
          const d = cfg.doors
          const want = firing[d.seat][0] || firing[d.seat][1] ? 1 : 0
          r.doors = approach(r.doors, want, want ? 2.2 : 1.2, dt)
          for (const [n, ang] of d.names) {
            const bi = boneAt(r, n)
            if (bi >= 0) setBoneAxis(r, bi, d.axis, ang * r.doors * r.doors * (3 - 2 * r.doors))
          }
        }
        if (cfg.rudders) {
          const target = clamp(f.angularVelocity[1] * cfg.rudders.gain, -cfg.rudders.max, cfg.rudders.max)
          r.rudder = approach(r.rudder, target, 8, dt)
          for (const n of cfg.rudders.names) {
            const bi = boneAt(r, n)
            if (bi >= 0) setBoneAxis(r, bi, "y", r.rudder)
          }
        }

        // Nav lights: steady with a slow subtle pulse; tail strobe double-flash.
        const pulse = 0.85 + 0.15 * Math.sin((time + blinkPhase) * 2.4)
        for (const m of r.navMats) m.color.copy(m.userData.baseColor as Color).multiplyScalar(2.5 * pulse)
        const ph = (time * 0.8 + blinkPhase) % 1
        const strobe = ph < 0.06 || (ph > 0.14 && ph < 0.2) ? 12 : 0.4
        for (const m of r.strobeMats) m.color.copy(m.userData.baseColor as Color).multiplyScalar(strobe)
      }

      r.rootBone.updateMatrixWorld(true)
      updateAnchors(r)
    },
    dispose() {
      disposed = true
      readyListeners.get(kind)?.delete(build)
      root.removeFromParent()
      if (rig) {
        for (const m of rig.owned) m.dispose()
        spotMat?.dispose()
        rig.skeleton.dispose()
        rig = null
      }
      placeholder = null
      ;(shadow.material as MeshBasicNodeMaterial).dispose()
      root.clear()
    },
  }
  return view
}
