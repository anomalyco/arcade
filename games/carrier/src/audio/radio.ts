import type { LabControl } from "@arcade/kit/lab-panel"
import { type Mixer, mixer as sharedMixer } from "./mixer"
import { type SfxBank, sfx } from "./sfx-bank"

/**
 * Radio chatter: short voice lines on your own key moments (catapult shot, a lock or a missile on you, a kill, your
 * carrier hit, zones, the landing call, being hit), each a recorded slot `radio-<line>` (ElevenLabs text to speech, two
 * takes, sfx-slots.ts) played through a radio: band-pass, a little saturation, a squelch click and a burst of static at
 * the start and the end, a faint hiss under the voice, on the dry `radio` bus (the Voices volume) with the world
 * ducked slightly under it. One line at a time: a more urgent line cuts a lesser one off, a lesser one waits (briefly)
 * or is dropped; every line has its own cooldown. A small subtitle shows the line on the HUD. `RadioDirector` (in
 * radio-director.ts) decides when to talk; this only speaks.
 */
export type RadioLine = "launch" | "ball" | "mother" | "spike" | "break-left" | "break-right" | "splash" | "hit" | "zone-captured" | "zones-moving"

/** Priority (higher cuts lower off), cooldown (s) and subtitle of each line. Missile > lock > kill > the rest. */
export const RADIO_LINES: Readonly<Record<RadioLine, { prio: number; cooldown: number; text: string }>> = {
  "break-left": { prio: 4, cooldown: 4, text: "MISSILE, BREAK LEFT" },
  "break-right": { prio: 4, cooldown: 4, text: "MISSILE, BREAK RIGHT" },
  spike: { prio: 3, cooldown: 9, text: "SPIKE, SPIKE" },
  splash: { prio: 2, cooldown: 3, text: "SPLASH ONE" },
  hit: { prio: 1.5, cooldown: 12, text: "I'M HIT" },
  mother: { prio: 1, cooldown: 25, text: "MOTHER'S TAKING HITS" },
  launch: { prio: 1, cooldown: 15, text: "CLEARED, GOOD SHOT" },
  ball: { prio: 1, cooldown: 20, text: "CALL THE BALL" },
  "zone-captured": { prio: 1, cooldown: 8, text: "ZONE CAPTURED" },
  "zones-moving": { prio: 1, cooldown: 20, text: "ZONES MOVING" },
}

export type RadioSettings = {
  enabled: boolean
  subtitles: boolean
  /** Voice level into the radio bus. */
  level: number
  /** Band-pass edges (Hz) and the presence peak's boost (dB). */
  lowHz: number
  highHz: number
  presence: number
  /** Saturation drive (1 clean .. 6 crunchy). */
  drive: number
  /** Squelch burst and click level, and the hiss under the voice. */
  squelch: number
  hiss: number
  /** How far the world dips under a line (1 none .. 0 silent). */
  duck: number
  /** Silence between two lines (s), and how long a waiting line stays worth saying (s). */
  gap: number
  wait: number
}

export const RADIO_DEFAULTS: Readonly<RadioSettings> = {
  enabled: true,
  subtitles: true,
  level: 1,
  lowHz: 420,
  highHz: 3100,
  presence: 5,
  drive: 2.6,
  squelch: 0.22,
  hiss: 0.035,
  duck: 0.72,
  gap: 0.5,
  wait: 2.5,
}

/** Live (the dev panel's Audio tab binds it). */
export const RADIO: RadioSettings = { ...RADIO_DEFAULTS }

const G = "Radio chatter"
export const RADIO_CONTROLS: LabControl[] = [
  { key: "enabled", label: "Radio chatter", group: G, type: "toggle" },
  { key: "subtitles", label: "Subtitles", group: G, type: "toggle" },
  { key: "level", label: "Voice level", group: G, min: 0, max: 2, step: 0.05 },
  { key: "lowHz", label: "Band low edge", group: G, min: 150, max: 1200, step: 10, unit: "Hz" },
  { key: "highHz", label: "Band high edge", group: G, min: 1800, max: 6000, step: 50, unit: "Hz" },
  { key: "presence", label: "Presence peak", group: G, min: 0, max: 12, step: 0.5, unit: "dB" },
  { key: "drive", label: "Distortion drive", group: G, min: 1, max: 6, step: 0.1 },
  { key: "squelch", label: "Squelch level", group: G, min: 0, max: 0.6, step: 0.01 },
  { key: "hiss", label: "Static under voice", group: G, min: 0, max: 0.15, step: 0.005 },
  { key: "duck", label: "World under radio", group: G, min: 0.3, max: 1, step: 0.02 },
  { key: "gap", label: "Gap between lines", group: G, min: 0, max: 3, step: 0.1, unit: "s" },
  { key: "wait", label: "Waiting line expires", group: G, min: 0, max: 6, step: 0.1, unit: "s" },
]

const CSS = `
#radio-sub { position: fixed; left: 28px; bottom: 34%; pointer-events: none; font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; font-size: 12px; letter-spacing: 0.3em; color: #c9f3d6; text-transform: uppercase; padding: 5px 10px 5px 9px;
  background: rgba(6, 16, 30, 0.55); box-shadow: 0 0 0 1px rgba(160, 240, 190, 0.14) inset; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
  opacity: 0; transition: opacity 0.25s; zoom: var(--hud, 1); white-space: nowrap; }
#radio-sub.on { opacity: 1; }
#radio-sub b { font-weight: 300; color: #7dffa8; margin-right: 0.6em; animation: radio-blink 0.5s steps(2, jump-none) infinite; }
@keyframes radio-blink { from { opacity: 1 } to { opacity: 0.35 } }
body.mn-open #radio-sub { display: none; }
`

type Playing = { line: RadioLine; prio: number; end: number; stop(fade: number): void }

export class Radio {
  /** The line on air (null when quiet), and lines said so far (scripts). */
  current: RadioLine | null = null
  readonly said: { t: number; line: RadioLine; take: number }[] = []
  private clock = 0
  private quietAt = 0
  private playing: Playing | null = null
  private pending: { line: RadioLine; at: number } | null = null
  private last = new Map<RadioLine, number>()
  private lastTake = new Map<RadioLine, number>()
  private sub: HTMLElement | null = null
  private subUntil = 0
  private curve: Float32Array<ArrayBuffer> | null = null
  private curveDrive = 0

  constructor(
    readonly mixer: Mixer = sharedMixer(),
    readonly bank: SfxBank = sfx(mixer),
    subtitles = typeof document !== "undefined",
  ) {
    if (subtitles) {
      if (!document.getElementById("radio-css")) {
        const style = document.createElement("style")
        style.id = "radio-css"
        style.textContent = CSS
        document.head.append(style)
      }
      this.sub = document.createElement("div")
      this.sub.id = "radio-sub"
      document.body.append(this.sub)
    }
  }

  /** Asks for a line. False when it is dropped (off, cooling down, or something as urgent is on air or waiting). */
  say(line: RadioLine): boolean {
    if (!RADIO.enabled) return false
    const spec = RADIO_LINES[line]
    if (this.clock - (this.last.get(line) ?? -1e9) < spec.cooldown) return false
    const on = this.playing && this.playing.end > this.clock ? this.playing : null
    if ((on && on.prio >= spec.prio) || (!on && this.clock < this.quietAt)) {
      // Wait for the air, unless something at least as urgent is already waiting.
      if (this.pending && RADIO_LINES[this.pending.line].prio >= spec.prio) return false
      this.pending = { line, at: this.clock }
      return true
    }
    on?.stop(0.04)
    this.speak(line)
    return true
  }

  /** Every frame: the clock, waiting lines and the subtitle. */
  update(dt: number): void {
    this.clock += dt
    if (this.playing && this.playing.end <= this.clock) {
      this.playing = null
      this.current = null
      this.quietAt = this.clock + RADIO.gap
    }
    const p = this.pending
    if (p && !this.playing && this.clock >= this.quietAt) {
      this.pending = null
      if (this.clock - p.at <= RADIO.wait && RADIO.enabled) this.speak(p.line)
    }
    if (this.sub && this.subUntil && this.clock > this.subUntil) {
      this.sub.classList.remove("on")
      this.subUntil = 0
    }
  }

  /** Stops whatever is on air and forgets waiting lines (leaving a room). */
  reset(): void {
    this.playing?.stop(0.05)
    this.playing = null
    this.pending = null
    this.current = null
    this.sub?.classList.remove("on")
  }

  private speak(line: RadioLine): void {
    const spec = RADIO_LINES[line]
    this.last.set(line, this.clock)
    const slot = `radio-${line}`
    const takes = this.bank.takesFor(slot).filter((t) => this.bank.get(slot, t))
    const prev = this.lastTake.get(line)
    const choices = takes.length > 1 ? takes.filter((t) => t !== prev) : takes
    const take = choices[Math.floor(Math.random() * choices.length)] ?? 0
    if (take) this.lastTake.set(line, take)
    const buf = take ? this.bank.get(slot, take) : null
    // Without the take (not loaded yet, muted): the squelch and the subtitle still carry it.
    const voice = buf ? buf.duration : 0.4 + spec.text.length * 0.055
    const total = 0.07 + voice + 0.18
    const stop = this.air(buf, voice)
    this.playing = { line, prio: spec.prio, end: this.clock + total, stop }
    this.current = line
    this.said.push({ t: this.clock, line, take })
    if (this.sub && RADIO.subtitles) {
      this.sub.innerHTML = `<b>◉</b>${spec.text}`
      this.sub.classList.add("on")
      this.subUntil = this.clock + total + 0.6
    }
  }

  /** Builds the radio for one transmission: open squelch, the voice through the radio, close squelch. */
  private air(buf: AudioBuffer | null, voice: number): (fade: number) => void {
    const m = this.mixer
    const ctx = m.ctx
    if (!ctx || m.muted || !m.bus) return () => undefined
    const k = RADIO
    const t0 = ctx.currentTime + 0.01
    const vStart = t0 + 0.06
    const vEnd = vStart + voice
    const end = vEnd + 0.2
    const out = ctx.createGain()
    out.gain.value = 1
    out.connect(m.bus.radio)
    const nodes: AudioScheduledSourceNode[] = []

    // The voice: band-pass, a presence peak, saturation, then a gentle top-end roll-off.
    if (buf) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      const hp = ctx.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = k.lowHz
      hp.Q.value = 0.8
      const peak = ctx.createBiquadFilter()
      peak.type = "peaking"
      peak.frequency.value = 1900
      peak.Q.value = 1.1
      peak.gain.value = k.presence
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = k.highHz
      lp.Q.value = 0.9
      const pre = ctx.createGain()
      pre.gain.value = 1.4
      const shaper = ctx.createWaveShaper()
      shaper.curve = this.shape(k.drive)
      shaper.oversample = "2x"
      const post = ctx.createBiquadFilter()
      post.type = "lowpass"
      post.frequency.value = k.highHz * 1.4
      const g = ctx.createGain()
      // Saturation adds level: hold the loudness about where the clean take was.
      g.gain.value = (k.level * 0.55) / Math.sqrt(k.drive)
      src.connect(hp).connect(peak).connect(lp).connect(pre).connect(shaper).connect(post).connect(g).connect(out)
      src.start(vStart)
      nodes.push(src)
    }

    // Static: a burst as the key opens and a longer one as it lets go, a faint hiss between, and a click at each end.
    const noise = m.noise.white
    const hiss = ctx.createBufferSource()
    hiss.buffer = noise
    hiss.loop = true
    // Radio static lives in the same band as the voice.
    const bp = ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.value = 2200
    bp.Q.value = 1.2
    const bl = ctx.createBiquadFilter()
    bl.type = "lowpass"
    bl.frequency.value = k.highHz * 1.3
    const hg = ctx.createGain()
    const p = hg.gain
    p.setValueAtTime(0, t0)
    p.linearRampToValueAtTime(k.squelch, t0 + 0.004)
    p.setTargetAtTime(k.hiss, t0 + 0.03, 0.015)
    p.setValueAtTime(k.hiss, vEnd)
    p.linearRampToValueAtTime(k.squelch * 0.9, vEnd + 0.01)
    p.setTargetAtTime(k.squelch * 0.5, vEnd + 0.04, 0.04)
    p.setTargetAtTime(0, vEnd + 0.14, 0.012)
    hiss.connect(bp).connect(bl).connect(hg).connect(out)
    hiss.start(t0, Math.random() * 3)
    hiss.stop(end + 0.1)
    nodes.push(hiss)
    for (const at of [t0, vEnd + 0.17]) {
      const click = ctx.createOscillator()
      click.type = "square"
      click.frequency.value = 1400
      const cg = ctx.createGain()
      cg.gain.setValueAtTime(0, at)
      cg.gain.linearRampToValueAtTime(k.squelch * 0.6, at + 0.001)
      cg.gain.setTargetAtTime(0, at + 0.002, 0.004)
      click.connect(cg).connect(out)
      click.start(at)
      click.stop(at + 0.04)
      nodes.push(click)
    }
    if (k.duck < 1) m.duck(k.duck, voice + 0.15, 0.05, false)
    hiss.onended = () => out.disconnect()
    return (fade) => {
      const t = ctx.currentTime
      out.gain.cancelScheduledValues(t)
      out.gain.setTargetAtTime(0, t, fade / 3)
      for (const n of nodes) {
        try {
          n.stop(t + fade + 0.02)
        } catch {
          // Already stopped.
        }
      }
    }
  }

  private shape(drive: number): Float32Array<ArrayBuffer> {
    if (this.curve && this.curveDrive === drive) return this.curve
    const n = 1024
    const c = new Float32Array(n)
    const norm = Math.tanh(drive)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      c[i] = Math.tanh(x * drive) / norm
    }
    this.curve = c
    this.curveDrive = drive
    return c
  }
}
