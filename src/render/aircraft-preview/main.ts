// Dev preview for aircraft rendering: all four aircraft in team colors with animation and draw-call readout.
import {
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import type { Quality, TeamId, Vec3, VehicleEntity, VehicleKind } from "../../sim/types"
import { VEHICLES, WEAPONS } from "../../sim/vehicles"
import { PALETTE } from "../world/palette"
import { SUN_DIRECTION } from "../world/settings"
import { aircraftStats, createAircraftView, preloadAircraft, type AircraftView } from "../aircraft"

const params = new URLSearchParams(location.search)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const hud = $("hud")
const thrInput = $<HTMLInputElement>("thr")
const autoInput = $<HTMLInputElement>("auto")
const boostInput = $<HTMLInputElement>("boost")
const gearInput = $<HTMLInputElement>("gear")
const fireInput = $<HTMLInputElement>("fire")
const qInput = $<HTMLSelectElement>("q")
if (params.has("q")) qInput.value = params.get("q")!
if (params.has("static")) autoInput.checked = false
if (params.has("boost")) boostInput.checked = true

const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = SRGBColorSpace
// Match the world renderer: no tone mapping.
document.body.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color(PALETTE.horizon)
scene.fog = new Fog(PALETTE.horizon, 600, 5000)
const hemi = new HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 2.2)
scene.add(hemi)
const sun = new DirectionalLight(PALETTE.sunLight, 2.2)
sun.position.copy(SUN_DIRECTION).multiplyScalar(100)
scene.add(sun)
const ground = new Mesh(new CircleGeometry(3000, 48), new MeshLambertMaterial({ color: PALETTE.grass, flatShading: true, toneMapped: false }))
ground.rotation.x = -Math.PI / 2
ground.position.y = -4
scene.add(ground)
const runway = new Mesh(new CircleGeometry(1, 4), new MeshLambertMaterial({ color: PALETTE.paving, flatShading: true, toneMapped: false }))
runway.scale.set(90, 30, 1)
runway.rotation.x = -Math.PI / 2
runway.position.y = -3.95
scene.add(runway)

const camera = new PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 20000)
camera.position.set(-38, 22, -48)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
if (params.has("cam")) camera.position.fromArray(params.get("cam")!.split(",").map(Number))
if (params.has("target")) controls.target.fromArray(params.get("target")!.split(",").map(Number))
controls.update()

const KINDS: VehicleKind[] = ["fighter", "apache", "warthog", "blackbird"]
const X: Record<VehicleKind, number> = { fighter: -34, apache: -12, warthog: 10, blackbird: 38 }
const only = params.get("only") as VehicleKind | null

function makeEntity(kind: VehicleKind, team: TeamId): VehicleEntity {
  const spec = VEHICLES[kind]
  const w = (id: keyof typeof WEAPONS | null) => ({ ammo: id ? WEAPONS[id].ammo : 0, readyAt: 0, lockTarget: null, lock: 0 })
  return {
    id: kind,
    kind,
    team,
    flight: {
      kind,
      position: [only ? 0 : X[kind], 0, 0],
      velocity: [0, 0, 0],
      orientation: [0, 0, 0, 1],
      angularVelocity: [0, 0, 0],
      throttle: 0.7,
      onGround: false,
      gearDown: true,
      crashed: null,
      tick: 0,
    },
    hp: spec.maxHp,
    maxHp: spec.maxHp,
    seats: ["p1", "p2"],
    aim: [null, null],
    weapons: [
      [w(spec.seatWeapons[0][0]), w(spec.seatWeapons[0][1])],
      [w(spec.seatWeapons[1][0]), w(spec.seatWeapons[1][1])],
    ],
    flaresReadyAt: 0,
    flareCount: spec.flares,
    abilityReadyAt: 0,
    spottedUntil: 0,
    lastDamagedBy: null,
    alive: true,
  }
}

interface Entry {
  kind: VehicleKind
  entity: VehicleEntity
  view: AircraftView
}
let entries: Entry[] = []
function rebuild() {
  for (const e of entries) e.view.dispose()
  entries = (only ? [only] : KINDS).map((kind, i) => {
    const team = (only ? Number(params.get("team") ?? 0) : i) as TeamId
    const entity = makeEntity(kind, team)
    const view = createAircraftView(kind, team, qInput.value as Quality)
    scene.add(view.root)
    return { kind, entity, view }
  })
}
qInput.addEventListener("change", rebuild)
rebuild()
const loadStart = performance.now()
let loadMs = 0
void preloadAircraft(import.meta.env.BASE_URL).then(() => (loadMs = performance.now() - loadStart))

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const tmpQ = new Quaternion()
const aimV = new Vector3()
let last = performance.now()
let time = 0
let frames = 0
let fpsT = 0
let fps = 0

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  time += dt
  frames++
  fpsT += dt
  if (fpsT > 0.5) {
    fps = frames / fpsT
    frames = 0
    fpsT = 0
  }
  const auto = autoInput.checked
  for (const e of entries) {
    const f = e.entity.flight
    f.throttle = auto ? 0.5 + 0.5 * Math.sin(time * 0.6) : Number(thrInput.value)
    f.gearDown = auto ? Math.floor(time / 5) % 2 === 0 : gearInput.checked
    f.angularVelocity = [0, auto ? Math.sin(time * 1.3) * 0.4 : 0, 0]
    // Seat aim sweeps around the aircraft (world space).
    aimV.set(Math.sin(time * 0.7) * 0.9, -0.35 + Math.sin(time * 0.43) * 0.3, -Math.cos(time * 0.7)).normalize()
    const aim: Vec3 = [aimV.x, aimV.y, aimV.z]
    e.entity.aim = [aim, aim]
    // Ammo depletes and refills over a 16 s cycle.
    if (auto) {
      const k = 1 - ((time / 16) % 1)
      for (const seat of e.entity.weapons)
        for (const w of seat) w.ammo = Math.round(k * 8) / 8 * 1000
      const spec = VEHICLES[e.kind]
      e.entity.weapons.forEach((seat, s) =>
        seat.forEach((w, slot) => {
          const id = spec.seatWeapons[s][slot]
          if (!id) return
          const cap = WEAPONS[id].ammo
          w.ammo = Number.isFinite(cap) ? Math.ceil(cap * k) : cap
        }),
      )
      e.entity.seats = [Math.floor(time / 7) % 3 === 2 ? null : "p1", "p2"]
    }
    e.view.setBoost(boostInput.checked)
    e.view.setFiring(0, 0, fireInput.checked || (auto && Math.floor(time / 3) % 2 === 0))
    if (params.has("bank")) {
      tmpQ.setFromAxisAngle(new Vector3(0, 0, 1), Math.sin(time * 0.5) * 0.4)
      f.orientation = [tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w]
    }
    e.view.update(e.entity, [], dt, camera)
  }
  controls.update()
  renderer.render(scene, camera)

  const info = renderer.info.render
  const lines = [
    `fps ${fps.toFixed(0)}  total draws ${info.calls}  tris ${info.triangles}${loadMs ? `  (loaded in ${loadMs.toFixed(0)} ms)` : ""}`,
    "kind        draws  tris    outline  bones  mats  (src nodes/meshes/mats)",
  ]
  for (const k of only ? [only] : KINDS) {
    const s = aircraftStats(k)
    lines.push(
      s
        ? `${k.padEnd(11)} ${String(s.drawCalls).padStart(5)}  ${String(s.triangles).padStart(6)}  ${String(s.outlineTriangles).padStart(7)}  ${String(s.bones).padStart(5)}  ${String(s.materials).padStart(4)}  (${s.sourceNodes}/${s.sourceMeshes}/${s.sourceMaterials})`
        : `${k.padEnd(11)} loading…`,
    )
  }
  hud.textContent = lines.join("\n")
  ;(window as unknown as { __stats: unknown }).__stats = { calls: info.calls, triangles: info.triangles, kinds: KINDS.map((k) => [k, aircraftStats(k)]) }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
