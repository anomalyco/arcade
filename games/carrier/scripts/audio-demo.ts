// Browser entry for scripts/audio-render.ts: renders scripted jet-audio scenes through the real mixer and JetAudio on an
// OfflineAudioContext (48 kHz stereo), stepping the scene every 1024 frames (21 ms) with suspend/resume, and returns
// 16-bit WAV bytes (base64) plus peak and RMS. Exposed as `globalThis.renderScene(name, base)`.
import { encodeWavPcm16 } from "@arcade/kit/audio/offline"
import { mulberry32 } from "@arcade/kit/sim/rng"
import type { PlaneTuple } from "../shared/protocol"
import type { VehicleKind } from "../shared/vehicles"
import { LAUNCH } from "../shared/launch"
import { WEATHER_PRESETS, type WeatherKind, makeWeather } from "../shared/weather"
import { JetAudio, type OwnJet } from "../src/audio/jet-audio"
import { BOOM_KINDS, boomsFor } from "../src/audio/jet-boom"
import { sfx } from "../src/audio/sfx-bank"
import type { ShipLike } from "../src/audio/ship-audio"
import { DEFAULT_LEVELS, mixer } from "../src/audio/mixer"
import { WeaponAudio } from "../src/audio/weapon-audio"
import { WeatherAudio } from "../src/audio/weather-audio"
import { JetSfx } from "../src/audio/jet-sfx"
import { UiAudio } from "../src/audio/ui-audio"
import { TurretAudio } from "../src/audio/turret-audio"
import { GUNNERY } from "../shared/gunnery"
import type { PlaneDrawPose } from "../src/render/plane-pass"

const RATE = 48000
const STEP = 1024 / RATE

type Scene = { dur: number; samples?: boolean; setup?: (s: Sim) => void; step: (s: Sim, t: number, dt: number) => void }


/** Mutable scene state the steps write and the renderer feeds to JetAudio. */
class Sim {
  own: (OwnJet & { phase: string; vehicle: VehicleKind; launch: { phase: string } | null; landing: { phase: string } | null; cam: { mode: string }; plane: { crashed: string } }) | null = null
  pose: PlaneDrawPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 1, throttle: 0, burner: 0, hook: 0 }
  remotes: { id: number; pose: PlaneDrawPose; tuple: PlaneTuple }[] = []
  weapons: WeaponAudio | null = null
  weather: WeatherAudio | null = null
  wx = makeWeather()
  /** Interface sounds (the scene calls them where the player would press and click). */
  ui: UiAudio | null = null
  /** Carriers for the ship ambience (none unless a scene adds one). */
  ships: [number, ShipLike][] = []

  /** The game's weapon sounds on this render's context. */
  arm(): WeaponAudio {
    const w = (this.weapons = new WeaponAudio())
    ;(w as unknown as { start(): void }).start()
    return w
  }

  /** The game's weather sounds on this render's context, at a preset. */
  sky(kind: WeatherKind): void {
    const w = (this.weather = new WeatherAudio())
    ;(w as unknown as { start(): void }).start()
    this.wx = makeWeather(WEATHER_PRESETS[kind])
  }
  eye = [0, 20, 0]
  fwd = [0, 0, -1]
  up = [0, 1, 0]

  makeOwn(kind: VehicleKind, mode: "chase" | "cockpit"): NonNullable<Sim["own"]> {
    this.own = {
      phase: "flying",
      vehicle: kind,
      draw: { x: 0, y: 300, z: 0, qx: 0, qy: 1, qz: 0, qw: 0, vx: 0, vy: 0, vz: 0, throttle: 0.15, boosting: 0, stall: 0, g: 1, brake: 0 },
      plane: { crashed: "" },
      launch: null,
      landing: null,
      cam: { mode },
    }
    return this.own
  }

  makeRemote(id: number, kind: VehicleKind): { pose: PlaneDrawPose; tuple: PlaneTuple } {
    const r = { id, pose: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, pitch: 0, roll: 0, gear: 0, throttle: 0.8, burner: 0, kind } as PlaneDrawPose, tuple: new Array(19).fill(0) as unknown as PlaneTuple }
    r.tuple[1] = 1
    this.remotes.push(r)
    return r
  }

  /** The chase camera behind the own jet (27 m back, 5.2 up), looking along its nose. */
  chase(): void {
    const d = this.own!.draw
    const [nx, , nz] = nose(d.qx, d.qy, d.qz, d.qw)
    this.eye[0] = d.x - nx * 27
    this.eye[1] = d.y + 5.2
    this.eye[2] = d.z - nz * 27
    this.fwd[0] = nx
    this.fwd[1] = -0.07
    this.fwd[2] = nz
  }

  cockpit(): void {
    const d = this.own!.draw
    const [nx, , nz] = nose(d.qx, d.qy, d.qz, d.qw)
    this.eye[0] = d.x + nx * 4.3
    this.eye[1] = d.y + 1.1
    this.eye[2] = d.z + nz * 4.3
    this.fwd[0] = nx
    this.fwd[1] = 0
    this.fwd[2] = nz
  }
}

const nose = (qx: number, qy: number, qz: number, qw: number): [number, number, number] => [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)]
const yawQ = (o: { qx: number; qy: number; qz: number; qw: number }, yaw: number) => {
  o.qx = 0
  o.qy = Math.sin(yaw / 2)
  o.qz = 0
  o.qw = Math.cos(yaw / 2)
}
const smooth = (a: number, b: number, t: number) => {
  const k = Math.max(0, Math.min(1, (t - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

/** Idle → military → afterburner → cruise, flying north (-z), from the chase camera or the cockpit. */
function ramp(kind: VehicleKind, view: "chase" | "cockpit"): Scene {
  let thr = 0.15
  return {
    dur: 15,
    setup: (s) => {
      const o = s.makeOwn(kind, view)
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      const d = s.own!.draw
      const want = t < 3 ? 0.15 : t < 12.5 ? 1 : 0.77
      thr += Math.max(-0.7 * dt, Math.min(0.7 * dt, want - thr))
      d.throttle = thr
      d.boosting = t > 8 && t < 12 ? 1 : 0
      const speed = 90 + 100 * smooth(3, 8, t) + 45 * smooth(8, 11.5, t) - 50 * smooth(12, 15, t)
      d.vz = -speed
      d.z += d.vz * dt
      d.g = 1 + 4 * smooth(9, 10, t) * (1 - smooth(11, 12, t))
      if (view === "chase") s.chase()
      else s.cockpit()
    },
  }
}

/** A remote jet passing in front of a camera on the deck, right to left, `off` metres out and `up` metres above it. */
function flyby(burner: boolean, off = 40, up = burner ? 18 : 28): Scene {
  let rt = 0
  const speed = burner ? 245 : 215
  return {
    dur: 12,
    setup: (s) => {
      s.eye = [0, 22, 0]
      s.fwd = [0, 0, -1]
      const r = s.makeRemote(7, "hornet")
      r.pose.x = speed * 5.6
      r.pose.y = 22 + up
      r.pose.z = -off
      yawQ(r.pose, -Math.PI / 2)
    },
    step: (s, _t, dt) => {
      const r = s.remotes[0]!
      r.pose.x -= speed * dt
      r.pose.throttle = burner ? 1 : 0.9
      r.pose.burner = burner ? 1 : 0
      rt += dt
      const tp = r.tuple
      tp[0] = Math.round(rt * 20) / 20
      tp[1] = 1
      tp[9] = -speed
      tp[10] = 0
      tp[11] = 0
    },
  }
}

/**
 * Your own launch (shared/launch.ts): parked at idle on the shuttle for 1 s, then launchStart: full throttle and
 * afterburner with the stroke, eased in over 0.3 s then ~3.5 g down 285 m (`progress`) in 4.2 s, off the bow
 * (launchEnd) at ~140 m/s, then the climb-out and the gear.
 */
function catapult(view: "chase" | "cockpit" = "chase"): Scene {
  const DECK = 20
  const STROKE_M = 285
  let run = 0
  let off = -1
  return {
    dur: 10,
    setup: (s) => {
      const o = s.makeOwn("hornet", view)
      o.phase = "deck"
      o.draw.y = DECK
      yawQ(o.draw, Math.PI)
      s.pose.gear = 1
    },
    step: (s, t, dt) => {
      const o = s.own!
      const d = o.draw
      let speed = 0
      if (t < 1) {
        o.phase = "launching"
        o.launch = { phase: "ready", progress: 0 }
        d.throttle = 0.15
        d.boosting = 0
      } else if (run < STROKE_M) {
        o.phase = "launching"
        d.throttle = 1
        d.boosting = 1
        const u = t - 1
        speed = u < 0.3 ? (34.7 * u * u) / 0.6 : 34.7 * (u - 0.15)
        run += speed * dt
        o.launch = { phase: "stroke", progress: Math.min(1, run / STROKE_M) }
      } else {
        if (off < 0) off = t
        o.phase = "flying"
        o.launch = { phase: "airborne", progress: 1 }
        d.boosting = 0
        speed = 141 + 4 * (t - off)
        d.vy = 6
        d.y += d.vy * dt
        // Gear up after 0.8 s, over 2.2 s.
        s.pose.gear = 1 - Math.max(0, Math.min(1, (t - off - 0.8) / 2.2))
      }
      d.vz = -speed
      d.z += d.vz * dt
      if (view === "chase") s.chase()
      else s.cockpit()
    },
  }
}

/**
 * Cruising after the launch, the engine's character: cruise, to military, a burst of afterburner, back to cruise, then
 * into the cockpit and back out to the chase camera.
 */
function cruise(): Scene {
  let thr = 0.77
  return {
    dur: 20,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.draw.y = 400
      o.draw.throttle = thr
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      const o = s.own!
      const d = o.draw
      const want = t < 3 ? 0.77 : t < 9 ? 1 : 0.77
      thr += Math.max(-0.7 * dt, Math.min(0.7 * dt, want - thr))
      d.throttle = thr
      d.boosting = t > 6 && t < 9 ? 1 : 0
      d.vz = -(140 + 40 * smooth(3, 6, t) + 50 * smooth(6, 9, t) - 90 * smooth(9, 14, t))
      d.z += d.vz * dt
      o.cam.mode = t > 12 && t < 16 ? "cockpit" : "chase"
      if (o.cam.mode === "chase") s.chase()
      else s.cockpit()
    },
  }
}

/**
 * The whole launch as a player hears it, from the chase camera on the deck of a carrier in clear weather: E opens ship
 * operations, the pointer finds LAUNCH and clicks it, then the catapult sequence (line-up, spool to afterburner, the
 * stroke, off the bow, gear up) and the climb-out.
 */
function launch(): Scene {
  const cat = catapult()
  return {
    dur: 11,
    setup: (s) => {
      s.sky("clear")
      s.ships = [[1, { x: 0, z: 0, heave: 0, slams: 0, slam: 0 }]]
      s.ui = new UiAudio(mixer(), false)
      cat.setup!(s)
    },
    step: (s, t, dt) => {
      const at = (x: number) => Math.abs(t - x) < dt / 2
      if (at(0.15)) s.ui!.opened()
      if (at(0.55)) s.ui!.hover()
      if (at(0.85)) s.ui!.clicked()
      s.weather!.update(s.wx, dt)
      cat.step(s, Math.max(0, t - 1), dt)
    },
  }
}

/** The whole landing: the autopilot capture, touchdown and the trap, from the chase camera, ship ambience on. */
function landing(): Scene {
  const tr = trap()
  return {
    dur: 7,
    setup: (s) => {
      s.sky("clear")
      s.ships = [[1, { x: 0, z: -200, heave: 0, slams: 0, slam: 0 }]]
      const o = s.makeOwn("hornet", "chase")
      o.phase = "flying"
      tr.setup!(s)
      s.own!.phase = "flying"
    },
    step: (s, t, dt) => {
      s.weather!.update(s.wx, dt)
      tr.step(s, t, dt)
      // The landing autopilot takes the jet a moment in.
      if (t < 0.3) s.own!.phase = "flying"
      else if (s.own!.phase === "flying") s.own!.phase = "landing"
    },
  }
}

/** Another player's catapult launch heard from the deck beside the track. */
function catapultDeck(): Scene {
  // The jet starts at the stern end of the runway (world z = 120 here) and runs north (-z) 285 m to the bow.
  let run = 0
  let speed = 0
  let off = -1
  return {
    dur: 9,
    setup: (s) => {
      s.eye = [-30, 22, -20]
      s.fwd = [0.6, 0, -0.8]
      const r = s.makeRemote(9, "f35")
      r.pose.x = 0
      r.pose.y = 22
      r.pose.z = 120
      yawQ(r.pose, Math.PI)
      r.pose.gear = 1
    },
    step: (s, t, dt) => {
      const r = s.remotes[0]!
      const stroke = t >= 1 && run < 285
      if (stroke) {
        const u = t - 1
        speed = u < 0.3 ? (34.7 * u * u) / 0.6 : 34.7 * (u - 0.15)
        run += speed * dt
      } else if (t >= 1) {
        if (off < 0) off = t
        speed += 3 * dt
        r.pose.y += 6 * dt
      }
      r.pose.throttle = t < 1 ? 0.15 : 1
      r.pose.burner = t >= 1 && (stroke || t - off < 0.2) ? 1 : 0
      r.pose.z -= speed * dt
      const tp = r.tuple
      tp[0] = Math.round(t * 20) / 20
      tp[1] = off >= 0 ? 1 : 0
      // Mode 0 carries the ship-local catapult z (the stroke's progress from LAUNCH.startZ).
      tp[2] = LAUNCH.startZ + run
      tp[11] = -speed
    },
  }
}

/** Your own trap from the chase camera: hook down on the approach, touchdown, the wire pulls the jet up. */
function trap(): Scene {
  const DECK = 20
  return {
    dur: 7,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.phase = "landing"
      o.landing = { phase: "approach" }
      o.draw.y = DECK + 2 + 70 * 1.6 * Math.tan((3.5 * Math.PI) / 180)
      o.draw.z = 70 * 1.6
      yawQ(o.draw, Math.PI)
      s.pose.gear = 1
      s.pose.hook = 0
    },
    step: (s, t, dt) => {
      const o = s.own!
      const d = o.draw
      s.pose.hook = Math.min(1, t * 2)
      let speed: number
      if (t < 1.6) {
        speed = 70
        d.throttle = 0.62
        d.vy = -70 * Math.tan((3.5 * Math.PI) / 180)
        d.y += d.vy * dt
      } else {
        if (o.landing!.phase === "approach") o.landing = { phase: "trap" }
        d.vy = 0
        d.y = DECK + 2
        speed = Math.max(0, 70 - 35 * (t - 1.6))
        d.throttle += (0.15 - d.throttle) * Math.min(1, dt / 0.4)
        if (speed === 0) o.landing = { phase: "stopped" }
      }
      d.vz = -speed
      d.z += d.vz * dt
      s.chase()
    },
  }
}

/** Calibration: a 440 Hz sine at 0.1 peak into the sfx bus (expected out 0.1 × sfx level × master if the chain is unity). */
function calib(): Scene {
  return {
    dur: 2,
    setup: () => {
      const m = mixer()
      const o = m.ctx!.createOscillator()
      const g = m.ctx!.createGain()
      g.gain.value = 0.1
      o.connect(g).connect(m.bus.sfx)
      o.start(0.2)
    },
    step: () => {},
  }
}

/** The gun in bursts, a missile launch and a missile airburst 300 m off (the level reference). */
function gun(): Scene {
  return {
    dur: 7,
    setup: (s) => void s.arm(),
    step: (s, t, dt) => {
      const w = s.weapons!
      w.update(dt, (t > 0.5 && t < 2) || (t > 3 && t < 4), 0, 0, 0)
      if (Math.abs(t - 4.5) < dt / 2) w.missile(0)
    },
  }
}

/** The M61 alone: `bursts` as [start, end] seconds the gun fires; `far` metres away (another jet's gun) or 0 (yours). */
function gunScene(dur: number, bursts: readonly (readonly [number, number])[], far = 0, cockpit = false): Scene {
  return {
    dur,
    setup: (s) => {
      s.arm()
      if (cockpit) {
        mixer().forceCockpit = 1
        mixer().setCockpit(1)
      }
    },
    step: (s, t, dt) => {
      const on = bursts.some(([a, b]) => t >= a && t < b)
      s.weapons!.update(dt, !far && on, far && on ? 1 / (1 + far / 300) : 0, 0, 0)
    },
  }
}

/** Weather at a preset, alone. */
function weather(kind: WeatherKind): Scene {
  return { dur: 6, setup: (s) => s.sky(kind), step: (s, _t, dt) => s.weather!.update(s.wx, dt) }
}

/** Your jet in the chase view at cruise with medium weather, two gun bursts, then the afterburner: the balance check. */
function mixChase(): Scene {
  const base = ramp("hornet", "chase")
  return {
    dur: 12,
    setup: (s) => {
      base.setup!(s)
      s.arm()
      s.sky("medium")
    },
    step: (s, t, dt) => {
      const d = s.own!.draw
      d.throttle = 0.77
      d.boosting = t > 8 && t < 10.5 ? 1 : 0
      d.vz = -(140 + 60 * smooth(8, 10, t))
      d.z += d.vz * dt
      s.chase()
      s.weather!.update(s.wx, dt)
      s.weapons!.update(dt, (t > 3 && t < 4.5) || (t > 6 && t < 7), 0, 0, 0)
    },
  }
}

/** Every explosion scenario close (60 m) then far (2 km), 4.5 s apart, travel delay left out to keep the reel short. */
function explosions(): Scene {
  return {
    dur: BOOM_KINDS.length * 9 + 1,
    step: (s, t, dt) => {
      const b = boomsFor(mixer())
      BOOM_KINDS.forEach((k, i) => {
        if (Math.abs(t - (0.3 + i * 9)) < dt / 2) b.play(k, 60, k === "missile" ? 1 : 1.5, { delay: 0 })
        if (Math.abs(t - (4.8 + i * 9)) < dt / 2) b.play(k, 2000, k === "missile" ? 1 : 1.5, { delay: 0 })
      })
    },
  }
}

/**
 * The SAM from the gunner's seat (src/audio/turret-audio.ts): the seeker tracking (beeps quickening and rising) for
 * `lockTime`, the lock chirp and solid tone, the launch, the motor climbing away (placed and Doppler-shifted), and its
 * proximity burst 1.3 km out, heard after the sound's travel time. `pass`: instead, another ship's SAM crossing 40 m
 * in front of the listener at full speed (the motor's Doppler drop), then bursting far off.
 */
function sam(pass = false): Scene {
  let ta: TurretAudio | null = null
  const p = { x: 0, y: 20, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, age: -1, live: false, burst: false }
  const LAUNCH = pass ? 0.5 : 0.3 + GUNNERY.sam.lockTime + 0.5
  // Out along -z (ahead of the listener) and climbing; the pass flies along +x 40 m ahead.
  const dir = pass ? [1, 0.03, 0] : [0.2, 0.35, -0.92]
  return {
    dur: pass ? 9 : LAUNCH + 9,
    setup: (s) => {
      s.eye = [0, 20, 0]
      s.fwd = [0, 0.2, -1]
      ta = new TurretAudio()
    },
    step: (_s, t, dt) => {
      const a = ta!
      const progress = pass ? 0 : Math.max(0, Math.min(1, (t - 0.3) / GUNNERY.sam.lockTime))
      const seek: 0 | 1 | 2 = pass || t < 0.3 || t > LAUNCH + 0.3 ? 0 : progress >= 1 ? 2 : 1
      a.update(dt, false, 0, seek, progress)
      if (!p.live && !p.burst && t >= LAUNCH) {
        p.live = true
        p.age = 0
        if (pass) {
          p.x = -900
          p.z = -40
          p.speed = GUNNERY.sam.topSpeed
        } else {
          p.x = 3
          p.y = 18
          p.z = -6
          p.speed = GUNNERY.sam.eject
          a.samLaunch(Math.hypot(p.x, p.y - 20, p.z))
        }
      }
      if (p.live) {
        p.age += dt
        if (!pass && p.age < GUNNERY.sam.burn) p.speed = Math.min(GUNNERY.sam.topSpeed, p.speed + GUNNERY.sam.accel * dt)
        p.vx = dir[0]! * p.speed
        p.vy = dir[1]! * p.speed
        p.vz = dir[2]! * p.speed
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.z += p.vz * dt
        const d = Math.hypot(p.x, p.y - 20, p.z)
        if (d > (pass ? 2500 : 1300)) {
          p.live = false
          p.burst = true
          a.burstAt(d, "sam", "air")
        }
      }
      a.samMotors(p.live ? [{ key: 1, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, burning: pass || p.age < GUNNERY.sam.burn }] : [])
    },
  }
}

/**
 * The 60 s montage: the deck at dawn over a calm sea → your catapult shot → the climb to military and afterburner → a
 * head-on pass with a crack → gun bursts → a missile → the kill → the weather turns to a storm with thunder → the trap.
 * Each segment is one of the scenes above (re-set at its start); the weapons and weather persist across them.
 */
function montage(): Scene {
  const segs: [start: number, make: () => Scene][] = [
    [0, () => deck()],
    [6, catapult],
    [15, () => climb()],
    [23, () => headOn()],
    [29, () => combat()],
    [38, () => storm()],
    [50, trap],
  ]
  let cur: Scene | null = null
  let idx = -1
  return {
    dur: 60,
    setup: (s) => {
      s.arm()
      s.sky("clear")
      s.ships = [[1, { x: 0, z: 0, heave: 0, slams: 0, slam: 0 }]]
    },
    step: (s, t, dt) => {
      let i = 0
      while (i + 1 < segs.length && t >= segs[i + 1]![0]) i++
      if (i !== idx) {
        idx = i
        s.own = null
        s.remotes = []
        s.pose.gear = 1
        s.pose.hook = 0
        cur = segs[i]![1]()
        cur.setup?.(s)
      }
      cur!.step(s, t - segs[i]![0], dt)
      s.weather!.update(s.wx, dt)
      if (i < 4) s.weapons!.update(dt, false, 0, 0, 0)
    },
  }
}

/** Standing on deck over a calm sea at dawn. */
function deck(): Scene {
  return {
    dur: 6,
    setup: (s) => {
      s.eye = [-20, 22, 40]
      s.fwd = [0.3, 0, -0.95]
      s.wx = makeWeather(WEATHER_PRESETS.clear)
    },
    step: () => {},
  }
}

/** The climb: military power, then the afterburner, in the chase view. */
function climb(): Scene {
  let thr = 0.8
  return {
    dur: 8,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.draw.y = 120
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      const d = s.own!.draw
      thr = Math.min(1, thr + 0.7 * dt)
      d.throttle = thr
      d.boosting = t > 2.5 && t < 6.5 ? 1 : 0
      d.vz = -(150 + 70 * smooth(2.5, 6.5, t))
      d.vy = 20
      d.z += d.vz * dt
      d.y += d.vy * dt
      s.chase()
    },
  }
}

/** A remote jet head-on past your chase camera (closing at ~450 m/s: a crack). */
function headOn(): Scene {
  let rt = 0
  return {
    dur: 6,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.draw.y = 280
      o.draw.throttle = 0.85
      yawQ(o.draw, Math.PI)
      const r = s.makeRemote(4, "hornet")
      r.pose.x = 25
      r.pose.y = 300
      r.pose.z = -1500
      yawQ(r.pose, 0)
    },
    step: (s, _t, dt) => {
      const d = s.own!.draw
      d.vz = -200
      d.z += d.vz * dt
      s.chase()
      const r = s.remotes[0]!
      r.pose.z += 240 * dt
      r.pose.throttle = 1
      r.pose.burner = 1
      rt += dt
      r.tuple[0] = Math.round(rt * 20) / 20
      r.tuple[1] = 1
      r.tuple[11] = 240
    },
  }
}

/** Gun bursts, a missile, and the kill 600 m ahead. */
function combat(): Scene {
  return {
    dur: 9,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.draw.y = 300
      o.draw.throttle = 0.85
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      const d = s.own!.draw
      d.vz = -190
      d.z += d.vz * dt
      s.chase()
      const w = s.weapons!
      w.update(dt, (t > 0.4 && t < 1.6) || (t > 2.2 && t < 2.9), 0, t > 3 && t < 4.5 ? (t > 3.8 ? 2 : 1) : 0, 0)
      if (Math.abs(t - 4.6) < dt / 2) w.missile(0)
      if (Math.abs(t - 6) < dt / 2) w.explosion(600, 1.5, "air-kill")
    },
  }
}

/** The weather turns: a storm over the sea, the jet low, thunder near and far. */
function storm(): Scene {
  let mix = 0
  return {
    dur: 12,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.draw.y = 90
      o.draw.throttle = 0.7
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      const d = s.own!.draw
      d.vz = -130
      d.z += d.vz * dt
      s.chase()
      mix = Math.min(1, mix + dt / 3)
      const a = WEATHER_PRESETS.clear
      const b = WEATHER_PRESETS.heavy
      for (const k of Object.keys(b) as (keyof typeof b)[]) (s.wx as Record<string, number>)[k] = a[k] + (b[k] - a[k]) * mix
      if (Math.abs(t - 3.5) < dt / 2) s.weather!.strike({ t: 0, power: 1, bearing: 0.7, dist: 700, seed: 1 }, 700 / 343)
      if (Math.abs(t - 8) < dt / 2) s.weather!.strike({ t: 0, power: 0.9, bearing: -1.2, dist: 5000, seed: 2 }, 1.2)
    },
  }
}

/** The "pitch" flight's sections (s). */
const PITCH_SECTIONS: readonly (readonly [name: string, at: number])[] = [
  ["idle", 0],
  ["launch", 4],
  ["climb", 8.5],
  ["cruise", 14],
  ["military", 20],
  ["afterburner", 25],
  ["cruise", 30],
  ["flyby", 36],
  ["cockpit", 44],
  ["end", 50],
]

/**
 * One continuous Hornet flight (the engine pitch of captures/audio/hornet-pitch/): parked at idle on the deck (chase camera), the catapult (its live
 * voice), the climb at military, cruise, military, afterburner, back to cruise, then from the deck another Hornet's
 * flyby at military 40 m out, and your own jet at cruise from the cockpit. Weather clear, the carrier's ambience on.
 */
function pitch(dry = false): Scene {
  const at = (name: string) => PITCH_SECTIONS.find((p) => p[0] === name)![1]
  const DECK = 20
  const STROKE_M = 285
  let thr = 0.15
  let run = 0
  let speed = 0
  const fly = flyby(false)
  let flyT = -1
  return {
    dur: at("end"),
    setup: (s) => {
      if (!dry) {
        s.sky("clear")
        s.ships = [[1, { x: 0, z: 0, heave: 0, slams: 0, slam: 0 }]]
      }
      const o = s.makeOwn("hornet", "chase")
      o.phase = "launching"
      o.launch = { phase: "ready", progress: 0 }
      o.draw.y = DECK
      o.draw.throttle = thr
      yawQ(o.draw, Math.PI)
    },
    step: (s, t, dt) => {
      s.weather?.update(s.wx, dt)
      if (t >= at("flyby") && t < at("cockpit")) {
        // From the deck: your jet parked out of the way, another Hornet passes.
        if (flyT < 0) {
          flyT = 0
          s.own = null
          fly.setup!(s)
        }
        fly.step(s, flyT, dt)
        flyT += dt
        return
      }
      if (t >= at("cockpit") && (!s.own || s.own.cam.mode !== "cockpit")) {
        s.remotes = []
        const o = s.makeOwn("hornet", "cockpit")
        o.draw.y = 420
        thr = 0.77
        o.draw.throttle = thr
        yawQ(o.draw, Math.PI)
        speed = 150
      }
      const o = s.own!
      const d = o.draw
      const want = t < at("launch") ? 0.15 : t < at("cruise") || (t >= at("military") && t < 30) ? 1 : 0.77
      if (t >= at("launch") && t < at("climb")) thr = 1
      else thr += Math.max(-0.7 * dt, Math.min(0.7 * dt, want - thr))
      d.throttle = thr
      d.boosting = (t >= at("launch") && run < STROKE_M) || (t >= at("afterburner") && t < 30) ? 1 : 0
      if (t >= at("launch") && run < STROKE_M) {
        o.phase = "launching"
        const u = t - at("launch")
        speed = u < 0.3 ? (34.7 * u * u) / 0.6 : 34.7 * (u - 0.15)
        run += speed * dt
        o.launch = { phase: "stroke", progress: Math.min(1, run / STROKE_M) }
      } else if (run >= STROKE_M) {
        o.phase = "flying"
        o.launch = { phase: "airborne", progress: 1 }
        const target = t < at("cruise") ? 165 : t < at("military") ? 155 : t < at("afterburner") ? 168 : t < 30 ? 215 : 160
        speed += (target - speed) * Math.min(1, dt / 2.5)
        d.vy = t < at("cruise") ? 18 : 0
        d.y += d.vy * dt
      }
      d.vz = -speed
      d.z += d.vz * dt
      if (o.cam.mode === "chase") s.chase()
      else s.cockpit()
    },
  }
}

const SCENES: Record<string, () => Scene> = {
  pitch: () => pitch(),
  // The engines alone (no sea, wind or ship ambience), for measuring them.
  "pitch-dry": () => pitch(true),
  launch,
  landing,
  montage,
  "exterior-ramp": () => ramp("hornet", "chase"),
  "cockpit-ramp": () => ramp("hornet", "cockpit"),
  "f35-exterior-ramp": () => ramp("f35", "chase"),
  flyby: () => flyby(false),
  "flyby-burner": () => flyby(true),
  "flyby-crack": headOn,
  "flyby-distant": () => flyby(false, 120, 90),
  catapult: () => catapult(),
  "launch-cockpit": () => catapult("cockpit"),
  cruise,
  "catapult-deck": catapultDeck,
  trap,
  calib,
  gun,
  "gun-short": () => gunScene(6, [[0.4, 0.7], [1.3, 1.55], [2.2, 2.6], [3.2, 3.4], [4.0, 4.5]]),
  // Held for 4.5 s: the gun overheats after 3.2 s of fire (shared/weapons.ts heatTime) and falls silent.
  "gun-overheat": () => gunScene(7, [[0.5, 3.7]]),
  "gun-distant": () => gunScene(7, [[0.5, 2], [3, 4.2]], 600),
  "gun-cockpit": () => gunScene(6, [[0.4, 1.4], [2.2, 3.6]], 0, true),
  "weather-medium": () => weather("medium"),
  "weather-heavy": () => weather("heavy"),
  "mix-chase": mixChase,
  explosions,
  sam: () => sam(),
  "sam-pass": () => sam(true),
}

/** What fired, when (audio time, s): every bank slot played and every jet one-shot, for the before/after lists. */
const fired: string[] = []
let logged = false
function logSounds(mx: ReturnType<typeof mixer>): void {
  if (logged) return
  logged = true
  const bank = sfx(mx)
  const play = bank.play.bind(bank)
  bank.play = (slot, o) => {
    const r = play(slot, o)
    fired.push(`${mx.now.toFixed(2)} ${r ? "" : "(dropped) "}${slot}`)
    return r
  }
  const loop = bank.loop.bind(bank)
  bank.loop = (slot, o) => {
    fired.push(`${mx.now.toFixed(2)} loop ${slot}`)
    return loop(slot, o)
  }
  for (const k of ["catapult", "holdback", "shuttleBrake", "burnerLight", "gear", "hook", "trap", "crash", "boom", "flyby", "thunk"] as const) {
    const proto = JetSfx.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
    const f = proto[k]
    if (!f) continue
    proto[k] = function (this: unknown, ...a: unknown[]) {
      fired.push(`${mx.now.toFixed(2)} jet:${k}`)
      return f.apply(this, a)
    }
  }
}

async function renderScene(name: string, base: string): Promise<{ wav: string; peak: number; rms: number; loaded: number; fired: string[] }> {
  // Seeded per scene (pooled takes, loop start points), so two builds render the same notes and can be compared.
  Math.random = mulberry32(0x5eed)
  const scene = SCENES[name]!()
  const ctx = new OfflineAudioContext(2, Math.ceil(scene.dur * RATE), RATE)
  // The game's shared mixer, rebuilt on this context (weapon and weather audio find it there too).
  const mx = mixer()
  mx.levels = { ...DEFAULT_LEVELS }
  mx.muted = false
  mx.samplesOn = scene.samples !== false
  mx.rain = 0
  mx.sea = 0
  mx.forceCockpit = null
  mx.cockpit = 0
  const bank = sfx(mx)
  logSounds(mx)
  fired.length = 0
  mx.use(ctx)
  // The sound bank's picked takes (decoded once; buffers are reused across renders).
  await bank.boot(base)
  const jets = new JetAudio(mx, false)
  const sim = new Sim()
  scene.setup?.(sim)
  let t = 0
  const feed = () => {
    scene.step(sim, t, STEP)
    jets.own(sim.own)
    for (const r of sim.remotes) jets.remote(r.id, r.pose, r.tuple)
    jets.ships(sim.ships)
    jets.frame(STEP, sim.eye, sim.fwd, sim.up)
  }
  feed()
  const tick = () => {
    t += STEP
    feed()
    const next = t + STEP
    if (next < scene.dur - STEP) void ctx.suspend(next).then(tick)
    void ctx.resume()
  }
  void ctx.suspend(STEP).then(tick)
  const buf = await ctx.startRendering()
  // Stats and 16-bit WAV.
  const l = buf.getChannelData(0)
  const r = buf.getChannelData(1)
  let peak = 0
  let sum = 0
  for (let i = 0; i < l.length; i++) {
    peak = Math.max(peak, Math.abs(l[i]!), Math.abs(r[i]!))
    sum += l[i]! * l[i]! + r[i]! * r[i]!
  }
  const n = l.length
  const bytes = encodeWavPcm16(buf)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { wav: btoa(bin), peak, rms: Math.sqrt(sum / (2 * n)), loaded: bank.loaded, fired: [...fired] }
}

Object.assign(globalThis, { renderScene, scenes: Object.keys(SCENES) })
