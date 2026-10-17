// Standalone review page (scripts/documents-sheet.html), not part of the game: every document from
// src/render/documents.ts pinned in a grid on a cork wall, lit by a warm key light, through documentMesh().
//   ?view=close&id=memo_signin   one document filling the frame (legibility check)
//   ?view=desk                   a few sheets lying on a desk surface (curl/flat check)
// Driven by scripts/documents-sheet.ts.
import * as THREE from "three/webgpu"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { DOCUMENTS, documentMesh, type DocumentId, type DocumentPlacement } from "../src/render/documents"
import { initModels } from "../src/render/models"

const params = new URLSearchParams(location.search)
const status = { ready: false, errors: [] as string[] }
;(globalThis as { __sheet?: typeof status }).__sheet = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))
addEventListener("unhandledrejection", (e) => status.errors.push(String((e as PromiseRejectionEvent).reason)))

const canvas = document.querySelector<HTMLCanvasElement>("#c")!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
initModels(renderer)
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x111111)
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.5
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 50)
const key = new THREE.DirectionalLight(0xfff0dc, 2.4)
key.position.set(-1.5, 2, 3)
scene.add(key)

const view = params.get("view") ?? "grid"
const ids = Object.keys(DOCUMENTS) as DocumentId[]
const placements: DocumentPlacement[] = []
if (view === "grid") {
  const cols = 10
  const pitchX = 0.44
  const pitchY = 0.47
  ids.forEach((id, i) => {
    const x = ((i % cols) - (cols - 1) / 2) * pitchX
    const y = -Math.floor(i / cols) * pitchY
    placements.push({ id, position: [x, y, 0], rotation: ((i * 37) % 7 - 3) * 0.01, pin: id.startsWith("plate_") || id === "stencil_w1" || id === "board_dosimeter" ? "none" : i % 5 === 2 ? "tape" : i % 7 === 4 ? "tack" : "pin", curl: id.startsWith("plate_") || id === "stencil_w1" || id === "board_dosimeter" ? 0 : undefined, seed: i + 1 })
  })
  const rows = Math.ceil(ids.length / cols)
  const cork = new THREE.Mesh(new THREE.PlaneGeometry(cols * pitchX + 0.3, rows * pitchY + 0.3), new THREE.MeshStandardNodeMaterial({ color: 0x8a6a46, roughness: 0.95 }))
  cork.position.set(0, (-(rows - 1) * pitchY) / 2, -0.002)
  scene.add(cork)
  camera.position.set(0, cork.position.y, 5.6)
  camera.lookAt(0, cork.position.y, 0)
} else if (view === "close") {
  const id = (params.get("id") ?? "memo_signin") as DocumentId
  placements.push({ id, position: [0, 0, 0], pin: "pin", curl: 0.4 })
  const [w, h] = DOCUMENTS[id].size
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(w * 1.6, h * 1.4), new THREE.MeshStandardNodeMaterial({ color: 0x8a6a46, roughness: 0.95 })).translateZ(-0.002))
  const d = (Math.max(h, w / camera.aspect) * 0.62) / Math.tan((camera.fov * Math.PI) / 360)
  camera.position.set(0.08 * w, -0.05 * h, d)
  camera.lookAt(0, 0, 0)
} else {
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshStandardNodeMaterial({ color: 0x6a6e6a, roughness: 0.6, metalness: 0.2 }))
  desk.rotation.x = -Math.PI / 2
  scene.add(desk)
  const flat: [DocumentId, number, number, number][] = [
    ["memo_signin", -0.45, 0.05, 0.2], ["form_requisition", -0.2, 0.1, -0.15], ["note_repeated", 0.15, 0.02, 0.4],
    ["printout_greenbar", 0.5, 0.1, -0.05], ["polaroid_corridor", 0.05, -0.25, 0.7], ["sticky_dont", -0.3, -0.25, -0.3], ["card_extensions", 0.35, -0.25, 0.15],
  ]
  flat.forEach(([id, x, z, r], i) => placements.push({ id, position: [x, 0, z], normal: [0, 1, 0], rotation: r, offset: 0.0015 + i * 0.0004, seed: i + 3 }))
  camera.position.set(0, 0.75, 0.75)
  camera.lookAt(0, 0, -0.02)
}
scene.add(documentMesh(placements))
// Let the KTX2 atlas stream in, then render a few frames.
for (let i = 0; i < 90; i++) {
  await new Promise((r) => requestAnimationFrame(r))
  renderer.render(scene, camera)
}
status.ready = true
