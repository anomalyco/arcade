import * as THREE from "three/webgpu"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { LabPanel, type LabControl, type LabSettings } from "@arcade/kit/lab-panel"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { BODY_CONTROLS, BODY_LAYER, HEAD_LAYER, PlayerBody } from "../body"
import { buildStage, groundAt, LADDER, RAMP, STAIRS } from "./stage"
import { LabWalker } from "./walker"
import "./lab.css"

// Body Lab (body.html): the real PlayerBody in a lit room with a staircase, a ramp and a ladder, driven by a stand-in
// controller (free walk or treadmill), with an orbit camera, a first-person inset, scripted moves, slow motion, a
// skeleton overlay and a foot-slide meter. Every body tunable is in the Lab panel (Backquote).
//
// Automation (query only): ?script=<name> starts a scripted move, &speed=0.25 slow motion, &cam=side|front|back|3q|top
// view preset, &pitch=<rad> view pitch, &flashlight=1, &set=key:value,…, &inset=0 hides the first-person inset, &fp=1 shows the first-person view full-frame, &skeleton=1.
// `__bodyLab` reports { ready, frames, state, slide: [l, r] cm/s EMA, slideAvg: mean planted foot slide cm/s since the
// script's warm-up, slideMax }.

const params = new URLSearchParams(location.search)
const canvas = document.querySelector<HTMLCanvasElement>("#view")!
const hud = document.querySelector<HTMLPreElement>("#hud")!
const bar = document.querySelector<HTMLDivElement>("#bar")!

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
await renderer.init()
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
buildStage(scene)

const settings: LabSettings = {
  "lab.speed": Number(params.get("speed") ?? 1),
  "lab.treadmill": true,
  "lab.skeleton": params.get("skeleton") === "1",
  "lab.inset": params.get("inset") !== "0",
  "lab.follow": true,
  "lab.walk": 1.9,
  // The lab's flashlight comes out of the torch lens, so the hand needn't dodge a beam from beside the eye.
  "body.torchAvoidBeam": false,
}
const labControls: LabControl[] = [
  { key: "lab.speed", label: "Playback speed", group: "Lab", unit: "×", min: 0.1, max: 1, step: 0.05 },
  { key: "lab.treadmill", label: "Treadmill (stay in place)", group: "Lab", type: "toggle" },
  { key: "lab.skeleton", label: "Skeleton overlay", group: "Lab", type: "toggle" },
  { key: "lab.inset", label: "First-person inset", group: "Lab", type: "toggle" },
  { key: "lab.follow", label: "Camera follows the body", group: "Lab", type: "toggle" },
  { key: "lab.walk", label: "Walk speed (run = 2.3×)", group: "Lab", unit: "m/s", min: 0.8, max: 3, step: 0.05 },
]

const walker = new LabWalker()
const body = new PlayerBody({ url: `${import.meta.env.BASE_URL}models/player/janitor.glb`, settings, ground: groundAt })
scene.add(body.root)

// Cameras: orbit (sees the head), first person (the game's view: body layer, no head).
const cam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200)
cam.layers.enable(BODY_LAYER)
cam.layers.enable(HEAD_LAYER)
cam.position.set(3, 1.6, 3)
const orbit = new OrbitControls(cam, canvas)
orbit.target.set(0, 1, 0)
orbit.enableDamping = true
const fp = new THREE.PerspectiveCamera(68, 16 / 10, 0.1, 200)
fp.layers.enable(BODY_LAYER)
// The game's flashlight, emitted from the torch lens here (so the lab shows what a torch-mounted beam looks like).
const flash = new THREE.SpotLight(0xfff0dc, 0, 30, 0.42, 0.35, 2)
flash.castShadow = true
flash.shadow.mapSize.set(1024, 1024)
flash.shadow.camera.near = 0.05
scene.add(flash, flash.target)

// The eye (the first-person camera) as a red dot, for the orbit view only.
const eyeDot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), new THREE.MeshBasicNodeMaterial({ color: 0xff2020, depthTest: false }))
eyeDot.renderOrder = 11
eyeDot.layers.set(HEAD_LAYER)
scene.add(eyeDot)
let skeleton: THREE.SkeletonHelper | null = null
body.ready.then(() => {
  skeleton = new THREE.SkeletonHelper(body.model!)
  ;(skeleton.material as THREE.LineBasicMaterial).depthTest = false
  skeleton.renderOrder = 10
  skeleton.layers.set(HEAD_LAYER)
  scene.add(skeleton)
})

// ------------------------------------------------------------------------------------------- scripted moves
type Script = { label: string; treadmill: boolean; at?: [number, number, number]; input: (t: number) => Partial<typeof walker.input> & { flashlight?: boolean; reach?: boolean; pitch?: number } }
const pulse = (t: number, every: number) => t % every < 1 / 60
const SCRIPTS: Record<string, Script> = {
  idle: { label: "Idle", treadmill: true, input: () => ({}) },
  walk: { label: "Walk", treadmill: true, input: () => ({ fwd: 1 }) },
  run: { label: "Run", treadmill: true, input: () => ({ fwd: 1, run: true }) },
  back: { label: "Back", treadmill: true, input: () => ({ fwd: -1 }) },
  strafe_l: { label: "Strafe L", treadmill: true, input: () => ({ side: -1 }) },
  strafe_r: { label: "Strafe R", treadmill: true, input: () => ({ side: 1 }) },
  diag: { label: "Diagonal", treadmill: true, input: () => ({ fwd: 1, side: 1 }) },
  run_strafe: { label: "Run strafe", treadmill: true, input: () => ({ side: 1, run: true }) },
  turn: { label: "Turn", treadmill: true, input: (t) => ({ yawRate: Math.cos(t * 0.8) * 2.4 }) },
  crouch: { label: "Crouch", treadmill: true, input: (t) => ({ crouch: true, fwd: t % 4 > 0.6 ? 1 : 0 }) },
  jump: { label: "Jump", treadmill: true, input: (t) => ({ fwd: 1, jump: pulse(t + 1, 1.4) }) },
  stairs_up: { label: "Stairs up", treadmill: false, at: [STAIRS.x0 - 1.5, 0, -Math.PI / 2], input: (t) => ({ fwd: t < 4.2 ? 1 : 0 }) },
  stairs_down: { label: "Stairs down", treadmill: false, at: [STAIRS.x0 + STAIRS.steps * STAIRS.run + 1.2, 0, Math.PI / 2], input: (t) => ({ fwd: t < 4.2 ? 1 : 0 }) },
  slope: { label: "Ramp", treadmill: false, at: [0, RAMP.z0 - 1.5, Math.PI], input: (t) => ({ fwd: t < 5 ? 1 : 0 }) },
  ladder: { label: "Ladder", treadmill: false, at: [(LADDER.x0 + LADDER.x1) / 2, LADDER.z + 1.2, 0], input: (t) => ({ fwd: t < 4 ? 1 : 0 }) },
  flashlight: { label: "Flashlight", treadmill: true, input: (t) => ({ flashlight: true, fwd: t % 6 > 3 ? 1 : 0, pitch: Number(params.get("pitch") ?? -0.3) + Math.sin(t * 0.9) * 0.4 }) },
  reach: { label: "Reach (E)", treadmill: true, input: (t) => ({ reach: pulse(t, 2) }) },
}
let script: string | null = null
let scriptT = 0
let scriptReal = 0
const slideAcc = { sum: 0, n: 0, max: 0 }
function startScript(name: string | null) {
  script = name && SCRIPTS[name] ? name : null
  scriptT = 0
  scriptReal = 0
  slideAcc.sum = slideAcc.n = slideAcc.max = 0
  walker.pitch = Number(params.get("pitch") ?? 0)
  walker.flashlight = params.get("flashlight") === "1"
  Object.assign(walker.input, { fwd: 0, side: 0, run: false, crouch: false, jump: false, yawRate: 0, pitchRate: 0 })
  if (!script) return
  const s = SCRIPTS[script]!
  settings["lab.treadmill"] = s.treadmill
  if (s.at) walker.place(s.at[0], s.at[1], s.at[2])
  else walker.place(0, 0, walker.yaw)
}

for (const [name, s] of Object.entries(SCRIPTS)) {
  const b = document.createElement("button")
  b.textContent = s.label
  b.onclick = () => startScript(script === name ? null : name)
  b.dataset.script = name
  bar.append(b)
}
const camPresets = ["side", "front", "back", "3q", "top", "free"] as const
let camPreset: (typeof camPresets)[number] = (params.get("cam") as (typeof camPresets)[number]) ?? "3q"
const camSel = document.createElement("select")
for (const p of camPresets) camSel.append(new Option(`cam: ${p}`, p, p === camPreset, p === camPreset))
camSel.onchange = () => (camPreset = camSel.value as typeof camPreset)
bar.append(camSel)
let fpFull = params.get("fp") === "1"
const fpBtn = document.createElement("button")
fpBtn.textContent = "FP full"
fpBtn.onclick = () => (fpFull = !fpFull)
bar.append(fpBtn)

// ------------------------------------------------------------------------------------------- keyboard (free walk)
const keys = new Set<string>()
window.addEventListener("keydown", (e) => {
  if (isEditableEventTarget(e.target)) return
  keys.add(e.code)
  if (e.repeat) return
  if (e.code === "KeyF") walker.flashlight = !walker.flashlight
  if (e.code === "KeyE") body.reach()
  if (e.code === "Space") {
    walker.input.jump = true
    e.preventDefault()
  }
  if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code) && script) startScript(null)
})
window.addEventListener("keyup", (e) => keys.delete(e.code))
addEventListener("blur", () => keys.clear())

new LabPanel(settings, [...labControls, ...BODY_CONTROLS], params, () => keys.clear(), { open: !params.has("shot"), presets: false })

addEventListener("resize", () => renderer.setSize(innerWidth, innerHeight, false))

// ------------------------------------------------------------------------------------------- loop
const status = { ready: false, frames: 0, state: "", slide: [0, 0], slideAvg: 0, slideMax: 0, clips: {} as unknown, errors: [] as string[], settings, body }
;(globalThis as { __bodyLab?: unknown }).__bodyLab = status
window.addEventListener("error", (e) => status.errors.push(String(e.message)))
// `set=key:value,key:value` (automation): settings overrides, e.g. set=body.footIK:0.
for (const kv of params.get("set")?.split(",") ?? []) {
  const [k, v] = kv.split(":") as [string, string]
  settings[k] = v === "true" ? true : v === "false" ? false : Number(v)
}
startScript(params.get("script"))
const lensP = new THREE.Vector3()
const lensD = new THREE.Vector3()
const look = new THREE.Vector3()
let last = performance.now()
let hudT = 0
let ready = false
body.ready.then(() => {
  ready = true
  status.clips = body.clipInfo()
})

renderer.setAnimationLoop(() => {
  const now = performance.now()
  const real = Math.min(0.05, (now - last) / 1000)
  last = now
  const dt = real * Number(settings["lab.speed"])
  walker.walk = Number(settings["lab.walk"])
  walker.treadmill = settings["lab.treadmill"] === true

  // Input: a script, or the keyboard.
  const k = walker.input
  if (script) {
    scriptT += dt
    scriptReal += real
    const s = SCRIPTS[script]!.input(scriptT)
    Object.assign(k, { fwd: 0, side: 0, run: false, crouch: false, yawRate: 0, pitchRate: 0 }, s)
    if (s.flashlight !== undefined) walker.flashlight = s.flashlight
    if (s.reach) body.reach()
    if (s.pitch !== undefined) walker.pitch = s.pitch
  } else {
    k.fwd = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0)
    k.side = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0)
    k.run = keys.has("ShiftLeft") || keys.has("ShiftRight")
    k.crouch = keys.has("KeyC")
    k.yawRate = ((keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0)) * 2.2
    k.pitchRate = ((keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0)) * 1.4
  }
  walker.update(dt)
  body.debug.belt.set(walker.treadmill ? walker.vel.x : 0, 0, walker.treadmill ? walker.vel.z : 0)
  body.update(dt, walker)

  // Slide stats over the script, after a warm-up.
  if (ready && scriptReal > 1 && dt > 0) {
    for (let i = 0; i < 2; i++) {
      if (!body.debug.planted[i]) continue
      const v = body.debug.slide[i]! * 100
      slideAcc.sum += v
      slideAcc.n++
      slideAcc.max = Math.max(slideAcc.max, v)
    }
  }

  // Flashlight from the torch lens (or the eye while the hand isn't holding it).
  const lit = walker.flashlight && body.torchLens(lensP, lensD)
  flash.intensity = walker.flashlight ? 40 : 0
  if (lit) {
    flash.position.copy(lensP)
    flash.target.position.copy(lensP).addScaledVector(lensD, 5)
  } else {
    flash.position.set(walker.eye.x, walker.eye.y - 0.3, walker.eye.z)
    flash.target.position.copy(flash.position).add(look.set(0, 0, -1).applyEuler(new THREE.Euler(walker.pitch, walker.yaw, 0, "YXZ")))
  }

  // Cameras.
  fp.position.set(walker.eye.x, walker.eye.y, walker.eye.z)
  fp.rotation.set(walker.pitch, walker.yaw, 0, "YXZ")
  eyeDot.position.copy(fp.position)
  const target = new THREE.Vector3(body.root.position.x, walker.pos.y + 0.95, body.root.position.z)
  if (camPreset !== "free") {
    const y = walker.yaw
    const f = new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y))
    const r = new THREE.Vector3(Math.cos(y), 0, -Math.sin(y))
    const off = { side: r.clone().multiplyScalar(3.4), front: f.clone().multiplyScalar(3.4), back: f.clone().multiplyScalar(-3.4), "3q": f.clone().multiplyScalar(2.4).addScaledVector(r, 2.4), top: f.clone().multiplyScalar(0.01) }[camPreset]
    cam.position.copy(target).add(off).add(new THREE.Vector3(0, camPreset === "top" ? 4.5 : 0.25, 0))
    orbit.target.copy(target)
    cam.lookAt(target)
  } else if (settings["lab.follow"]) {
    const d = target.clone().sub(orbit.target)
    orbit.target.add(d)
    cam.position.add(d)
    orbit.update()
  } else orbit.update()
  if (skeleton) skeleton.visible = settings["lab.skeleton"] === true

  const W = canvas.clientWidth
  const H = canvas.clientHeight
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, W, H)
  if (fpFull) {
    fp.aspect = W / H
    fp.updateProjectionMatrix()
    renderer.render(scene, fp)
  } else {
    cam.aspect = W / H
    cam.updateProjectionMatrix()
    renderer.render(scene, cam)
    if (settings["lab.inset"]) {
      const iw = Math.round(W * 0.32)
      const ih = Math.round(iw * 0.625)
      fp.aspect = iw / ih
      fp.updateProjectionMatrix()
      renderer.setScissorTest(true)
      renderer.setScissor(W - iw - 12, 12, iw, ih)
      renderer.setViewport(W - iw - 12, 12, iw, ih)
      renderer.render(scene, fp)
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, W, H)
    }
  }

  if (ready) {
    status.ready = true
    status.frames++
    status.state = body.debug.state
    status.slide = body.debug.slide.map((v) => +(v * 100).toFixed(1))
    status.slideAvg = slideAcc.n ? +(slideAcc.sum / slideAcc.n).toFixed(1) : 0
    status.slideMax = +slideAcc.max.toFixed(1)
  }
  hudT += real
  if (hudT > 0.1) {
    hudT = 0
    const w = Object.entries(body.debug.weights)
      .filter(([, v]) => v > 0.01)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join("  ")
    const sp = Math.hypot(walker.vel.x, walker.vel.z)
    hud.textContent = [
      `${script ? `script ${script}  t ${scriptT.toFixed(1)}s` : "free walk: WASD, Shift run, C crouch, Space jump, F torch, E reach, arrows look"}  ×${Number(settings["lab.speed"]).toFixed(2)}`,
      `state ${body.debug.state}  warp ${body.debug.warp.toFixed(0)}°  stride ×${body.debug.stride.toFixed(2)}  speed ${sp.toFixed(2)} m/s  phase ${body.debug.phase.toFixed(2)}${walker.treadmill ? "  (treadmill)" : ""}`,
      `blend ${w}`,
      `foot slide while planted  L ${(body.debug.slide[0] * 100).toFixed(1)}  R ${(body.debug.slide[1] * 100).toFixed(1)} cm/s  ${body.debug.planted.map((p) => (p ? "▮" : "▯")).join("")}   script avg ${status.slideAvg} max ${status.slideMax} cm/s`,
    ].join("\n")
  }
})
if (params.has("shot")) document.body.classList.add("shot")
