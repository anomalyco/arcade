// Browser entry for scripts/audio-render.ts: renders scripted jet-audio scenes through the real mixer and JetAudio on an
// OfflineAudioContext (48 kHz stereo), stepping the scene every 1024 frames (21 ms) with suspend/resume, and returns
// 16-bit WAV bytes (base64) plus peak and RMS. Exposed as `globalThis.renderScene(name, base)`.
import type { PlaneTuple } from "../shared/protocol"
import type { VehicleKind } from "../shared/vehicles"
import { WEATHER_PRESETS, type WeatherKind, makeWeather } from "../shared/weather"
import { JetAudio, type OwnJet } from "../src/audio/jet-audio"
import { BOOM_KINDS, boomsFor } from "../src/audio/jet-boom"
import { sfx } from "../src/audio/sfx-bank"
import type { ShipLike } from "../src/audio/ship-audio"
import { DEFAULT_LEVELS, mixer } from "../src/audio/mixer"
import { WeaponAudio } from "../src/audio/weapon-audio"
import { WeatherAudio } from "../src/audio/weather-audio"
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

/** Your own catapult launch from the chase camera: line-up, spool (burner lit at the end), the stroke, gear up. */
function catapult(): Scene {
  const DECK = 20
  return {
    dur: 9,
    setup: (s) => {
      const o = s.makeOwn("hornet", "chase")
      o.phase = "deck"
      o.draw.y = DECK
      yawQ(o.draw, Math.PI)
      s.pose.gear = 1
    },
    step: (s, t, dt) => {
      const o = s.own!
      const d = o.draw
      let speed = 0
      if (t < 0.4) {
        o.phase = "deck"
        d.throttle = 0.15
      } else if (t < 1.5) {
        o.phase = "launching"
        o.launch = { phase: "lineup" }
        d.throttle = 0.15
        speed = 14 * Math.sin(((t - 0.4) / 1.1) * Math.PI)
      } else if (t < 2.5) {
        o.launch = { phase: "spool" }
        d.throttle = 0.15 + 0.85 * (t - 1.5)
        d.boosting = t > 2.05 ? 1 : 0
      } else if (t < 4.9) {
        o.launch = { phase: "stroke" }
        d.throttle = 1
        d.boosting = 1
        speed = 38.2 * (t - 2.5)
      } else {
        o.phase = "flying"
        o.launch = { phase: "airborne" }
        d.boosting = 0
        speed = 92 + 4 * (t - 4.9)
        d.vy = 6
        d.y += d.vy * dt
        // Gear up after 0.8 s, over 2.2 s.
        s.pose.gear = 1 - Math.max(0, Math.min(1, (t - 5.7) / 2.2))
      }
      d.vz = -speed
      d.z += d.vz * dt
      s.chase()
    },
  }
}

/** Another player's catapult launch heard from the deck beside the track. */
function catapultDeck(): Scene {
  let z = -80
  let speed = 0
  return {
    dur: 8,
    setup: (s) => {
      s.eye = [-30, 22, -100]
      s.fwd = [0.6, 0, -0.8]
      const r = s.makeRemote(9, "f35")
      r.pose.x = 0
      r.pose.y = 22
      r.pose.z = z
      yawQ(r.pose, Math.PI)
      r.pose.gear = 1
    },
    step: (s, t, dt) => {
      const r = s.remotes[0]!
      r.pose.throttle = t < 1 ? 0.15 : t < 2 ? 0.15 + 0.85 * (t - 1) : 1
      r.pose.burner = t > 1.55 && t < 4.4 ? 1 : 0
      const flying = t > 4.4
      if (t > 2) speed = flying ? speed + 3 * dt : 38 * (t - 2)
      z -= speed * dt
      r.pose.z = z
      if (flying) r.pose.y += 6 * dt
      const tp = r.tuple
      tp[0] = Math.round(t * 20) / 20
      tp[1] = flying ? 1 : 0
      // Mode 0 carries the ship-local catapult z (bow = -z world here, so negate).
      tp[2] = -z
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

const SCENES: Record<string, () => Scene> = {
  montage,
  "exterior-ramp": () => ramp("hornet", "chase"),
  "cockpit-ramp": () => ramp("hornet", "cockpit"),
  "f35-exterior-ramp": () => ramp("f35", "chase"),
  flyby: () => flyby(false),
  "flyby-burner": () => flyby(true),
  "flyby-crack": headOn,
  "flyby-distant": () => flyby(false, 120, 90),
  catapult,
  "catapult-deck": catapultDeck,
  trap,
  calib,
  gun,
  "weather-medium": () => weather("medium"),
  "weather-heavy": () => weather("heavy"),
  "mix-chase": mixChase,
  explosions,
}

async function renderScene(name: string, base: string): Promise<{ wav: string; peak: number; rms: number; loaded: number }> {
  const scene = SCENES[name]!()
  const ctx = new OfflineAudioContext(2, Math.ceil(scene.dur * RATE), RATE)
  // The game's shared mixer, rebuilt on this context (weapon and weather audio find it there too).
  const mx = mixer()
  mx.levels = { ...DEFAULT_LEVELS }
  mx.muted = false
  mx.samplesOn = scene.samples !== false
  mx.rain = 0
  mx.sea = 0
  const bank = sfx(mx)
  mx.use(ctx)
  // The sound bank's picked takes (decoded once; buffers are reused across renders).
  await bank.boot(base)
  const jets = new JetAudio(mx, false)
  const sim = new Sim()
  scene.setup?.(sim)
  let t = 0
  const feed = () => {
    scene.step(sim, t, STEP)
    jets.own(sim.own, sim.pose)
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
  const out = new DataView(new ArrayBuffer(44 + n * 4))
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  str(0, "RIFF")
  out.setUint32(4, 36 + n * 4, true)
  str(8, "WAVEfmt ")
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 2, true)
  out.setUint32(24, RATE, true)
  out.setUint32(28, RATE * 4, true)
  out.setUint16(32, 4, true)
  out.setUint16(34, 16, true)
  str(36, "data")
  out.setUint32(40, n * 4, true)
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i]!)) * 32767, true)
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i]!)) * 32767, true)
  }
  const bytes = new Uint8Array(out.buffer)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { wav: btoa(bin), peak, rms: Math.sqrt(sum / (2 * n)), loaded: bank.loaded }
}

Object.assign(globalThis, { renderScene, scenes: Object.keys(SCENES) })
