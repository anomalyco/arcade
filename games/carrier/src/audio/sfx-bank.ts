import { airCutoff, clamp, distanceGain, smoothstep } from "./jet-math"
import { type Bus, type Mixer, mixer as sharedMixer } from "./mixer"
import { CATEGORIES, SLOT_BY_ID, SLOTS, type Slot, type SlotCategory } from "./sfx-slots"

/** Per take, from public/sfx/v3/manifest.json (scripts/sfx-cinematic.ts). */
export type TakeInfo = { dur: number; loop?: number; peak: number; lufs: number; tp: number; seam?: number }
/** The user's choice for a slot: the take that plays, a level trim (dB), and 0-5 ratings per take (index take - 1). */
export type SlotPick = { take: number; trim: number; ratings?: number[] }
export type Picks = Record<string, SlotPick>

const PICKS_KEY = "carrier.sfx.picks"
/** One-shot slots that play a random take each time (variation): the user's rated-up takes, or every take not rated
 *  down. Everything else plays its picked take. */
const POOLED = new Set(["boom-air", "boom-missile", "boom-bomb-land", "boom-bomb-water", "boom-crash-sea", "boom-crash-land", "boom-far", "impact-water", "impact-metal", "thunder-near", "thunder-far", "hull-slam", "flares"])
/** Default reverb send per category (open air is most of what makes it sound big). */
const REVERB: Record<SlotCategory, number> = { carrier: 0.25, gun: 0.3, missile: 0.35, bomb: 0.3, boom: 0.5, ship: 0.15, sea: 0, ui: 0, hooks: 0.35 }
/** Default bus per category. */
const BUS: Record<SlotCategory, Bus> = { carrier: "sfx", gun: "weapons", missile: "weapons", bomb: "weapons", boom: "weapons", ship: "weather", sea: "weather", ui: "ui", hooks: "weapons" }
/**
 * The voice budget: at most VOICES recorded one-shots at once, no slot retriggering within its cooldown, and priority
 * (explosion > weapons > deck events > thunder > accents and interface): a louder-mattering sound ducks the lesser ones
 * already playing, takes the place of the least important when the budget is full, and for half a second keeps
 * accents (priority ≤ 1) from starting at all. One clear sound per moment.
 */
const VOICES = 6
const PRIORITY: Record<SlotCategory, number> = { boom: 5, gun: 4, missile: 4, bomb: 4, hooks: 4, carrier: 3, sea: 2, ship: 1, ui: 1 }
const SLOT_PRIORITY: Record<string, number> = { sinking: 3, "ship-horn": 0, "hull-creak": 0, "ui-kill": 2 }
/** Per-slot retrigger cooldown (s). */
const COOLDOWN = 0.15
const SLOT_COOLDOWN: Record<string, number> = { "ui-click": 0.12, "impact-metal": 0.12, "hull-slam": 2, "hull-creak": 6 }
for (const k of ["boom-air", "boom-missile", "boom-bomb-land", "boom-bomb-water", "boom-crash-sea", "boom-crash-land", "boom-far"]) SLOT_COOLDOWN[k] = 0.08

type Voice = { prio: number; start: number; end: number; input: GainNode; stop(fade?: number): void }

/** Load order after the first gesture. */
const ORDER: readonly SlotCategory[] = ["sea", "carrier", "ui", "gun", "missile", "boom", "bomb", "ship", "hooks"]

export type Place = {
  /** World position (needs the listener: mixer.listener, set by jet-audio.ts each frame). */
  at?: ArrayLike<number>
  /** Or a position in listener space (x right, y up, -z ahead). */
  local?: { x: number; y: number; z: number }
  /** Or only a distance (placed straight ahead). */
  dist?: number
}

export type PlayOptions = Place & {
  gain?: number
  /** Playback rate (pitch and speed). */
  rate?: number
  /** Seconds from now (before the travel time). */
  delay?: number
  /** Seconds into the take. */
  offset?: number
  bus?: Bus
  /** Reverb send (default per category), and the water slapback for loud events. */
  reverb?: number
  echo?: number
  /** Full level inside `ref` metres (default 60), falling with `rolloff`. */
  ref?: number
  rolloff?: number
  /** HRTF (focused sources) or equal-power panning. */
  hrtf?: boolean
  /** Delay by the speed of sound (≤ 3 s). */
  travel?: boolean
  /** Force a take (the SOUNDS tab). */
  take?: number
}

/** A playing one-shot. */
export type Shot = { src: AudioBufferSourceNode; end: number; move(p: Place): void; stop(fade?: number): void }
/** A playing loop: move it, change its level and rate, stop it. */
export type LoopHandle = { slot: string; set(o: Place & { gain?: number; rate?: number; tc?: number }): void; stop(fade?: number): void; readonly playing: boolean }

type Chain = { input: GainNode; lp: BiquadFilterNode | null; panner: PannerNode | null; direct: GainNode; send: GainNode | null; echo: GainNode | null; ref: number; rolloff: number; rev: number; positional: boolean }

/**
 * The cinematic sound bank: every slot in sfx-slots.ts, its candidate takes in public/sfx/v3 (Ogg Opus, 48 kHz stereo),
 * the user's picks (shipped defaults in public/sfx/picks.json, overridden in localStorage by the SOUNDS tab, live), and
 * `play` / `loop` through a cinematic spatial chain: a level, an air-absorption low-pass, a panner (HRTF for focused
 * sources), distance gain, a reverb send that grows with distance (far = more room, less direct), and an optional water
 * slapback. Beds (no position) play as wide stereo. After the first gesture it loads the picked takes category by
 * category; until a slot has loaded, `play` / `loop` return null and the caller plays its procedural placeholder.
 */
export class SfxBank {
  manifest: Record<string, TakeInfo> = {}
  shipped: Picks = {}
  picks: Picks = {}
  /** Bumped whenever picks change (voices holding a loop re-create it). */
  version = 0
  private buffers = new Map<string, AudioBuffer>()
  private loading = new Map<string, Promise<AudioBuffer | null>>()
  private base = ""
  private started = false
  private last = new Map<string, number>()
  private voices: Voice[] = []
  private budgetCtx: BaseAudioContext | null = null
  private lastPlayed = new Map<string, number>()
  /** One-shots the budget turned away (readout). */
  dropped = 0
  /** Resolves once boot has loaded every category's playing takes. */
  booted: Promise<void> = Promise.resolve()

  constructor(readonly mixer: Mixer) {
    this.picks = this.restore()
    mixer.onStart(() => void this.boot())
  }

  /** Fetches the manifest and shipped picks, then every slot's picked takes, category by category. */
  boot(base?: string): Promise<void> {
    if (this.started) return this.booted
    this.started = true
    this.booted = this.load(base)
    return this.booted
  }

  private async load(base?: string): Promise<void> {
    this.base = base ?? (typeof document !== "undefined" ? document.baseURI : "")
    try {
      this.manifest = await (await fetch(new URL("sfx/v3/manifest.json", this.base))).json()
    } catch (err) {
      console.warn("[audio] sfx manifest not loaded (procedural only)", err)
      return
    }
    try {
      const r = await fetch(new URL("sfx/picks.json", this.base))
      if (r.ok) this.shipped = await r.json()
    } catch {
      // No shipped picks: take 1 everywhere until the user picks.
    }
    this.picks = this.restore()
    this.version++
    for (const cat of ORDER) await this.loadCategory(cat)
  }

  /** Loads the takes a category plays (its picks, or the pools of pooled slots). */
  async loadCategory(cat: SlotCategory): Promise<void> {
    const jobs: Promise<unknown>[] = []
    for (const s of SLOTS) if (s.category === cat) for (const t of this.takesFor(s.id)) jobs.push(this.fetch(s.id, t))
    await Promise.all(jobs)
  }

  /** The take that plays for `slot`. */
  take(slot: string): number {
    const s = SLOT_BY_ID.get(slot)
    const p = this.picks[slot]?.take ?? this.shipped[slot]?.take ?? 1
    return s ? clamp(Math.round(p), 1, s.count) : 1
  }

  /** Level trim (dB) for `slot`. */
  trim(slot: string): number {
    return this.picks[slot]?.trim ?? this.shipped[slot]?.trim ?? 0
  }

  ratings(slot: string): number[] {
    return this.picks[slot]?.ratings ?? this.shipped[slot]?.ratings ?? []
  }

  /** Takes a slot can play: the pick, or for pooled one-shots its rated-up takes (else every take not rated down). */
  takesFor(slot: string): number[] {
    const s = SLOT_BY_ID.get(slot)
    if (!s) return []
    if (!POOLED.has(slot)) return [this.take(slot)]
    const r = this.ratings(slot)
    const all = Array.from({ length: s.count }, (_, i) => i + 1)
    const good = all.filter((t) => (r[t - 1] ?? 0) >= 4)
    const pool = good.length ? good : all.filter((t) => (r[t - 1] ?? 0) === 0 || (r[t - 1] ?? 0) >= 3)
    if (!pool.includes(this.take(slot))) pool.push(this.take(slot))
    return pool
  }

  /** A slot's (or a take's) decoded buffer, null until loaded. */
  get(slot: string, take = this.take(slot)): AudioBuffer | null {
    return this.buffers.get(`${slot}-${take}`) ?? null
  }

  /** True once `slot`'s picked take has decoded (and recorded sounds are on). */
  ready(slot: string): boolean {
    return this.mixer.samplesOn && this.buffers.has(`${slot}-${this.take(slot)}`)
  }

  info(slot: string, take = this.take(slot)): TakeInfo | null {
    return this.manifest[`${slot}-${take}`] ?? null
  }

  /** Decodes a take (once). */
  fetch(slot: string, take: number): Promise<AudioBuffer | null> {
    const key = `${slot}-${take}`
    const have = this.buffers.get(key)
    if (have) return Promise.resolve(have)
    const pending = this.loading.get(key)
    if (pending) return pending
    const ctx = this.mixer.ctx
    if (!ctx || !this.manifest[key]) return Promise.resolve(null)
    const p = fetch(new URL(`sfx/v3/${key}.ogg`, this.base || (typeof document !== "undefined" ? document.baseURI : "")))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => {
        this.buffers.set(key, buf)
        return buf
      })
      .catch((err) => {
        console.warn(`[audio] ${key}.ogg not loaded`, err)
        return null
      })
    this.loading.set(key, p)
    return p
  }

  /** Decoded takes, and how many takes the game plays in total. */
  get loaded(): number {
    return this.buffers.size
  }

  /** Loop points of a slot's take: [start, end] in seconds (null until loaded). */
  loopRange(slot: string, take = this.take(slot)): [number, number] | null {
    const buf = this.get(slot, take)
    return buf ? this.loopPoints(buf, `${slot}-${take}`) : null
  }

  /** Loop points for a take: [start, end] in seconds, skipping any leading decoder padding. */
  private loopPoints(buf: AudioBuffer, key: string): [number, number] {
    const len = this.manifest[key]?.loop ?? buf.duration
    const d = buf.getChannelData(0)
    const max = Math.min(d.length, Math.floor(buf.sampleRate * 0.1))
    let s = 0
    while (s < max && Math.abs(d[s]!) < 1e-5) s++
    const start = s >= max ? 0 : s / buf.sampleRate
    return [start, Math.min(buf.duration, start + len)]
  }

  /** Builds the spatial chain into `bus`. */
  private chain(slot: Slot | undefined, o: PlayOptions): Chain {
    const ctx = this.mixer.ctx!
    const m = this.mixer
    const cat = slot?.category ?? "carrier"
    const bus = m.bus[o.bus ?? BUS[cat]]
    const input = ctx.createGain()
    const direct = ctx.createGain()
    const positional = !!(o.at || o.local || o.dist !== undefined)
    let lp: BiquadFilterNode | null = null
    let panner: PannerNode | null = null
    if (positional) {
      lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.Q.value = 0.5
      panner = ctx.createPanner()
      panner.panningModel = o.hrtf === false ? "equalpower" : "HRTF"
      panner.distanceModel = "linear"
      panner.rolloffFactor = 0
      input.connect(lp).connect(direct).connect(panner).connect(bus)
    } else input.connect(direct).connect(bus)
    const rev = o.reverb ?? REVERB[cat]
    let send: GainNode | null = null
    if (rev > 0) {
      send = ctx.createGain()
      ;(lp ?? input).connect(send).connect(m.reverb)
    }
    let echo: GainNode | null = null
    if (o.echo && o.echo > 0) {
      echo = ctx.createGain()
      ;(lp ?? input).connect(echo).connect(m.echo)
    }
    const c: Chain = { input, lp, panner, direct, send, echo, ref: o.ref ?? 60, rolloff: o.rolloff ?? 1, rev, positional }
    this.place(c, o, o.echo ?? 0, true)
    return c
  }

  /** Listener-space position for a placement. */
  private local(p: Place): { x: number; y: number; z: number; d: number } {
    if (p.local) return { ...p.local, d: Math.hypot(p.local.x, p.local.y, p.local.z) }
    if (p.at) {
      const L = this.mixer.listener
      const dx = p.at[0]! - L.eye[0]
      const dy = p.at[1]! - L.eye[1]
      const dz = p.at[2]! - L.eye[2]
      const x = dx * L.right[0] + dy * L.right[1] + dz * L.right[2]
      const y = dx * L.up[0] + dy * L.up[1] + dz * L.up[2]
      const z = -(dx * L.fwd[0] + dy * L.fwd[1] + dz * L.fwd[2])
      return { x, y, z, d: Math.hypot(dx, dy, dz) }
    }
    const d = p.dist ?? 0
    return { x: 0, y: 0, z: -Math.max(1, d), d }
  }

  /** Distance gain, air absorption, panning and the far-gets-wetter reverb balance. */
  private place(c: Chain, p: Place, echo: number, now: boolean): number {
    if (!c.positional) {
      if (c.send) c.send.gain.value = c.rev
      return 0
    }
    const ctx = this.mixer.ctx!
    const w = this.local(p)
    const t = ctx.currentTime
    const set = (a: AudioParam, v: number) => (now ? a.setValueAtTime(v, t) : a.setTargetAtTime(v, t, 0.03))
    const g = distanceGain(w.d, c.ref, c.rolloff)
    const far = smoothstep(c.ref, c.ref * 25, w.d)
    set(c.direct.gain, g * (1 - 0.35 * far))
    set(c.lp!.frequency, airCutoff(w.d))
    set(c.panner!.positionX, w.x)
    set(c.panner!.positionY, w.y)
    set(c.panner!.positionZ, w.z)
    // The room carries further than the direct sound: far = more reverb, less direct.
    if (c.send) set(c.send.gain, c.rev * Math.sqrt(g) * (0.6 + 0.8 * far))
    if (c.echo) set(c.echo.gain, echo * Math.sqrt(g))
    return w.d
  }

  /** Plays a one-shot slot; null when it hasn't loaded (play the procedural placeholder). */
  play(slot: string, o: PlayOptions = {}): Shot | null {
    const ctx = this.mixer.ctx
    const s = SLOT_BY_ID.get(slot)
    if (!ctx || !s || this.mixer.muted || !this.mixer.samplesOn) return null
    // The budget (auditions with a forced take bypass it).
    const prio = SLOT_PRIORITY[slot] ?? PRIORITY[s.category]
    const now = ctx.currentTime
    if (o.take === undefined && !this.admit(slot, prio, now)) {
      this.dropped++
      return null
    }
    let take = o.take ?? this.take(slot)
    if (o.take === undefined && POOLED.has(slot)) {
      const pool = this.takesFor(slot).filter((t) => this.buffers.has(`${slot}-${t}`))
      if (pool.length > 1) {
        const prev = this.last.get(slot)
        const choices = pool.filter((t) => t !== prev)
        take = choices[Math.floor(Math.random() * choices.length)] ?? take
      } else if (pool.length) take = pool[0]!
    }
    const buf = this.buffers.get(`${slot}-${take}`)
    if (!buf) {
      void this.fetch(slot, take)
      return null
    }
    this.last.set(slot, take)
    const c = this.chain(s, o)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const rate = o.rate ?? 1
    src.playbackRate.value = rate
    c.input.gain.value = (o.gain ?? 1) * 10 ** (this.trim(slot) / 20)
    src.connect(c.input)
    const d = o.travel ? Math.min(3, this.local(o).d / 343) : 0
    const at = ctx.currentTime + 0.003 + (o.delay ?? 0) + d
    const off = Math.min(Math.max(0, o.offset ?? 0), buf.duration - 0.02)
    src.start(at, off)
    const end = at + (buf.duration - off) / rate
    const echo = o.echo ?? 0
    const shot: Shot = {
      src,
      end,
      move: (p) => this.place(c, p, echo, false),
      stop: (fade = 0.05) => {
        const t = ctx.currentTime
        c.input.gain.setTargetAtTime(0, t, fade / 3)
        try {
          src.stop(t + fade)
        } catch {
          // Already stopped.
        }
      },
    }
    if (o.take === undefined) {
      this.lastPlayed.set(slot, now)
      // Lesser sounds already playing step back under this one.
      for (const v of this.voices) if (v.prio < prio) v.input.gain.setTargetAtTime(v.input.gain.value * 0.45, at, 0.03)
      this.voices.push({ prio, start: at, end, input: c.input, stop: shot.stop })
    }
    return shot
  }

  /** Whether the budget lets `slot` (priority `prio`) start now; makes room by stopping a lesser voice if it must. */
  private admit(slot: string, prio: number, now: number): boolean {
    // A new context (scripted renders) starts a fresh budget.
    if (this.budgetCtx !== this.mixer.ctx) {
      this.budgetCtx = this.mixer.ctx
      this.voices = []
      this.lastPlayed.clear()
    }
    this.voices = this.voices.filter((v) => v.end > now)
    if (now - (this.lastPlayed.get(slot) ?? -1e9) < (SLOT_COOLDOWN[slot] ?? COOLDOWN)) return false
    if (prio <= 1 && this.voices.some((v) => v.prio >= 3 && now - v.start < 0.5)) return false
    if (this.voices.length < VOICES) return true
    let low: Voice | null = null
    for (const v of this.voices) if (!low || v.prio < low.prio || (v.prio === low.prio && v.start < low.start)) low = v
    if (!low || low.prio >= prio) return false
    low.stop(0.08)
    this.voices.splice(this.voices.indexOf(low), 1)
    return true
  }

  /** Starts a looping slot (silent until `set` gives it a level); null when it hasn't loaded. */
  loop(slot: string, o: PlayOptions = {}): LoopHandle | null {
    const ctx = this.mixer.ctx
    const s = SLOT_BY_ID.get(slot)
    if (!ctx || !s || !this.mixer.samplesOn) return null
    const take = o.take ?? this.take(slot)
    const key = `${slot}-${take}`
    const buf = this.buffers.get(key)
    if (!buf) {
      void this.fetch(slot, take)
      return null
    }
    const c = this.chain(s, o)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const [a, b] = this.loopPoints(buf, key)
    src.loopStart = a
    src.loopEnd = b
    src.playbackRate.value = o.rate ?? 1
    const trim = 10 ** (this.trim(slot) / 20)
    c.input.gain.value = 0
    src.connect(c.input)
    // Start somewhere random in the loop so two of the same never phase.
    src.start(ctx.currentTime + 0.003, a + Math.random() * (b - a))
    let playing = true
    const echo = o.echo ?? 0
    const h: LoopHandle = {
      slot,
      get playing() {
        return playing
      },
      set: (p) => {
        if (!playing) return
        const t = ctx.currentTime
        if (p.gain !== undefined) c.input.gain.setTargetAtTime(p.gain * trim, t, p.tc ?? 0.06)
        if (p.rate !== undefined) src.playbackRate.setTargetAtTime(Math.max(0.05, p.rate), t, 0.05)
        if (p.at || p.local || p.dist !== undefined) this.place(c, p, echo, false)
      },
      stop: (fade = 0.3) => {
        if (!playing) return
        playing = false
        const t = ctx.currentTime
        c.input.gain.cancelScheduledValues(t)
        c.input.gain.setTargetAtTime(0, t, fade / 3)
        try {
          src.stop(t + fade + 0.05)
        } catch {
          // Already stopped.
        }
      },
    }
    if (o.gain !== undefined) h.set({ gain: o.gain })
    return h
  }

  // ---- picks ----------------------------------------------------------------------------------------------------

  setPick(slot: string, take: number): void {
    this.edit(slot).take = take
    this.commit()
    for (const t of this.takesFor(slot)) void this.fetch(slot, t)
  }

  setTrim(slot: string, db: number): void {
    this.edit(slot).trim = clamp(db, -24, 12)
    this.commit()
  }

  setRating(slot: string, take: number, stars: number): void {
    const e = this.edit(slot)
    const r = (e.ratings ??= [])
    while (r.length < take) r.push(0)
    r[take - 1] = clamp(Math.round(stars), 0, 5)
    this.commit()
  }

  /** Back to the shipped picks. */
  reset(): void {
    this.picks = { ...this.shipped }
    if (typeof localStorage !== "undefined") localStorage.removeItem(PICKS_KEY)
    this.version++
  }

  /** Every slot's pick, trim and ratings (what picks.json holds). */
  export(): Picks {
    const out: Picks = {}
    for (const s of SLOTS) out[s.id] = { take: this.take(s.id), trim: Math.round(this.trim(s.id) * 10) / 10, ratings: this.ratings(s.id) }
    return out
  }

  /** Slots whose pick differs from the shipped one. */
  get changed(): number {
    let n = 0
    for (const s of SLOTS) {
      const a = this.picks[s.id]
      const b = this.shipped[s.id]
      if (a && (a.take !== (b?.take ?? 1) || a.trim !== (b?.trim ?? 0) || JSON.stringify(a.ratings ?? []) !== JSON.stringify(b?.ratings ?? []))) n++
    }
    return n
  }

  private edit(slot: string): SlotPick {
    const cur = this.picks[slot] ?? { ...(this.shipped[slot] ?? { take: 1, trim: 0 }) }
    if (cur.ratings) cur.ratings = [...cur.ratings]
    this.picks[slot] = cur
    return cur
  }

  private commit(): void {
    this.version++
    if (typeof localStorage === "undefined") return
    try {
      const local: Picks = {}
      for (const [k, v] of Object.entries(this.picks)) if (JSON.stringify(v) !== JSON.stringify(this.shipped[k])) local[k] = v
      localStorage.setItem(PICKS_KEY, JSON.stringify(local))
    } catch {
      // Storage blocked: picks last for this session.
    }
  }

  private restore(): Picks {
    const out: Picks = { ...this.shipped }
    if (typeof localStorage === "undefined") return out
    try {
      const local = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "{}") as Picks
      for (const [k, v] of Object.entries(local)) if (SLOT_BY_ID.has(k) && v && typeof v.take === "number") out[k] = v
    } catch {
      // Corrupt: shipped picks.
    }
    return out
  }
}

const banks = new WeakMap<Mixer, SfxBank>()
/** The sound bank for a mixer (the game's by default). The API for every module: `sfx().play(slot, opts)`, `sfx().loop(slot)`. */
export function sfx(m: Mixer = sharedMixer()): SfxBank {
  let b = banks.get(m)
  if (!b) banks.set(m, (b = new SfxBank(m)))
  return b
}

export { CATEGORIES, SLOTS }
