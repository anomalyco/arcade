/**
 * Web Audio context, buses and sample bank.
 *
 * Graph: sfx -> duck -> daze -> master, ambience -> duck -> daze -> master, stinger -> master, reverb send -> convolver ->
 * duck, master -> soft compressor -> destination. The context starts on the first click or key press (browsers block audio
 * until then); M toggles a global mute that is remembered in localStorage.
 */

export const SFX = [
  "engine_robber_loop",
  "engine_cop_loop",
  "tire_screech_loop",
  "tire_scrub_loop",
  "skid_short",
  "nitro_burst",
  "nitro_rush_loop",
  "crash_thump_1",
  "crash_thump_2",
  "crash_thump_3",
  "crash_bump_1",
  "crash_bump_2",
  "crash_bump_3",
  "crash_crunch_1",
  "crash_crunch_2",
  "crash_crunch_3",
  "crash_heavy_1",
  "crash_heavy_2",
  "crash_heavy_3",
  "crash_debris_1",
  "crash_debris_2",
  "crash_wall_1",
  "crash_wall_2",
  "crash_wall_3",
  "shove_chirp_1",
  "shove_chirp_2",
  "scrape_loop",
  "siren_wail_loop",
  "siren_yelp_loop",
  "heli_rotor_loop",
  "spike_deploy",
  "tire_pop",
  "flat_tire_loop",
  "repair",
  "bust_sting",
  "round_start_sting",
  "escape_tick",
  "city_ambience_loop",
  "ui_click",
  "ui_whoosh",
  "radio_chatter",
  "near_whoosh",
] as const

export type SfxName = (typeof SFX)[number]
export type Bus = "sfx" | "amb" | "sting"

const MUTE_KEY = "getaway.mute"
const MAX_ONE_SHOTS = 18

export type PlayOpts = { bus?: Bus; gain?: number; rate?: number; pan?: number; wet?: number; cutoff?: number; delay?: number }

export class AudioEngine {
  ctx: AudioContext | OfflineAudioContext | null = null
  /** Offline proof supplies a scheduling clock; live playback always uses currentTime. */
  scheduleTime: number | null = null
  master!: GainNode
  sfx!: GainNode
  amb!: GainNode
  sting!: GainNode
  /** Reverb send; spatial voices feed it more the further away they are. */
  verb!: GainNode
  muted = false
  private duck!: GainNode
  /** Low-pass after the duck, normally wide open; closes briefly when your car takes a big hit. */
  private daze!: BiquadFilterNode
  private buffers = new Map<SfxName, AudioBuffer>()
  private raw = new Map<SfxName, Promise<ArrayBuffer | null>>()
  private oneShots: number[] = []
  private nitroShots = new Map<AudioBufferSourceNode, GainNode>()
  private readyFns: (() => void)[] = []
  private muteFns: ((muted: boolean) => void)[] = []

  /**
   * `bindDom: false` (the Lab) leaves out the game's page wiring: no saved mute, sample fetch, gesture unlock, `M` key
   * or tab suspension. The host then calls `attach` with its own context.
   */
  constructor(offline?: OfflineAudioContext, options: { bindDom?: boolean } = {}) {
    if (offline) {
      this.ctx = offline
      this.buildGraph(offline)
      return
    }
    if (options.bindDom === false) return
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1"
    } catch {}
    if (typeof window === "undefined") return
    // Fetch the bytes straight away; decoding waits for the context, which needs a user gesture.
    this.fetchAll()
    const unlock = () => {
      this.start()
      if (this.ctx?.state === "running") {
        removeEventListener("pointerdown", unlock, true)
        removeEventListener("keydown", unlock, true)
        removeEventListener("touchend", unlock, true)
      }
    }
    addEventListener("pointerdown", unlock, true)
    addEventListener("keydown", unlock, true)
    addEventListener("touchend", unlock, true)
    window.addEventListener("keydown", (e) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      this.setMuted(!this.muted)
    })
    document.addEventListener("visibilitychange", () => {
      if (!(this.ctx instanceof AudioContext)) return
      if (document.hidden) void this.ctx.suspend()
      else void this.ctx.resume()
    })
  }

  get ready() {
    return this.buffers.size > 0
  }

  get now() {
    return this.scheduleTime ?? this.ctx?.currentTime ?? 0
  }

  onReady(fn: () => void) {
    if (this.ready) fn()
    else this.readyFns.push(fn)
  }

  onMute(fn: (muted: boolean) => void) {
    this.muteFns.push(fn)
    fn(this.muted)
  }

  buffer(name: SfxName) {
    return this.buffers.get(name)
  }

  setMuted(m: boolean) {
    this.muted = m
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0")
    } catch {}
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.now, 0.04)
    if (!m) this.play("ui_click", { bus: "sting", gain: 0.5 })
    for (const fn of this.muteFns) fn(m)
  }

  /** Bus level, e.g. fading the world out under the end card. */
  fadeBus(bus: Bus, level: number, tau: number) {
    if (!this.ctx) return
    const g = bus === "sfx" ? this.sfx : bus === "amb" ? this.amb : this.sting
    g.gain.setTargetAtTime(level, this.now, tau)
  }

  /** Pulls the sfx and ambience buses down under a stinger, then lets them back up. */
  duckFor(seconds: number, depth = 0.4) {
    if (!this.ctx) return
    const g = this.duck.gain
    const t = this.now
    g.cancelScheduledValues(t)
    g.setTargetAtTime(depth, t, 0.03)
    g.setTargetAtTime(1, t + seconds, 0.5)
  }

  /** Muffles the sfx and ambience buses for a moment (a big hit on your car), then opens them back up. */
  dazeFor(seconds: number, cutoff = 650) {
    if (!this.ctx) return
    const f = this.daze.frequency
    const t = this.now
    f.cancelScheduledValues(t)
    f.setValueAtTime(f.value, t)
    f.exponentialRampToValueAtTime(cutoff, t + 0.04)
    f.setTargetAtTime(20000, t + seconds * 0.45, seconds * 0.3)
  }

  /** Fire-and-forget one-shot. Returns false if it could not play (not unlocked, not loaded, or too many voices). */
  play(name: SfxName, o: PlayOpts = {}): boolean {
    const ctx = this.ctx
    const buf = this.buffers.get(name)
    this.oneShots = this.oneShots.filter(end => end > this.now)
    if (!ctx || !buf || this.oneShots.length >= MAX_ONE_SHOTS) return false
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = o.rate ?? 1
    const g = ctx.createGain()
    g.gain.value = o.gain ?? 1
    const nodes: AudioNode[] = [src, g]
    let tail: AudioNode = src
    if (o.cutoff !== undefined && o.cutoff < 18000) {
      const f = ctx.createBiquadFilter()
      nodes.push(f)
      f.type = "lowpass"
      f.frequency.value = o.cutoff
      tail.connect(f)
      tail = f
    }
    tail.connect(g)
    let out: AudioNode = g
    if (o.pan) {
      const p = ctx.createStereoPanner()
      nodes.push(p)
      p.pan.value = Math.max(-1, Math.min(1, o.pan))
      g.connect(p)
      out = p
    }
    out.connect(o.bus === "amb" ? this.amb : o.bus === "sting" ? this.sting : this.sfx)
    if (o.wet) {
      const s = ctx.createGain()
      nodes.push(s)
      s.gain.value = o.wet
      out.connect(s)
      s.connect(this.verb)
    }
    this.oneShots.push(this.now + (o.delay ?? 0) + buf.duration / (o.rate ?? 1))
    src.onended = () => {
      this.nitroShots.delete(src)
      for (const node of nodes) node.disconnect()
    }
    if (name === "nitro_burst") this.nitroShots.set(src, g)
    src.start(this.now + (o.delay ?? 0))
    return true
  }

  stopNitro() {
    for (const [source, gain] of this.nitroShots) {
      gain.gain.cancelAndHoldAtTime(this.now)
      gain.gain.linearRampToValueAtTime(0, this.now + 0.025)
      source.stop(this.now + 0.03)
    }
    this.nitroShots.clear()
  }

  /** Joins a context created elsewhere (after the host's own gesture) and loads the samples into it. */
  async attach(ctx: AudioContext | OfflineAudioContext) {
    if (this.ctx) return
    this.ctx = ctx
    this.buildGraph(ctx)
    this.fetchAll()
    await this.decodeAll(ctx)
  }

  private start() {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume()
      return
    }
    const ctx = new AudioContext({ latencyHint: "interactive" })
    this.ctx = ctx
    this.buildGraph(ctx)
    void ctx.resume()
    void this.decodeAll(ctx)
  }

  private buildGraph(ctx: BaseAudioContext) {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 12
    comp.ratio.value = 3
    comp.attack.value = 0.006
    comp.release.value = 0.25
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.09
    // Measured chase target ~-16 LUFS; fixed output headroom also protects sample transients.
    const output = ctx.createGain()
    output.gain.value = 0.66
    comp.connect(limiter).connect(output).connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(comp)
    this.daze = ctx.createBiquadFilter()
    this.daze.type = "lowpass"
    this.daze.frequency.value = 20000
    this.daze.Q.value = 0.707
    this.daze.connect(this.master)
    this.duck = ctx.createGain()
    this.duck.connect(this.daze)
    this.sfx = ctx.createGain()
    this.sfx.connect(this.duck)
    this.amb = ctx.createGain()
    this.amb.connect(this.duck)
    this.sting = ctx.createGain()
    this.sting.connect(this.master)
    // Street-canyon reverb: a short synthetic impulse (decaying noise with early slap-back off the buildings).
    const conv = ctx.createConvolver()
    conv.buffer = impulse(ctx, 1.7)
    const verbOut = ctx.createGain()
    verbOut.gain.value = 0.5
    this.verb = ctx.createGain()
    this.verb.connect(conv)
    conv.connect(verbOut)
    verbOut.connect(this.duck)
  }

  private fetchAll() {
    for (const name of SFX)
      this.raw.set(
        name,
        fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      )
  }

  async loadOffline() {
    if (!(this.ctx instanceof OfflineAudioContext)) throw new Error("Offline context required")
    this.fetchAll()
    await this.decodeAll(this.ctx)
    if (!this.ready) throw new Error("No comparison samples loaded")
  }

  private async decodeAll(ctx: BaseAudioContext) {
    await Promise.all(
      SFX.map(async (name) => {
        const bytes = await this.raw.get(name)
        if (!bytes) return
        try {
          const buf = await ctx.decodeAudioData(bytes)
          this.buffers.set(name, name.endsWith("_loop") ? trimPadding(ctx, buf) : buf)
        } catch {}
      }),
    )
    if (!this.ready) return
    for (const fn of this.readyFns) fn()
    this.readyFns = []
  }
}

/**
 * Some decoders keep the mp3 encoder delay and padding as digital silence at the ends, which would click once per loop.
 * The loops are continuous sound, so exact zeros at either end can only be padding.
 */
function trimPadding(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const d = buf.getChannelData(0)
  let a = 0
  let b = d.length
  while (a < b && Math.abs(d[a]!) < 1e-6) a++
  while (b > a && Math.abs(d[b - 1]!) < 1e-6) b--
  if (a < 8 && d.length - b < 8) return buf
  const out = ctx.createBuffer(buf.numberOfChannels, b - a, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c)
  return out
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  let seed = 1234567
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate
      d[i] = rnd() * Math.exp(-t * 3.6) * (t < 0.012 ? t / 0.012 : 1)
    }
    // Slap-back off the facades across the street.
    for (const [tap, g] of [
      [0.043 + c * 0.007, 0.5],
      [0.091 - c * 0.005, 0.32],
      [0.137 + c * 0.011, 0.2],
    ] as const) {
      const k = Math.floor(tap * ctx.sampleRate)
      for (let i = 0; i < 160; i++) d[k + i]! += rnd() * g * (1 - i / 160)
    }
    // Darken the tail: a one-pole low-pass that closes as the reverb decays.
    let lp = 0
    for (let i = 0; i < n; i++) {
      const a = 0.5 * Math.exp((-i / n) * 2.5)
      lp += (d[i]! - lp) * a
      d[i] = lp
    }
  }
  return buf
}

