// Sound effects: a tiny Web Audio synth, no files. Cues are struck out of a few layers each (a
// sine, a sine knocked sharp that drops to its pitch, a struck glass bar's modes, or a burst of
// filtered noise), each swelling in along a straight line and dying away exponentially, so they
// read as small physical parts: detents, latches, glass. Quiet, short and dry by design.
//
// One AudioContext, made on the first user gesture after something wants sound (never before, so
// browsers don't warn), feeds one bus: the volume and mute, a subsonic cut and a gentle
// compressor. Voices are capped; a cue repeated faster than it can sound is dropped, and one
// repeated quickly is lighter (a fast scrub ticks softly). Panels play only when mounted with
// `sound` (data kept on the root, like `haptics`); the page's switch (`sound.enable`) mutes all.
//
// The approach (struck modes, the knock, the cadence, the lazy context) follows Cuelume
// (https://cuelume.dev, MIT); the palette is knobs' own.

import type { SoundOptions, SoundTheme } from "../core/store.js"

export type { SoundOptions, SoundTheme }

/** A cue knobs plays for a moment in a panel (see README, Sound). */
export type SoundCue =
  | "step"
  | "limit"
  | "toggle"
  | "select"
  | "preset"
  | "random"
  | "mutate"
  | "reset"
  | "copy"
  | "undo"
  | "redo"
  | "open"
  | "close"
  | "hint"
  | "type"
  | "press"
  | "capture"
/** What a play knows about its moment. */
export interface CueDetail {
  /** Where the value now sits in its range, 0–1: a step's pitch. */
  readonly position?: number
  /** Forwards or on (1), back or off (-1). */
  readonly direction?: number
  /** A firmer play: the default's notch catching. */
  readonly strong?: boolean
  readonly volume?: number
  readonly theme?: SoundTheme
}
/**
 * One layer of a sound: a tone (`wave`) or a burst of noise through a filter. Times are seconds;
 * `d` is how long it takes to die away by 60 dB.
 */
export interface SoundLayer {
  readonly wave?: OscillatorType
  /** The noise's filter; `bandpass` by default. */
  readonly filter?: BiquadFilterType
  /** The tone's pitch, or the noise filter's frequency (Hz). */
  readonly f: number
  /** Glides `f` here over `glide` seconds. */
  readonly to?: number
  readonly glide?: number
  readonly q?: number
  /** Starts this long after the play. */
  readonly at?: number
  readonly a: number
  readonly d: number
  readonly p: number
}
interface Recipe {
  readonly layers: readonly SoundLayer[]
  /** The play's level, matched across cues by ear and by loudness (1 by default). */
  readonly gain?: number
  /** How much rings into the shared room (0 by default: dry). */
  readonly room?: number
}

// ── Layers ───────────────────────────────────────────────────────────────────────────────────

/** Noise ringing narrowly at `f`: one resonance of a click. */
const click = (f: number, p: number, d = 0.005, q = 4, at = 0): SoundLayer => ({
  f,
  q,
  a: 0.0008,
  d,
  p,
  at,
})
/** A dull bump: noise under a low-pass, a part meeting its stop. */
const thud = (f: number, p: number, d: number, at = 0): SoundLayer => ({
  filter: "lowpass",
  f,
  q: 0.7,
  a: 0.0015,
  d,
  p,
  at,
})
/** Air moving: noise sweeping from `f` to `to`. */
const air = (f: number, to: number, d: number, p: number, a = 0.012, at = 0): SoundLayer => ({
  f,
  to,
  glide: a + d * 0.6,
  q: 1.4,
  a,
  d,
  p,
  at,
})
/** A small hollow part tapped: a sine struck 60% sharp that drops to `f` in 18 ms. */
const knock = (f: number, d: number, p: number, at = 0): SoundLayer => ({
  wave: "sine",
  f: f * 1.6,
  to: f,
  glide: 0.018,
  a: 0.001,
  d,
  p,
  at,
})
/** A free glass bar's modes (1, 2.76, 5.4), each higher one dying sooner, under 5 kHz. */
const glass = (f: number, d: number, p: number, at = 0): SoundLayer[] =>
  [
    [1, 1],
    [2.76, 0.28],
    [5.4, 0.08],
  ]
    .filter(([ratio]) => f * ratio! <= 5000)
    .map(([ratio, level]) => ({
      wave: "sine" as const,
      f: f * ratio!,
      a: 0.002,
      d: Math.max(0.028, d / ratio! ** 0.75),
      p: p * level!,
      at,
    }))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Repeats closer than FAST play fully lightened; slower than SLOW, not at all (ms). */
const FAST = 70
const SLOW = 240
/** 0 (unhurried) to 1 (as fast as it goes), from the time since the cue last played. */
export const cadence = (sinceMs: number) => clamp((SLOW - sinceMs) / (SLOW - FAST), 0, 1)

/**
 * A cue's layers for this play: `speed` from `cadence`, `random` for its small variations (a die's
 * clicks, a key's pitch). Pure, so tests and an offline render read the same sound.
 */
export function recipe(
  cue: SoundCue,
  detail: CueDetail = {},
  speed = 0,
  random: () => number = Math.random,
): Recipe {
  const dir = Math.sign(detail.direction ?? 0)
  const light = 1 - 0.45 * speed
  const vary = (amount: number) => 1 + (random() * 2 - 1) * amount
  switch (cue) {
    case "step": {
      // A ratchet's tooth: a tight click over a softer body, pitched by where the value sits, and
      // a faint glass ping that a fast scrub drops. The notch is firmer, with a knock under it.
      // Noise through a narrower band carries less, so lower ticks are lifted to match.
      const k = 2 ** (clamp(detail.position ?? 0.5, 0, 1) * 0.9 - 0.35)
      const even = light / k ** 0.75
      const layers = [
        click(3000 * k, 0.5 * even, 0.004, 5),
        click(1300 * k, 0.22 * even, 0.01, 2.5),
      ]
      if (speed < 0.6)
        layers.push({ wave: "sine", f: 1480 * k, a: 0.001, d: 0.05, p: 0.008 * light })
      if (detail.strong) layers.push(knock(240, 0.03, 0.05), click(2100, 0.3, 0.006, 3))
      return { layers, gain: 1.8 }
    }
    case "limit":
      // The give at an end: a soft felt bump, felt more than heard.
      return { layers: [thud(380, 0.9, 0.05), knock(115, 0.06, 0.07)], gain: 0.9 }
    case "toggle":
      // A switch's throw: the lever leaves its detent, then snaps over 13 ms later. Off sits lower.
      return dir < 0
        ? {
            layers: [
              click(2800, 0.14, 0.003, 3),
              click(1450, 0.5, 0.013, 2, 0.012),
              knock(250, 0.034, 0.06, 0.012),
            ],
            gain: 1.2,
          }
        : {
            layers: [
              click(3300, 0.14, 0.003, 3),
              click(1850, 0.5, 0.012, 2, 0.013),
              knock(330, 0.03, 0.06, 0.013),
            ],
            gain: 1.2,
          }
    case "select": {
      // A detent with a small wooden knock, a step higher going forwards, lower going back.
      const k = 1 + 0.06 * dir
      return {
        layers: [click(2700 * k, 0.4 * light, 0.006, 3), knock(430 * k, 0.02, 0.045 * light)],
        gain: 1.5,
      }
    }
    case "preset":
      // A detent, then a soft glass fifth: something landed.
      return {
        layers: [
          click(2400, 0.3, 0.005, 3),
          thud(1800, 0.08, 0.004),
          ...glass(1046.5, 0.24, 0.016, 0.012),
          ...glass(1568, 0.2, 0.01, 0.012),
        ],
        gain: 2.5,
        room: 0.6,
      }
    case "random":
    case "mutate": {
      // A die tumbling on felt: a few small clicks, each sooner and softer than the last.
      const n = cue === "random" ? 5 : 2
      const layers: SoundLayer[] = []
      let at = 0
      let gap = 0.044
      for (let i = 0; i < n; i++) {
        const level = 0.8 ** i
        layers.push(
          click(1500 + 1900 * random(), 0.36 * level, 0.006, 3, at),
          knock(380 + 320 * random(), 0.018, 0.04 * level, at),
        )
        at += gap * vary(0.15)
        gap *= 0.78
      }
      return { layers, gain: 1.6 }
    }
    case "reset":
      // A breath drawn backwards that lands on a tick: values running home.
      return {
        layers: [
          { f: 2600, to: 750, glide: 0.09, q: 1.3, a: 0.07, d: 0.03, p: 0.18 },
          click(2200, 0.3, 0.004, 3, 0.082),
          knock(300, 0.02, 0.04, 0.082),
        ],
        gain: 1.1,
      }
    case "copy":
      // Two small glass notes rising, the first shimmering on a twin a few hertz sharp.
      return {
        layers: [
          thud(2200, 0.06, 0.003),
          ...glass(1174.66, 0.2, 0.014),
          { wave: "sine", f: 1178.5, a: 0.002, d: 0.18, p: 0.006 },
          ...glass(1567.98, 0.24, 0.014, 0.06),
        ],
        gain: 2.6,
        room: 1,
      }
    case "undo":
    case "redo": {
      // Air sliding back (falling) or forward (rising), caught by a light knock.
      const back = cue === "undo"
      return {
        layers: [
          air(back ? 1700 : 850, back ? 750 : 1800, 0.04, 0.14),
          knock(back ? 330 : 420, 0.02, 0.04, 0.028),
        ],
        gain: 1.4,
      }
    }
    case "open":
      // A latch letting go as air draws up.
      return { layers: [click(2600, 0.16, 0.004, 3), air(700, 1600, 0.045, 0.14, 0.02)], gain: 1.7 }
    case "close":
      // Air falling shut onto the latch.
      return {
        layers: [
          air(1500, 650, 0.04, 0.13, 0.015),
          knock(240, 0.028, 0.06, 0.03),
          click(1700, 0.2, 0.006, 3, 0.03),
        ],
        gain: 1.1,
      }
    case "hint":
      // A small glass ting as the codes appear.
      return {
        layers: [air(1200, 2400, 0.05, 0.06, 0.02), ...glass(1568, 0.14, 0.01, 0.012)],
        gain: 2.3,
        room: 0.8,
      }
    case "type": {
      // A low-profile key: a dry tick, every one a little different, softer when typed fast.
      const k = vary(0.06)
      return {
        layers: [click(3600 * k, 0.16 * light, 0.003, 1), click(1600 * k, 0.3 * light, 0.008, 3)],
        gain: 1.4,
      }
    }
    case "press":
      // A firm button: a click over the knock of its housing and a little body.
      return {
        layers: [click(2650, 0.4, 0.004, 1.5), knock(380, 0.02, 0.05), thud(220, 0.25, 0.022)],
        gain: 2,
      }
    case "capture":
      // A key going down and up, then a glass tick: got it.
      return {
        layers: [
          click(3000, 0.3, 0.003, 3),
          click(2400, 0.22, 0.004, 3, 0.035),
          ...glass(1318.5, 0.12, 0.012, 0.04),
        ],
        gain: 2.5,
        room: 0.5,
      }
  }
}

/** The `mech` theme: the same cues with the rings all but gone and the clicks tighter. */
export const themed = (layers: readonly SoundLayer[], theme: SoundTheme): SoundLayer[] =>
  theme === "mech"
    ? layers.map((l) =>
        l.wave
          ? { ...l, p: l.p * 0.5, d: l.d * 0.5 }
          : { ...l, d: l.d * 0.75, q: (l.q ?? 1) * 1.3, p: l.p * 1.1 },
      )
    : [...layers]

/** The shortest gap (ms) between two plays of a cue: closer ones are dropped. */
export const GAPS: Readonly<Record<SoundCue, number>> = {
  step: 24,
  limit: 140,
  toggle: 40,
  select: 28,
  preset: 80,
  random: 120,
  mutate: 120,
  reset: 120,
  copy: 200,
  undo: 45,
  redo: 45,
  open: 60,
  close: 60,
  hint: 120,
  type: 18,
  press: 50,
  capture: 120,
}

/** How a cue's plays are let through: too close are dropped; the rest report their cadence. */
export function createLimiter(gaps: Readonly<Record<string, number>> = GAPS) {
  const last = new Map<string, number>()
  return (cue: string, now: number): number | null => {
    const since = now - (last.get(cue) ?? Number.NEGATIVE_INFINITY)
    if (since < (gaps[cue] ?? 0)) return null
    last.set(cue, now)
    return cadence(since)
  }
}

/** A change this long (ms) after the last one on its slider is a fresh one (a key, a click). */
export const FRESH_MS = 150
/** A continuous slider ticks this many times across its range while it's dragged. */
export const DETENTS = 24

/**
 * Whether a slider's change (positions 0–1) earns a tick: a fresh change always does; within a
 * drag, only crossing into another of its `detents` (each stop of a stepped slider, else
 * DETENTS), so a slow drag ratchets evenly instead of ticking every pixel.
 */
export function createDetents() {
  const last = new Map<string, number>()
  return (key: string, before: number, after: number, detents: number, now: number) => {
    const since = now - (last.get(key) ?? Number.NEGATIVE_INFINITY)
    last.set(key, now)
    if (since > FRESH_MS) return true
    const n = Math.max(1, Math.round(detents))
    return Math.round(clamp(before, 0, 1) * n) !== Math.round(clamp(after, 0, 1) * n)
  }
}

/** The parts of a field a change's cue reads. */
interface CueField {
  readonly kind: string
  readonly value?: unknown
  readonly min?: unknown
  readonly max?: unknown
  readonly step?: unknown
  readonly options?: readonly unknown[]
}
const numbers = (v: unknown): number[] =>
  typeof v === "number"
    ? [v]
    : v && typeof v === "object"
      ? Object.values(v).filter((n): n is number => typeof n === "number")
      : []

/**
 * The cue for a row's value changing by hand from `before` to `after`: a step for numbers (pitched
 * by position, firmer landing on the default), a switch's throw, a choice's detent (by direction),
 * a captured key. `detents` is how many ticks a drag across the whole range may make.
 */
export function changeCue(
  field: CueField,
  before: unknown,
  after: unknown,
): { cue: SoundCue; detail: CueDetail; detents: number; at: number; was: number } | null {
  if (field.kind === "toggle")
    return { cue: "toggle", detail: { direction: after ? 1 : -1 }, detents: 1, at: 1, was: 0 }
  if (field.kind === "choice") {
    const options = field.options ?? []
    const dir = options.indexOf(after) - options.indexOf(before)
    return { cue: "select", detail: { direction: dir }, detents: 1, at: 1, was: 0 }
  }
  if (field.kind === "keybind")
    return after
      ? { cue: "capture", detail: {}, detents: 1, at: 1, was: 0 }
      : { cue: "select", detail: { direction: -1 }, detents: 1, at: 1, was: 0 }
  const { min, max, step } = field
  const a = numbers(before)
  const b = numbers(after)
  if (typeof min !== "number" || typeof max !== "number" || !(max > min) || !b.length)
    return { cue: "step", detail: {}, detents: 1, at: 0.5, was: 0.5 }
  // The part that moved (a range's thumb, a vector's cell) sets the pitch.
  let i = b.findIndex((n, j) => n !== a[j])
  if (i < 0) i = 0
  const pos = (n: number | undefined) => clamp(((n ?? min) - min) / (max - min), 0, 1)
  const steps = typeof step === "number" && step > 0 ? (max - min) / step : Number.POSITIVE_INFINITY
  return {
    cue: "step",
    detail: { position: pos(b[i]), strong: same(after, field.value) && !same(before, field.value) },
    detents: steps <= 10 ? steps : DETENTS,
    at: pos(b[i]),
    was: pos(a[i]),
  }
}
const same = (x: unknown, y: unknown) => {
  const a = numbers(x)
  const b = numbers(y)
  return a.length > 0 && a.length === b.length && a.every((n, i) => n === b[i])
}

/** A mount's `sound` option as what the panel plays with, or null for silence. */
export function resolveSound(option: boolean | SoundOptions | undefined): SoundOptions | null {
  if (!option) return null
  if (option === true) return {}
  return {
    ...(option.volume !== undefined ? { volume: clamp(Number(option.volume) || 0, 0, 1) } : {}),
    ...(option.theme ? { theme: option.theme } : {}),
  }
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────

/** At most this many plays sound at once; the oldest fades for a new one. */
export const MAX_VOICES = 10
const PAD = 0.04
const FADE = 0.015
/** Most of a play's level: the recipes are written near full scale, this sets the page's level. */
const LEVEL = 0.5

/** What the engine needs from the page, so tests can hand it a fake. */
export interface SoundEnv {
  readonly AudioContext?: { new (): AudioContext }
  /** Whether the page has had a user gesture yet (no context is made before one). */
  readonly activated?: () => boolean
  readonly now?: () => number
  readonly random?: () => number
}
const browserEnv = (): SoundEnv => {
  const win = typeof window === "undefined" ? undefined : window
  const Ctor =
    win?.AudioContext ??
    (win as (Window & { webkitAudioContext?: { new (): AudioContext } }) | undefined)
      ?.webkitAudioContext
  return {
    AudioContext: Ctor,
    activated: () =>
      (win?.navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
        ?.userActivation?.hasBeenActive !== false,
    now: () => performance.now(),
  }
}

export interface Sound {
  /** The page's switch: on unless turned off. Panels only play with `sound` on their mount. */
  readonly enabled: boolean
  enable(on?: boolean): void
  /** 0–1, 1 by default. */
  readonly volume: number
  setVolume(volume: number): void
  readonly theme: SoundTheme
  setTheme(theme: SoundTheme): void
  /** Plays a cue, or layers of your own, unless sound is off or the page hasn't been touched. */
  play(cue: SoundCue | readonly SoundLayer[], detail?: CueDetail): void
  /**
   * The shared context and the bus to connect your own nodes to (volume, mute and the compressor
   * apply), once there is one: after the first user gesture with sound wanted.
   */
  output(): { readonly context: AudioContext; readonly destination: AudioNode } | null
  /** Makes the context on the page's next gesture, so the first cue sounds at once. */
  prime(doc?: Document): void
  /** Called when `enabled`, `volume` or `theme` change; returns an unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createSound(env: SoundEnv = browserEnv()): Sound {
  let enabled = true
  let volume = 1
  let theme: SoundTheme = "glass"
  let context: AudioContext | null = null
  let bus: { input: GainNode; room: AudioNode; noise: AudioBuffer } | null = null
  const voices: { gain: GainNode; end: number }[] = []
  const listeners = new Set<() => void>()
  const limit = createLimiter()
  const now = env.now ?? (() => Date.now())
  const random = env.random ?? Math.random
  const notify = () => {
    for (const f of listeners) f()
  }

  const ensure = (): AudioContext | null => {
    if (context) return context
    if (!env.AudioContext || env.activated?.() === false) return null
    try {
      context = new env.AudioContext()
    } catch {
      return null
    }
    return context
  }
  const wake = (ctx: AudioContext) => {
    if (ctx.state === "suspended" && enabled)
      try {
        void ctx.resume().catch(() => {})
      } catch {}
  }
  const build = (ctx: AudioContext) => {
    if (bus) return bus
    const input = ctx.createGain()
    input.gain.value = enabled ? volume : 0
    const subsonic = ctx.createBiquadFilter()
    subsonic.type = "highpass"
    subsonic.frequency.value = 45
    const squeeze = ctx.createDynamicsCompressor()
    squeeze.threshold.value = -22
    squeeze.knee.value = 12
    squeeze.ratio.value = 3
    squeeze.attack.value = 0.002
    squeeze.release.value = 0.12
    input.connect(subsonic).connect(squeeze).connect(ctx.destination)
    // A seeded second of noise that noise layers loop from a random point.
    const rate = ctx.sampleRate
    const noise = ctx.createBuffer(1, rate, rate)
    const data = noise.getChannelData(0)
    let s = 7
    for (let i = 0; i < data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0
      data[i] = s / 2 ** 31 - 1
    }
    // A small room, a fifth of a second of decaying noise under a low-pass, for the glass cues.
    const len = Math.floor(rate * 0.2)
    const impulse = ctx.createBuffer(2, len, rate)
    for (let c = 0; c < 2; c++) {
      const ch = impulse.getChannelData(c)
      for (let i = Math.floor(rate * 0.006); i < len; i++)
        ch[i] = (data[(i * (c + 3)) % data.length]! * Math.exp((-6.9 * i) / len)) / 9
    }
    const verb = ctx.createConvolver()
    verb.normalize = false
    verb.buffer = impulse
    const walls = ctx.createBiquadFilter()
    walls.type = "lowpass"
    walls.frequency.value = 3800
    walls.connect(verb).connect(input)
    bus = { input, room: walls, noise }
    return bus
  }

  const render = (
    ctx: AudioContext,
    layers: readonly SoundLayer[],
    level: number,
    room: number,
  ) => {
    const b = build(ctx)
    const t0 = ctx.currentTime + 0.002
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i]!.end < t0) voices.splice(i, 1)
    while (voices.length >= MAX_VOICES) {
      const old = voices.shift()!
      old.gain.gain.cancelScheduledValues(t0)
      old.gain.gain.setValueAtTime(old.gain.gain.value, t0)
      old.gain.gain.linearRampToValueAtTime(0, t0 + FADE)
    }
    const out = ctx.createGain()
    out.gain.value = level
    out.connect(b.input)
    let send: GainNode | undefined
    if (room > 0) {
      send = ctx.createGain()
      send.gain.value = 0.1 * room
      out.connect(send).connect(b.room)
    }
    let end = t0
    for (const l of layers) {
      const t = t0 + (l.at ?? 0)
      const stop = t + l.a + l.d + PAD
      end = Math.max(end, stop)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(l.p, t + l.a)
      g.gain.setTargetAtTime(0, t + l.a, l.d / 6.9)
      let source: AudioScheduledSourceNode
      let param: AudioParam
      if (l.wave) {
        const osc = ctx.createOscillator()
        osc.type = l.wave
        param = osc.frequency
        osc.connect(g)
        source = osc
      } else {
        const src = ctx.createBufferSource()
        src.buffer = b.noise
        src.loop = true
        const filter = ctx.createBiquadFilter()
        filter.type = l.filter ?? "bandpass"
        if (l.q !== undefined) filter.Q.value = l.q
        param = filter.frequency
        src.connect(filter).connect(g)
        source = src
      }
      param.setValueAtTime(l.f, t)
      if (l.to !== undefined) param.exponentialRampToValueAtTime(l.to, t + (l.glide ?? l.a + l.d))
      g.connect(out)
      // Each burst starts somewhere else in the noise.
      if (l.wave) source.start(t)
      else (source as AudioBufferSourceNode).start(t, random() * 0.9)
      source.stop(stop)
    }
    voices.push({ gain: out, end })
    setTimeout(
      () => {
        out.disconnect()
        send?.disconnect()
      },
      (end - ctx.currentTime + 0.1) * 1000,
    )
  }

  const sound: Sound = {
    get enabled() {
      return enabled
    },
    enable(on = true) {
      if (on === enabled) return
      enabled = on
      if (context && bus) {
        const t = context.currentTime
        const g = bus.input.gain
        g.cancelScheduledValues(t)
        g.setValueAtTime(g.value, t)
        g.linearRampToValueAtTime(on ? volume : 0, t + FADE * 2)
      }
      if (on && context) wake(context)
      notify()
    },
    get volume() {
      return volume
    },
    setVolume(next) {
      const v = clamp(Number(next) || 0, 0, 1)
      if (v === volume) return
      volume = v
      if (context && bus && enabled) bus.input.gain.setTargetAtTime(v, context.currentTime, 0.02)
      notify()
    },
    get theme() {
      return theme
    },
    setTheme(next) {
      if (next !== "glass" && next !== "mech") return
      if (next === theme) return
      theme = next
      notify()
    },
    play(cue, detail = {}) {
      if (!enabled || volume === 0) return
      const level = LEVEL * clamp(detail.volume ?? 1, 0, 1)
      if (level === 0) return
      let made: Recipe
      if (typeof cue === "string") {
        const speed = limit(cue, now())
        if (speed === null) return
        made = recipe(cue, detail, speed, random)
      } else made = { layers: cue }
      const ctx = ensure()
      if (!ctx) return
      const gain = level * (made.gain ?? 1)
      const layers = themed(made.layers, detail.theme ?? theme)
      const room = (detail.theme ?? theme) === "mech" ? 0 : (made.room ?? 0)
      if (ctx.state === "running") render(ctx, layers, gain, room)
      else {
        // Resumed in this gesture, it sounds a moment late rather than not at all.
        try {
          void ctx
            .resume()
            .then(() => {
              if (enabled && ctx.state === "running") render(ctx, layers, gain, room)
            })
            .catch(() => {})
        } catch {}
      }
    },
    output() {
      const ctx = ensure()
      if (!ctx) return null
      wake(ctx)
      return { context: ctx, destination: build(ctx).input }
    },
    prime(doc = typeof document === "undefined" ? undefined : document) {
      const win = doc?.defaultView
      if (!win || context) return
      const kinds = ["pointerdown", "keydown", "touchend"] as const
      const unlock = () => {
        if (!enabled) return
        const ctx = ensure()
        if (!ctx) return
        build(ctx)
        wake(ctx)
        for (const k of kinds) win.removeEventListener(k, unlock, true)
      }
      for (const k of kinds) win.addEventListener(k, unlock, true)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return sound
}

/** The page's sound: one switch, volume and theme for every panel (and the host's own cues). */
export const sound: Sound = /* @__PURE__ */ createSound()

// ── Panels ───────────────────────────────────────────────────────────────────────────────────

const panels = new WeakMap<Element, SoundOptions>()
/** Where the page keeps the user's choice, in a store's storage. */
export const SOUND_PREF = "knobs:sound:v1"

/** Marks `root` as a panel that plays (a mount's resolved `sound`). */
export function soundPanel(root: Element, options: SoundOptions) {
  panels.set(root, options)
  sound.prime(root.ownerDocument)
}
/** Whether the panel `from` sits in plays sounds. */
export const sounds = (from: Element | null | undefined) => {
  const root = from?.closest?.(".knobs-panel")
  return Boolean(root && panels.has(root))
}

const detents = createDetents()
/** A row's value changing by hand in the panel `from` sits in (see `changeCue`). */
export function changed(
  from: Element | null | undefined,
  key: string,
  field: CueField,
  before: unknown,
  after: unknown,
) {
  if (!sounds(from)) return
  const c = changeCue(field, before, after)
  if (!c) return
  if (c.cue === "step" && !detents(key, c.was, c.at, c.detents, performance.now())) return
  cue(from, c.cue, c.detail)
}

/** Plays `cue` for a moment in the panel `from` sits in, if that panel plays sounds. */
export function cue(from: Element | null | undefined, name: SoundCue, detail: CueDetail = {}) {
  const root = from?.closest?.(".knobs-panel")
  const options = root && panels.get(root)
  if (!options) return
  sound.play(name, {
    ...detail,
    volume: (options.volume ?? 1) * (detail.volume ?? 1),
    ...(options.theme && !detail.theme ? { theme: options.theme } : {}),
  })
}
