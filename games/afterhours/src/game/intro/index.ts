import * as THREE from "three/webgpu"
import type { World } from "../../boot/world"
import type { Flow } from "../flow"
import { weather } from "../../world/weather"
import { BUILDING } from "../../world/layout"
import { DOOR_OPEN, PlayerCar, SEATS, type Seat } from "./car"
import { IntroAudio } from "./audio"
import { buildRoute, PARKED, type Route, type RouteSample } from "./route"
import { createSkip } from "./skip"
import { Eerie } from "./eerie"
import type { CharacterBody } from "../../playerb/body"

// The opening cutscene: the player drives the government sedan up the access road at 3 a.m. through the fog, the
// station's lights come up out of it, the main gate stands open, and the car pulls into the lot. Engine off, the radio
// dies, headlights off, a beat of silence; the door opens, the player steps out and gets control beside the car, which
// stays parked in the lot as a solid world object (`playerCar()`, for a later "won't start" beat).
//
//   await prepareIntro(world)   // optional, early (e.g. under the title card): loads the car and warms its shaders
//   await runIntro({ world })   // plays it; resolves once the player has control
//
// While it runs the cutscene owns the camera. With a `flow` (the play shell's GameContext) it runs as a flow update
// hook; without one (debug) it stands in for `player.update` (the loop's per-frame player step) until the hand-over.
// Hold Space 1 s to skip (Esc too where Esc isn't the pause key). Aborting `signal` stops it where it is.
//
// Debug: `/debug?intro` plays it straight after boot (src/main.ts); `&introAt=<s>` starts that far into it.
//
// Car sounds are placeholders (audio.ts); the takes needed are listed in INTRO_SOUNDS.

/** The play shell's GameContext satisfies this; debug passes just the world. */
export type IntroContext = {
  world: World
  flow?: Flow
  signal?: AbortSignal
  /** Seconds into the cutscene to start at (debug/automation). */
  startAt?: number
}

/**
 * Sounds the cutscene needs that aren't in the library yet, with ElevenLabs sound-effect prompts. Until they exist,
 * audio.ts synthesises quiet stand-ins (engine, road) or borrows a near library take (keys, switch, door).
 */
export const INTRO_SOUNDS = [
  { id: "car-engine-idle", loop: true, prompt: "Interior of a 1980 American sedan with a 318 V8 idling, heard from the driver's seat with windows up: low, smooth, slightly lumpy burble, faint fan belt whine, no music, seamless loop, 10 seconds" },
  { id: "car-engine-drive", loop: true, prompt: "Interior of an old American V8 sedan cruising at 30 mph on a quiet country road at night, steady low engine drone with a soft automatic transmission hum, windows closed, seamless loop, 12 seconds" },
  { id: "car-road-tyres", loop: true, prompt: "Tyres rolling on slightly damp rough asphalt heard inside a closed car at 30 mph, soft broadband road roar with occasional small bumps, no engine, seamless loop, 10 seconds" },
  { id: "car-turn-gravel", loop: false, prompt: "Car tyres slowly rolling over loose gravel and grit at walking pace, crunching, close perspective, 4 seconds" },
  { id: "car-brake-stop", loop: false, prompt: "Old heavy sedan coming to a gentle stop, soft brake squeal and suspension settling creak, interior perspective, 2 seconds" },
  { id: "car-shift-park", loop: false, prompt: "Column shifter of a 1980 automatic car moved into Park, mechanical clunk and detent clicks, close up, 1 second" },
  { id: "car-engine-off", loop: false, prompt: "1980 V8 sedan engine switched off with the ignition key, engine shudders and dies, a final cough, then ticking silence, interior perspective, 3 seconds" },
  { id: "car-ignition-key", loop: false, prompt: "Car ignition key turned off and pulled out of a steering column lock, keyring jingling, close up, 1.5 seconds" },
  { id: "car-headlight-switch", loop: false, prompt: "Pull-knob headlight switch on an old car dashboard pushed in, solid plastic and metal click, close up, 0.5 seconds" },
  { id: "car-door-open", loop: false, prompt: "Heavy 1980s American car door unlatched from inside and pushed open, door handle clack, hinge creak, check-strap detent clunk, interior perspective, 2 seconds" },
  { id: "car-door-close", loop: false, prompt: "Heavy old sedan door swung shut from outside at night, solid deep thunk with a slight rattle of loose trim, outdoor perspective, 1.5 seconds" },
  { id: "car-lights-on-chime", loop: false, prompt: "Old car 'lights on' warning buzzer when the driver's door opens with headlights on, harsh electromechanical buzz, 2 seconds" },
  { id: "car-engine-tick", loop: false, prompt: "Hot car engine cooling down after being switched off, sparse metallic ticks and pings under the hood, quiet night, 6 seconds" },
  { id: "car-starter-fail", loop: false, prompt: "Old car that won't start: ignition key turned, single solenoid click then weak slow starter cranking that dies out, dashboard buzz, interior perspective, 4 seconds" },
] as const

const FADE_IN = 2.6
/**
 * After the car stops (s): shift to park, ignition off, keys, lights off, the beat, the left hand reaches for the door
 * (REACH_S, `body.reachDoor` 0→1) and pushes it open, step out, door shut, control.
 */
const PARK = { shift: 0.9, ignition: 1.7, keys: 2.3, lights: 3.4, reach: 5.2, step: 8.0, shut: 11.6, done: 12.2 }
const REACH_S = 2.6
/** The Mixamo driving-exit-car clip (`body.exitCar`), from PARK.reach: door beat, swing out, stand up (s). */
const EXIT_S = 5.8
/**
 * The camera's look through the exit clip (car frame, relative yaw/pitch), at seconds into it: the eyes go to the
 * handle, follow the door out, look down at the step out of the car, then up and round to the building (`end` is set
 * from the entrance). "handle"/"edge" aim at those anchors.
 */
const EXIT_LOOK: { t: number; at?: "handle" | "edge"; yaw?: number; pitch?: number }[] = [
  { t: 0, at: "handle" },
  { t: 0.9, at: "handle" },
  { t: 2.1, at: "edge" },
  { t: 3.1, yaw: 1.25, pitch: -0.32 },
  { t: 4.3, yaw: 0.95, pitch: -0.08 },
  { t: EXIT_S, yaw: 0, pitch: 0.02 },
]
const STEP_S = 3.6
/** The seated body lets go of the door this far into the step-out, as the view turns out of the car (s). */
const UNSEAT_AT = 0.85

/**
 * Door open fraction from the hand: shut until the handle is pulled (reach t ≈ 0.42), the latch pops it ajar, the palm
 * finds the panel, then the push (t 0.65→1) swings it out and it carries on a little on its own to the check strap.
 * `after` is seconds since the push ended.
 */
function doorFromHand(t: number, after: number) {
  const pop = 0.045 * smooth(clamp01((t - 0.42) / 0.08))
  const push = 0.42 * (1 - (1 - clamp01((t - 0.65) / 0.35)) ** 2)
  const coast = after > 0 ? 0.2 * (1 - Math.exp(-after * 2.6)) : 0
  return pop + push + coast
}

/** The seated body, when the body runtime has it (src/playerb/seat.ts). */
type SeatBody = CharacterBody & { seated: boolean }
function seatBody(): SeatBody | null {
  const b = (globalThis as { __afterhoursBody?: { body?: SeatBody } }).__afterhoursBody?.body
  return b && typeof b.seat === "function" ? b : null
}

let car: PlayerCar | null = null
let eerie: Eerie | null = null
let route: Route | null = null
let prepared: Promise<void> | null = null

/** The player's car once prepared (parked in the lot after the intro). */
export function playerCar() {
  return car
}

/** Seat eye points (model space) for co-op passengers; `playerCar()?.seatWorld(seat)` gives world positions. */
export const CAR_SEATS: readonly Seat[] = SEATS

/** Loads the car, registers its (dark) lamps and compiles its shaders. Idempotent; call it early. */
export function prepareIntro(world: World) {
  prepared ??= (async () => {
    route = buildRoute()
    car = new PlayerCar(world.ctx)
    const r = route.sample(0, sampleOut)
    car.place(r.x, r.y, r.z, r.yaw, r.pitch, r.roll)
    // Lights at a level while warming so their emissive graphs compile as drawn.
    car.lights.head = car.lights.tail = car.lights.dash = 1
    eerie = new Eerie()
    eerie.warmPose(new THREE.Vector3(r.x, r.y, r.z - 8))
    world.scene.add(eerie.group)
    await Promise.all([car.prepare((o) => world.warmup.warm(o)), world.warmup.warm(eerie.group)])
    eerie.stop()
    car.lights.head = car.lights.tail = car.lights.dash = 0
    car.update(0, 0, 0, 0, 0)
    world.scene.add(car.root)
  })()
  return prepared
}

/** Puts the car in its stall, lights off, solid (no cutscene: a skipped intro or a loaded game). */
export async function parkCar(world: World) {
  await prepareIntro(world)
  settle(world, car!, route!)
  return car!
}

/** Parks a prepared car at once: stall pose, door shut, lights off, contact shadow, collider. */
function settle(world: World, c: PlayerCar, r: Route) {
  const p = r.sample(r.duration, sampleOut)
  c.place(p.x, p.y, p.z, p.yaw, p.pitch, p.roll)
  c.lights.head = c.lights.tail = c.lights.brake = c.lights.dash = 0
  c.doorAmount = 0
  c.update(0.016, 0, 0, 0, 0)
  c.park()
  c.refreshShadows(world.scene)
}

/** Ends the running cutscene, if any, as an abort would (a new run, or a caller without a signal). */
let stopCurrent: (() => void) | null = null
export function stopIntro() {
  stopCurrent?.()
}

const sampleOut: RouteSample = { x: 0, z: 0, yaw: 0, y: 0, pitch: 0, roll: 0, speed: 0, accel: 0, curvature: 0, s: 0 }
const ahead: RouteSample = { ...sampleOut }

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

/** Stepping out of the driver's door (car-local eye positions, yaw/pitch relative to the car), at seconds into the move. */
function stepKeys(endYaw: number) {
  return [
    // Starts from wherever the head is at the end of the door push (set at runtime).
    { t: 0, p: [SEATS[0]!.eye[0], SEATS[0]!.eye[1], SEATS[0]!.eye[2]], yaw: 0.6, pitch: -0.2 },
    { t: 0.8, p: [-0.5, 1.09, 0.12], yaw: 0.85, pitch: -0.24 },
    { t: 1.7, p: [-0.92, 1.16, 0.1], yaw: 1.25, pitch: -0.12 },
    { t: 2.65, p: [-1.33, 1.52, 0.22], yaw: 0.85, pitch: -0.02 },
    { t: STEP_S, p: [-1.5, 1.65 - 0.0, 0.36], yaw: endYaw, pitch: 0.02 },
  ]
}

function sampleKeys(keys: ReturnType<typeof stepKeys>, t: number, out: THREE.Vector3) {
  let i = 0
  while (i < keys.length - 2 && t > keys[i + 1]!.t) i++
  const a = keys[Math.max(0, i - 1)]!
  const b = keys[i]!
  const c = keys[i + 1]!
  const d = keys[Math.min(keys.length - 1, i + 2)]!
  const u = smooth(clamp01((t - b.t) / (c.t - b.t)))
  // Catmull-Rom through the eye points (uniform), eased per segment.
  const cr = (p0: number, p1: number, p2: number, p3: number) =>
    0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
  out.set(cr(a.p[0]!, b.p[0]!, c.p[0]!, d.p[0]!), cr(a.p[1]!, b.p[1]!, c.p[1]!, d.p[1]!), cr(a.p[2]!, b.p[2]!, c.p[2]!, d.p[2]!))
  return { yaw: b.yaw + (c.yaw - b.yaw) * u, pitch: b.pitch + (c.pitch - b.pitch) * u }
}

export async function runIntro(ic: IntroContext): Promise<void> {
  const { world } = ic
  const { player, camera, ctx } = world
  // Only one cutscene at a time: a new run ends a previous one that was never finished or aborted.
  stopIntro()
  await prepareIntro(world)
  if (ic.signal?.aborted) {
    settle(world, car!, route!)
    return
  }
  stopIntro()
  debugRate.value = 1
  debugAim.at = null
  const c = car!
  const r = route!
  c.unpark()
  if (ctx.params.has("introRig")) c.showRig(world.scene)
  const sfx = player.audio?.sfx ?? null
  const sound = new IntroAudio(sfx)
  const woods = eerie!
  woods.start((pos) => sfx?.play("out-twig", { bus: "ambience", gain: 0.55, pos, ref: 4, rolloff: 0.9, jitter: 0.05 }))
  const beamPos = new THREE.Vector3()
  const beamDir = new THREE.Vector3()
  // The gate and boom stand open (the booth's GATE and BARRIER buttons, i.e. the motors, as the guard would leave them).
  // The compound's gate tick starts the leaf on the next frame; `frame` then runs its travel out at once, so it is
  // already open, not opening, however far into the cutscene we start.
  ctx.doors.get("ctl-gate")?.open()
  ctx.doors.get("ctl-boom")?.open()
  let gateFrames = 0

  // Cutscene state the game owns, restored at the hand-over.
  const s = ctx.settings
  const saved = { bodyShow: s["body.show"], ambience: s["audio.ambience"], fly: player.fly }
  s["body.show"] = false
  player.fly = false
  const hud = document.querySelector<HTMLElement>("#hud")
  const hudDisplay = hud?.style.display ?? ""
  if (hud) hud.style.display = "none"
  const ambience = Number(saved.ambience ?? 0.75)

  const fade = document.createElement("div")
  fade.style.cssText = "position:fixed;inset:0;z-index:6;background:#000;pointer-events:none;opacity:1"
  document.body.append(fade)

  c.borrowBeam(player)
  // The driver's body in the seat, hands on the wheel (when the body runtime has the seated mode).
  const body = seatBody()
  body?.seat(c.seatOptions())
  const lookAt = new THREE.Vector3()
  const seatEyeW = new THREE.Vector3()
  const seatEyeLocal = new THREE.Vector3()
  let haveSeatEye = false
  // The exit clip (driving-exit-car) when the body has it; else the older reach + keyed step-out.
  const exiting = !!body && typeof (body as { exitCar?: unknown }).exitCar === "function"
  let exitDoor = 0
  const exitFrom = { yaw: 0, pitch: 0 }
  const total = r.duration + PARK.done
  let time = Math.max(0, ic.startAt ?? 0)
  let skipping = -1
  const keys = stepKeys(0)
  const eye = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler(0, 0, 0, "YXZ")
  const bodyQ = new THREE.Quaternion()
  let lookYaw = 0
  let lookPitch = 0
  let lookIdle = 0
  let headYaw = 0
  let fired = new Set<string>()
  const once = (id: string, at: number, now: number, fn: () => void) => {
    if (now >= at && !fired.has(id)) {
      fired.add(id)
      fn()
    }
  }
  // The final yaw (world) faces the building's entrance from beside the car.
  const standLocal = keys[keys.length - 1]!.p
  const standX = PARKED.x + standLocal[0]!
  const standZ = PARKED.z + standLocal[2]!
  const entranceYaw = Math.atan2(-(BUILDING.entrance.x - standX), -(BUILDING.entrance.z + 6 - standZ)) - PARKED.yaw
  keys[keys.length - 1]!.yaw = entranceYaw

  let resolveDone!: () => void
  const done = new Promise<void>((res) => (resolveDone = res))
  const skip = createSkip(
    () => {
      if (skipping < 0) skipping = 0
    },
    ic.flow ? ["Space"] : ["Space", "Escape"],
  )

  const frame = (dtIn: number) => {
    const dt = Math.min(dtIn, 0.1)
    skip.update(dt)
    if (skipping >= 0) {
      // Fade to black, jump to the hand-over, fade back in.
      skipping += dt
      fade.style.opacity = String(clamp01(skipping / 0.35))
      if (skipping >= 0.4 && time < total) {
        time = total
        fired = new Set(["skipped"])
        if (body?.seated) body.unseat()
        sound.stop()
        void parkCar(world)
      }
    } else time += dt * debugRate.value

    // The seated body's real eyes, in the car body's frame. The body is posed after this hook runs (in the world's
    // update, from the car as last placed), so read it now, while the car's matrices are still the ones it was posed
    // against; then it rides this frame's car pose like the seat does.
    if (body?.seated && body.seatEye(seatEyeW)) {
      seatEyeLocal.copy(c.body.worldToLocal(seatEyeW))
      haveSeatEye = true
    }
    const T0 = r.duration
    // ---- the car
    const driving = time < T0
    const st = r.sample(time, sampleOut)
    c.place(st.x, st.y, st.z, st.yaw, st.pitch, st.roll)
    const p = time - T0
    // Lights: on until the switch; brake lamps whenever slowing, and held at the stop until park.
    if (!fired.has("skipped")) {
      c.lights.head = time < T0 + PARK.lights ? 1 : 0
      c.lights.tail = c.lights.head
      c.lights.dash = time < T0 + PARK.ignition ? 1 : Math.max(0, 1 - (p - PARK.ignition) / 0.25)
      c.lights.brake = (driving && st.accel < -0.25) || (!driving && p < PARK.shift) ? 1 : 0
      sound.engineOn = time < T0 + PARK.ignition ? 1 : 0
      sound.radioOn = time < T0 + PARK.ignition ? smooth(clamp01((time - 1) / 3)) : 0
      const reach = clamp01((p - PARK.reach) / REACH_S)
      let opened: number
      if (exiting) {
        // The exit clip: the hand opens the door, the door follows it (angle → open fraction; the swing is linear).
        const et = p - PARK.reach
        if (et < EXIT_S) {
          if (!body!.seated) body!.seat(c.seatOptions())
          const angle = et > 0 ? body!.exitCar(et) : null
          if (angle !== null) exitDoor = Math.max(exitDoor, clamp01(angle / DOOR_OPEN))
        } else if (body!.seated) {
          // Hand over from where the clip ends: the eyes stay where they last were.
          body!.unseat()
        }
        opened = exitDoor
      } else {
        opened = doorFromHand(reach, p - PARK.reach - REACH_S)
        if (body) {
          if (p - PARK.step < UNSEAT_AT) {
            if (!body.seated) body.seat(c.seatOptions())
            body.reachDoor(reach)
          } else if (body.seated) body.unseat()
        }
      }
      c.doorAmount = p < PARK.shut ? opened : opened * Math.max(0, 1 - (p - PARK.shut) / 0.42)
    }
    body?.steer(c.wheelAngle)
    c.update(dt, time, st.speed, st.accel, st.curvature)
    if (st.speed > 0.05) c.refreshShadows(world.scene)
    if (!fired.has("skipped")) {
      once("parked", T0, time, () => {
        c.park()
        c.refreshShadows(world.scene)
      })
      once("shift", T0 + PARK.shift, time, () => sound.play("light-switch", 0.35, { rate: 0.55, lowpass: 1400 }))
      once("keys", T0 + PARK.keys, time, () => sound.play("int-keys", 0.5, { lowpass: 5000 }))
      once("lights", T0 + PARK.lights, time, () => sound.play("light-switch", 0.55, { rate: 0.8 }))
      if (exiting ? exitDoor > 0.01 : time >= T0 + PARK.reach + REACH_S * 0.44)
        once("door", 0, time, () => sound.play("door-office-wood", 0.35, { rate: 0.75, lowpass: 2200 }))
      once("shut", T0 + PARK.shut + 0.35, time, () => sound.play("door-office-wood", 0.55, { rate: 0.6, lowpass: 1500, lowBoost: 6 }))
    }
    // The cabin muffles the forest until the door opens.
    const open = exiting ? smooth(clamp01(c.doorAmount * 4)) : clamp01((p - PARK.reach - REACH_S * 0.44) / 1.2)
    s["audio.ambience"] = ambience * (0.4 + 0.6 * open)

    // ---- the camera
    // Free look (mouse, pointer-locked) within a seated driver's range, drifting back to the road when idle.
    const m = skip.takeLook()
    const sens = Number(s["player.sensitivity"] ?? 1) * 0.0022
    if (m.x || m.y) lookIdle = 0
    else lookIdle += dt
    lookYaw = Math.max(-1.3, Math.min(1.3, lookYaw - m.x * sens))
    lookPitch = Math.max(-0.5, Math.min(0.45, lookPitch - m.y * sens))
    if (lookIdle > 1.5) {
      const k = 1 - Math.exp(-dt * 0.9)
      lookYaw -= lookYaw * k
      lookPitch -= lookPitch * k
    }
    // The driver looks into bends a moment before the car turns.
    r.sample(time + 0.9, ahead)
    const into = Math.max(-0.32, Math.min(0.32, ahead.curvature * 5.5 * Math.min(1, ahead.speed / 4)))
    headYaw += (into - headYaw) * (1 - Math.exp(-dt * 2.5))
    const stepT = p - PARK.step
    let yaw: number
    let pitch: number
    let free = 1
    let viaBody = false
    if (exiting && p >= PARK.reach) {
      // The exit clip: the camera at the body's eyes throughout (held where they ended once it hands over), the look
      // keyed through EXIT_LOOK; free look fades out as the driver gets moving.
      viaBody = true
      if (haveSeatEye) eye.copy(seatEyeLocal)
      else eye.set(SEATS[0]!.eye[0], SEATS[0]!.eye[1], SEATS[0]!.eye[2])
      const et = Math.min(p - PARK.reach, EXIT_S)
      let i = 0
      while (i < EXIT_LOOK.length - 2 && et > EXIT_LOOK[i + 1]!.t) i++
      const A = EXIT_LOOK[i]!
      const B = EXIT_LOOK[i + 1]!
      const u = smooth(clamp01((et - A.t) / (B.t - A.t)))
      const dir = (k: (typeof EXIT_LOOK)[number]) => {
        if (k.at) {
          const a = aim(c.anchorLocal(k.at, lookAt), eye)
          // The eyes do part of the work: the head turns ~80% of the way (a little past the edge: out of the gap).
          return k.at === "edge" ? { yaw: (a.yaw + 0.25) * 0.8, pitch: (a.pitch + 0.12) * 0.8 } : { yaw: a.yaw * 0.8, pitch: a.pitch * 0.8 }
        }
        return { yaw: k === EXIT_LOOK[EXIT_LOOK.length - 1] ? entranceYaw : k.yaw!, pitch: k.pitch! }
      }
      const da = dir(A)
      const db = dir(B)
      // Start from wherever the look was when the clip began.
      if (i === 0 && u < 1) {
        da.yaw = exitFrom.yaw + (da.yaw - exitFrom.yaw) * smooth(clamp01(et / 0.5))
        da.pitch = exitFrom.pitch + (da.pitch - exitFrom.pitch) * smooth(clamp01(et / 0.5))
      }
      yaw = da.yaw + (db.yaw - da.yaw) * u
      pitch = da.pitch + (db.pitch - da.pitch) * u
      free = 1 - smooth(clamp01(et / 1.2))
    } else if (stepT <= 0) {
      if (haveSeatEye) eye.copy(seatEyeLocal)
      else eye.set(SEATS[0]!.eye[0], SEATS[0]!.eye[1], SEATS[0]!.eye[2])
      // The step-out starts from where the eyes are now.
      keys[0]!.p = [eye.x, eye.y, eye.z]
      // In the beat of silence the eyes go up to the building.
      const look = smooth(clamp01((p - PARK.lights - 0.6) / 1.6))
      yaw = headYaw * (1 - look) + 0.06 * look
      pitch = -0.035 + 0.05 * look
      // Then down to the door handle as the hand goes for it, and with the door as it's pushed out.
      const reach = clamp01((p - PARK.reach) / REACH_S)
      if (reach > 0) {
        const toHandle = smooth(clamp01(reach / 0.28))
        const toEdge = smooth(clamp01((reach - 0.5) / 0.35))
        const h = aim(c.anchorLocal("handle", lookAt), eye)
        const g = aim(c.anchorLocal("edge", lookAt), eye)
        // The eyes do part of the work: the head turns ~80% of the way.
        const ty = (h.yaw + (g.yaw + 0.25 - h.yaw) * toEdge) * 0.8
        const tp = (h.pitch + (g.pitch + 0.12 - h.pitch) * toEdge) * 0.8
        yaw += (ty - yaw) * toHandle
        pitch += (tp - pitch) * toHandle
      }
      keys[0]!.yaw = yaw
      keys[0]!.pitch = pitch
      exitFrom.yaw = yaw
      exitFrom.pitch = pitch
    } else {
      const k = sampleKeys(keys, Math.min(stepT, STEP_S), eye)
      yaw = k.yaw
      pitch = k.pitch
      free = 1 - smooth(clamp01(stepT / 0.8))
    }
    yaw += lookYaw * free
    pitch += lookPitch * free
    // Eye rides the body (pitch/roll), the head steadies half of it; standing outside it is the ground's frame.
    c.root.updateMatrixWorld(true)
    const outside = viaBody ? 0 : smooth(clamp01((stepT - 1.6) / 1.4))
    eye.applyMatrix4(outside > 0.5 ? c.root.matrixWorld : c.body.matrixWorld)
    bodyQ.copy(c.body.quaternion).slerp(q.identity(), 0.5 + 0.5 * outside)
    camera.position.copy(eye)
    e.set(pitch, yaw, 0, "YXZ")
    camera.quaternion.setFromEuler(e).premultiply(bodyQ).premultiply(c.root.quaternion)
    if (fired.has("skipped")) {
      // Skipped: under the black the view is already where the player will stand.
      const sp = standPose(c, r)
      camera.position.set(sp.x, sp.y + PLAYER_EYE, sp.z)
      camera.rotation.set(0.02, sp.yaw, 0, "YXZ")
    }
    if (debugAim.at) camera.lookAt(debugAim.at)
    camera.updateMatrixWorld()
    // Fade in from black at the start.
    if (skipping < 0) fade.style.opacity = String(1 - smooth(clamp01((time - 0.4) / FADE_IN)))
    else if (time >= total) fade.style.opacity = String(1 - clamp01((skipping - 0.6) / 0.7))

    if (time < T0 + PARK.lights) {
      const lit = c.headlamps(beamPos, beamDir)
      woods.update(dt, camera, lit ? beamPos : null, lit ? beamDir : null)
    }

    // What player.update would have done besides moving the player.
    if (++gateFrames === 3) ctx.doors.update(10)
    ctx.doors.update(dt)
    weather.update(dt)
    sound.update(dt, st.speed, st.accel)
    player.audio?.update(dt, camera)

    if (time >= total && (skipping < 0 || skipping > 1.3)) finish()
  }

  let finished = false
  const finish = (aborted = false) => {
    if (finished) return
    finished = true
    if (stopCurrent === stop) stopCurrent = null
    unhook()
    ic.signal?.removeEventListener("abort", onAbort)
    if (body?.seated) body.unseat()
    woods.stop()
    if (aborted) {
      // Quit mid-drive: everything the cutscene took is given back, and the car is left where it ends up anyway.
      c.releaseBeam(player)
      settle(world, c, r)
      sound.stop()
      s["audio.ambience"] = saved.ambience as never
      s["body.show"] = saved.bodyShow as never
      player.fly = saved.fly
      if (hud) hud.style.display = hudDisplay
      skip.dispose()
      fade.remove()
      resolveDone()
      return
    }
    // The car parked solid in its stall, door shut, lights off (also after a skip from anywhere in the drive).
    c.releaseBeam(player)
    settle(world, c, r)
    // Hand over. Played through: the player stands where the camera is, looking where it looks. Skipped: at the
    // step-out spot beside the driver's door (where the exit clip ends), facing the building. Either way the feet are
    // on the ground and outside the car's collider.
    const skipped = fired.has("skipped")
    const sp = standPose(c, r)
    const cam = camera.position
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const at = skipped ? { x: sp.x, z: sp.z } : clearOfCar(c, cam.x, cam.z) ?? { x: sp.x, z: sp.z }
    player.pos.x = at.x
    player.pos.z = at.z
    player.pos.y = r.groundAt(at.x, at.z)
    player.yaw = skipped ? sp.yaw : Math.atan2(-f.x, -f.z)
    player.pitch = skipped ? 0.02 : Math.asin(Math.max(-1, Math.min(1, f.y)))
    player.release()
    player.resetMotion()
    sound.stop()
    s["audio.ambience"] = saved.ambience as never
    s["body.show"] = saved.bodyShow as never
    player.fly = saved.fly
    if (hud) hud.style.display = hudDisplay
    skip.dispose()
    fade.style.transition = "opacity 0.4s ease"
    fade.style.opacity = "0"
    setTimeout(() => fade.remove(), 500)
    resolveDone()
  }
  // Drive frames: a flow hook in play, else in place of the debug loop's player step.
  let unhook: () => void
  if (ic.flow) {
    const offUpdate = ic.flow.onUpdate((dt) => frame(dt))
    const offPause = ic.flow.onPause((paused) => sound.setPaused(paused))
    unhook = () => {
      offUpdate()
      offPause()
    }
  }
  else {
    const own = Object.prototype.hasOwnProperty.call(player, "update")
    const original = player.update
    player.update = frame
    unhook = () => {
      if (own) player.update = original
      else delete (player as { update?: unknown }).update
    }
  }
  // Automation only: seek and freeze the cutscene for stills (scripts/intro/shots.ts).
  ;(globalThis as { __afterhoursIntro?: unknown }).__afterhoursIntro = {
    get time() {
      return time
    },
    seek(t: number) {
      time = t
    },
    set rate(v: number) {
      debugRate.value = v
    },
    get total() {
      return total
    },
    car: c,
    route: r,
    sound,
    woods,
    /** Point the camera at a world point (null: back to the cutscene's own look). */
    aim(p: [number, number, number] | null) {
      debugAim.at = p ? new THREE.Vector3(...p) : null
    },
  }
  const onAbort = () => finish(true)
  const stop = () => finish(true)
  stopCurrent = stop
  ic.signal?.addEventListener("abort", onAbort)
  return done
}

/** Player eye height standing (src/player.ts EYE) and body radius (RADIUS) plus a margin. */
const PLAYER_EYE = 1.65
const PLAYER_CLEAR = 0.3 + 0.12
/** Where the driver ends up standing after getting out: 1.8 m left of the driver's seat, a little back. */
const STAND_LOCAL = new THREE.Vector3(SEATS[0]!.eye[0] - 1.8, 0, 0.25)

/** The step-out spot (world, feet on the ground) beside the parked car, and the yaw that faces the building. */
function standPose(c: PlayerCar, r: Route) {
  const end = r.sample(r.duration, sampleOut)
  const cy = Math.cos(end.yaw)
  const sy = Math.sin(end.yaw)
  // Model-space x/z rotated by the parked heading (yaw about +Y).
  const x = end.x + STAND_LOCAL.x * cy + STAND_LOCAL.z * sy
  const z = end.z - STAND_LOCAL.x * sy + STAND_LOCAL.z * cy
  void c
  const yaw = Math.atan2(-(BUILDING.entrance.x - x), -(BUILDING.entrance.z + 6 - z))
  return { x, y: r.groundAt(x, z), z, yaw }
}

/** (x, z) if a standing player there is clear of the parked car's footprint, else null. */
function clearOfCar(c: PlayerCar, x: number, z: number) {
  const box = c.footprint()
  if (!box) return { x, z }
  const inside = x > box.min[0] - PLAYER_CLEAR && x < box.max[0] + PLAYER_CLEAR && z > box.min[2] - PLAYER_CLEAR && z < box.max[2] + PLAYER_CLEAR
  return inside ? null : { x, z }
}

/** Yaw/pitch (car frame, model convention) from the driver's eye to a point in the car body's frame. */
function aim(p: THREE.Vector3, from?: THREE.Vector3) {
  const e = from ? [from.x, from.y, from.z] : SEATS[0]!.eye
  const dx = p.x - e[0]!, dy = p.y - e[1]!, dz = p.z - e[2]!
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}
const debugRate = { value: 1 }
const debugAim: { at: THREE.Vector3 | null } = { at: null }
