import { LANDING } from "../../shared/landing"
import { LAUNCH, STROKE } from "../../shared/launch"
import type { PlaneTuple } from "../../shared/protocol"
import type { VehicleKind } from "../../shared/vehicles"
import type { PlaneDrawPose } from "../render/plane-pass"
import { type BoomKind, boomsFor } from "./jet-boom"
import { CatapultVoice } from "./jet-catapult"
import { CockpitBed } from "./jet-cockpit"
import { JetVoice, makeVoiceInput } from "./jet-engine"
import {
  type Approach,
  FlybyWatch,
  VelocityTracker,
  airCutoff,
  clamp,
  closestApproach,
  distanceGain,
  dopplerRatio,
  ease,
  jetCone,
  makeApproach,
  makeCone,
  makeFlybyPlan,
  rpmFor,
  smoothstep,
  spoolStep,
} from "./jet-math"
import { type FlybyHandle, JetSfx, type Where } from "./jet-sfx"
import { type Mixer, mixer as sharedMixer } from "./mixer"
import { type SfxBank, sfx } from "./sfx-bank"
import { ShipAudio, type ShipLike } from "./ship-audio"
import { UiAudio } from "./ui-audio"

/** Your own jet as the flight module has it (src/flight/flight.ts `Flight` satisfies this). */
export type OwnJet = {
  readonly phase: string
  readonly vehicle: VehicleKind
  readonly draw: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vy: number; vz: number; throttle: number; boosting: number; stall: number; g: number; brake: number }
  readonly plane: { crashed: string }
  readonly launch: { phase: string; progress?: number } | null
  readonly landing: { phase: string } | null
  readonly cam: { mode: string; readonly feel?: { readonly strain: number } }
}

/** Live tuning (the AUDIO debug tab). */
export const JET_TUNE = {
  /** Doppler exponent: 1 physical, 0 none. */
  doppler: 0.7,
  /** Flyby take level, and how far a jet's own engine voice dips under its flyby take at the pass. */
  flyby: 0.65,
  flybyDuck: 0.9,
  /** One-shot level. */
  sfx: 1,
}

/** Engine voices at once (your jet first, then the loudest), and how many may be built in one frame. */
const VOICES = 6
const NEW_PER_FRAME = 2
/** Engine loudness: full level inside ENGINE_REF metres, then a gentle inverse-distance rolloff (jets carry). */
const ENGINE_REF = 60
const ENGINE_ROLLOFF = 0.7
/** One-shot reference distance (m). */
const SHOT_REF = 55
const OWN = -1
const TEST = -100

type Track = {
  id: number
  kind: VehicleKind
  /** Frame stamp of the last feed. */
  seen: number
  /** 0 deck, 1 flying, 2 crashed, 3 landing (the relay's modes; your own jet mapped onto them). */
  mode: number
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
  throttle: number
  boost: number
  burner: number
  /** The afterburner as last seen (its lighting is an event). */
  lit: number
  rpm: number
  doppler: number
  fresh: boolean
  /** The throttle as heard: the sim's, smoothed (no filter jumps when it changes). */
  thrA: number
  /** Seconds since launchStart (-1: not launching), progress 0..1 along the stroke, and its catapult voice. */
  launchT: number
  progress: number
  catStart: boolean
  catEnd: boolean
  cat: CatapultVoice | null
  score: number
  voice: JetVoice | null
  watch: FlybyWatch
  /** Closest approach of the pass in progress (audio time), for the engine duck. */
  passAt: number
  // Remote event detection: the newest relayed sample's time, the catapult / landing z, and one-shot latches.
  snapT: number
  localZ: number
  launched: boolean
  trapped: boolean
  crashKey: number
}

type JetEvent = { type: "burner" | "trap" | "crash"; own: boolean; x: number; y: number; z: number; water: boolean }

/**
 * Every jet's sound. The flight module feeds it each frame (`own`, `remote`, `crash`, then `frame` with the camera):
 * a procedural engine voice for your jet and the loudest others (jet-engine.ts), placed in listener space with
 * distance, air absorption, Doppler and the engine's directional cone; recorded flyby takes lined up with each close
 * pass (jet-sfx.ts); the catapult shot, the trap and crashes as one-shots; and the cockpit (jet-cockpit.ts).
 * Your own engine is exterior in the chase view and a muffled interior mix in the cockpit, where the world bus closes
 * behind the canopy too. Allocation-free per frame apart from new voices and one-shots.
 */
export class JetAudio {
  readonly sfx: JetSfx
  /** The sound bank (sfx-bank.ts), for scripts and the console. */
  readonly bank: SfxBank
  private bed: CockpitBed | null = null
  private tracks = new Map<number, Track>()
  private order: Track[] = []
  private dying: JetVoice[] = []
  private cats: CatapultVoice[] = []
  private testCat: { voice: CatapultVoice; t: number } | null = null
  /** The carriers near the camera (fed by `ships`), and the interface sounds. */
  readonly shipAudio: ShipAudio
  private shipList: [number, ShipLike][] = []
  private flybys: FlybyHandle[] = []
  private events: JetEvent[] = []
  private eventPool: JetEvent[] = []
  private frameNo = 0
  private listenerV = new VelocityTracker()
  private eye = [0, 0, 0]
  private right = [1, 0, 0]
  private up = [0, 1, 0]
  private fwd = [0, 0, -1]
  private interior = 0
  private cone = makeCone()
  private approach: Approach = makeApproach()
  private plan = makeFlybyPlan()
  private input = makeVoiceInput()
  private where = { x: 0, y: 0, z: 0 }
  private lastFrame = 0
  // Your own jet's previous state, for its events.
  private ownPhase = ""
  private ownLaunch = ""
  private ownLanding = ""
  private ownCockpit = { interior: 0, flying: false, speed: 0, g: 1, stall: 0, brake: 0, strain: 0 }
  private ownSeen = false
  private test: { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; burner: boolean } | null = null

  constructor(
    readonly mixer: Mixer = sharedMixer(),
    /** A wall-clock watchdog fades every engine when frames stop (menus, the world not built yet). */
    watchdog = true,
  ) {
    this.sfx = new JetSfx(this.mixer)
    // The sound bank loads its picked takes once the context starts.
    this.bank = sfx(this.mixer)
    this.shipAudio = new ShipAudio(this.mixer)
    if (watchdog) new UiAudio(this.mixer)
    // Registers the recorded explosions to load when the context starts.
    boomsFor(this.mixer)
    if (watchdog && typeof window !== "undefined")
      setInterval(() => {
        if (performance.now() - this.lastFrame > 600) this.silence()
      }, 300)
  }

  /** Engine voices playing, passes in flight, jets tracked. */
  get stats(): { voices: number; flybys: number; jets: number } {
    let v = 0
    for (const t of this.tracks.values()) if (t.voice) v++
    return { voices: v, flybys: this.flybys.length, jets: this.tracks.size }
  }

  private track(id: number, kind: VehicleKind): Track {
    let t = this.tracks.get(id)
    if (!t) {
      t = {
        id,
        kind,
        seen: -1,
        mode: 1,
        x: 0,
        y: 0,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        throttle: 0,
        boost: 0,
        burner: 0,
        lit: 0,
        rpm: 0.64,
        doppler: 1,
        fresh: true,
        thrA: 0,
        launchT: -1,
        progress: 0,
        catStart: false,
        catEnd: false,
        cat: null,
        score: 0,
        voice: null,
        watch: new FlybyWatch(),
        passAt: Number.NEGATIVE_INFINITY,
        snapT: Number.NEGATIVE_INFINITY,
        localZ: 0,
        launched: false,
        trapped: false,
        crashKey: Number.NaN,
      }
      this.tracks.set(id, t)
    }
    if (t.kind !== kind && t.voice) {
      t.voice.release()
      this.dying.push(t.voice)
      t.voice = null
    }
    t.kind = kind
    return t
  }

  private event(type: JetEvent["type"], own: boolean, x: number, y: number, z: number, water = false): void {
    if (this.events.length > 16) return
    const e = this.eventPool.pop() ?? { type, own, x, y, z, water }
    e.type = type
    e.own = own
    e.x = x
    e.y = y
    e.z = z
    e.water = water
    this.events.push(e)
  }

  /** Your own jet this frame (null when you are not in one). */
  own(f: OwnJet | null): void {
    if (!f || f.phase === "idle") {
      this.ownSeen = false
      this.ownPhase = ""
      this.ownLaunch = ""
      this.ownLanding = ""
      return
    }
    const p = f.draw
    const phase = f.phase
    const crashed = phase === "crashed"
    const t = this.track(OWN, f.vehicle)
    t.seen = crashed ? t.seen : this.frameNo
    t.mode = phase === "flying" ? 1 : phase === "landing" ? 3 : crashed ? 2 : 0
    t.x = p.x
    t.y = p.y
    t.z = p.z
    t.qx = p.qx
    t.qy = p.qy
    t.qz = p.qz
    t.qw = p.qw
    t.vx = p.vx
    t.vy = p.vy
    t.vz = p.vz
    t.throttle = p.throttle
    t.boost = p.boosting > 0 ? 1 : 0
    this.ownSeen = !crashed

    // Events from phase changes.
    const lp = f.launch?.phase ?? ""
    // launchStart (shared/launch.ts: ready → stroke): the engine surges from idle and the catapult voice starts;
    // launchEnd (stroke → off the bow): the catapult's rush lets go.
    if (phase === "launching" && lp === "stroke" && this.ownLaunch !== "stroke") this.launchStart(t)
    t.progress = f.launch?.progress ?? t.progress
    if (this.ownLaunch === "stroke" && lp !== "stroke") t.catEnd = true
    const ld = f.landing?.phase ?? ""
    if (phase === "landing" && this.ownLanding === "approach" && ld === "trap") this.event("trap", true, p.x, p.y, p.z)
    if (crashed && this.ownPhase !== "crashed" && this.ownPhase !== "" && f.plane.crashed !== "shot" && f.plane.crashed !== "lost") this.event("crash", true, p.x, p.y, p.z, f.plane.crashed === "sea")
    this.ownPhase = phase
    this.ownLaunch = lp
    this.ownLanding = ld

    const c = this.ownCockpit
    c.interior = f.cam.mode === "cockpit" && !crashed ? 1 : 0
    c.flying = phase === "flying" || phase === "landing"
    c.speed = Math.hypot(p.vx, p.vy, p.vz)
    c.g = p.g
    c.stall = p.stall
    c.brake = p.brake
    c.strain = crashed ? 0 : (f.cam.feel?.strain ?? 0)
  }

  /** launchStart: the engine surges (a fast launch spool, the afterburner lighting 0.3 s in) and the catapult starts. */
  private launchStart(t: Track): void {
    t.launchT = 0
    t.progress = 0
    t.catStart = true
  }

  /** Another player's jet this frame: its draw pose and newest relayed tuple (shared/protocol.ts PlaneTuple). */
  remote(id: number, pose: PlaneDrawPose, tuple: PlaneTuple): void {
    const t = this.track(id, pose.kind ?? "hornet")
    t.seen = this.frameNo
    t.x = pose.x
    t.y = pose.y
    t.z = pose.z
    t.qx = pose.qx
    t.qy = pose.qy
    t.qz = pose.qz
    t.qw = pose.qw
    t.vx = tuple[9]
    t.vy = tuple[10]
    t.vz = tuple[11]
    t.throttle = pose.throttle
    t.boost = pose.burner > 0.5 ? 1 : 0
    const mode = tuple[1]
    // launchStart as drawn: on the deck the throttle jumps from idle to full the instant the stroke begins.
    if (mode === 0 && pose.throttle >= 0.985 && !t.launched) {
      t.launched = true
      this.launchStart(t)
    }
    if (t.launched && mode === 0) t.progress = clamp((tuple[2] - LAUNCH.startZ) / STROKE, 0, 1)
    if (t.cat && mode !== 0) t.catEnd = true
    // A new relayed sample: traps (mode 3 crossing the wires).
    if (tuple[0] !== t.snapT) {
      const z = mode === 0 ? tuple[2] : mode === 3 ? tuple[4] : 0
      if (mode === 3 && t.mode === 3 && !t.trapped && t.localZ < LANDING.touchZ && z >= LANDING.touchZ) {
        t.trapped = true
        this.event("trap", false, pose.x, pose.y, pose.z)
      }
      if (mode !== 0) t.launched = false
      if (mode !== 3) t.trapped = false
      t.localZ = z
      t.snapT = tuple[0]
      t.mode = mode
    }
  }

  /** A remote jet that crashed (not shot down: that one already has its explosion), `age` seconds ago. */
  crash(id: number, x: number, y: number, z: number, age: number, water: boolean): void {
    const t = this.tracks.get(id)
    const key = x * 31 + z
    if (!t || t.crashKey === key || age > 0.6) return
    t.crashKey = key
    this.event("crash", false, x, y, z, water)
  }

  /** Every carrier as drawn this frame, by id (for the deck ambience, hull slams and creaks: ship-audio.ts). */
  ships(list: Iterable<[number, ShipLike]>): void {
    this.shipList.length = 0
    for (const e of list) this.shipList.push(e)
  }

  /** Flies a test jet past the camera (the debug tab): 220 m/s, 40 m off, from 900 m ahead. */
  testFlyby(burner = false): void {
    const [ex, ey, ez] = this.eye as [number, number, number]
    const f = this.fwd
    const r = this.right
    const fx = f[0]!
    const fz = f[2]!
    const l = Math.hypot(fx, fz) || 1
    const speed = burner ? 250 : 210
    this.test = {
      t: 0,
      x: ex + (fx / l) * 900 + r[0]! * 40,
      y: ey + 18,
      z: ez + (fz / l) * 900 + r[2]! * 40,
      vx: (-fx / l) * speed,
      vy: 0,
      vz: (-fz / l) * speed,
      burner,
    }
  }

  /** An explosion of `kind` 60 m ahead, or 2.5 km away (the debug tab). */
  testBoom(kind: BoomKind, far = false): void {
    if (!boomsFor(this.mixer).play(kind, far ? 2500 : 60, kind === "missile" ? 1 : 1.5, { bus: "weapons" }))
      this.sfx.crash(kind.endsWith("water") || kind.endsWith("sea"), far ? 0.05 : 0.9, { delay: far ? 2.5 : 0.17 })
  }

  /** Plays an event in front of the camera (the debug tab). */
  /** A catapult stroke in front of the camera (the debug tab): 4.2 s, then released. */
  testLaunch(): void {
    if (!this.mixer.ctx) return
    const voice = new CatapultVoice(this.mixer, null, 0)
    this.cats.push(voice)
    this.testCat = { voice, t: 0 }
  }

  testEvent(type: JetEvent["type"]): void {
    const [ex, ey, ez] = this.eye as [number, number, number]
    const f = this.fwd
    this.event(type, false, ex + f[0]! * 30, ey + f[1]! * 30 - 3, ez + f[2]! * 30, true)
  }

  /** Per frame, after the jets are fed: the listener (camera eye, forward, up), voices, passes, events, cockpit. */
  frame(dt: number, eye: ArrayLike<number>, forward: ArrayLike<number>, up: ArrayLike<number>): void {
    this.lastFrame = typeof performance !== "undefined" ? performance.now() : 0
    const frame = this.frameNo++
    const m = this.mixer
    const ctx = m.ctx
    if (!ctx) {
      this.events.length = 0
      return
    }
    const now = ctx.currentTime
    // Listener basis: right = forward × up.
    const ex = (this.eye[0] = eye[0]!)
    const ey = (this.eye[1] = eye[1]!)
    const ez = (this.eye[2] = eye[2]!)
    const fx = (this.fwd[0] = forward[0]!)
    const fy = (this.fwd[1] = forward[1]!)
    const fz = (this.fwd[2] = forward[2]!)
    const ux0 = up[0]!
    const uy0 = up[1]!
    const uz0 = up[2]!
    let rx = fy * uz0 - fz * uy0
    let ry = fz * ux0 - fx * uz0
    let rz = fx * uy0 - fy * ux0
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl
    ry /= rl
    rz /= rl
    this.right[0] = rx
    this.right[1] = ry
    this.right[2] = rz
    // Re-orthogonalised up = right × forward.
    const ux = (this.up[0] = ry * fz - rz * fy)
    const uy = (this.up[1] = rz * fx - rx * fz)
    const uz = (this.up[2] = rx * fy - ry * fx)
    const lv = this.listenerV
    lv.update(ex, ey, ez, dt)
    // The shared listener (sfx-bank.ts places world sounds with it).
    const L = m.listener
    L.eye[0] = ex
    L.eye[1] = ey
    L.eye[2] = ez
    L.right[0] = rx
    L.right[1] = ry
    L.right[2] = rz
    L.up[0] = ux
    L.up[1] = uy
    L.up[2] = uz
    L.fwd[0] = fx
    L.fwd[1] = fy
    L.fwd[2] = fz
    L.vel[0] = lv.x
    L.vel[1] = lv.y
    L.vel[2] = lv.z

    // Cockpit muffle on the world.
    const inCockpit = this.ownSeen && this.ownCockpit.interior > 0.5
    // A fresh jet starts in its view; switching views crossfades.
    const fresh = this.tracks.get(OWN)?.fresh ?? false
    this.interior += ((inCockpit ? 1 : 0) - this.interior) * (fresh ? 1 : ease(dt, 0.2))
    m.setCockpit(this.interior)

    // The test jet.
    const test = this.test
    if (test) {
      test.t += dt
      test.x += test.vx * dt
      test.y += test.vy * dt
      test.z += test.vz * dt
      const t = this.track(TEST, "hornet")
      t.seen = frame
      t.mode = 1
      t.x = test.x
      t.y = test.y
      t.z = test.z
      const yaw = Math.atan2(test.vx, test.vz)
      t.qx = 0
      t.qy = Math.sin(yaw / 2)
      t.qz = 0
      t.qw = Math.cos(yaw / 2)
      t.vx = test.vx
      t.vy = test.vy
      t.vz = test.vz
      t.throttle = test.burner ? 1 : 0.85
      t.boost = test.burner ? 1 : 0
      if (test.t > 10) this.test = null
    }

    const local = (x: number, y: number, z: number): Where => {
      const dx = x - ex
      const dy = y - ey
      const dz = z - ez
      const w = this.where
      w.x = dx * rx + dy * ry + dz * rz
      w.y = dx * ux + dy * uy + dz * uz
      w.z = -(dx * fx + dy * fy + dz * fz)
      return w
    }

    // Each jet: spool, Doppler, cone, loudness; passes.
    const order = this.order
    order.length = 0
    const muted = m.muted
    for (const t of this.tracks.values()) {
      if (t.seen !== frame) continue
      const own = t.id === OWN
      // The launch surge: idle to full in ~0.7 s with the afterburner lighting 0.3 s in; otherwise the normal spool.
      const launching = t.launchT >= 0
      if (launching) t.launchT = t.launchT + dt > 2 ? -1 : t.launchT + dt
      const boost = launching && t.launchT < 0.3 ? 0 : t.boost
      if (t.fresh) {
        t.rpm = rpmFor(t.throttle)
        t.thrA = t.throttle
      } else if (launching) {
        t.rpm += (rpmFor(t.throttle) - t.rpm) * ease(dt, 0.25)
        t.thrA += (t.throttle - t.thrA) * ease(dt, 0.22)
      } else {
        t.rpm = spoolStep(t.rpm, rpmFor(t.throttle), dt)
        t.thrA += (t.throttle - t.thrA) * ease(dt, 0.3)
      }
      t.burner += (boost - t.burner) * ease(dt, boost > t.burner ? 0.18 : 0.4)
      // The afterburner lighting: a soft thump and a swell of roar.
      if (t.boost > 0.5 && t.lit < 0.5 && !t.fresh && t.mode === 1) this.event("burner", own, t.x, t.y, t.z)
      t.lit = t.boost
      const dx = t.x - ex
      const dy = t.y - ey
      const dz = t.z - ez
      const d = Math.hypot(dx, dy, dz)
      const rvx = t.vx - lv.x
      const rvy = t.vy - lv.y
      const rvz = t.vz - lv.z
      // Your own jet never shifts: the camera rides with it (chase or cockpit), so its perspective stays steady.
      const dop = own ? 1 : dopplerRatio(dx, dy, dz, rvx, rvy, rvz, JET_TUNE.doppler)
      t.doppler = t.fresh ? dop : t.doppler + (dop - t.doppler) * ease(dt, 0.12)
      t.fresh = false
      t.score = own ? Number.POSITIVE_INFINITY : distanceGain(d, ENGINE_REF, ENGINE_ROLLOFF) * (0.45 + 0.55 * t.throttle + 0.5 * t.burner) * (t.voice ? 1.3 : 1)
      if (!muted && (own || t.score > 0.01)) order.push(t)
      // The catapult: one live voice from launchStart, following the stroke, released at launchEnd.
      if (t.catStart && !muted) {
        t.catStart = false
        t.cat?.release()
        const head = own && inCockpit
        t.cat = new CatapultVoice(m, head ? null : { ...local(t.x, t.y, t.z)! }, head ? 0 : d)
        this.cats.push(t.cat)
      }
      if (t.cat) {
        if (t.catEnd || t.progress >= 1) {
          t.cat.release()
          t.cat = null
        } else t.cat.update(t.progress, own && inCockpit ? null : local(t.x, t.y, t.z), d)
      }
      t.catEnd = false
      // A close pass coming up: line a flyby take up with it.
      if (!own && (t.mode === 1 || t.mode === 3)) {
        const a = closestApproach(dx, dy, dz, rvx, rvy, rvz, this.approach)
        const plan = t.watch.check(now, a, t.burner > 0.5, this.plan)
        if (plan && !muted) {
          const rate = clamp(0.94 + (plan.speed - 150) / 1500, 0.9, 1.08)
          const h = this.sfx.flyby(t.id, plan.kind, plan.t, plan.gain * JET_TUNE.flyby, rate, local(t.x, t.y, t.z))
          if (h) {
            if (this.flybys.length > 3) this.flybys.shift()
            this.flybys.push(h)
            t.passAt = now + plan.t
            if (plan.kind !== "high") m.duck(0.85, 0.8, Math.max(0, plan.t - 0.3), true)
          }
          if (plan.boom) this.sfx.boom(0.7 * JET_TUNE.sfx, { at: local(t.x, t.y, t.z), delay: plan.t, bus: "flyby" })
        }
      }
    }

    for (let i = this.cats.length - 1; i >= 0; i--) {
      const c = this.cats[i]!
      c.tick()
      if (c.done) this.cats.splice(i, 1)
    }
    if (this.testCat) {
      this.testCat.t += dt
      const p = Math.min(1, (this.testCat.t / 4.2) ** 2)
      this.testCat.voice.update(p, null, 0)
      if (p >= 1) {
        this.testCat.voice.release()
        this.testCat = null
      }
    }

    // Voices for your jet and the loudest others.
    order.sort((a, b) => b.score - a.score)
    let built = 0
    for (let i = 0; i < order.length; i++) {
      const t = order[i]!
      if (i >= VOICES) {
        this.drop(t)
        continue
      }
      if (!t.voice) {
        if (built >= NEW_PER_FRAME) continue
        t.voice = new JetVoice(m, t.kind, t.id !== OWN, t.id === OWN)
        built++
      }
      this.feed(t, local, now)
    }
    for (const t of this.tracks.values()) {
      if (t.seen !== frame || muted) this.drop(t)
      // A jet gone mid-stroke (crashed, left): its catapult lets go.
      if (t.seen !== frame && t.cat) {
        t.cat.release()
        t.cat = null
      }
      if (frame - t.seen > 120 && t.id !== OWN) this.tracks.delete(t.id)
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i]!
      if (now >= v.stopAt) {
        v.dispose()
        this.dying.splice(i, 1)
      }
    }

    // Passes in flight follow their jets.
    for (let i = this.flybys.length - 1; i >= 0; i--) {
      const h = this.flybys[i]!
      if (now > h.end) {
        this.flybys.splice(i, 1)
        continue
      }
      const t = this.tracks.get(h.id)
      if (!t || t.seen !== frame) continue
      h.move(local(t.x, t.y, t.z)!)
    }

    // One-shots.
    for (const e of this.events) {
      if (!muted) this.play(e, local)
      this.eventPool.push(e)
    }
    this.events.length = 0

    // The carriers around the camera.
    this.shipAudio.update(dt, this.shipList)

    // The air around your jet.
    if (!this.bed) this.bed = new CockpitBed(m)
    this.bed.update(dt, this.ownSeen && !muted ? this.ownCockpit : null)
  }

  private feed(t: Track, local: (x: number, y: number, z: number) => Where, now: number): void {
    const s = this.input
    const own = t.id === OWN
    const w = local(t.x, t.y, t.z)!
    const d = Math.hypot(w.x, w.y, w.z)
    // Nose = body +Z through the jet's orientation; listener direction = from the jet to the eye.
    const { qx, qy, qz, qw } = t
    const nx = 2 * (qx * qz + qw * qy)
    const ny = 2 * (qy * qz - qw * qx)
    const nz = 1 - 2 * (qx * qx + qy * qy)
    const inv = d > 1e-3 ? 1 / d : 0
    jetCone(nx, ny, nz, (this.eye[0]! - t.x) * inv, (this.eye[1]! - t.y) * inv, (this.eye[2]! - t.z) * inv, this.cone)
    const interior = own ? this.interior : 0
    s.rpm = t.rpm
    s.throttle = t.thrA
    s.burner = t.burner
    s.doppler = t.doppler
    // Inside, the cone means nothing: both ends of the engine reach you through the airframe.
    // Your own jet keeps one steady perspective (from behind, as the chase camera hears it; through the airframe in
    // the cockpit) whatever the camera's angle; other jets get the cone.
    s.front = own ? (interior > 0.5 ? 0.3 : 0.35) : this.cone.front
    s.rear = own ? 1 : this.cone.rear
    s.level = own ? 1 : this.cone.level
    // The engine voice dips under its flyby take around the pass.
    const pass = now - t.passAt
    const duck = 1 - (1 - JET_TUNE.flybyDuck) * Math.exp(-((pass / 1.3) ** 2))
    s.gain = (interior > 0.5 ? 1 : distanceGain(d, ENGINE_REF, ENGINE_ROLLOFF)) * duck
    s.cutoff = own ? 20000 : airCutoff(d)
    s.x = w.x
    s.y = w.y
    s.z = w.z
    s.interior = interior
    s.far = smoothstep(ENGINE_REF * 2, 2500, d)
    t.voice!.update(s)
  }

  private drop(t: Track): void {
    if (!t.voice) return
    t.voice.release()
    this.dying.push(t.voice)
    t.voice = null
  }

  private play(e: JetEvent, local: (x: number, y: number, z: number) => Where): void {
    const s = this.sfx
    const head = e.own && this.interior > 0.5
    const w = local(e.x, e.y, e.z)!
    const d = head ? 0 : Math.hypot(w.x, w.y, w.z)
    const g = (head ? 1 : distanceGain(d, SHOT_REF)) * JET_TUNE.sfx
    if (g < 0.004) return
    const o = { at: head ? null : { x: w.x, y: w.y, z: w.z }, cutoff: head ? 20000 : airCutoff(d), bus: "sfx" as const }
    switch (e.type) {
      case "burner":
        s.burnerLight(g * 0.15, o)
        break
      case "trap":
        s.trap(g, o)
        break
      case "crash": {
        // The recorded crash for the surface (jet-boom.ts), else the procedural one.
        const pan = head || d < 1 ? 0 : clamp(w.x / d, -1, 1) * 0.8
        if (!boomsFor(this.mixer).play(e.water ? "crash-sea" : "crash-land", d, 1.2, { bus: "sfx", pan, delay: head ? 0 : undefined }))
          s.crash(e.water, g, { ...o, delay: head ? 0 : Math.min(2.5, d / 343) })
        break
      }
    }
  }

  /** Fades every engine and the cockpit (frames stopped). */
  private silence(): void {
    for (const t of this.tracks.values()) this.drop(t)
    this.ownSeen = false
    if (this.mixer.ctx) {
      const now = this.mixer.ctx.currentTime
      for (let i = this.dying.length - 1; i >= 0; i--)
        if (now >= this.dying[i]!.stopAt) {
          this.dying[i]!.dispose()
          this.dying.splice(i, 1)
        }
      this.bed?.update(0.3, null)
      this.mixer.setCockpit(0)
    }
  }
}
