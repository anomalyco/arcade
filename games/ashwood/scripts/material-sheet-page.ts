// Standalone material inspection page (scripts/material-sheet.html), not part of the game. Two layouts:
//   ?mode=grid[&only=a,b]  every library material on a tilted 1.6 m slab and a sphere, with metre UVs
//   ?mode=floor&mat=asphalt[&wet=1&puddles=0.3]  one ground material as a 80 m floor under a sodium lamp, eye level
// Driven by scripts/material-sheet.ts (headless capture).
import * as THREE from "three/webgpu"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials, material, type MaterialName } from "../src/render/materials"

const ALL: MaterialName[] = [
  "asphalt", "asphalt_lot", "road_line_yellow", "road_line_white", "gravel", "forest_floor", "grass", "dirt",
  "concrete_wall", "concrete_dark", "concrete_floor", "concrete_floor_dry", "bark", "pine_needles", "pine_foliage",
  "wood_pole", "metal_painted", "metal_galvanized", "metal_dark", "chainlink", "barbed_wire", "glass_lit",
  "glass_dark", "door_steel", "tile_green", "tile_green_dark", "linoleum", "ceiling_tile", "terrazzo",
  "painted_wall", "rubber", "car_paint", "chrome", "plastic_orange", "emissive_sodium", "emissive_fluorescent",
]

const params = new URLSearchParams(location.search)
const status = { ready: false, frames: 0, errors: [] as string[], loadMs: 0, textureMB: 0, programs: "" }
;(globalThis as { __sheet?: typeof status }).__sheet = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))

const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = Number(params.get("exposure") ?? 1)

const settings = { ...MATERIAL_SETTINGS }
if (params.has("wet")) settings["materials.wetness"] = Number(params.get("wet"))
if (params.has("puddles")) settings["materials.puddles"] = Number(params.get("puddles"))
bindMaterialSettings(settings)
const t0 = performance.now()
await loadMaterials(renderer)
status.loadMs = performance.now() - t0

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 400)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
const labels: [THREE.Vector3, string][] = []

/** Scales a geometry's 0..1 UVs to metres. */
function metres(g: THREE.BufferGeometry, su: number, sv: number) {
  const uv = g.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
  return g
}

if ((params.get("mode") ?? "grid") === "grid") {
  scene.background = new THREE.Color(0x101414)
  scene.environmentIntensity = Number(params.get("env") ?? 0.6)
  const names = (params.get("only")?.split(",") as MaterialName[] | undefined) ?? ALL
  const cols = Math.ceil(Math.sqrt(names.length * 1.5))
  const rows = Math.ceil(names.length / cols)
  const pitch = 2.2
  names.forEach((name, i) => {
    const cx = (i % cols - (cols - 1) / 2) * pitch
    const cy = ((rows - 1) / 2 - Math.floor(i / cols)) * pitch
    const m = material(name)
    const slab = new THREE.Mesh(metres(new THREE.PlaneGeometry(1.6, 1.6), 1.6, 1.6), m)
    slab.position.set(cx - 0.15, cy + 0.1, 0)
    slab.rotation.x = -0.55
    scene.add(slab)
    const ball = new THREE.Mesh(metres(new THREE.SphereGeometry(0.38, 48, 24), 2.4, 1.2), m)
    ball.position.set(cx + 0.55, cy - 0.35, 0.45)
    scene.add(ball)
    labels.push([new THREE.Vector3(cx, cy - 0.95, 0), name])
  })
  const key = new THREE.SpotLight(0xfff4e8, 700, 0, 0.9, 0.5, 2)
  key.position.set(-8, 10, 12)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xbfe0ff, 0.5)
  fill.position.set(6, 2, 8)
  scene.add(fill)
  const span = Math.max(rows * pitch, (cols * pitch) / camera.aspect)
  camera.position.set(0, 0, (span * 1.02) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + 0.5)
  camera.lookAt(0, 0, 0)
} else if (params.get("mode") === "door") {
  // Three 0.9 × 2.1 m leaves (UV metres, V up from the floor) at different positions, under a flashlight-like spot and
  // a dim overhead: checks repeat between identical leaves and the wear layout.
  const name = (params.get("mat") ?? "door_steel") as MaterialName
  scene.background = new THREE.Color(0x0a0d0c)
  scene.environmentIntensity = Number(params.get("env") ?? 0.25)
  for (const [i, x] of [-1.15, 0, 1.15].entries()) {
    const leaf = new THREE.Mesh(metres(new THREE.PlaneGeometry(0.9, 2.1), 0.9, 2.1), material(name))
    leaf.position.set(x, 1.05, -0.02 * i)
    scene.add(leaf)
  }
  const torch = new THREE.SpotLight(0xfff1dc, Number(params.get("torch") ?? 18), 12, 0.5, 0.6, 2)
  torch.position.set(0.25, 1.5, 2.6)
  torch.target.position.set(0, 1.1, 0)
  scene.add(torch, torch.target)
  const tube = new THREE.PointLight(0xdcf2c8, 6, 8, 2)
  tube.position.set(0, 2.8, 1.2)
  scene.add(tube)
  camera.position.set(0, 1.25, 3.1)
  camera.lookAt(0, 1.05, 0)
} else {
  const name = (params.get("mat") ?? "asphalt") as MaterialName
  scene.background = new THREE.Color(0x0b1715)
  scene.fog = new THREE.FogExp2(0x0e1d1a, Number(params.get("fog") ?? 0.02))
  scene.environmentIntensity = Number(params.get("env") ?? 0.12)
  const floor = new THREE.Mesh(metres(new THREE.PlaneGeometry(80, 80, 1, 1), 80, 80), material(name))
  floor.rotation.x = -Math.PI / 2
  scene.add(floor)
  const lamp = new THREE.SpotLight(0xff9a40, 2600, 45, 0.95, 0.6, 2)
  lamp.position.set(2.5, 7, -22)
  lamp.target.position.set(2.5, 0, -22)
  scene.add(lamp, lamp.target)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.3), material("emissive_sodium"))
  head.position.copy(lamp.position)
  scene.add(head)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 10), material("metal_painted"))
  pole.position.set(2.5, 3.5, -22.2)
  scene.add(pole)
  const far = new THREE.SpotLight(0xff9a40, 2000, 45, 0.95, 0.6, 2)
  far.position.set(-4, 7, -40)
  far.target.position.set(-4, 0, -40)
  scene.add(far, far.target)
  const head2 = head.clone()
  head2.position.copy(far.position)
  scene.add(head2)
  scene.add(new THREE.HemisphereLight(0x1c3a36, 0x0a0d0b, 0.35))
  camera.position.set(0, 1.7, 0)
  camera.lookAt(0.5, 1.1, -12)
}

const labelRoot = document.querySelector<HTMLDivElement>("#labels")!
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera)
  status.frames++
  if (status.frames === 2) {
    for (const [p, text] of labels) {
      const v = p.clone().project(camera)
      const el = document.createElement("div")
      el.textContent = text
      el.style.left = `${((v.x + 1) / 2) * innerWidth}px`
      el.style.top = `${((1 - v.y) / 2) * innerHeight}px`
      labelRoot.append(el)
    }
  }
  if (status.frames === 6) {
    const pp = (renderer as unknown as { _pipelines: { programs: Record<string, Map<unknown, unknown>>; caches: Map<unknown, unknown> } })._pipelines
    status.programs = `${pp.programs.fragment!.size} fragment / ${pp.programs.vertex!.size} vertex / ${pp.caches.size} pipelines`
    status.textureMB = (renderer.info.memory as { texturesSize?: number }).texturesSize! / 2 ** 20
    status.ready = true
  }
})
