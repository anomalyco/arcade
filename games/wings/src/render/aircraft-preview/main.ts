// Dev preview for aircraft rendering: all four aircraft in team colors with animation and draw-call readout.
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Quaternion,
  RenderPipeline,
  Scene,
  Vector3,
  WebGPURenderer,
} from "three/webgpu"
import { pass } from "three/tsl"
import { bloom } from "three/addons/tsl/display/BloomNode.js"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import type { Quality, TeamId, Vec3, VehicleEntity, VehicleKind } from "../../sim/types"
import { VEHICLES, WEAPONS } from "../../sim/vehicles"
import { aircraftStats, createAircraftView, preloadAircraft, setAircraftGroundQuery, type AircraftView } from "../aircraft"

// STORMFRONT preview lighting: dim cool diffuse key from above, very low ambient, dark sea, dense mist.
const STORM = {
  keyDir: new Vector3(0.25, 1, 0.35).normalize(),
  key: "#b9c7c6",
  keyIntensity: 2.0,
  hemiSky: "#6a7a74",
  hemiGround: "#1c2523",
  hemiIntensity: 1.6,
  fog: "#33403d",
  sea: "#2e3b38",
}

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

const renderer = new WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = ACESFilmicToneMapping
renderer.toneMappingExposure = Number(params.get("exposure") ?? 1.15)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFShadowMap
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new Scene()
scene.background = new Color(STORM.fog)
scene.fog = new Fog(STORM.fog, 120, 2200)
const hemi = new HemisphereLight(STORM.hemiSky, STORM.hemiGround, STORM.hemiIntensity)
scene.add(hemi)
const sun = new DirectionalLight(STORM.key, STORM.keyIntensity)
sun.position.copy(STORM.keyDir).multiplyScalar(100)
sun.castShadow = params.has("shadows")
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -70
sun.shadow.camera.right = 70
sun.shadow.camera.top = 70
sun.shadow.camera.bottom = -70
sun.shadow.camera.far = 300
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.03
scene.add(sun.target)
scene.add(sun)

const camera = new PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 20000)

// Node post: scene pass + bloom on HDR emissives, ACES tone mapping in the output transform.
const pipeline = new RenderPipeline(renderer)
const scenePass = pass(scene, camera)
const sceneColor = scenePass.getTextureNode("output")
pipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.6, 0.35, 0.85))
const ground = new Mesh(new CircleGeometry(3000, 48), new MeshStandardNodeMaterial({ color: STORM.sea, roughness: 0.22, metalness: 0 }))
ground.rotation.x = -Math.PI / 2
ground.position.y = -4
ground.receiveShadow = true
scene.add(ground)

camera.position.set(-38, 22, -48)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
if (params.has("cam")) camera.position.fromArray(params.get("cam")!.split(",").map(Number))
if (params.has("target")) controls.target.fromArray(params.get("target")!.split(",").map(Number))
controls.update()

setAircraftGroundQuery(() => -4)
const ALT = Number(params.get("alt") ?? 0)
if (params.has("occluder")) {
  // A rock ridge in front of the spotted aircraft to check the through-terrain highlight.
  const [ox, oz, w] = params.get("occluder")!.split(",").map(Number)
  const ridge = new Mesh(new CircleGeometry(1, 6), new MeshStandardNodeMaterial({ color: "#2b2f2d", roughness: 0.6, side: 2 }))
  ridge.scale.set(w || 8, 7, 1)
  ridge.position.set(ox || 0, -1, oz || -6)
  scene.add(ridge)
}
const KINDS: VehicleKind[] = ["fighter", "apache", "warthog", "blackbird", "bomber"]
const X: Record<VehicleKind, number> = { fighter: -34, apache: -12, warthog: 10, blackbird: 38, bomber: 80 }
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
      position: [only ? 0 : X[kind], ALT, 0],
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
    e.view.setSpotted(params.get("spot") === e.kind)
    e.view.update(e.entity, [], dt, camera)
  }
  controls.update()
  pipeline.render()

  const info = renderer.info.render
  const lines = [
    `fps ${fps.toFixed(0)}  total draws ${info.drawCalls}  tris ${info.triangles}${loadMs ? `  (loaded in ${loadMs.toFixed(0)} ms)` : ""}`,
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
