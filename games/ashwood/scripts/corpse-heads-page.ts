// Throwaway review page (scripts/corpse-heads.html): the four listening-room bodies (LISTENING_ROOM_BODIES), each in
// its pose with its wounds, head close-ups lit by a narrow flashlight-like spot from the camera. Row 1: blood overlay
// off; row 2: on. ?blood=0|1 forces one row. Driven by scripts/corpse-heads.ts.
import * as THREE from "three/webgpu"
import { spawnCorpse } from "../src/world/npc/corpse"
import { LISTENING_ROOM_BODIES } from "../src/world/interior/storeys/s3/listening"

const status = { ready: false, errors: [] as string[] }
;(globalThis as { __heads?: typeof status }).__heads = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))
addEventListener("unhandledrejection", (e) => status.errors.push(String((e as PromiseRejectionEvent).reason)))
const params = new URLSearchParams(location.search)
const cw = Number(params.get("w") ?? 480)
const ch = Number(params.get("h") ?? 420)
const rows = params.has("blood") ? [params.get("blood") === "1"] : [false, true]
const only = params.get("only")
const bodies = LISTENING_ROOM_BODIES.filter((b) => !only || only.split(",").includes(b.character)).map((b) => ({ ...b, pose: (params.get("pose") ?? b.pose) as typeof b.pose }))
const hideHair = params.get("hair") === "0"
const hairDebug = params.get("hair") === "debug"
const out = document.querySelector<HTMLCanvasElement>("#c")!
out.width = cw * bodies.length
out.height = ch * rows.length
const ctx = out.getContext("2d")!
const gpu = document.createElement("canvas")
const renderer = new THREE.WebGPURenderer({ canvas: gpu, antialias: true })
await renderer.init()
renderer.setPixelRatio(1)
renderer.setSize(cw, ch, false)
renderer.toneMapping = THREE.AgXToneMapping
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0d0d)
scene.add(new THREE.HemisphereLight(0x7a8a90, 0x201a16, 0.25))
const cam = new THREE.PerspectiveCamera(28, cw / ch, 0.02, 20)
const torch = new THREE.SpotLight(0xfff1dc, Number(params.get("torch") ?? 14), 6, 0.35, 0.5, 2)
cam.add(torch, torch.target)
torch.position.set(0.12, -0.05, 0)
torch.target.position.set(0, 0, -1)
scene.add(cam)
for (const [ri, blood] of rows.entries())
  for (const [ci, a] of bodies.entries()) {
    const root = await spawnCorpse(a.character, a.pose, { x: 0, y: 0, z: 0, yaw: a.yaw }, blood ? { blood: { wounds: a.wounds } } : {})
    scene.add(root)
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mats = [m.material].flat() as THREE.Material[]
      if (mats.some((x) => /hair/i.test(x.name))) {
        if (hideHair) m.visible = false
        if (hairDebug) m.material = new THREE.MeshBasicNodeMaterial({ color: 0xff00ff, wireframe: true })
      }
    })
    root.updateMatrixWorld(true)
    let head: THREE.Object3D | undefined
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone && /(^|:)Head$/.test(o.name)) head = o
    })
    const hp = new THREE.Vector3()
    head?.getWorldPosition(hp)
    hp.y += 0.08
    // View from the side the face points at, slightly above.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(head!.getWorldQuaternion(new THREE.Quaternion()))
    fwd.y = 0
    if (fwd.lengthSq() < 1e-3) fwd.set(1, 0, 0)
    fwd.normalize()
    const side = Number(params.get("side") ?? 0)
    fwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), side)
    // Orbit around the head at `side` radians from the face direction, `elev` metres up, `dist` away (default 0.62).
    const dist = Number(params.get("dist") ?? 0.62)
    const elev = Number(params.get("elev") ?? 0.28)
    cam.position.copy(hp).addScaledVector(fwd, dist).add(new THREE.Vector3(0, elev, 0))
    if (params.has("world")) {
      // World-fixed: orbit the head at `side` radians from the body's facing (yaw), dist/elev as above.
      const f = new THREE.Vector3(Math.sin(a.yaw + side), 0, Math.cos(a.yaw + side))
      cam.position.copy(hp).addScaledVector(f, dist).add(new THREE.Vector3(0, elev, 0))
    }
    cam.lookAt(hp)
    for (let f = 0; f < 3; f++) renderer.render(scene, cam)
    ctx.drawImage(gpu, ci * cw, ri * ch)
    ctx.fillStyle = "#fff"
    ctx.font = "14px monospace"
    ctx.fillText(`${a.name} (${a.character}, ${a.pose}) blood ${blood ? "on" : "off"}`, ci * cw + 6, ri * ch + 16)
    scene.remove(root)
  }
status.ready = true
