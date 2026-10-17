// Standalone model inspection page (scripts/models-sheet.html), not part of the game. Renders every model in
// src/render/models.ts into its own cell, framed from the front-left (the -Z side, so a correctly oriented model shows
// its front), on a 1 m grid with a red arrow pointing to -Z (model front) and a 1.8 m grey post for scale.
//   ?only=a,b      subset
//   &view=back     view from the +Z side instead; view=side looks along -X
//   &night=1       dark teal fog with one warm overhead lamp, closer to the game's look
//   &cell=420x300  cell size in px
//   &lod=1         render each model's LOD1 (models without one show LOD0)
//   &inst=pallet   extra cell drawing a 3×3 instanceModel() grid
//   &stats=1       no shadows; report material objects, node programs and pipelines built for the models in __sheet.stats
//   &raw=1         disable models.ts material sharing (A/B for stats)
// Driven by scripts/models-sheet.ts (headless capture).
import * as THREE from "three/webgpu"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { MODELS, initModels, instanceModel, loadModel, modelMaterialSharing, type ModelName } from "../src/render/models"

const params = new URLSearchParams(location.search)
const status = { ready: false, errors: [] as string[], stats: null as Record<string, unknown> | null }
const statsMode = params.get("stats") === "1"
if (params.get("raw") === "1") modelMaterialSharing.enabled = false
;(globalThis as { __sheet?: typeof status }).__sheet = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))
addEventListener("unhandledrejection", (e) => status.errors.push(String((e as PromiseRejectionEvent).reason)))

const names = (params.get("only")?.split(",") ?? Object.keys(MODELS)) as ModelName[]
const [cw, ch] = (params.get("cell") ?? "384x288").split("x").map(Number) as [number, number]
const night = params.get("night") === "1"
const lod = Number(params.get("lod") ?? 0)
const view = params.get("view") ?? "front"
const cols = Math.max(1, Math.min(names.length, Math.floor(innerWidth / cw)))
const rows = Math.ceil(names.length / cols)

const sheet = document.querySelector<HTMLCanvasElement>("#sheet")!
sheet.width = cols * cw
sheet.height = rows * ch
const ctx = sheet.getContext("2d")!
ctx.fillStyle = "#000"
ctx.fillRect(0, 0, sheet.width, sheet.height)

const gpu = document.querySelector<HTMLCanvasElement>("#gpu")!
const renderer = new THREE.WebGPURenderer({ canvas: gpu, antialias: true })
await renderer.init()
initModels(renderer)
renderer.setPixelRatio(1)
renderer.setSize(cw, ch, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = !statsMode
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, cw / ch, 0.02, 200)
if (night) {
  scene.background = new THREE.Color(0x0c1a17)
  scene.fog = new THREE.FogExp2(0x0c1a17, 0.06)
} else {
  scene.background = new THREE.Color(0x1d2224)
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.55
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardNodeMaterial({ color: 0x2a2c2c, roughness: night ? 0.35 : 0.95 }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)
const grid = new THREE.GridHelper(20, 20, 0x556060, 0x3a4242)
grid.position.y = 0.002
scene.add(grid)
const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8), new THREE.MeshStandardNodeMaterial({ color: 0x777777 }))
scene.add(post)
const arrowMat = new THREE.MeshBasicNodeMaterial({ color: 0xff3020 })
const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 12), arrowMat)
arrow.rotation.x = -Math.PI / 2
const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.005, 1), arrowMat)
scene.add(arrow, shaft)

const key = night ? new THREE.SpotLight(0xffa040, 0, 0, 0.75, 0.6, 2) : new THREE.DirectionalLight(0xfff2e0, 2.2)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
key.shadow.bias = -0.0004
key.shadow.normalBias = 0.02
scene.add(key, key.target)
if (!night) scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202020, 0.4))
else scene.add(new THREE.HemisphereLight(0x2a5a50, 0x050808, 0.6))

type Internals = { _nodes: { nodeBuilderCache: Map<unknown, unknown> }; _pipelines: { caches: Map<unknown, unknown>; programs: { fragment: Map<unknown, unknown> } } }
const internals = renderer as unknown as Internals
const counts = () => ({
  nodePrograms: internals._nodes.nodeBuilderCache.size,
  fragmentShaders: internals._pipelines.programs.fragment.size,
  pipelines: internals._pipelines.caches.size,
})
renderer.render(scene, camera)
const baseline = counts()
const materials = new Set<THREE.Material>()
const layouts = new Map<string, number>()
const variants = new Map<string, string[]>()
for (let i = 0; i < names.length; i++) {
  const name = names[i]!
  const info = MODELS[name]
  const [w, h, d] = info.size as readonly [number, number, number]
  let model: THREE.Group
  try {
    model = await loadModel(name, { lod: lod as 0 | 1 })
  } catch (e) {
    status.errors.push(`${name}: ${String(e)}`)
    continue
  }
  scene.add(model)
  model.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    for (const mat of [m.material].flat()) {
      materials.add(mat)
      const pm = mat as THREE.MeshPhysicalMaterial
      const v = `${mat.type} side${mat.side} ${mat.transparent ? "blend" : "opaque"}${mat.alphaTest ? " alphaTest" : ""}${pm.clearcoat ? " clearcoat" : ""}${pm.transmission ? " transmission" : ""}`
      variants.set(v, [...(variants.get(v) ?? []), name])
    }
    const g = m.geometry
    const key = Object.keys(g.attributes).sort().map((n) => { const a = g.getAttribute(n); return `${n}${a.itemSize}${a.normalized ? "n" : ""}` }).join(",")
    layouts.set(key, (layouts.get(key) ?? 0) + 1)
  })
  const r = 0.5 * Math.hypot(w, h, d)
  const lift = h * 0.45
  const dir = view === "back" ? new THREE.Vector3(0.9, 0.55, 1.3) : view === "side" ? new THREE.Vector3(-1.4, 0.35, 0.0001) : new THREE.Vector3(-0.9, 0.55, -1.3)
  dir.normalize()
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95
  camera.position.copy(dir).multiplyScalar(dist).add(new THREE.Vector3(0, lift, 0))
  camera.lookAt(0, lift, 0)
  camera.near = dist / 100
  camera.far = dist * 10
  camera.updateProjectionMatrix()
  post.position.set(w / 2 + 0.25, 0.9, d / 2 + 0.1)
  const len = Math.max(0.3, d * 0.5)
  shaft.scale.z = len
  shaft.position.set(0, 0.004, -(d / 2) - len / 2 - 0.05)
  arrow.position.set(0, 0.03, -(d / 2) - len - 0.12)
  if (night) {
    key.position.set(-r * 0.6, h + r * 1.6, -r * 1.2)
    ;(key as THREE.SpotLight).intensity = 25 * r * r + 30
  } else key.position.set(-r * 2, r * 3, -r * 1.5)
  key.target.position.set(0, 0, 0)
  const sc = key.shadow.camera as THREE.OrthographicCamera
  if (!night) {
    sc.left = sc.bottom = -r * 1.5
    sc.right = sc.top = r * 1.5
    sc.near = 0.1
    sc.far = r * 10
    sc.updateProjectionMatrix()
  }
  ground.scale.setScalar(Math.max(1, r))
  renderer.render(scene, camera)
  const x = (i % cols) * cw
  const y = Math.floor(i / cols) * ch
  ctx.drawImage(gpu, x, y, cw, ch)
  ctx.font = "12px ui-monospace, Menlo, monospace"
  ctx.fillStyle = "rgba(0,0,0,0.55)"
  ctx.fillRect(x, y + ch - 18, cw, 18)
  ctx.fillStyle = "#e8e8e8"
  const lodInfo = info as { lod1?: number }
  const tris = lod === 1 && lodInfo.lod1 ? `LOD1 ${(lodInfo.lod1 / 1000).toFixed(1)}k` : `${(info.tris / 1000).toFixed(1)}k`
  ctx.fillText(`${name}  ${w}×${h}×${d} m  ${tris}  ${info.kb} KB`, x + 6, y + ch - 5)
  scene.remove(model)
}
if (statsMode) {
  const after = counts()
  status.stats = {
    raw: !modelMaterialSharing.enabled,
    models: names.length,
    materialObjects: materials.size,
    nodePrograms: after.nodePrograms - baseline.nodePrograms,
    fragmentShaders: after.fragmentShaders - baseline.fragmentShaders,
    pipelines: after.pipelines - baseline.pipelines,
    layouts: Object.fromEntries(layouts),
    variants: Object.fromEntries([...variants].map(([k, v]) => [k, [...new Set(v)].join(" ")])),
  }
}
// &inst=<name>: one extra cell with a 3×3 instanceModel() grid of that model, to check the instancing path.
const instName = params.get("inst") as ModelName | null
if (instName && MODELS[instName]) {
  const [w, h, d] = MODELS[instName].size as readonly [number, number, number]
  const step = Math.max(w, d) * 1.4
  const placements = Array.from({ length: 9 }, (_, k) => ({
    position: [((k % 3) - 1) * step, 0, (Math.floor(k / 3) - 1) * step] as const,
    yaw: k * 0.7,
  }))
  const group = await instanceModel(instName, placements)
  scene.add(group)
  const r = step * 2.2
  camera.position.set(-r * 0.6, r * 0.7, -r * 0.9)
  camera.lookAt(0, h / 2, 0)
  camera.near = 0.05
  camera.far = r * 20
  camera.updateProjectionMatrix()
  shaft.visible = arrow.visible = post.visible = false
  key.position.set(-r, r * 2, -r)
  renderer.render(scene, camera)
  const i = names.length
  const x = (i % cols) * cw
  const y = Math.floor(i / cols) * ch
  if (y + ch > sheet.height) {
    const prev = ctx.getImageData(0, 0, sheet.width, sheet.height)
    sheet.height = y + ch
    ctx.putImageData(prev, 0, 0)
  }
  ctx.drawImage(gpu, x, y, cw, ch)
  ctx.fillStyle = "#e8e8e8"
  ctx.font = "12px ui-monospace, Menlo, monospace"
  ctx.fillText(`instanceModel(${instName}) ×9: ${group.children.length} InstancedMesh`, x + 6, y + ch - 5)
}
status.ready = true
