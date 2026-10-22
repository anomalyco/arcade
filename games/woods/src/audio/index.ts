import { SoundBank } from "@arcade/kit/audio"
import { Footsteps, type FootEvent, type FootSurface } from "@arcade/kit/audio/footsteps"
import type { LabControl, LabPanel } from "@arcade/kit/lab-panel"
import { createDistant, DISTANT_SOUNDS, holdDistant, placeDistant, stepDistant, type DistantEvent, type DistantSound } from "../../shared/distant"
import type { WoodsEvent, WoodsState } from "../../shared/sim"
import type { WoodsWorld } from "../../shared/world"
import { WOODS_SFX } from "../sfx"
import { SOUND, SOUND_CONTROLS, type SoundSettings } from "./settings"
import { Soundscape, type Listener, type SoundLayer } from "./soundscape"

export { Soundscape, type Listener, type SoundLayer } from "./soundscape"

const LAYERS: SoundLayer[] = ["wind", "creaks", "room", "leaves", "insects", "lake", "dock", "lights", "walls", "distant"]

/** Footsteps (the shared quiet bank, #398 levels) and the soundscape, each on its player level, through one limiter. */
export class WoodsMix {
  readonly feet: Footsteps
  readonly scape: Soundscape
  readonly feetOut: GainNode
  readonly scapeOut: GainNode
  readonly limiter: DynamicsCompressorNode

  constructor(readonly ctx: BaseAudioContext, sound: SoundSettings, baseUrl: string, world: () => WoodsWorld) {
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.limiter.connect(ctx.destination)
    this.feetOut = ctx.createGain()
    this.scapeOut = ctx.createGain()
    this.feetOut.connect(this.limiter)
    this.scapeOut.connect(this.limiter)
    this.feet = new Footsteps(ctx, this.feetOut)
    this.scape = new Soundscape(ctx, this.scapeOut, sound, baseUrl, world)
  }

  /** Player volumes in 0..1 (master × effects for feet, master × ambience for the woods); mute silences both. */
  levels(master: number, effects: number, ambience: number, muted: boolean): void {
    const now = this.ctx.currentTime
    this.feetOut.gain.setTargetAtTime(muted ? 0 : master * effects, now, 0.05)
    this.scapeOut.gain.setTargetAtTime(muted ? 0 : master * ambience, now, 0.05)
  }
}

/** One frame of what the ears got, for rendering the same mix offline (the proof tape, the listening page). */
export type TapeFrame = {
  /** Seconds since recording began. */
  t: number
  sim: number
  l: Listener
  steps: { events: FootEvent[]; surface: FootSurface; walkTime: number; gain: number }[]
  distant: DistantEvent[]
}

/**
 * The woods' sound: the shared library bank for UI cues, the shared quiet footsteps, and the soundscape (beds, tree
 * sounds, lake and camp, distant events). Files load after Begin (the first gesture), never on page load.
 */
export class WoodsAudio {
  readonly bank = new SoundBank("woods", WOODS_SFX)
  readonly sound: SoundSettings = { ...SOUND }
  /** The distant-event schedule. Plain data: the sim can own it once a server does (see shared/distant.ts). */
  readonly distant = createDistant(1987)
  /** Lab-only: audition one distant sound, solo one layer. */
  readonly lab = { audition: 0, solo: -1 }
  mix: WoodsMix | null = null
  /** Set to [] to record a tape (automation). */
  tape: TapeFrame[] | null = null
  private tapeTime = 0
  private pending: Pick<TapeFrame, "steps" | "distant"> = { steps: [], distant: [] }
  private listener: Listener = { x: 0, y: 1.7, z: 0, yaw: 0 }
  private sim = 0
  private world: WoodsWorld | null = null

  constructor(private readonly baseUrl = typeof document === "undefined" ? "./audio/" : new URL("./audio/", document.baseURI).href) {}

  private ready(): boolean {
    const ctx = this.bank.runtime.ctx
    if (!ctx || ctx.state !== "running" || this.bank.runtime.isOffline) return false
    if (!this.mix) {
      this.mix = new WoodsMix(ctx, this.sound, this.baseUrl, () => this.world!)
      this.mix.scape.solo = LAYERS[this.lab.solo] ?? null
      void this.mix.scape.load().catch((e) => console.warn("woods audio:", e))
    }
    return true
  }

  bindControls(panel: Pick<LabPanel, "addControls">): void {
    this.bank.bindControls(panel)
    panel.addControls(this.sound, SOUND_CONTROLS)
    const controls: LabControl[] = [
      { key: "audition", label: "Distant sound", group: "Sound", type: "select", options: DISTANT_SOUNDS.map((s, i) => ({ value: i, label: s.slice(4) })) },
      { key: "auditionPlay", label: "Play it somewhere out there", group: "Sound", type: "action", run: () => { this.audition(DISTANT_SOUNDS[this.lab.audition] ?? "far.owl") } },
      { key: "solo", label: "Solo a layer", group: "Sound", type: "select", options: [{ value: -1, label: "Everything" }, ...LAYERS.map((l, i) => ({ value: i, label: l }))], change: (v) => { if (this.mix) this.mix.scape.solo = LAYERS[Number(v)] ?? null } },
    ]
    panel.addControls(this.lab, controls)
  }

  /** Once per frame, after the sim: the ears at the eye, facing `yaw`. */
  frame(eye: readonly number[], yaw: number, dt: number, world: WoodsWorld, state: WoodsState): void {
    this.world = world
    this.sim = state.t
    this.listener = { x: eye[0]!, y: eye[1]!, z: eye[2]!, yaw }
    this.bank.listen(eye[0]!, eye[2]!, 1.7)
    const people = state.players.filter((p) => !p.bot)
    const e = stepDistant(this.distant, world, people, state.t, this.sound.distantRate)
    if (e) this.event(e)
    if (this.tape) {
      this.tapeTime += dt
      this.tape.push({ t: this.tapeTime, sim: state.t, l: this.listener, ...this.pending })
    }
    this.pending = { steps: [], distant: [] }
    if (!this.ready()) return
    const v = this.bank.volumes
    this.mix!.levels(v.volumeMaster / 100, v.volumeEffects / 100, v.volumeAmbience / 100, this.bank.muted)
    this.mix!.scape.update(this.listener, state.t)
  }

  /** Sim events: a signal keeps the woods quiet for a while; a distant event plays where it happens. */
  event(e: WoodsEvent | DistantEvent): void {
    if (e.kind === "signal") holdDistant(this.distant, this.sim + 8)
    if (e.kind !== "distant") return
    this.pending.distant.push(e)
    if (this.ready()) this.mix!.scape.distant(e, this.listener, this.sim)
  }

  /** A friend is talking (voice chat, later): no distant sound over them. */
  speaking(seconds = 3): void {
    holdDistant(this.distant, this.sim + seconds + 2)
  }

  /** Plays one distant sound where the schedule would put it now (the Lab's audition button). */
  audition(sound: DistantSound, seed = (this.sim * 1000) | 0): DistantEvent | null {
    if (!this.world) return null
    const e = placeDistant(this.world, sound, this.listener, this.sim, seed)
    if (e) this.event(e)
    return e
  }

  /** Footstep and cloth contacts from the walk clock (`Walk.events`, sample-accurate) or a friend's gait. */
  steps(events: readonly FootEvent[], surface: FootSurface, walkTime: number, gain = 1): void {
    if (!events.length) return
    if (this.tape) this.pending.steps.push({ events: events.map((e) => ({ ...e })), surface, walkTime, gain })
    if (!this.ready()) return
    this.mix!.feet.play(events, surface, walkTime, gain)
  }

  play(id: (typeof WOODS_SFX)[number], x?: number, z?: number, gain = 1): void {
    this.bank.play(id, x, z, { gain })
  }

  /**
   * Renders a tape through the same mix in an OfflineAudioContext (never to the speakers). `solo` keeps one layer;
   * `footsteps: false` drops the feet.
   */
  async renderTape(tape: readonly TapeFrame[], world: WoodsWorld, seconds: number, opts: { solo?: SoundLayer | null; footsteps?: boolean; sound?: Partial<SoundSettings>; volume?: { master: number; effects: number; ambience: number } } = {}): Promise<AudioBuffer> {
    const sr = 48000
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr)
    const mix = new WoodsMix(ctx, { ...this.sound, ...opts.sound }, this.baseUrl, () => world)
    mix.scape.solo = opts.solo ?? null
    await mix.scape.load()
    const v = opts.volume ?? { master: this.bank.volumes.volumeMaster / 100, effects: this.bank.volumes.volumeEffects / 100, ambience: this.bank.volumes.volumeAmbience / 100 }
    mix.feetOut.gain.value = v.master * v.effects
    mix.scapeOut.gain.value = v.master * v.ambience
    let last = -1
    for (const f of tape) {
      if (f.t >= seconds - 0.05) break
      const at = Math.ceil((f.t * sr) / 128) * 128 / sr
      if (at <= last) continue
      last = at
      void ctx.suspend(at).then(() => {
        mix.scape.update(f.l, f.sim)
        if (opts.footsteps !== false) for (const s of f.steps) mix.feet.play(s.events, s.surface, s.walkTime, s.gain)
        for (const e of f.distant) mix.scape.distant(e, f.l, f.sim)
        void ctx.resume()
      })
    }
    return ctx.startRendering()
  }
}
