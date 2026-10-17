// Self-check for src/render/documents.ts handedness (scripts/documents-orient.html): one sheet per orientation
// (+X, −X, +Z, −Z, a 45° wall, flat with up −Z, flat with up +X, and a sheet seen from BEHIND), each rendered in its
// own cell by a camera in front of it (on the +normal side). Every front cell must read left-to-right; the "behind"
// cell must show blank paper. Captured by `bun scripts/documents-sheet.ts`-style headless run (see documents-orient.ts).
import * as THREE from "three/webgpu"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { documentMesh, type DocumentPlacement } from "../src/render/documents"
import { initModels } from "../src/render/models"

const status = { ready: false, errors: [] as string[] }
;(globalThis as { __sheet?: typeof status }).__sheet = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))
const cw = 400
const ch = 320
const cases: { label: string; n: [number, number, number]; up?: [number, number, number]; behind?: boolean }[] = [
  { label: "+X", n: [1, 0, 0] }, { label: "-X", n: [-1, 0, 0] }, { label: "+Z", n: [0, 0, 1] }, { label: "-Z", n: [0, 0, -1] },
  { label: "45°", n: [Math.SQRT1_2, 0, -Math.SQRT1_2] }, { label: "flat up -Z", n: [0, 1, 0] }, { label: "flat up +X", n: [0, 1, 0], up: [1, 0, 0] },
  { label: "behind (-Z seen from -Z)", n: [0, 0, 1], behind: true },
]
const sheetCanvas = document.querySelector<HTMLCanvasElement>("#c")!
sheetCanvas.width = cw * 4
sheetCanvas.height = ch * 2
const ctx = sheetCanvas.getContext("2d")!
const gpu = document.createElement("canvas")
const renderer = new THREE.WebGPURenderer({ canvas: gpu, antialias: true })
await renderer.init()
initModels(renderer)
renderer.setPixelRatio(1)
renderer.setSize(cw, ch, false)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x30343a)
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
const camera = new THREE.PerspectiveCamera(35, cw / ch, 0.01, 10)
const meshes = cases.map((c) => {
  const p: DocumentPlacement = { id: "board_dosimeter", position: [0, 0, 0], normal: c.n, up: c.up, pin: "none", curl: 0 }
  return documentMesh([p])
})
// Let the atlas stream in.
for (let f = 0; f < 60; f++) {
  await new Promise((r) => requestAnimationFrame(r))
  scene.add(meshes[0]!)
  renderer.render(scene, camera)
  scene.remove(meshes[0]!)
}
cases.forEach((c, i) => {
  scene.add(meshes[i]!)
  const n = new THREE.Vector3(...c.n).multiplyScalar(c.behind ? -1 : 1)
  camera.position.copy(n).multiplyScalar(0.85)
  camera.up.set(...((Math.abs(c.n[1]) > 0.9 ? (c.up ?? [0, 0, -1]) : [0, 1, 0]) as [number, number, number]))
  camera.lookAt(0, 0, 0)
  renderer.render(scene, camera)
  ctx.drawImage(gpu, (i % 4) * cw, Math.floor(i / 4) * ch)
  ctx.fillStyle = "#fff"
  ctx.font = "16px monospace"
  ctx.fillText(c.label, (i % 4) * cw + 8, Math.floor(i / 4) * ch + 20)
  scene.remove(meshes[i]!)
})
status.ready = true
