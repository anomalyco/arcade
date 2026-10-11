/**
 * Web Audio context, buses and sample bank.
 *
 * Graph: sfx -> duck -> master, ambience -> duck -> master, stinger -> master, reverb send -> convolver -> master,
 * master -> soft compressor -> destination. The context starts on the first click or key press (browsers block audio
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
  "impact_light",
  "impact_heavy",
  "scrape_loop",
  "siren_wail_loop",
  "siren_yelp_loop",
  "heli_rotor_loop",
  "spike_deploy",
  "tire_pop",
  "flat_tire_loop",
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
  ctx: AudioContext | null = null
  master!: GainNode
  sfx!: GainNode
  amb!: GainNode
  sting!: GainNode
  /** Reverb send; spatial voices feed it more the further away they are. */
  verb!: GainNode
  muted = false
  private duck!: GainNode
  private buffers = new Map<SfxName, AudioBuffer>()
  private raw = new Map<SfxName, Promise<ArrayBuffer | null>>()
  private oneShots = 0
  private readyFns: (() => void)[] = []
  private muteFns: ((muted: boolean) => void)[] = []

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1"
    } catch {}
    if (typeof window === "undefined") return
    // Fetch the bytes straight away; decoding waits for the context, which needs a user gesture.
    for (const name of SFX)
      this.raw.set(
        name,
        fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      )
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
    addEventListener("keydown", (e) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      this.setMuted(!this.muted)
    })
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return
      if (document.hidden) void this.ctx.suspend()
      else void this.ctx.resume()
    })
  }

  get ready() {
    return this.buffers.size > 0
  }

  get now() {
    return this.ctx?.currentTime ?? 0
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
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.04)
    if (!m) this.play("ui_click", { bus: "sting", gain: 0.5 })
    for (const fn of this.muteFns) fn(m)
  }

  /** Bus level, e.g. fading the world out under the end card. */
  fadeBus(bus: Bus, level: number, tau: number) {
    if (!this.ctx) return
    const g = bus === "sfx" ? this.sfx : bus === "amb" ? this.amb : this.sting
    g.gain.setTargetAtTime(level, this.ctx.currentTime, tau)
  }

  /** Pulls the sfx and ambience buses down under a stinger, then lets them back up. */
  duckFor(seconds: number, depth = 0.4) {
    if (!this.ctx) return
    const g = this.duck.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setTargetAtTime(depth, t, 0.03)
    g.setTargetAtTime(1, t + seconds, 0.5)
  }

  /** Fire-and-forget one-shot. Returns false if it could not play (not unlocked, not loaded, or too many voices). */
  play(name: SfxName, o: PlayOpts = {}): boolean {
    const ctx = this.ctx
    const buf = this.buffers.get(name)
    if (!ctx || !buf || this.oneShots >= MAX_ONE_SHOTS) return false
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = o.rate ?? 1
    const g = ctx.createGain()
    g.gain.value = o.gain ?? 1
    let tail: AudioNode = src
    if (o.cutoff !== undefined && o.cutoff < 18000) {
      const f = ctx.createBiquadFilter()
      f.type = "lowpass"
      f.frequency.value = o.cutoff
      tail.connect(f)
      tail = f
    }
    tail.connect(g)
    let out: AudioNode = g
    if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, o.pan))
      g.connect(p)
      out = p
    }
    out.connect(o.bus === "amb" ? this.amb : o.bus === "sting" ? this.sting : this.sfx)
    if (o.wet) {
      const s = ctx.createGain()
      s.gain.value = o.wet
      out.connect(s)
      s.connect(this.verb)
    }
    this.oneShots++
    src.onended = () => {
      this.oneShots--
      src.disconnect()
      out.disconnect()
    }
    src.start(ctx.currentTime + (o.delay ?? 0))
    return true
  }

  private start() {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume()
      return
    }
    const ctx = new AudioContext({ latencyHint: "interactive" })
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 12
    comp.ratio.value = 3
    comp.attack.value = 0.006
    comp.release.value = 0.25
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(comp)
    this.duck = ctx.createGain()
    this.duck.connect(this.master)
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
    void ctx.resume()
    void this.decodeAll(ctx)
  }

  private async decodeAll(ctx: AudioContext) {
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
function trimPadding(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
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

function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
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

export const audio = new AudioEngine()
