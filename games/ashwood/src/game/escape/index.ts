import * as THREE from "three/webgpu"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { World } from "../../boot/world"
import type { Flow, GameContext } from "../flow"
import type { CharacterBody } from "../../playerb/body"
import { heightAt } from "../../world/height"
import { weather } from "../../world/weather"
import { FENCE, LOGGING_ROAD, NORTH_GATE, NORTH_TRACK, loggingRoadSamples, northTrackDistance, northTrackSamples, type Vec2 } from "../../world/layout"
import { Line } from "../../world/roads/util"
import { hooks } from "../../audio/hooks"
import { emitNoise } from "../hunter/noise"
import { hasItem } from "../inventory"
import { showSubtitle } from "../shell/subtitles"
import { IntroAudio } from "../intro/audio"
import { Projector } from "../intro/route"
import type { PlayerCar } from "../intro/car"
import { motorPool } from "./yard"
import { TRUCK_PARK } from "./places"
import { drive } from "./input"

// The escape: Truck 2 in the motor-pool shed (src/game/escape/yard.ts). E on the driver's door: locked without the
// keys; with them the player gets in (the seated body: hands on the wheel), E starts it (the starter labours, the
// engine catches: a big noise the hunter hears), the shed's roll-up goes up on its wall button (6 s, also noisy; before
// or after getting in), and the player drives: W/S throttle and brake (S reverses from a stop), A/D steer, E gets out
// when stopped. Out of the shed, across the dock court, through the open north gate, up the north track and on along the
// logging road; ~200 m along it (or ~24 s past the gate) the road ambush takes over (src/game/encounters/road-ambush.ts,
// `runRoadAmbush(ctx, vehicle)`). Headlights (the intro car's lamps and borrowed shadowed beam), the radio crackling
// faintly, the placeholder engine and road sounds.
//
// Physics: a kinematic bicycle model on the rear axle (engine force falling off with speed, brakes, rolling drag, the
// slope's pull), steering limited by speed; the body sits on its four tyre contacts on the ground (slab, court, track,
// terrain), pitch and roll from them, and its footprint stops against the world's colliders (walls, posts, the near
// trees the forest keeps as colliders around the camera, the closed curtain). Automation: `__ashwoodEscape`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Truck geometry (car_pickup, model space): rear axle z, wheelbase, track; footprint half sizes. */
const G = { rear: 1.108, wb: 2.57, track: 1.22, halfW: 0.86, halfL: 2.2 }
const MAX_STEER = 0.62
const TOP = 24
const REVERSE_TOP = 4.2
/** Seated eye height above the ground, and where the outside door handle is (model space). */
const DOOR_OUT = new THREE.Vector3(-0.98, 1.0, -0.45)
const STAND_OUT = new THREE.Vector3(-1.55, 0, -0.2)
/** How far along the logging road the ambush comes (m), or this long after passing the gate (s). */
const AMBUSH_ROAD_S = 200
const AMBUSH_AFTER_GATE_S = 24
/** Noise radii (m): the engine catching, the roll-up motor while it runs, the truck hitting something hard. */
const NOISE = { engine: 60, rollup: 32, crash: 24 }

type State = "outside" | "seated" | "cranking" | "running" | "handover"
type SeatBody = CharacterBody & { seated: boolean; seat(o: unknown): void; unseat(): void; steer(a: number): void; seatEye(out: THREE.Vector3): boolean }
const seatBody = (): SeatBody | null => {
  const b = (globalThis as { __afterhoursBody?: { body?: SeatBody } }).__afterhoursBody?.body
  return b && typeof b.seat === "function" ? b : null
}

export type EscapeHost = { world: World; flow: Flow; hud: HTMLElement; signal?: AbortSignal }

/** The route the autopilot follows and the checks sample: shed → court → north track → logging road. */
export function escapePath(): Line {
  const track = northTrackSamples(1)
  let join = 0
  for (let i = 0; i < track.length; i++) if (track[i]![1] <= -52.5) {
    join = i
    break
  }
  const lead: Vec2[] = [
    // Straight out of the door and clear of the apron before the turn east down the court.
    [TRUCK_PARK.x, TRUCK_PARK.z],
    [TRUCK_PARK.x, -39.5],
    [TRUCK_PARK.x, -42.5],
    [TRUCK_PARK.x + 0.3, -44.5],
    [-48.0, -46.6],
    [-43.5, -48.6],
    [-36.5, -50.6],
    [-30.5, -52.4],
  ]
  const pts: Vec2[] = [...lead, ...track.slice(join + 1), ...loggingRoadSamples(1).slice(1)]
  // Light Gaussian smoothing over the joins (ends held).
  const sm = pts.map((_, i) => {
    let x = 0, z = 0, w = 0
    for (let k = -4; k <= 4; k++) {
      const q = pts[Math.max(0, Math.min(pts.length - 1, i + k))]!
      const wk = Math.exp(-(k * k) / 8)
      x += q[0] * wk
      z += q[1] * wk
      w += wk
    }
    return i === 0 ? pts[0]! : ([x / w, z / w] as Vec2)
  })
  return new Line(sm)
}

let current: ReturnType<typeof createEscape> | null = null

/** Starts the escape for a run (play mode, at explore). Idempotent per run; stops with `signal`. */
export function startEscape(host: EscapeHost) {
  current?.stop()
  current = createEscape(host)
  return current
}

function createEscape(host: EscapeHost) {
  const { world, flow } = host
  const { player, camera, ctx } = world
  const g: GameContext = { world, ctx, player, camera, scene: world.scene, flow, hud: host.hud, signal: host.signal ?? new AbortController().signal }
  let state: State = "outside"
  let sound: IntroAudio | null = null
  let truck: PlayerCar | null = null

  // ---- vehicle state
  const pose = { x: 0, z: 0, yaw: 0, y: 0, pitch: 0, roll: 0 }
  let v = 0
  let steer = 0
  let accel = 0
  let controlLocked = false
  let brakeHold = 0
  let throttleIn = 0
  let time = 0
  let gateAt = -1
  let fired = false
  let autopilot = false
  let lookYaw = 0
  let lookPitch = 0
  let lookIdle = 0
  let rollNoiseAt = -99
  let crankT = 0
  const path = escapePath()
  const pathProj = new Projector(path, 6)
  const road = new Line(loggingRoadSamples(1))
  const roadProj = new Projector(road, 6)

  // ---- prompt (styled like the door system's)
  const prompt = document.createElement("div")
  prompt.className = "door-prompt escape-prompt akc-minimal"
  prompt.style.cssText = "position:fixed;left:50%;top:58%;transform:translate(-50%,0);pointer-events:none;opacity:0"
  document.body.appendChild(prompt)
  let shown = ""
  const show = (html: string) => {
    if (html === shown) return
    shown = html
    if (html) {
      const shared = [...document.querySelectorAll<HTMLElement>(".door-prompt")].find((el) => el !== prompt && el.style.font)
      if (shared) {
        prompt.style.cssText = shared.style.cssText
        prompt.style.transform = "translate(-50%, 0)"
      }
      prompt.innerHTML = html
    }
    prompt.style.opacity = html ? "1" : "0"
  }
  // In the cab: no on-foot controls strip and no door prompts (E there drives the truck, not the doors).
  const style = document.createElement("style")
  style.textContent = `body[data-driving] .hints-strip, body[data-driving] .hints-toast, body[data-driving] .door-prompt:not(.escape-prompt) { opacity: 0 !important; visibility: hidden !important; }`
  document.head.appendChild(style)
  const blink = document.createElement("div")
  blink.style.cssText = "position:fixed;inset:0;z-index:6;background:#000;pointer-events:none;opacity:0;transition:opacity 0.18s ease"
  document.body.appendChild(blink)
  const fadeThrough = (fn: () => void) => {
    blink.style.opacity = "1"
    setTimeout(() => {
      fn()
      blink.style.opacity = "0"
    }, 200)
  }

  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler(0, 0, 0, "YXZ")

  /** The rear-axle state from where the truck stands (its root is the footprint centre, the rear axle is behind it). */
  const readPose = (t: PlayerCar) => {
    pose.yaw = t.root.rotation.y
    pose.x = t.root.position.x + Math.sin(pose.yaw) * G.rear
    pose.z = t.root.position.z + Math.cos(pose.yaw) * G.rear
  }

  /** Ground the tyres roll on: the shed slab, low floors (court, aprons), the track/road bed, else the terrain. */
  const ground = (x: number, z: number) => {
    const slab = motorPool?.slab(x, z)
    if (slab != null) return slab
    let h = heightAt(x, z)
    for (const f of ctx.floors) if (f.y < 0.45 && x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y > h) h = f.y
    if (northTrackDistance(x, z) < Math.max(NORTH_TRACK.width, LOGGING_ROAD.width) / 2 + 0.6) h += 0.05
    return h
  }

  /** Centre pose (root) from the rear-axle state, on the four tyre contacts. */
  const settle = (out: typeof pose, x: number, z: number, yaw: number) => {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
    const rx = Math.cos(yaw), rz = -Math.sin(yaw)
    const t = G.track / 2
    const h = (a: number, s: number) => ground(x + fx * a + rx * s, z + fz * a + rz * s)
    const rl = h(0, -t), rr = h(0, t), fl = h(G.wb, -t), fr = h(G.wb, t)
    out.pitch = Math.atan(((fl + fr) / 2 - (rl + rr) / 2) / G.wb)
    out.roll = Math.atan(((fr + rr) / 2 - (fl + rl) / 2) / G.track)
    const rear = (rl + rr) / 2
    out.y = rear + ((fl + fr) / 2 - rear) * (G.rear / G.wb)
    return { cx: x + fx * G.rear, cz: z + fz * G.rear }
  }

  /** Penetration of the footprint (centre cx,cz, heading yaw, floor y) into any collider (> 0 hit). */
  const hits = (cx: number, cz: number, yaw: number, y: number) => {
    const ca = Math.cos(yaw), sa = Math.sin(yaw)
    const ex = G.halfW * Math.abs(ca) + G.halfL * Math.abs(sa)
    const ez = G.halfW * Math.abs(sa) + G.halfL * Math.abs(ca)
    const own = truck ? truck.footprint() : null
    const test = (b: { min: readonly number[]; max: readonly number[] }) => {
      if (b === own) return false
      if (b.max[1]! < y + 0.3 || b.min[1]! > y + 1.6) return false
      if (b.max[0]! < cx - ex || b.min[0]! > cx + ex || b.max[2]! < cz - ez || b.min[2]! > cz + ez) return false
      // Separating axes: the box's own (done above) and the truck's two.
      const corners = [
        [b.min[0]!, b.min[2]!],
        [b.max[0]!, b.min[2]!],
        [b.max[0]!, b.max[2]!],
        [b.min[0]!, b.max[2]!],
      ]
      for (const [axx, axz, half] of [
        [ca, -sa, G.halfW],
        [-sa, -ca, G.halfL],
      ] as const) {
        let lo = Infinity, hi = -Infinity
        for (const [px, pz] of corners) {
          const d = (px! - cx) * axx + (pz! - cz) * axz
          lo = Math.min(lo, d)
          hi = Math.max(hi, d)
        }
        if (lo > half || hi < -half) return false
      }
      return true
    }
    for (const b of ctx.colliders) if (test(b)) return true
    const door = motorPool?.doorBox
    return !!door && test(door)
  }

  const apply = () => {
    const c = settle(pose, pose.x, pose.z, pose.yaw)
    truck!.place(c.cx, pose.y, c.cz, pose.yaw, pose.pitch, pose.roll)
  }

  // ---- interaction
  const nearDoor = () => {
    if (!truck || state !== "outside" || !flow.playerActive) return false
    truck.root.updateMatrixWorld(true)
    tmp.copy(DOOR_OUT).applyMatrix4(truck.root.matrixWorld)
    const eye = camera.position
    if (tmp.distanceTo(eye) > 1.9) return false
    camera.getWorldDirection(tmp2)
    return tmp2.dot(tmp.clone().sub(eye).normalize()) > 0.55
  }

  const getIn = () => {
    const t = truck!
    fadeThrough(() => {
      state = "seated"
      readPose(t)
      t.unpark()
      flow.hold = true
      player.release()
      drive.active = true
      document.body.dataset.driving = "1"
      const body = seatBody()
      body?.seat(t.seatOptions())
      lookYaw = lookPitch = 0
      sound ??= new IntroAudio(hooks.sfx)
      sound.radioLevel = 0.55
    })
  }

  const getOut = () => {
    const t = truck!
    fadeThrough(() => {
      state = "outside"
      drive.active = false
      delete document.body.dataset.driving
      drive.held.clear()
      seatBody()?.unseat()
      t.root.updateMatrixWorld(true)
      tmp.copy(STAND_OUT).applyMatrix4(t.root.matrixWorld)
      player.pos.x = tmp.x
      player.pos.z = tmp.z
      player.pos.y = ground(tmp.x, tmp.z)
      player.yaw = pose.yaw + 0.4
      player.pitch = 0
      player.resetMotion()
      t.park()
      flow.hold = false
    })
  }

  const startEngine = () => {
    state = "cranking"
    crankT = 0
    if (sound) sound.starter = 1
    hooks.sfx?.play("int-keys", { bus: "doors", gain: 0.6 })
  }

  const engineCaught = () => {
    state = "running"
    if (sound) {
      sound.starter = 0
      sound.engineOn = 1
      sound.boost = 4
      sound.radioOn = 1
    }
    const t = truck!
    t.lights.head = t.lights.tail = t.lights.dash = 1
    t.borrowBeam(player)
    // Loud: everything for a long way round hears it.
    emitNoise({ x: pose.x, y: pose.y + 1, z: pose.z }, NOISE.engine, "other")
    setTimeout(() => emitNoise({ x: pose.x, y: pose.y + 1, z: pose.z }, NOISE.engine * 0.6, "other"), 1200)
    showSubtitle("", "W / S drive · A / D steer", 3)
    void import("../encounters/road-ambush").then((m) => m.prepareRoadAmbush(world)).catch(() => {})
  }

  const offPress = drive.onPress((code) => {
    if (code !== "KeyE" || flow.paused) return false
    if (state === "outside") {
      if (!nearDoor()) return false
      if (!hasItem("truck-keys")) {
        showSubtitle("", "It's locked. Need the keys.", 2.2)
        hooks.sfx?.play("door-office-wood", { bus: "doors", gain: 0.25, rate: 1.6, offset: 0.05 })
        return true
      }
      getIn()
      return true
    }
    if (state === "seated") {
      startEngine()
      return true
    }
    if (state === "running" && Math.abs(v) < 0.4 && !controlLocked) {
      getOut()
      return true
    }
    return false
  })

  // ---- the vehicle handed to the road ambush
  const eyeObj = new THREE.Object3D()
  eyeObj.name = "truck-eye"
  const vehicle = {
    get root() {
      return truck!.root
    },
    get speed() {
      return v
    },
    forward: (out: THREE.Vector3) => out.set(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw)),
    headlights: [] as THREE.Light[],
    setHeadlights: (level: number) => {
      if (!truck) return
      truck.lights.head = level
      truck.lights.tail = Math.min(1, level + 0.2)
    },
    takeControl: () => {
      controlLocked = true
    },
    brake: (amount: number) => {
      brakeHold = Math.max(0, Math.min(1, amount))
    },
    eye: eyeObj,
  }

  const fire = () => {
    if (fired) return
    fired = true
    state = "handover"
    void import("../encounters/road-ambush").then((m) => m.runRoadAmbush(g, vehicle)).catch((err: unknown) => console.error("road ambush:", err))
  }

  // ---- per frame
  const off = flow.onUpdate((dtIn) => {
    const dt = Math.min(dtIn, 0.05)
    time += dt
    truck ??= motorPool?.truck ?? null
    if (!truck) return
    if (state === "outside") {
      if (sound) sound.update(dt, 0, 0)
      if (nearDoor()) show(hasItem("truck-keys") ? keyPromptHtml("KeyE", "Get in", { minimal: true }) : `<span class="akp-label">Truck 2 (locked)</span>`)
      else show("")
      return
    }
    // In the cab the shell doesn't step the controller (the player isn't on foot): do what its update would, besides
    // moving the player (doors and the roll-up motor, the weather, the listener).
    ctx.doors.update(dt)
    weather.update(dt)
    player.audio?.update(dt, camera)
    const body = seatBody()
    if (state === "cranking") {
      crankT += dt
      if (crankT > 1.35) engineCaught()
    }
    if (sound && state === "running") sound.boost += (1 - sound.boost) * (1 - Math.exp(-dt * 1.5))

    // Controls (or the autopilot / the ambush's hands).
    let throttle = 0
    let brake = 0
    let steerIn = 0
    const running = state === "running" || state === "handover"
    if (controlLocked) {
      brake = brakeHold
    } else if (autopilot && running) {
      const a = pilot()
      throttle = a.throttle
      brake = a.brake
      steerIn = a.steer
    } else if (running) {
      const fwd = drive.axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"])
      steerIn = drive.axis(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"])
      if (fwd > 0) throttle = v < -0.3 ? 0 : 1
      if (fwd > 0 && v < -0.3) brake = 1
      if (fwd < 0) {
        if (v > 0.3) brake = 1
        else throttle = -1
      }
      if (drive.held.has("Space")) brake = 1
    }
    throttleIn += (throttle - throttleIn) * (1 - Math.exp(-dt * 4))
    // Steering: rate-limited wheel, less lock at speed.
    const lock = MAX_STEER / (1 + Math.abs(v) / 9)
    const want = steerIn * lock
    steer += Math.sign(want - steer) * Math.min(Math.abs(want - steer), dt * 1.6)

    if (running) {
      // Longitudinal: engine (falling off towards the top speed), brakes, rolling + air drag, the slope's pull.
      const surface = northTrackDistance(pose.x, pose.z) < 3 ? 1.6 : 1
      let a = 0
      if (throttleIn > 0) a += throttleIn * 3.1 * Math.max(0, 1 - v / TOP)
      if (throttleIn < 0) a += throttleIn * 2.0 * Math.max(0, 1 + v / REVERSE_TOP)
      const drag = (0.25 * surface + 0.0045 * v * v) * Math.sign(v)
      a -= drag
      a -= 9.8 * Math.sin(pose.pitch)
      if (brake > 0) {
        const b = brake * 7.5 * dt
        v = Math.abs(v) <= b ? 0 : v - Math.sign(v) * b
      }
      const vPrev = v
      v += a * dt
      if (throttleIn === 0 && Math.abs(v) < 0.08 && brake === 0) v = 0
      accel = (v - vPrev) / dt
      // Kinematic bicycle on the rear axle, a few substeps so collisions stay honest at speed.
      const n = Math.max(1, Math.ceil((Math.abs(v) * dt) / 0.15))
      for (let k = 0; k < n; k++) {
        const h = dt / n
        const yawRate = (v * Math.tan(steer)) / G.wb
        const nyaw = pose.yaw + yawRate * h
        const nx = pose.x - Math.sin(nyaw) * v * h
        const nz = pose.z - Math.cos(nyaw) * v * h
        const probe = { ...pose }
        const c = settle(probe, nx, nz, nyaw)
        if (hits(c.cx, c.cz, nyaw, probe.y)) {
          if (Math.abs(v) > 3) {
            hooks.sfx?.play("hor-metal-bang", { bus: "doors", gain: Math.min(1, Math.abs(v) / 10), rate: 0.7, lowBoost: 6 })
            emitNoise({ x: pose.x, y: pose.y + 1, z: pose.z }, NOISE.crash, "knock")
          }
          v = -v * 0.15
          break
        }
        pose.x = nx
        pose.z = nz
        pose.yaw = nyaw
      }
    }
    apply()
    const curvature = Math.tan(steer) / G.wb
    truck.lights.brake = brake > 0.1 && running ? 1 : 0
    truck.update(dt, time, v, accel, curvature)
    body?.steer(truck.wheelAngle)

    // The camera at the driver's eyes, looking round the cab with the mouse.
    const m = drive.takeLook()
    const sens = Number(ctx.settings["player.sensitivity"] ?? 1) * 0.0022
    if (m.x || m.y) lookIdle = 0
    else lookIdle += dt
    lookYaw = Math.max(-1.6, Math.min(1.6, lookYaw - m.x * sens))
    lookPitch = Math.max(-0.6, Math.min(0.5, lookPitch - m.y * sens))
    if (lookIdle > 2.5 && Math.abs(v) > 2) {
      const k = 1 - Math.exp(-dt * 0.8)
      lookYaw -= lookYaw * k
      lookPitch -= lookPitch * k
    }
    if (!body?.seatEye(tmp)) truck.seatWorld("driver", tmp)
    // Sat up a little and leaning towards the glass: the road over the hood, the roof line high in the frame.
    tmp.addScaledVector(tmp2.set(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw)), 0.07)
    tmp.y += 0.03
    camera.position.copy(tmp)
    eyeObj.position.copy(tmp)
    eyeObj.updateMatrixWorld()
    // Eyes a little down the road (the cab roof and visors otherwise take the top third).
    e.set(lookPitch - 0.03, lookYaw, 0, "YXZ")
    q.copy(truck.root.quaternion)
    camera.quaternion.setFromEuler(e).premultiply(truck.body.getWorldQuaternion(new THREE.Quaternion()).slerp(q, 0.5))
    camera.updateMatrixWorld()
    // The hunter tracks the player: keep the controller's body at the seat.
    player.pos.x = tmp.x
    player.pos.z = tmp.z
    player.pos.y = pose.y

    // Sound: engine and road, the radio crackling.
    sound?.update(dt, Math.abs(v), accel)

    // Prompts.
    if (state === "seated") show(keyPromptHtml("KeyE", "Start the engine", { minimal: true }))
    else if (state === "running" && Math.abs(v) < 0.4 && !controlLocked) {
      const doorShut = motorPool && !motorPool.rollup.isOpen && Math.abs(pose.z - TRUCK_PARK.z) < 4
      show(keyPromptHtml("KeyE", doorShut ? "Get out (the roll-up's button is by the door)" : "Get out", { minimal: true }))
    } else show("")

    // Past the north gate, then the ambush.
    if (gateAt < 0 && pose.z < FENCE.min[1] - 3 && pose.x > NORTH_GATE.x0 - 8 && pose.x < NORTH_GATE.x1 + 8) gateAt = time
    if (running && !fired) {
      const rs = roadProj.project(pose.x, pose.z)
      if ((rs.d < 8 && rs.s >= AMBUSH_ROAD_S) || (gateAt >= 0 && time - gateAt >= AMBUSH_AFTER_GATE_S)) fire()
    }
  })

  // The roll-up's motor: noisy while it runs.
  const offDoor = flow.onUpdate(() => {
    const r = motorPool?.rollup
    if (!r) return
    const moving = r.isOpen && r.amount < 0.99
    if (moving && time - rollNoiseAt > 2) {
      rollNoiseAt = time
      emitNoise({ x: TRUCK_PARK.x, y: 1.5, z: -39.4 }, NOISE.rollup, "door")
    }
  })

  /** Pure pursuit along the escape path, speed from the curvature ahead. */
  function pilot() {
    const p = pathProj.project(pose.x, pose.z)
    // Short look-ahead in the shed (squeeze through the door square), longer at speed.
    const L = (pose.z > -42 ? 2.2 : 4.5) + Math.abs(v) * 0.55
    const tgt = path.at(p.s + L)
    const dx = tgt.x - pose.x
    const dz = tgt.z - pose.z
    // Angle of the target off the heading (+ left).
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw)
    const rx = Math.cos(pose.yaw), rz = -Math.sin(pose.yaw)
    const ahead = dx * fx + dz * fz
    const side = dx * rx + dz * rz
    const alpha = Math.atan2(-side, ahead)
    const d = Math.atan2(2 * G.wb * Math.sin(alpha), Math.max(1, Math.hypot(dx, dz)))
    // Speed: slow in the shed and court, the gate, faster on the track and road, easing for bends ahead.
    const a1 = path.at(p.s + 6), a2 = path.at(p.s + 14)
    const bend = Math.abs(Math.atan2(a2.tx * a1.tz - a2.tz * a1.tx, a2.tx * a1.tx + a2.tz * a1.tz))
    let target = pose.z > -48 ? 3.5 : Math.abs(pose.z - FENCE.min[1]) < 8 ? 4.5 : 9.5
    target = Math.min(target, 9.5 - bend * 14)
    target = Math.max(target, 3)
    const doorShut = motorPool && motorPool.doorBox && pose.z > -41
    if (doorShut) target = 0
    return { steer: Math.max(-1, Math.min(1, d / MAX_STEER)), throttle: v < target - 0.3 ? 1 : 0, brake: v > target + 1 ? 0.6 : 0 }
  }

  const stop = () => {
    off()
    offDoor()
    offPress()
    prompt.remove()
    blink.remove()
    style.remove()
    delete document.body.dataset.driving
    drive.active = false
    if (truck) truck.releaseBeam(player)
    sound?.stop()
    if (current === api) current = null
  }
  host.signal?.addEventListener("abort", stop)

  const api = {
    stop,
    vehicle,
    get state() {
      return state
    },
    /** Automation / the ending chapter: put the player in the running truck at `s` m along the escape path. */
    async placeOnPath(s: number, speed = 0) {
      for (let i = 0; i < 200 && !(truck ??= motorPool?.truck ?? null); i++) await new Promise((r) => setTimeout(r, 50))
      const t = truck!
      const p = path.at(s)
      pose.yaw = Math.atan2(-p.tx, -p.tz)
      pose.x = p.x
      pose.z = p.z
      t.unpark()
      apply()
      t.root.updateMatrixWorld(true)
      state = "seated"
      flow.hold = true
      player.release()
      drive.active = true
      document.body.dataset.driving = "1"
      seatBody()?.seat(t.seatOptions())
      sound ??= new IntroAudio(hooks.sfx)
      sound.radioLevel = 0.55
      engineCaught()
      if (sound) sound.boost = 1
      v = speed
    },
    get autopilot() {
      return autopilot
    },
    set autopilot(on: boolean) {
      autopilot = on
    },
    get info() {
      return { state, v: +v.toFixed(2), x: +pose.x.toFixed(2), z: +pose.z.toFixed(2), yaw: +pose.yaw.toFixed(3), y: +pose.y.toFixed(3), roadS: +roadProj.project(pose.x, pose.z).s.toFixed(1), pathS: +pathProj.project(pose.x, pose.z).s.toFixed(1), fired, gateAt }
    },
    path,
  }
  ;(globalThis as { __ashwoodEscape?: unknown }).__ashwoodEscape = api
  // The ending chapter starts the drive `lead` s before the ambush.
  void import("../encounters/road-ambush").then((m) =>
    m.setEndingDrive(async (_g: Any, lead: number) => {
      // Back from the trigger along the road, at the speed the autopilot would hold.
      const roadStart = pathProj.project(road.pts[0]!.x, road.pts[0]!.z).s
      const s = Math.max(0, roadStart + AMBUSH_ROAD_S - lead * 9)
      await api.placeOnPath(s, 9)
      autopilot = true
    }),
  )
  return api
}
