import type { SimEvent, WorldView } from "../../shared/sim/world"
import { audio } from "./audio"

/**
 * Police radio: voice lines on sightings, lost contact, dispatch tips, spike strip hits, the chase start and the bust.
 * Cops hear them clean on their own radio bus with the world ducked a little; the driver eavesdrops on a quieter,
 * muffled scanner and gets a short alert sting when they're spotted. One line at a time, at most one waiting.
 * The radio buses feed the master gain, so the global mute (M) silences them too.
 */

const LINES = [
  "spotted_north",
  "spotted_east",
  "spotted_south",
  "spotted_west",
  "spotted_eyes",
  "spotted_moving",
  "heli_light",
  "heli_eyes",
  "lost_marked",
  "lost_gone",
  "tip_area",
  "tip_maps",
  "flat_strip",
  "flat_limping",
  "chase_start",
  "bust_custody",
  "bust_driver",
  "radio_squelch",
  "spotted_sting",
] as const

type Line = (typeof LINES)[number]

/** A waiting line is dropped if it can't start within this many seconds; the news is stale by then. */
const STALE = 5
const GAP = 0.25

type Pending = { line: Line; at: number; delay: number; duck: boolean }

export class Radio {
  private a = audio
  private raw = new Map<Line, Promise<ArrayBuffer | null>>()
  private buffers = new Map<Line, AudioBuffer>()
  private decoding = false
  private clean: GainNode | null = null
  private scanner: GainNode | null = null
  private current: AudioBufferSourceNode | null = null
  private busyUntil = 0
  private pending: Pending | null = null
  private driver = false
  private flip = new Map<string, number>()

  constructor() {
    if (typeof window === "undefined") return
    for (const name of LINES)
      this.raw.set(
        name,
        fetch(`${import.meta.env.BASE_URL}sfx/radio/${name}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      )
  }

  update(view: WorldView, myId: string, events: SimEvent[]) {
    const ctx = this.a.ctx
    if (!ctx) return
    if (!this.decoding) {
      this.decoding = true
      this.build(ctx)
      void this.decode(ctx)
    }
    this.driver = view.robberId === myId && view.cars.some((c) => c.ownerId === myId)
    for (const e of events) this.event(view, e)
    if (this.pending && ctx.currentTime >= this.busyUntil) {
      const p = this.pending
      this.pending = null
      if (ctx.currentTime - p.at < STALE) this.start(p.line, p.delay, p.duck)
    }
  }

  private event(view: WorldView, e: SimEvent) {
    const chase = view.phase === "chase"
    switch (e.kind) {
      case "spotted": {
        if (!chase) return
        const [who, heading] = e.text.split("|")
        if (this.driver) this.oneShot("spotted_sting", 0.75)
        const delay = this.driver ? 0.35 : 0
        if (who === "heli") this.say(this.pick("heli", ["heli_light", "heli_eyes"]), delay)
        else if (heading && this.pick("dir", [true, true, false])) this.say(`spotted_${heading}` as Line, delay)
        else this.say(this.pick("ground", ["spotted_eyes", "spotted_moving"]), delay)
        return
      }
      case "lost":
        if (chase) this.say(this.pick("lost", ["lost_marked", "lost_gone"]))
        return
      case "tip":
        if (chase) this.say(this.pick("tip", ["tip_area", "tip_maps"]))
        return
      case "flat":
        if (chase) this.say(this.pick("flat", ["flat_strip", "flat_limping"]))
        return
      case "dispatch":
        if (/fleeing/i.test(e.text)) this.say("chase_start", this.driver ? 0.4 : 0)
        return
      case "bust":
        // Cuts off whatever is on the air. No duck here: the bust stinger has its own.
        this.interrupt()
        this.say(this.driver ? "bust_driver" : "bust_custody", 1.1, false)
        return
    }
  }

  /** Cycles through variants so the same take doesn't play twice in a row. */
  private pick<T>(key: string, options: readonly T[]): T {
    const i = this.flip.get(key) ?? Math.floor(Math.random() * options.length)
    this.flip.set(key, (i + 1) % options.length)
    return options[i % options.length]!
  }

  private say(line: Line, delay = 0, duck = true) {
    const ctx = this.a.ctx
    if (!ctx) return
    if (ctx.currentTime >= this.busyUntil && !this.pending) this.start(line, delay, duck)
    else this.pending = { line, at: ctx.currentTime, delay: Math.min(delay, 0.3), duck }
  }

  private start(line: Line, delay: number, duck: boolean) {
    const ctx = this.a.ctx
    const buf = this.buffers.get(line)
    const out = this.driver ? this.scanner : this.clean
    if (!ctx || !buf || !out) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(out)
    src.onended = () => {
      src.disconnect()
      if (this.current === src) this.current = null
    }
    src.start(ctx.currentTime + delay)
    this.current = src
    this.busyUntil = ctx.currentTime + delay + buf.duration + GAP
    if (duck && !this.a.muted) this.duckLater(delay, buf.duration, this.driver ? 0.8 : 0.62)
  }

  private duckLater(delay: number, seconds: number, depth: number) {
    if (delay <= 0.05) return this.a.duckFor(seconds, depth)
    setTimeout(() => this.a.duckFor(seconds, depth), delay * 1000)
  }

  private interrupt() {
    this.pending = null
    const ctx = this.a.ctx
    if (!ctx || !this.current || ctx.currentTime >= this.busyUntil) return
    this.current.stop(ctx.currentTime + 0.02)
    this.current = null
    this.busyUntil = 0
    this.oneShot("radio_squelch", this.driver ? 0.25 : 0.5, this.driver ? this.scanner : this.clean)
  }

  private oneShot(line: Line, gain: number, out: AudioNode | null = this.a.sting) {
    const ctx = this.a.ctx
    const buf = this.buffers.get(line)
    if (!ctx || !buf || !out) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(g)
    g.connect(out)
    src.onended = () => g.disconnect()
    src.start()
  }

  private build(ctx: AudioContext) {
    this.clean = ctx.createGain()
    this.clean.gain.value = 0.85
    this.clean.connect(this.a.master)
    // Scanner: a cheap speaker in the driver's car, picking the cops up from a distance.
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 520
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 1900
    lp.Q.value = 0.9
    const scanner = ctx.createGain()
    scanner.gain.value = 0.42
    hp.connect(lp)
    lp.connect(scanner)
    scanner.connect(this.a.master)
    this.scanner = ctx.createGain()
    this.scanner.connect(hp)
  }

  private async decode(ctx: AudioContext) {
    await Promise.all(
      LINES.map(async (name) => {
        const bytes = await this.raw.get(name)
        if (!bytes) return
        try {
          this.buffers.set(name, await ctx.decodeAudioData(bytes))
        } catch {}
      }),
    )
  }
}
