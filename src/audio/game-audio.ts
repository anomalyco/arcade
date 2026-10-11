import type { Input } from "../../shared/sim/vehicle"
import type { CarView, SimEvent, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"
import { audio, type AudioEngine, type SfxName } from "./audio"

export type AudioContextInfo = {
  myId: string
  cam: Camera
  dt: number
  events: SimEvent[]
  /** The local player's controls this frame (throttle drives the engine load). */
  input?: Input
}

type Car = CarView

const ENGINE_VOICES = 4
const SIREN_HEAR = 260
const SIREN_VOICES = 4
/** Beyond this, other cars are inaudible. */
const HEAR = 150
/** The camera hangs well above the street, so nothing is ever closer than this. */
const EAR_HEIGHT = 16
/** Speed of sound for doppler, lowered a little so passes read clearly from the high camera. */
const SOUND = 260
/** Gear bands (m/s) for the engine note. */
const GEARS = [0, 9, 17, 26, 35, 46, 80]
/** Siren switches to yelp inside this distance of the driver. */
const YELP_IN = 34
const YELP_OUT = 46

type CarState = {
  seen: number
  speed: number
  boost: number
  impact: number
  drift: number
  rpm: number
  load: number
  impactCool: number
  nitroCool: number
  skidCool: number
  /** Own car: the tires are in a real slide (hysteresis, so the squeal doesn't flicker at the threshold). */
  sliding: boolean
  /** Own car: nitro firing, seconds since it lit, and a smoothed 0..1 amount for the engine lift. */
  boosting: boolean
  boostT: number
  boostAmt: number
  yelp: boolean
  /** Siren phase offset so a pack of cruisers doesn't wail in unison. */
  sirenOffset: number
}

/** A continuously running loop: source -> low-pass -> gain -> pan -> bus, plus a reverb send. */
class LoopVoice {
  carId = -1
  buf: AudioBuffer | null = null
  src: AudioBufferSourceNode | null = null
  filter: BiquadFilterNode
  gain: GainNode
  pan: StereoPannerNode
  send: GainNode
  active = false
  /** Where sources connect: the low-pass, or the head of an EQ chain set with `eq`. */
  private input: AudioNode

  constructor(
    private a: AudioEngine,
    out: AudioNode,
  ) {
    const ctx = a.ctx!
    this.filter = ctx.createBiquadFilter()
    this.filter.type = "lowpass"
    this.filter.frequency.value = 18000
    this.input = this.filter
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.pan = ctx.createStereoPanner()
    this.send = ctx.createGain()
    this.send.gain.value = 0
    this.filter.connect(this.gain)
    this.gain.connect(this.pan)
    this.pan.connect(out)
    this.pan.connect(this.send)
    this.send.connect(a.verb)
  }

  /** Fixed EQ bands ahead of the low-pass; call before `use`. */
  eq(...bands: [type: BiquadFilterType, freq: number, gain: number, q: number][]) {
    let next: AudioNode = this.filter
    for (const [type, freq, gain, q] of bands.reverse()) {
      const f = this.a.ctx!.createBiquadFilter()
      f.type = type
      f.frequency.value = freq
      f.gain.value = gain
      f.Q.value = q
      f.connect(next)
      next = f
    }
    this.input = next
    return this
  }

  /** Swaps the sample; only restarts the source when it actually changes. */
  use(buf: AudioBuffer | undefined, offset = Math.random()) {
    if (!buf || buf === this.buf) return
    const ctx = this.a.ctx!
    if (this.src) {
      const old = this.src
      old.stop(ctx.currentTime + 0.05)
      old.onended = () => old.disconnect()
    }
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.connect(this.input)
    s.start(ctx.currentTime, offset * buf.duration)
    this.src = s
    this.buf = buf
  }

  set(gain: number, rate: number, pan: number, cutoff: number, wet: number, tau = 0.06) {
    const t = this.a.now
    this.gain.gain.setTargetAtTime(gain, t, tau)
    if (this.src) this.src.playbackRate.setTargetAtTime(rate, t, tau)
    this.pan.pan.setTargetAtTime(pan, t, tau)
    this.filter.frequency.setTargetAtTime(cutoff, t, tau)
    this.send.gain.setTargetAtTime(wet, t, 0.2)
  }

  silence(tau = 0.08) {
    this.gain.gain.setTargetAtTime(0, this.a.now, tau)
    this.send.gain.setTargetAtTime(0, this.a.now, tau)
    this.active = false
    this.carId = -1
  }
}

/** Two loops (wail and yelp) crossfaded into one spatial chain. */
class SirenVoice {
  carId = -1
  wail: AudioBufferSourceNode
  yelp: AudioBufferSourceNode
  wailGain: GainNode
  yelpGain: GainNode
  out: LoopVoice
  private started = false

  constructor(
    private a: AudioEngine,
    bus: AudioNode,
  ) {
    const ctx = a.ctx!
    this.out = new LoopVoice(a, bus)
    this.wail = ctx.createBufferSource()
    this.yelp = ctx.createBufferSource()
    this.wailGain = ctx.createGain()
    this.yelpGain = ctx.createGain()
    this.yelpGain.gain.value = 0
    this.wail.connect(this.wailGain)
    this.yelp.connect(this.yelpGain)
    this.wailGain.connect(this.out.filter)
    this.yelpGain.connect(this.out.filter)
  }

  start() {
    if (this.started) return
    const w = this.a.buffer("siren_wail_loop")
    const y = this.a.buffer("siren_yelp_loop")
    if (!w || !y) return
    this.wail.buffer = w
    this.yelp.buffer = y
    this.wail.loop = this.yelp.loop = true
    const t = this.a.now
    this.wail.start(t, Math.random() * w.duration)
    this.yelp.start(t, Math.random() * y.duration)
    this.started = true
  }

  set(gain: number, rate: number, pan: number, cutoff: number, wet: number, yelp: boolean) {
    const t = this.a.now
    this.wailGain.gain.setTargetAtTime(yelp ? 0 : 1, t, 0.12)
    this.yelpGain.gain.setTargetAtTime(yelp ? 1 : 0, t, 0.12)
    this.wail.playbackRate.setTargetAtTime(rate, t, 0.08)
    this.yelp.playbackRate.setTargetAtTime(rate, t, 0.08)
    this.out.set(gain, 1, pan, cutoff, wet)
  }
}

function byId(cars: Car[], id: number): Car | undefined {
  for (const c of cars) if (c.id === id) return c
  return undefined
}

type Spatial = { gain: number; pan: number; cutoff: number; wet: number; dist: number }

/**
 * Turns the world view into sound every frame: the player's own car up close and unpanned, other cars, sirens and the
 * helicopter placed around the camera focus, the city bed underneath, and stingers on round events.
 */
export class GameAudio {
  private a = audio
  private built = false
  private states = new Map<number, CarState>()
  private frame = 0
  // Own car.
  private engine!: LoopVoice
  private screech!: LoopVoice
  private scrub!: LoopVoice
  private rush!: LoopVoice
  private flat!: LoopVoice
  private scrape!: LoopVoice
  private ownSiren!: SirenVoice
  // World.
  private engines: LoopVoice[] = []
  private sirens: SirenVoice[] = []
  private heli!: LoopVoice
  private ambience!: LoopVoice
  private candidates: Car[] = []
  private dists = new Map<number, number>()
  private byDist = (p: Car, q: Car) => this.dists.get(p.id)! - this.dists.get(q.id)!
  private scrapeT = 0
  private heliX = 0
  private heliZ = 0
  private heliVX = 0
  private heliVZ = 0
  private heliOn = false
  private phase = ""
  private round = -1
  private stingRound = -1
  private bustRound = -1
  private recordRound = -1
  private startBest = 0
  private beatT = 0
  private lastSurvived = 0
  private endFaded = false
  private hint: HTMLElement | null = null
  private sp: Spatial = { gain: 0, pan: 0, cutoff: 18000, wet: 0, dist: 0 }
  private rx = 1
  private rz = 0
  private lx = 0
  private lz = 0
  private lvx = 0
  private lvz = 0

  constructor(hudRoot?: HTMLElement) {
    if (hudRoot) this.mountHint(hudRoot)
  }

  private build() {
    const a = this.a
    if (this.built || !a.ctx || !a.ready) return
    this.built = true
    this.engine = new LoopVoice(a, a.sfx)
    // The squeal's bite lives at 2-5 kHz: scoop it so the slide sits under the engine instead of whistling over it.
    this.screech = new LoopVoice(a, a.sfx).eq(["peaking", 3200, -6, 0.8], ["highshelf", 6000, -4, 0.7])
    this.screech.use(a.buffer("tire_screech_loop"))
    this.scrub = new LoopVoice(a, a.sfx)
    this.scrub.use(a.buffer("tire_scrub_loop"))
    this.rush = new LoopVoice(a, a.sfx)
    this.rush.use(a.buffer("nitro_rush_loop"))
    this.flat = new LoopVoice(a, a.sfx)
    this.flat.use(a.buffer("flat_tire_loop"))
    this.scrape = new LoopVoice(a, a.sfx)
    this.scrape.use(a.buffer("scrape_loop"))
    this.ownSiren = new SirenVoice(a, a.sfx)
    for (let i = 0; i < ENGINE_VOICES; i++) this.engines.push(new LoopVoice(a, a.sfx))
    for (let i = 0; i < SIREN_VOICES; i++) this.sirens.push(new SirenVoice(a, a.sfx))
    this.heli = new LoopVoice(a, a.sfx)
    this.heli.use(a.buffer("heli_rotor_loop"))
    this.ambience = new LoopVoice(a, a.amb)
    this.ambience.use(a.buffer("city_ambience_loop"))
    this.ambience.set(0.32, 1, 0, 18000, 0, 1.5)
  }

  update(view: WorldView, ctx: AudioContextInfo) {
    this.build()
    if (!this.built) return
    this.frame++
    const dt = Math.max(1e-3, ctx.dt)
    const cam = ctx.cam
    if (this.frame === 1) {
      // The camera never rotates, so its screen-right axis is fixed.
      const ax = cam.axes()
      this.rx = ax.right[0]
      this.rz = ax.right[1]
    }
    let mine: Car | null = null
    let robber: Car | null = null
    for (const c of view.cars) {
      if (c.ownerId === ctx.myId && !c.ghost) mine = c
      if (c.ownerId === view.robberId) robber = c
    }
    this.lx = cam.fx
    this.lz = cam.fz
    this.lvx = mine ? mine.vx : 0
    this.lvz = mine ? mine.vz : 0

    for (const c of view.cars) this.track(c, dt)
    this.phases(view, mine)
    this.events(view, ctx.events, mine)
    this.ownCar(view, mine, robber, ctx.input, dt)
    this.otherEngines(view, mine, dt)
    this.sirenVoices(view, mine, robber)
    this.helicopter(view, dt)
    this.tension(view, mine, dt)
    this.oneShotsFromState(view, mine)
    // Forget cars that left the view.
    if (this.frame % 60 === 0) for (const [id, s] of this.states) if (this.frame - s.seen > 60) this.states.delete(id)
  }

  private track(c: Car, dt: number) {
    let s = this.states.get(c.id)
    if (!s) {
      s = {
        seen: 0,
        speed: c.speed,
        boost: c.boost,
        impact: 0,
        drift: 0,
        rpm: 0,
        load: 0,
        impactCool: 0,
        nitroCool: 0,
        skidCool: 0,
        sliding: false,
        boosting: false,
        boostT: 0,
        boostAmt: 0,
        yelp: false,
        sirenOffset: Math.random(),
      }
      this.states.set(c.id, s)
    }
    s.seen = this.frame
    s.impactCool = Math.max(0, s.impactCool - dt)
    s.nitroCool = Math.max(0, s.nitroCool - dt)
    s.skidCool = Math.max(0, s.skidCool - dt)
  }

  /** Distance gain, screen pan, air-absorption low-pass and reverb send for a world position. */
  private spatial(x: number, z: number, y = 0, range = HEAR): Spatial {
    const dx = x - this.lx
    const dz = z - this.lz
    const flat = Math.hypot(dx, dz)
    const d = Math.hypot(flat, EAR_HEIGHT + y)
    const sp = this.sp
    sp.dist = flat
    const ref = EAR_HEIGHT + 6
    let g = d <= ref ? 1 : Math.pow(ref / d, 1.25)
    const fadeFrom = range * 0.75
    if (flat > fadeFrom) g *= Math.max(0, 1 - (flat - fadeFrom) / (range - fadeFrom))
    sp.gain = g
    sp.pan = Math.max(-1, Math.min(1, (dx * this.rx + dz * this.rz) / 38)) * 0.85
    sp.cutoff = Math.max(700, 16000 * Math.exp(-flat / 70))
    sp.wet = Math.min(0.55, 0.08 + flat / 200)
    return sp
  }

  /** Doppler ratio for a source moving at (vx, vz) relative to the listener. */
  private doppler(x: number, z: number, vx: number, vz: number) {
    const dx = x - this.lx
    const dz = z - this.lz
    const d = Math.hypot(dx, dz, EAR_HEIGHT)
    const away = ((vx - this.lvx) * dx + (vz - this.lvz) * dz) / d
    return Math.max(0.8, Math.min(1.25, SOUND / (SOUND + away)))
  }

  /** Engine note from a simulated gearbox: rpm climbs through each gear and drops on the shift. */
  private rpmFor(s: CarState, speed: number, load: number, dt: number) {
    let g = 1
    while (g < GEARS.length - 1 && speed > GEARS[g]!) g++
    const lo = GEARS[g - 1]!
    const hi = GEARS[g]!
    const frac = Math.min(1, (speed - lo) / (hi - lo))
    let rpm = g === 1 ? frac * 0.85 : 0.32 + 0.68 * frac
    // Throttle with no speed (wheelspin, pushing a wall) revs it up anyway.
    rpm = Math.max(rpm, load * 0.55) + load * 0.06
    const k = 1 - Math.exp(-dt * (rpm < s.rpm ? 9 : 5))
    s.rpm += (rpm - s.rpm) * k
    return 0.74 + 1.05 * s.rpm
  }

  private ownCar(view: WorldView, mine: Car | null, robber: Car | null, input: Input | undefined, dt: number) {
    const live = !!mine && view.phase !== "end"
    if (!mine || !live) {
      this.engine.silence(0.3)
      this.screech.silence()
      this.scrub.silence()
      this.rush.silence(0.12)
      this.flat.silence()
      this.scrape.silence()
      this.ownSiren.out.silence(0.3)
      return
    }
    const s = this.states.get(mine.id)!
    const a = this.a
    this.engine.use(a.buffer(mine.role === "cop" ? "engine_cop_loop" : "engine_robber_loop"))
    const off = !!mine.engineOff
    // Nitro fires while you hold boost with fuel left (mirrors the sim); without input, while the fuel drains.
    const boosting = !off && mine.stun <= 0 && mine.boost > 0.005 && (input ? input.boost : mine.boost < s.boost - 1e-5)
    if (boosting && !s.boosting) {
      s.boostT = 0
      if (s.nitroCool <= 0) a.play("nitro_burst", { gain: 0.75, wet: 0.08 })
      s.nitroCool = 0.4
    }
    s.boosting = boosting
    s.boostT += dt
    s.boostAmt += ((boosting ? 1 : 0) - s.boostAmt) * (1 - Math.exp(-dt * (boosting ? 10 : 4)))

    const accel = (mine.speed - s.speed) / dt
    const throttle = input ? Math.max(0, input.throttle) + (boosting ? 0.3 : 0) : Math.max(0, Math.min(1, accel / 6))
    s.load += (Math.min(1, throttle) - s.load) * (1 - Math.exp(-dt * 8))
    // Boost lifts the note and opens the tone a little on top of the extra load.
    const rate = this.rpmFor(s, mine.speed, s.load, dt) * (1 + 0.05 * s.boostAmt)
    const engGain = off ? 0 : 0.34 + 0.26 * s.load + 0.12 * Math.min(1, mine.speed / 40) + 0.05 * s.boostAmt
    const engCut = (1400 + 9000 * (0.25 + 0.75 * s.load) * (0.6 + 0.4 * s.rpm)) * (1 + 0.4 * s.boostAmt)
    this.engine.set(engGain, rate, 0, engCut, 0.05, off ? 0.25 : 0.05)

    // The rush under the kick: its low-pass opens over the first moments, it thins as the fuel runs dry, and it
    // fades (darkening) over a few hundred ms when the boost stops.
    const open = Math.min(1, s.boostT / 0.35)
    const dry = Math.min(1, 0.7 + (0.3 * mine.boost) / 0.12)
    this.rush.set(boosting ? 0.4 * dry : 0, 0.94 + 0.12 * Math.min(1, mine.speed / 45), 0, boosting ? 1600 + 8400 * open : 1600, 0.06, boosting ? 0.09 : 0.14)

    // Tires. Ordinary cornering only gets a faint, untonal rubber scrub. The squeal is reserved for real slides (the
    // handbrake, the drift state, or a lot of sideways speed), with hysteresis so it can't flicker at the threshold.
    const state = mine.slide ?? 0
    const handbrake = !!input?.handbrake && mine.speed > 7
    const was = s.sliding
    s.sliding = was
      ? mine.speed > 4 && (handbrake || (state > 0.15 && mine.drift > 2.5) || mine.drift > 4)
      : mine.speed > 6 && (handbrake || (state > 0.3 && mine.drift > 3) || mine.drift > 6)
    const k = Math.max(0, Math.min(1, (mine.drift - 3) / 9))
    const attack = 0.055
    const release = 0.07
    if (s.sliding) {
      // Low scrub leads at small angles; the squeal grows in with the slide, rising in pitch and opening up.
      this.screech.set(0.3 * (0.3 + 0.7 * k), 0.94 + 0.08 * k + 0.05 * Math.min(1, mine.speed / 40), 0, 2600 + 7400 * k, 0.06, attack)
      this.scrub.set(0.16 * (1 - 0.5 * k), 0.9 + 0.15 * Math.min(1, mine.speed / 35), 0, 1200 + 1800 * k, 0.04, attack)
    } else {
      const corner = mine.speed > 5 ? Math.max(0, Math.min(1, (mine.drift - 2) / 4)) : 0
      this.screech.set(0, 0.94, 0, 2600, 0.06, release)
      this.scrub.set(0.07 * corner * corner, 0.9 + 0.15 * Math.min(1, mine.speed / 35), 0, 900 + 600 * corner, 0.04, corner > 0 ? attack : release)
    }
    // A chirp only when a hard slide breaks loose, and never more than once every ~1.6 s.
    if (s.sliding && !was && mine.speed > 10 && (handbrake || state > 0.5 || mine.drift > 8) && s.skidCool <= 0) {
      a.play("skid_short", { gain: 0.28, rate: 0.95 + Math.random() * 0.1, wet: 0.08 })
      s.skidCool = 1.6
    }

    const flat = (mine.flat ?? 0) > 0 && mine.speed > 1.5
    this.flat.set(flat ? Math.min(0.55, 0.15 + mine.speed / 50) : 0, 0.55 + Math.min(1, mine.speed / 30) * 0.8, 0, 12000, 0.04, 0.1)

    // Wall scrape: repeated light contacts while moving read as sliding along a wall.
    if (mine.impact > 0.4 && mine.impact < 9 && mine.speed > 5) this.scrapeT = 0.18
    this.scrapeT = Math.max(0, this.scrapeT - dt)
    this.scrape.set(this.scrapeT > 0 ? Math.min(0.5, 0.18 + mine.speed / 60) : 0, 0.85 + Math.min(1, mine.speed / 40) * 0.3, 0, 14000, 0.08, this.scrapeT > 0 ? 0.03 : 0.1)

    // Your own lightbar, unpanned and a touch muffled, only once the chase is on.
    const siren = mine.role === "cop" && view.phase === "chase"
    if (siren) {
      this.ownSiren.start()
      const d = robber ? Math.hypot(robber.x - mine.x, robber.z - mine.z) : Infinity
      s.yelp = s.yelp ? d < YELP_OUT : d < YELP_IN
      this.ownSiren.set(0.2, 1, 0, 5200, 0.12, s.yelp)
    } else this.ownSiren.out.silence(0.4)
  }

  private otherEngines(view: WorldView, mine: Car | null, dt: number) {
    const cands = this.candidates
    cands.length = 0
    if (view.phase !== "end")
      for (const c of view.cars) {
        if (c === mine || c.ghost || c.engineOff) continue
        const d = Math.hypot(c.x - this.lx, c.z - this.lz)
        if (d > HEAR) continue
        this.dists.set(c.id, d)
        cands.push(c)
      }
    cands.sort(this.byDist)
    if (cands.length > ENGINE_VOICES) cands.length = ENGINE_VOICES
    this.assign(this.engines, cands)
    for (const v of this.engines) {
      if (v.carId < 0) continue
      const c = byId(cands, v.carId)
      if (!c) continue
      const s = this.states.get(c.id)!
      const accel = (c.speed - s.speed) / dt
      s.load += (Math.max(0, Math.min(1, accel / 6 + (c.speed > 6 ? 0.35 : 0))) - s.load) * (1 - Math.exp(-dt * 6))
      const rpmRate = this.rpmFor(s, c.speed, s.load, dt)
      v.use(this.a.buffer(c.role === "cop" ? "engine_cop_loop" : "engine_robber_loop"))
      const sp = this.spatial(c.x, c.z)
      const dop = this.doppler(c.x, c.z, c.vx, c.vz)
      v.set(sp.gain * (0.3 + 0.25 * s.load), rpmRate * dop, sp.pan, Math.min(sp.cutoff, 1800 + 7000 * s.load), sp.wet)
    }
  }

  /** Keeps voices on the same car across frames; frees voices whose car dropped out and hands them to newcomers. */
  private assign(voices: (LoopVoice | SirenVoice)[], want: Car[]) {
    for (const v of voices) {
      if (v.carId < 0 || byId(want, v.carId)) continue
      if (v instanceof LoopVoice) v.silence()
      else {
        v.out.silence(0.25)
        v.carId = -1
      }
    }
    outer: for (const c of want) {
      for (const v of voices) if (v.carId === c.id) continue outer
      for (const v of voices)
        if (v.carId < 0) {
          v.carId = c.id
          break
        }
    }
  }

  private sirenVoices(view: WorldView, mine: Car | null, robber: Car | null) {
    const cands = this.candidates
    cands.length = 0
    if (view.phase === "chase")
      for (const c of view.cars) {
        if (c.role !== "cop" || c === mine) continue
        const d = Math.hypot(c.x - this.lx, c.z - this.lz)
        if (d > SIREN_HEAR) continue
        this.dists.set(c.id, d)
        cands.push(c)
      }
    cands.sort(this.byDist)
    if (cands.length > SIREN_VOICES) cands.length = SIREN_VOICES
    this.assign(this.sirens, cands)
    for (const v of this.sirens) {
      if (v.carId < 0) continue
      v.start()
      const c = byId(cands, v.carId)
      if (!c) continue
      const s = this.states.get(c.id)!
      const dr = robber ? Math.hypot(robber.x - c.x, robber.z - c.z) : Infinity
      s.yelp = s.yelp ? dr < YELP_OUT : dr < YELP_IN
      // Sirens carry further than engines: a longer range and a gentler roll-off.
      const sp = this.spatial(c.x, c.z, 0, SIREN_HEAR)
      const g = Math.min(1, Math.sqrt(sp.gain) * 0.9)
      const dop = this.doppler(c.x, c.z, c.vx, c.vz)
      v.set(0.36 * g, dop * (0.985 + 0.03 * s.sirenOffset), sp.pan, Math.max(1500, sp.cutoff), sp.wet + 0.1, s.yelp)
    }
  }

  private helicopter(view: WorldView, dt: number) {
    const h = view.heli
    const on = h.active && view.phase !== "end"
    if (on && !this.heliOn) {
      this.heliX = h.x
      this.heliZ = h.z
      this.heliVX = this.heliVZ = 0
    }
    this.heliOn = on
    if (!on) {
      this.heli.silence(0.8)
      return
    }
    const k = 1 - Math.exp(-dt * 3)
    this.heliVX += ((h.x - this.heliX) / dt - this.heliVX) * k
    this.heliVZ += ((h.z - this.heliZ) / dt - this.heliVZ) * k
    this.heliX = h.x
    this.heliZ = h.z
    const sp = this.spatial(h.x, h.z, h.y * 0.5)
    const dop = this.doppler(h.x, h.z, this.heliVX, this.heliVZ)
    // Rotor wash carries: it never fully drops out while airborne, and the spotlight lock brings it closer.
    const g = Math.max(0.12, Math.sqrt(sp.gain)) * (0.5 + 0.15 * Math.min(1, h.lock))
    this.heli.set(g, dop, sp.pan * 0.7, Math.max(1200, sp.cutoff * 1.5), sp.wet, 0.3)
  }

  /** Heartbeat under a bust in progress: it quickens as the ring fills. */
  private tension(view: WorldView, mine: Car | null, dt: number) {
    if (view.phase !== "chase" || view.bust <= 0.02) {
      this.beatT = 0
      return
    }
    this.beatT -= dt
    if (this.beatT > 0) return
    const b = Math.min(1, view.bust)
    this.beatT = 0.95 - 0.55 * b
    const g = (mine && mine.ownerId === view.robberId ? 0.55 : 0.35) * (0.5 + 0.5 * b)
    this.a.play("escape_tick", { gain: g, rate: 0.95 + 0.1 * b })
    this.a.play("escape_tick", { gain: g * 0.6, rate: 0.92 + 0.1 * b, delay: 0.19 })
  }

  /** Impacts, nitro and tire chirps detected from per-car state changes. */
  private oneShotsFromState(view: WorldView, mine: Car | null) {
    const end = view.phase === "end"
    for (const c of view.cars) {
      const s = this.states.get(c.id)!
      const own = c === mine
      if (!c.ghost && !end) {
        const sp = own ? null : this.spatial(c.x, c.z)
        const audible = own || (sp !== null && sp.gain > 0.03)
        if (audible) {
          const g = own ? 1 : sp!.gain
          const pan = own ? 0 : sp!.pan
          const wet = own ? 0.08 : sp!.wet
          const cutoff = own ? 18000 : sp!.cutoff
          // Impacts: a fresh hit (not the same contact lingering across frames).
          if (c.impact > 2.5 && s.impactCool <= 0 && c.impact > s.impact * 1.4) {
            const heavy = c.impact >= 9
            const amt = Math.min(1, c.impact / (heavy ? 22 : 9))
            this.a.play(heavy ? "impact_heavy" : "impact_light", { gain: g * (0.45 + 0.55 * amt) * (heavy ? 0.9 : 0.8), rate: 0.9 + Math.random() * 0.2, pan, wet, cutoff })
            s.impactCool = heavy ? 0.35 : 0.18
          }
          // Your own nitro and tires are driven from your controls in ownCar.
          if (!own) {
            // Nitro: fuel starts draining.
            if (c.boost < s.boost - 1e-4 && s.nitroCool <= 0 && c.speed > 3) {
              this.a.play("nitro_burst", { gain: g * 0.55, pan, wet, cutoff })
              s.nitroCool = 1.2
            }
            if (c.boost >= s.boost) s.nitroCool = Math.min(s.nitroCool, 0.25)
            // A hard slide breaking loose; ordinary cornering never chirps.
            if (c.drift > 8 && s.drift <= 8 && c.speed > 10 && s.skidCool <= 0) {
              this.a.play("skid_short", { gain: g * 0.3, rate: 0.95 + Math.random() * 0.1, pan, wet, cutoff })
              s.skidCool = 1.6
            }
          }
        }
      }
      s.speed = c.speed
      s.boost = c.boost
      s.impact = c.impact
      s.drift = c.drift
    }
  }

  private phases(view: WorldView, mine: Car | null) {
    const a = this.a
    if (view.round !== this.round) {
      this.round = view.round
      this.startBest = view.best ?? 0
    }
    const changed = view.phase !== this.phase
    const prev = this.phase
    this.phase = view.phase
    if (changed && view.phase === "intro" && prev !== "") a.play("ui_whoosh", { bus: "sting", gain: 0.35 })
    if (changed && view.phase === "headstart" && prev !== "") this.roundSting()
    if (changed && view.phase === "end" && view.busted) this.bustSting()
    // Under the end card the world fades away; only the stinger stays.
    const end = view.phase === "end"
    if (end !== this.endFaded) {
      this.endFaded = end
      a.fadeBus("sfx", end ? 0 : 1, end ? 0.9 : 0.4)
      a.fadeBus("amb", end ? 0.25 : 1, end ? 1.5 : 1)
    }
    // A new room best: a soft double beat as the clock passes it.
    if (view.phase === "chase" && this.startBest > 0 && this.recordRound !== view.round && this.lastSurvived <= this.startBest && view.survived > this.startBest) {
      this.recordRound = view.round
      a.play("escape_tick", { bus: "sting", gain: 0.6 })
      a.play("escape_tick", { bus: "sting", gain: 0.45, delay: 0.22 })
      a.play("ui_whoosh", { bus: "sting", gain: 0.25, delay: 0.05 })
    }
    this.lastSurvived = view.survived ?? 0
  }

  private roundSting() {
    if (this.stingRound === this.round) return
    this.stingRound = this.round
    this.a.play("round_start_sting", { bus: "sting", gain: 0.85 })
    this.a.duckFor(2.2, 0.55)
  }

  private bustSting() {
    if (this.bustRound === this.round) return
    this.bustRound = this.round
    this.a.play("bust_sting", { bus: "sting", gain: 0.95 })
    this.a.duckFor(3, 0.3)
  }

  private events(view: WorldView, events: SimEvent[], mine: Car | null) {
    const a = this.a
    for (const e of events) {
      const c = e.carId !== undefined ? byId(view.cars, e.carId) : undefined
      const own = !!c && c === mine
      const sp = c && !own ? this.spatial(c.x, c.z) : null
      const g = sp ? Math.max(0.15, sp.gain) : 1
      const pan = sp?.pan ?? 0
      const wet = sp ? sp.wet : 0.1
      switch (e.kind) {
        case "go":
          this.roundSting()
          break
        case "bust":
          this.bustSting()
          break
        case "gadget":
          a.play("spike_deploy", { gain: 0.75 * g, pan, wet })
          break
        case "flat":
          a.play("tire_pop", { gain: own ? 0.95 : 0.85 * g, pan, wet })
          if (own) a.duckFor(0.6, 0.6)
          break
        case "near":
          a.play("near_whoosh", { gain: (own ? 0.6 : 0.5) * g, pan, wet, rate: 0.95 + Math.random() * 0.1 })
          break
      }
    }
  }

  private mountHint(root: HTMLElement) {
    const el = document.createElement("div")
    el.style.cssText =
      "position:absolute;top:22px;right:24px;font:500 10px/1 var(--display);letter-spacing:0.3em;color:var(--faint);opacity:0.8;pointer-events:none"
    root.appendChild(el)
    this.hint = el
    this.a.onMute((m) => {
      if (this.hint) this.hint.textContent = `M  SOUND ${m ? "OFF" : "ON"}`
    })
  }
}
