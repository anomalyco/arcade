import * as THREE from "three/webgpu"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { LabPanel, type LabControl, type LabSettings } from "@arcade/kit/lab-panel"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { BODY_LAYER, CHARACTERS, CharacterBody, HEAD_LAYER, clipSpeeds, saveCharacter, savedCharacter } from "../body"
import { buildStage, groundAt, LADDER, RAMP, STAIRS } from "./stage"
import { LabWalker } from "./walker"
import "./lab.css"

// Character lab (bodyb.html): the player character component (src/playerb/body.ts) on any roster character, in a
// room with a floor, 0.17 m stairs, a 15° ramp and a ladder, driven by a stand-in controller, with an orbit camera,
// close-up cameras, a first-person inset (the game's camera layers), a button per move and slow motion. The character
// picker shares its choice with the game (localStorage).
//
// Automation (query only): ?script=<name>, &speed=0.25, &cam=side|front|back|3q|top|hands|feet|knees|shoulders|face,
// &pose=<clip>&phase=<0..1> holds one clip at a phase (0 = left heel strike), &skeleton=1, &shot=1 hides the UI.
// `__bodyB` reports { ready, frames, state, clips, errors }.

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
  "lab.walk": 1.9,
  "lab.realSpeeds": params.get("real") === "1",
}
const labControls: LabControl[] = [
  { key: "lab.speed", label: "Playback speed", group: "Lab", unit: "×", min: 0.05, max: 1, step: 0.05 },
  { key: "lab.treadmill", label: "Treadmill (stay in place)", group: "Lab", type: "toggle" },
  { key: "lab.skeleton", label: "Skeleton overlay", group: "Lab", type: "toggle" },
  { key: "lab.walk", label: "Walk speed (run = 2.3×)", group: "Lab", unit: "m/s", min: 0.8, max: 3, step: 0.05 },
  { key: "lab.realSpeeds", label: "Human direction speeds (back 0.5×, side 0.6×)", group: "Lab", type: "toggle" },
]

const walker = new LabWalker()
const startCharacter = params.get("character") ?? savedCharacter()
const body = new CharacterBody({ character: startCharacter, ground: groundAt, ladderTop: () => LADDER.top })
scene.add(body.root)

const cam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.03, 200)
cam.position.set(3, 1.6, 3)
cam.layers.enable(BODY_LAYER)
cam.layers.enable(HEAD_LAYER)
const fpInset = new THREE.PerspectiveCamera(68, 1.6, 0.15, 200)
// The game's view camera: the body without its head (HEAD_LAYER).
fpInset.layers.enable(BODY_LAYER)
const orbit = new OrbitControls(cam, canvas)
orbit.target.set(0, 1, 0)
orbit.enableDamping = true
let skeleton: THREE.SkeletonHelper | null = null
const onModel = () => {
  if (skeleton) scene.remove(skeleton)
  skeleton = new THREE.SkeletonHelper(body.model!)
  ;(skeleton.material as THREE.LineBasicMaterial).depthTest = false
  skeleton.renderOrder = 10
  scene.add(skeleton)
  status.clips = body.debug.clips
  status.speeds = clipSpeeds(body.character)
}

// ------------------------------------------------------------------------------------------- scripted moves
type Script = { label: string; treadmill: boolean; at?: [number, number, number]; input: (t: number) => Partial<typeof walker.input> & { flashlight?: boolean; pitch?: number; press?: "button" | "door" } }
const pulse = (t: number, every: number) => t % every < 1 / 60
const SCRIPTS: Record<string, Script> = {
  demo: {
    label: "Demo",
    treadmill: true,
    input: (t) => {
      const u = t % 22
      if (u < 1.5) return {}
      if (u < 5) return { fwd: 1 }
      if (u < 8) return { fwd: 1, run: true }
      if (u < 9) return {}
      if (u < 11.5) return { fwd: -1 }
      if (u < 14) return { side: 1 }
      if (u < 16.5) return { side: -1 }
      if (u < 19) return { fwd: 1, jump: pulse(u - 16.5, 1.2) }
      return { crouch: true, fwd: u > 19.8 ? 1 : 0 }
    },
  },
  idle: { label: "Idle", treadmill: true, input: () => ({}) },
  press_button: { label: "Button", treadmill: true, input: (t) => ({ press: pulse(t + 2.8, 3) ? "button" : undefined }) },
  press_door: { label: "Door", treadmill: true, input: (t) => ({ press: pulse(t + 2.8, 3) ? "door" : undefined }) },
  walk_press: { label: "Walk + button", treadmill: true, input: (t) => ({ fwd: 1, flashlight: true, press: pulse(t + 2.8, 3) ? "button" : undefined }) },
  torch: { label: "Torch walk", treadmill: true, input: () => ({ flashlight: true, fwd: 1, pitch: Number(params.get("pitch") ?? 0) }) },
  torch_still: { label: "Torch still", treadmill: true, input: () => ({ flashlight: true, pitch: Number(params.get("pitch") ?? 0) }) },
  torch_crouch: { label: "Torch crouch", treadmill: true, input: (t) => ({ flashlight: true, crouch: true, fwd: t % 4 > 1.5 ? 1 : 0, pitch: Number(params.get("pitch") ?? 0) }) },
  torch_run: { label: "Torch run", treadmill: true, input: () => ({ flashlight: true, fwd: 1, run: true, pitch: Number(params.get("pitch") ?? 0) }) },
  torch_look: { label: "Torch look", treadmill: true, input: (t) => ({ flashlight: true, fwd: t % 8 > 4 ? 1 : 0, pitch: Math.sin(t * 0.7) * 1.15 }) },
  torch_all: {
    label: "Torch sweep",
    treadmill: true,
    // Idle, walk, run, back, strafe, crouch with the torch on while the view pitch sweeps ±66°.
    input: (t) => {
      const u = t % 18
      const pitch = Math.sin(t * 0.9) * 1.15
      const m = u < 2 ? {} : u < 6 ? { fwd: 1 } : u < 9 ? { fwd: 1, run: true } : u < 11 ? { fwd: -1 } : u < 13 ? { side: 1 } : u < 15 ? { side: -1 } : { crouch: true, fwd: u > 16 ? 1 : 0 }
      return { flashlight: true, pitch, ...m }
    },
  },
  walk: { label: "Walk", treadmill: true, input: () => ({ fwd: 1 }) },
  run: { label: "Run", treadmill: true, input: () => ({ fwd: 1, run: true }) },
  start_stop: { label: "Start/stop", treadmill: true, input: (t) => ({ fwd: t % 4 < 2.5 ? 1 : 0 }) },
  walk_run: { label: "Walk↔run", treadmill: true, input: (t) => ({ fwd: 1, run: t % 6 > 3 }) },
  back: { label: "Back", treadmill: true, input: () => ({ fwd: -1 }) },
  back_run: { label: "Back run", treadmill: true, input: () => ({ fwd: -1, run: true }) },
  strafe_l: { label: "Strafe L", treadmill: true, input: () => ({ side: -1 }) },
  strafe_r: { label: "Strafe R", treadmill: true, input: () => ({ side: 1 }) },
  run_strafe: { label: "Run strafe", treadmill: true, input: () => ({ side: 1, run: true }) },
  diag: { label: "Diagonal", treadmill: true, input: () => ({ fwd: 1, side: 1 }) },
  diag_back: { label: "Diag back", treadmill: true, input: () => ({ fwd: -1, side: -1 }) },
  line_walk: { label: "Walk past", treadmill: false, at: [-4.5, -7, -Math.PI / 2], input: (t) => ({ fwd: t < 4.5 ? 1 : 0 }) },
  line_run: { label: "Run past", treadmill: false, at: [-7, -7, -Math.PI / 2], input: (t) => ({ fwd: t < 3 ? 1 : 0, run: true }) },
  line_back: { label: "Back past", treadmill: false, at: [4.5, -7, Math.PI / 2], input: (t) => ({ fwd: t < 4.5 ? -1 : 0 }) },
  line_strafe: { label: "Strafe past", treadmill: false, at: [-4.5, -7, 0], input: (t) => ({ side: t < 4.5 ? 1 : 0 }) },
  circle: { label: "Circle", treadmill: false, at: [0, -3, 0], input: (t) => ({ fwd: 1, yawRate: 0.9 + 0 * t }) },
  turn: { label: "Turn", treadmill: true, input: (t) => ({ yawRate: Math.cos(t * 0.8) * 2.4 }) },
  crouch: { label: "Crouch", treadmill: true, input: (t) => ({ crouch: true, fwd: t % 4 > 0.6 ? 1 : 0 }) },
  jump: { label: "Jump", treadmill: true, input: (t) => ({ fwd: 1, jump: pulse(t + 1, 1.4) }) },
  jump_still: { label: "Jump still", treadmill: true, input: (t) => ({ jump: pulse(t + 1, 1.8) }) },
  stairs_up: { label: "Stairs up", treadmill: false, at: [STAIRS.x0 - 1.5, 0, -Math.PI / 2], input: (t) => ({ fwd: t < 4.2 ? 1 : 0 }) },
  stairs_down: { label: "Stairs down", treadmill: false, at: [STAIRS.x0 + STAIRS.steps * STAIRS.run + 1.2, 0, Math.PI / 2], input: (t) => ({ fwd: t < 4.2 ? 1 : 0 }) },
  slope: { label: "Ramp", treadmill: false, at: [0, RAMP.z0 - 1.5, Math.PI], input: (t) => ({ fwd: t < 5 ? 1 : 0 }) },
  ladder: { label: "Ladder", treadmill: false, at: [(LADDER.x0 + LADDER.x1) / 2, LADDER.z + 1.2, 0], input: (t) => ({ fwd: t < 4 ? 1 : 0 }) },
}
let script: string | null = null
let scriptT = 0
function startScript(name: string | null) {
  script = name && SCRIPTS[name] ? name : null
  scriptT = 0
  slideAcc.sum = slideAcc.n = slideAcc.max = 0
  clearAcc.min = Infinity
  clearAcc.at = ""
  walker.flashlight = false
  walker.pitch = 0
  Object.assign(walker.input, { fwd: 0, side: 0, run: false, crouch: false, jump: false, yawRate: 0, pitchRate: 0 })
  for (const b of bar.querySelectorAll<HTMLButtonElement>("button[data-script]")) b.classList.toggle("on", b.dataset.script === script)
  if (!script) return
  const s = SCRIPTS[script]!
  settings["lab.treadmill"] = s.treadmill
  if (s.at) walker.place(s.at[0], s.at[1], s.at[2])
  else walker.place(0, 0, 0)
}
for (const [name, s] of Object.entries(SCRIPTS)) {
  const b = document.createElement("button")
  b.textContent = s.label
  b.onclick = () => startScript(script === name ? null : name)
  b.dataset.script = name
  bar.append(b)
}
const camPresets = ["fp", "fixed", "fixedfeet", "3q", "side", "front", "back", "top", "hands", "feet", "knees", "shoulders", "face", "above", "grip", "gripin", "gripunder", "torchend", "torchside", "torchtop", "free"] as const
type Cam = (typeof camPresets)[number]
let camPreset: Cam = (params.get("cam") as Cam) ?? "3q"
const camSel = document.createElement("select")
for (const p of camPresets) camSel.append(new Option(`cam: ${p}`, p, p === camPreset, p === camPreset))
camSel.onchange = () => (camPreset = camSel.value as Cam)
const speedSel = document.createElement("select")
for (const v of [1, 0.5, 0.25, 0.1]) speedSel.append(new Option(`${v}×`, String(v), v === settings["lab.speed"], v === settings["lab.speed"]))
speedSel.onchange = () => (settings["lab.speed"] = Number(speedSel.value))
const realBtn = document.createElement("button")
const realLabel = () => (realBtn.textContent = settings["lab.realSpeeds"] ? "speeds: human" : "speeds: game")
realLabel()
realBtn.onclick = () => {
  settings["lab.realSpeeds"] = !settings["lab.realSpeeds"]
  realLabel()
}
const charSel = document.createElement("select")
for (const c of CHARACTERS) charSel.append(new Option(c.name, c.id, c.id === startCharacter, c.id === startCharacter))
charSel.onchange = () => {
  saveCharacter(charSel.value)
  void body.setCharacter(charSel.value).then(onModel)
}
const insetBtn = document.createElement("button")
let inset = params.get("inset") !== "0"
insetBtn.textContent = "FP inset"
insetBtn.onclick = () => (inset = !inset)
const eBtn = document.createElement("button")
eBtn.textContent = "Button (E)"
eBtn.onclick = () => body.interact("button")
const dBtn = document.createElement("button")
dBtn.textContent = "Door (R)"
dBtn.onclick = () => body.interact("door")
const fBtn = document.createElement("button")
fBtn.textContent = "Torch (F)"
fBtn.onclick = () => (walker.flashlight = !walker.flashlight)
bar.append(charSel, camSel, speedSel, realBtn, insetBtn, eBtn, dBtn, fBtn)

// ------------------------------------------------------------------------------------------- keyboard (free walk)
const keys = new Set<string>()
window.addEventListener("keydown", (e) => {
  if (isEditableEventTarget(e.target)) return
  keys.add(e.code)
  if (e.repeat) return
  if (e.code === "KeyF") walker.flashlight = !walker.flashlight
  if (e.code === "KeyE") body.interact("button")
  if (e.code === "KeyR") body.interact("door")
  if (e.code === "Space") {
    walker.input.jump = true
    e.preventDefault()
  }
  if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code) && script) startScript(null)
})
window.addEventListener("keyup", (e) => keys.delete(e.code))
addEventListener("blur", () => keys.clear())
new LabPanel(settings, labControls, params, () => keys.clear(), { open: false, presets: false })
addEventListener("resize", () => renderer.setSize(innerWidth, innerHeight, false))

// ------------------------------------------------------------------------------------------- loop
const slideAcc = { sum: 0, n: 0, max: 0 }
const clearAcc = { min: Infinity, at: "" }
const lensP = new THREE.Vector3()
const lensD = new THREE.Vector3()
const flash = new THREE.SpotLight(0xfff0dc, 0, 30, 0.42, 0.35, 2)
flash.castShadow = true
flash.shadow.mapSize.set(1024, 1024)
flash.shadow.camera.near = 0.05
scene.add(flash, flash.target)
// Automation: `pause()` then `advance(n)` steps exactly n frames of 1/30 s each (deterministic video frames).
const stepper = { paused: false, pending: 0 }
const status = {
  speeds: {} as Record<string, number>,
  setCharacter: (id: string) => body.setCharacter(id).then(onModel),
  info: () => body.info(),
  /** Automation: hold the view pitch (rad) during scripts. */
  pitchHold: undefined as number | undefined,
  clear: 0,
  clearMin: 0,
  clearAt: "", pause: () => (stepper.paused = true), advance: (n: number) => (stepper.pending += n), pending: () => stepper.pending, slideAvg: 0, slideMax: 0, ready: false, frames: 0, state: "", clips: {} as unknown, errors: [] as string[], body, walker, startScript, setCam: (c: Cam) => (camPreset = c), settings }
;(globalThis as { __bodyB?: unknown }).__bodyB = status
window.addEventListener("error", (e) => status.errors.push(String(e.message) + " " + String((e.error as Error | undefined)?.stack ?? "").slice(0, 400)))
startScript(params.get("script"))
let ready = false
body.ready.then(() => {
  ready = true
  onModel()
  const pose = params.get("pose")
  if (pose) body.setPose({ clip: pose, phase: Number(params.get("phase") ?? 0) })
})
body.ready.catch((e: unknown) => status.errors.push(String(e)))

const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()
let last = performance.now()
let hudT = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  let real = Math.min(0.05, (now - last) / 1000)
  last = now
  if (stepper.paused) {
    if (stepper.pending > 0) {
      stepper.pending--
      real = 1 / 30
    } else real = 0
  }
  const dt = real * Number(settings["lab.speed"])
  walker.walk = Number(settings["lab.walk"])
  walker.treadmill = settings["lab.treadmill"] === true
  walker.backK = settings["lab.realSpeeds"] ? 0.5 : 1
  walker.sideK = settings["lab.realSpeeds"] ? 0.6 : 1
  const k = walker.input
  if (script) {
    scriptT += dt
    const si = SCRIPTS[script]!.input(scriptT)
    Object.assign(k, { fwd: 0, side: 0, run: false, crouch: false, yawRate: 0, pitchRate: 0 }, si)
    if (si.flashlight !== undefined) walker.flashlight = si.flashlight
    if (si.pitch !== undefined) walker.pitch = si.pitch
    if (status.pitchHold !== undefined) walker.pitch = status.pitchHold
    if (si.press) body.interact(si.press)
  } else {
    k.fwd = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0)
    k.side = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0)
    k.run = keys.has("ShiftLeft") || keys.has("ShiftRight")
    k.crouch = keys.has("KeyC")
    k.yawRate = ((keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0)) * 2.2
    k.pitchRate = ((keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0)) * 1.4
  }
  walker.update(dt)
  if (camPreset === "fp") cam.layers.disable(HEAD_LAYER)
  else cam.layers.enable(HEAD_LAYER)
  body.eyeAnchor = camPreset === "fp"
  body.update(dt, walker)

  // Cameras: framing presets relative to the walker's facing; close-ups aim at a joint.
  const y = walker.yaw
  const f = tmp.set(-Math.sin(y), 0, -Math.cos(y))
  const r = tmp2.set(Math.cos(y), 0, -Math.sin(y))
  const at = new THREE.Vector3(body.root.position.x, body.root.position.y + 0.95, body.root.position.z)
  const bone = (n: string) => body.model?.getObjectByName(n)?.getWorldPosition(new THREE.Vector3())
  const near: Partial<Record<Cam, [string, number, number, number]>> = {
    // [bone, forward, right, up] offsets in metres.
    hands: ["RightHand", 0.35, 0.75, 0.1],
    feet: ["RightToeBase", 0.25, 0.9, 0.12],
    knees: ["RightLeg", 0.3, 1.1, 0.1],
    shoulders: ["Spine2", 0.9, 0.9, 0.25],
    face: ["Head", 0.75, 0.25, 0.05],
    above: ["Spine1", 0.35, -0.3, 1.5],
    grip: ["LeftHand", 0.15, -0.3, 0.12],
    gripin: ["LeftHand", 0.3, 0.12, 0.05],
    gripunder: ["LeftHand", 0.18, -0.15, -0.3],
  }
  const n = near[camPreset]
  if (n) {
    if (!body.model) return
    const p = bone(n[0])
    if (p) {
      at.copy(p)
      cam.position.copy(p).addScaledVector(f, n[1]).addScaledVector(r, n[2]).add(new THREE.Vector3(0, n[3], 0))
      cam.lookAt(at)
    }
  } else if (camPreset === "torchend" || camPreset === "torchside" || camPreset === "torchtop") {
    // Close-ups in the torch's own frame (its -Z is the beam): along the barrel, from the side, from above.
    const t = body.torch
    const off = { torchend: [0.02, 0.05, -0.32], torchside: [0.3, 0.04, 0.02], torchtop: [0.02, 0.3, 0.03] }[camPreset]
    cam.position.copy(t.localToWorld(new THREE.Vector3(off[0], off[1], off[2])))
    cam.lookAt(t.localToWorld(new THREE.Vector3(0, 0, 0.02)))
  } else if (camPreset === "fp") {
    // The game's view: at the eye, yaw + pitch, 68° vertical FOV; near plane past the inside of the head.
    cam.position.set(walker.eye.x, walker.eye.y, walker.eye.z)
    cam.rotation.set(walker.pitch, walker.yaw, 0, "YXZ")
  } else if (camPreset === "fixed" || camPreset === "fixedfeet") {
    // A static camera beside the walk-past line (z = -7), looking at where the body is now.
    const feet = camPreset === "fixedfeet"
    cam.position.set(body.root.position.x * (feet ? 0.85 : 0.5), feet ? 0.35 : 1.0, feet ? -8.8 : -10.8)
    cam.lookAt(body.root.position.x, body.root.position.y + (feet ? 0.12 : 0.9), body.root.position.z)
  } else if (camPreset !== "free") {
    const off = { side: r.clone().multiplyScalar(3.4), front: f.clone().multiplyScalar(3.4), back: f.clone().multiplyScalar(-3.4), "3q": f.clone().multiplyScalar(2.4).addScaledVector(r, 2.4), top: f.clone().multiplyScalar(0.01) }[camPreset as "side"]
    cam.position.copy(at).add(off).add(new THREE.Vector3(0, camPreset === "top" ? 4.5 : 0.1, 0))
    cam.lookAt(at)
  } else orbit.update()
  if (skeleton) skeleton.visible = settings["lab.skeleton"] === true
  const fpCam = camPreset === "fp"
  if (cam.fov !== (fpCam ? 68 : 40) || cam.near !== (fpCam ? 0.16 : 0.03)) {
    cam.fov = fpCam ? 68 : 40
    cam.near = fpCam ? 0.15 : 0.03
  }
  // Flashlight: from the torch lens along the barrel (the arm's pose sets it); beyond the arm's aim range the beam
  // leads toward the view, as the game's light follows the camera.
  if (walker.flashlight && body.torchLens(lensP, lensD)) {
    const view = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(walker.pitch, walker.yaw, 0, "YXZ"))
    flash.intensity = 40
    flash.position.copy(lensP)
    flash.target.position.copy(lensP).addScaledVector(lensD.lerp(view, 0.5).normalize(), 5)
  } else flash.intensity = 0
  // Clearance between the carrying arm/torch and the torso/thighs, every frame while the torch is out.
  if (ready && walker.flashlight && script && scriptT > 0.6 && (dt > 0 || stepper.paused)) {
    const c = body.clearance()
    if (c) {
      status.clear = +(c.min * 100).toFixed(1)
      if (c.min < clearAcc.min) {
        clearAcc.min = c.min
        clearAcc.at = `${c.at} @${scriptT.toFixed(2)}s ${body.debug.state} pitch ${walker.pitch.toFixed(2)}`
      }
      status.clearMin = +(clearAcc.min * 100).toFixed(1)
      status.clearAt = clearAcc.at
    }
  }
  cam.aspect = canvas.clientWidth / canvas.clientHeight
  cam.updateProjectionMatrix()
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight)
  renderer.render(scene, cam)
  // First-person inset (the game's view): the body with its head hidden, from the eye.
  if (inset && !fpCam && ready) {
    const W = canvas.clientWidth
    const H = canvas.clientHeight
    const iw = Math.round(W * 0.3)
    const ih = Math.round(iw * 0.625)
    fpInset.position.set(walker.eye.x, walker.eye.y, walker.eye.z)
    fpInset.rotation.set(walker.pitch, walker.yaw, 0, "YXZ")
    fpInset.aspect = iw / ih
    fpInset.updateProjectionMatrix()
    renderer.setScissorTest(true)
    renderer.setScissor(W - iw - 12, 12, iw, ih)
    renderer.setViewport(W - iw - 12, 12, iw, ih)
    renderer.render(scene, fpInset)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, W, H)
  }

  if (ready && script && scriptT > 1 && dt > 0) {
    for (let i = 0; i < 2; i++) {
      if (!body.debug.planted[i]) continue
      slideAcc.sum += body.debug.slide[i]! * 100
      slideAcc.n++
      slideAcc.max = Math.max(slideAcc.max, body.debug.slide[i]! * 100)
    }
    status.slideAvg = +(slideAcc.sum / Math.max(1, slideAcc.n)).toFixed(1)
    status.slideMax = +slideAcc.max.toFixed(1)
  }
  if (ready) {
    status.ready = true
    status.frames++
    status.state = body.debug.state
  }
  hudT += real
  if (hudT > 0.1) {
    hudT = 0
    const w = Object.entries(body.debug.weights)
      .filter(([, v]) => v > 0.01)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join("  ")
    hud.textContent = [
      `${script ? `script ${script}  t ${scriptT.toFixed(1)}s` : "free walk: WASD, Shift run, C crouch, Space jump, arrows turn"}  ×${Number(settings["lab.speed"]).toFixed(2)}`,
      `state ${body.debug.state}  speed ${Math.hypot(walker.vel.x, walker.vel.z).toFixed(2)} m/s  phase ${body.debug.phase.toFixed(2)}  pelvis ${(body.debug.pelvis * 100).toFixed(1)} cm`,
      `blend ${w}`,
      `torch ${walker.flashlight ? "on" : "off"} (F)  pitch ${((walker.pitch * 180) / Math.PI).toFixed(0)}°  arm clearance ${status.clear} cm  min ${status.clearMin} cm ${status.clearAt}`,
      `planted-foot slide  L ${(body.debug.slide[0]! * 100).toFixed(1)}  R ${(body.debug.slide[1]! * 100).toFixed(1)} cm/s  ${body.debug.planted.map((p) => (p ? "▮" : "▯")).join("")}`,
    ].join("\n")
  }
})
if (params.has("shot")) document.body.classList.add("shot")
if (params.get("hud") === "0") hud.style.display = "none"
