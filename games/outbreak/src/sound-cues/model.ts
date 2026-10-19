/**
 * Sound cues (AR-67), the pure half: which noises the HUD shows, what to call them, whose they are, how far the dead
 * hear them, and how each cue moves through its life. No DOM; `overlay.ts` draws it.
 *
 * Every cue comes from a noise the crowd hears (`sim.ai.noiseBus`), so what the player sees is what the dead hear: the
 * ring is the reach one of the dead has for that noise right now, in the open, or what is left of it outside a shut
 * building (`shared/hearing.ts`).
 */

/** Whose noise: yours, a teammate's, one of the dead's, or the world's (alarms, radios, dogs, traps). */
export type CueSource = "self" | "ally" | "dead" | "world"

export type SoundCue = {
  /** The noise bus id; a cue keeps it for life. */
  readonly id: number
  readonly kind: string
  readonly label: string
  readonly source: CueSource
  readonly urgent: boolean
  readonly x: number
  readonly y: number
  /** Metres the dead hear it from where it was made (open air, or inside its building). */
  readonly reach: number
  /** Metres it still carries outside a shut building it was made in; null when made outdoors or through an opening. */
  readonly outside: number | null
  readonly born: number
  readonly life: number
}

const LABELS: Readonly<Record<string, string>> = {
  gunshot: "Shot",
  glass: "Glass",
  bash: "Banging",
  vault: "Climbing",
  shove: "Scuffle",
  door: "Door",
  window: "Window",
  search: "Rummaging",
  barricade: "Hammering",
  groan: "Groan",
  alarm: "Alarm",
  radio: "Radio",
  lure: "Noisemaker",
  generator: "Generator",
  flare: "Flare",
  fuse: "Fuse",
  explosion: "Blast",
  firecracker: "Firecrackers",
  flamethrower: "Flamer",
  trap: "Trap",
  crash: "Crash",
  horn: "Horn",
  bark: "Dog",
  shriek: "Shriek",
  bloater: "Burst",
  cans: "Cans",
  reload: "Reload",
}

const URGENT = new Set(["gunshot", "explosion", "shriek", "alarm", "crash", "horn", "firecracker"])
/** Footsteps are continuous: yours draw as the steady ring at your feet, a teammate's as nothing. */
export const CONTINUOUS_KINDS: ReadonlySet<string> = new Set(["footstep", "sprint"])

/** What the label says for a noise kind ("Noise" for kinds nobody named). */
export function cueLabel(kind: string): string {
  return LABELS[kind] ?? "Noise"
}

/** Who made a noise, from its bus source id, the local survivor's id and the other survivors' ids. */
export function cueSource(sourceId: string, selfId: string, allies: ReadonlySet<string>): CueSource {
  if (sourceId === selfId) return "self"
  if (allies.has(sourceId)) return "ally"
  if (sourceId.startsWith("zombie") || sourceId.startsWith("shriek") || sourceId.startsWith("bloater")) return "dead"
  return "world"
}

/** How long a cue stays (s): longer for louder noises, as their rings are bigger. */
export function cueLife(reach: number): number {
  return Math.min(2.4, Math.max(1.2, 1.0 + reach * 0.05))
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
/** Kit's enter curve, cubic-bezier(.2,.8,.2,1), approximated as an ease-out quart. */
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 4)
/** Exits accelerate away, cubic-bezier(.4,0,1,1)-like. */
export const easeIn = (t: number) => Math.pow(clamp01(t), 2.2)

/** The wave's travel to the reach ring (s). */
export const WAVE_TIME = 0.6
/** Fade in, and the fade out that ends a cue (s): exits run shorter than entrances' travel. */
export const FADE_IN = 0.18
export const FADE_OUT = 0.45

/**
 * A cue's look at `age` seconds: the wavefront (0..1 of the reach, with its opacity) running out once, the reach ring
 * fading in and holding, then everything fading out together. Reduced motion keeps the fades and drops the travel.
 */
export function cueFrame(age: number, life: number, reduced = false): { wave: number; waveAlpha: number; alpha: number; lift: number } {
  const u0 = clamp01(age / FADE_IN)
  const fadeIn = u0 * u0 * (3 - 2 * u0)
  const fadeOut = 1 - easeIn((age - (life - FADE_OUT)) / FADE_OUT)
  const alpha = clamp01(Math.min(fadeIn, fadeOut))
  if (reduced) return { wave: 1, waveAlpha: 0, alpha, lift: 0 }
  const u = age / WAVE_TIME
  return {
    wave: easeOut(u),
    waveAlpha: u >= 1 ? 0 : Math.pow(1 - u, 1.6),
    alpha,
    lift: (1 - easeOut(age / 0.3)) * 4,
  }
}

export type NoiseLike = { id: number; x: number; y: number; radius: number; kind: string; sourceId: string; time: number }

/**
 * Keeps the live cues: each new noise on the bus (by id) becomes one cue, continuous footsteps excepted; cues leave
 * when their life is up. `reachOf` turns a noise into the reach the dead have for it, and what is left outside.
 */
export class SoundCueModel {
  readonly cues: SoundCue[] = []
  private lastId = 0

  observe(
    noises: readonly NoiseLike[],
    selfId: string,
    allies: ReadonlySet<string>,
    now: number,
    reachOf: (n: NoiseLike) => { reach: number; outside: number | null },
  ): void {
    let maxId = 0
    for (const n of noises) maxId = Math.max(maxId, n.id)
    // A restored or new session restarts the ids: forget the old ones.
    if (maxId < this.lastId) {
      this.lastId = 0
      this.cues.length = 0
    }
    for (const n of noises) {
      if (n.id <= this.lastId) continue
      if (CONTINUOUS_KINDS.has(n.kind)) continue
      const { reach, outside } = reachOf(n)
      if (reach < 0.5) continue
      const source = cueSource(n.sourceId, selfId, allies)
      this.cues.push({
        id: n.id,
        kind: n.kind,
        label: cueLabel(n.kind),
        source,
        urgent: URGENT.has(n.kind) || (source === "dead" && n.kind === "bash"),
        x: n.x,
        y: n.y,
        reach,
        outside,
        born: now,
        life: cueLife(outside ?? reach),
      })
    }
    this.lastId = Math.max(this.lastId, maxId)
    for (let i = this.cues.length - 1; i >= 0; i--) if (now - this.cues[i]!.born >= this.cues[i]!.life) this.cues.splice(i, 1)
    // Never more than a dozen at once: the oldest go first.
    if (this.cues.length > 12) this.cues.splice(0, this.cues.length - 12)
  }

  reset(): void {
    this.cues.length = 0
    this.lastId = 0
  }
}

/** A critically damped spring step (duration `d` s, bounce 0) for values the overlay eases toward. */
export function springStep(state: { v: number; dv: number }, target: number, dt: number, d = 0.3): void {
  const w = (2 * Math.PI) / d
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    const a = w * w * (target - state.v) - 2 * w * state.dv
    state.dv += a * h
    state.v += state.dv * h
  }
}

/**
 * Where an off-screen point's arrow sits on the screen edge: along the line from the screen centre, `inset` px in.
 * Null when the point is on screen (inside the inset).
 */
export function edgeAnchor(
  px: number,
  py: number,
  w: number,
  h: number,
  inset: number,
): { x: number; y: number; angle: number } | null {
  if (px >= inset && px <= w - inset && py >= inset && py <= h - inset) return null
  const cx = w / 2
  const cy = h / 2
  const dx = px - cx
  const dy = py - cy
  const angle = Math.atan2(dy, dx)
  const sx = dx !== 0 ? (w / 2 - inset) / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? (h / 2 - inset) / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s, angle }
}
