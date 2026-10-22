import { SoundBank } from "@arcade/kit/audio"
import { Footsteps, type FootEvent, type FootSurface } from "@arcade/kit/audio/footsteps"
import type { LabControl, LabPanel } from "@arcade/kit/lab-panel"
import { DISTANT_SOUNDS, placeDistant, type DistantEvent, type DistantSound } from "../../shared/distant"
import { SIGNAL_HOLD_SECONDS, type WoodsEvent, type WoodsState } from "../../shared/sim"
import type { VoiceEvent } from "../../shared/voices"
import type { WoodsWorld } from "../../shared/world"
import { WOODS_SFX } from "../sfx"
import { SOUND, SOUND_CONTROLS, type SoundSettings } from "./settings"
import { Soundscape, type Listener, type SoundLayer } from "./soundscape"
import { BRUSH_IDS, VOICE, VOICE_CONTROLS, VoiceBus, voiceHeard, type VoiceSettings } from "./voices"

export { Soundscape, type Listener, type SoundLayer } from "./soundscape"
export { VOICE, VoiceBus, voiceHeard, type VoiceSettings } from "./voices"

const LAYERS: SoundLayer[] = ["wind", "creaks", "room", "leaves", "insects", "lake", "dock", "lights", "walls", "distant"]

/** Footsteps (the shared quiet bank, #398 levels), the soundscape and the searchers' voices, each on its player level, through one limiter. */
export class WoodsMix {
  readonly feet: Footsteps
  readonly scape: Soundscape
  readonly feetOut: GainNode
  readonly scapeOut: GainNode
  readonly voices: VoiceBus
  readonly limiter: DynamicsCompressorNode

  constructor(readonly ctx: BaseAudioContext, sound: SoundSettings, baseUrl: string, world: () => WoodsWorld, voice: VoiceSettings = VOICE, fetcher?: (url: string) => Promise<ArrayBuffer>) {
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.limiter.connect(ctx.destination)
    this.feetOut = ctx.createGain()
    this.scapeOut = ctx.createGain()
    // Silent until `levels` says otherwise, so starting muted never leaks the first fade-in.
    this.feetOut.gain.value = 0
    this.scapeOut.gain.value = 0
    this.feetOut.connect(this.limiter)
    this.scapeOut.connect(this.limiter)
    this.feet = new Footsteps(ctx, this.feetOut)
    this.scape = new Soundscape(ctx, this.scapeOut, sound, baseUrl, world)
    this.voices = new VoiceBus(ctx, this.limiter, voice, baseUrl, world, fetcher)
  }

  /** Player volumes in 0..1 (master × effects for feet, master × ambience for the woods, master × voice); mute silences all. */
  levels(master: number, effects: number, ambience: number, muted: boolean, voice = 1): void {
    const now = this.ctx.currentTime
    this.feetOut.gain.setTargetAtTime(muted ? 0 : master * effects, now, 0.05)
    this.scapeOut.gain.setTargetAtTime(muted ? 0 : master * ambience, now, 0.05)
    this.voices.out.gain.setTargetAtTime(muted ? 0 : master * voice, now, 0.05)
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
  /** Searchers' lines (`shared/voices.ts`). */
  voices?: VoiceEvent[]
  /** Someone was signalling (distant sounds that start now fade out). */
  signal?: boolean
}

/**
 * The woods' sound: the shared library bank for UI cues, the shared quiet footsteps, and the soundscape (beds, tree
 * sounds, lake and camp, distant events). Nothing is created or fetched before Begin (`begin()`, from its click) or a
 * Lab audition; it all goes quiet while you are not playing (start screen, lost pointer lock, hidden tab). The sim owns
 * the distant-sound schedule (`shared/distant.ts` in `stepWoods`); this only plays its events.
 */
export class WoodsAudio {
  readonly bank = new SoundBank("woods", WOODS_SFX, { unlockOnGesture: false })
  readonly sound: SoundSettings = { ...SOUND }
  readonly voice: VoiceSettings = { ...VOICE }
  /** Each line as it reaches you (after its travel), for subtitles: whether you'd hear it, from how far. */
  onLine: ((e: VoiceEvent, heard: ReturnType<typeof voiceHeard>) => void) | null = null
  /** Lab-only: audition one distant sound, solo one layer. */
  readonly lab = { audition: 0, solo: -1 }
  mix: WoodsMix | null = null
  /** Set to [] to record a tape (automation). */
  tape: TapeFrame[] | null = null
  private tapeTime = 0
  private pending: Pick<TapeFrame, "steps" | "distant" | "voices"> = { steps: [], distant: [], voices: [] }
  private queued: DistantEvent[] = []
  private queuedVoices: VoiceEvent[] = []
  /** Lines heard before the mix existed (the context still starting): said once it does, unless long gone. */
  private waitingVoices: VoiceEvent[] = []
  /** Lines to have decoded ahead of time (the brush, the opening's): pinned in the bus once there is one. */
  private readonly wantVoices = new Set<string>(BRUSH_IDS)
  /** Lines on their way to you, for `onLine` when they arrive (page clock, s). */
  private arriving: { at: number; e: VoiceEvent; heard: ReturnType<typeof voiceHeard> }[] = []
  private clock = 0
  private listener: Listener = { x: 0, y: 1.7, z: 0, yaw: 0 }
  private sim = 0
  private world: WoodsWorld | null = null
  private begun = false
  private live = false
  private retryAt = 0
  private resuming = false

  constructor(private readonly baseUrl = typeof document === "undefined" ? "./audio/" : new URL("./audio/", document.baseURI).href) {
    if (typeof document === "undefined") return
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.quiet() })
    addEventListener("pagehide", () => this.quiet())
  }

  /** Begin (its click is the gesture): create or resume the context; the files load on the next playing frame. */
  begin(): void {
    this.begun = true
    void this.bank.unlock()
  }

  private running(): boolean {
    const ctx = this.bank.runtime.ctx
    return !!ctx && ctx.state === "running" && !this.bank.runtime.isOffline
  }

  /** The mix, created and loading once the context runs after Begin; failed files are fetched again every 10 s. */
  private ensureMix(): WoodsMix | null {
    if (!this.begun || !this.running()) return null
    const ctx = this.bank.runtime.ctx!
    if (!this.mix) {
      this.mix = new WoodsMix(ctx, this.sound, this.baseUrl, () => this.world!, this.voice)
      void this.mix.voices.preload(this.wantVoices)
      this.mix.scape.solo = LAYERS[this.lab.solo] ?? null
    }
    const scape = this.mix.scape
    if (!scape.complete && !scape.loading && ctx.currentTime >= this.retryAt) {
      this.retryAt = ctx.currentTime + 10
      void scape.load().catch((e) => console.warn("woods audio:", e))
    }
    return this.mix
  }

  /** Stops what is scheduled and suspends the context (hidden tab, lost pointer lock, start screen). */
  private quiet(): void {
    this.live = false
    this.queued.length = 0
    this.queuedVoices.length = 0
    this.waitingVoices.length = 0
    this.arriving.length = 0
    this.mix?.scape.stopAll()
    this.mix?.voices.stopAll()
    if (this.running()) this.bank.runtime.suspend()
  }

  /** `changed`: a Lab edit here the Escape menu also shows (the voices volume). */
  bindControls(panel: Pick<LabPanel, "addControls">, changed: () => void = () => {}): void {
    this.bank.bindControls(panel)
    panel.addControls(this.sound, SOUND_CONTROLS)
    const controls: LabControl[] = [
      { key: "audition", label: "Distant sound", group: "Sound", subsection: "Audition", type: "select", options: DISTANT_SOUNDS.map((s, i) => ({ value: i, label: s.slice(4) })) },
      { key: "auditionPlay", label: "Play it somewhere out there", group: "Sound", subsection: "Audition", type: "action", run: () => { void this.auditionNow(DISTANT_SOUNDS[this.lab.audition] ?? "far.owl") } },
      { key: "solo", label: "Solo a layer", group: "Sound", subsection: "Audition", type: "select", options: [{ value: -1, label: "Everything" }, ...LAYERS.map((l, i) => ({ value: i, label: l }))], change: (v) => { if (this.mix) this.mix.scape.solo = LAYERS[Number(v)] ?? null } },
    ]
    panel.addControls(this.lab, controls)
    panel.addControls(this.bank.volumes, [{ key: "volumeVoice", label: "Voices volume", group: "Voices", min: 0, max: 100, step: 1, unit: "%", change: () => { this.bank.applyVolumes(); changed() } }])
    panel.addControls(this.voice, VOICE_CONTROLS)
  }

  /**
   * Once per frame, after the session ticked and its events went to `event()`: the ears at the eye, facing `yaw`.
   * `live` is whether you can hear the woods now (playing, or the Lab panel open after Begin).
   */
  frame(eye: readonly number[], yaw: number, dt: number, world: WoodsWorld, state: WoodsState, live: boolean): void {
    this.world = world
    this.sim = state.t
    this.listener = { x: eye[0]!, y: eye[1]!, z: eye[2]!, yaw }
    this.bank.listen(eye[0]!, eye[2]!, 1.7)
    const signalling = state.players.some((p) => p.signal > SIGNAL_HOLD_SECONDS)
    if (live && this.begun && !(typeof document !== "undefined" && document.hidden)) {
      this.live = true
      if (!this.running() && !this.resuming) {
        this.resuming = true
        void this.bank.runtime.resume().finally(() => { this.resuming = false })
      }
    } else if (this.live) this.quiet()
    const mix = this.live ? this.ensureMix() : null
    for (const e of this.queued) {
      this.pending.distant.push(e)
      if (mix?.scape.loaded) mix.scape.distant(e, this.listener, this.sim)
    }
    this.queued.length = 0
    this.clock += dt
    for (const e of this.queuedVoices) {
      this.pending.voices!.push(e)
      const heard = voiceHeard(world, e, this.listener, this.voice)
      this.waitingVoices.push(e)
      const late = Math.max(0, this.sim - e.at)
      if (late < heard.delay + 2) this.arriving.push({ at: this.clock + Math.max(0, heard.delay - late), e, heard })
    }
    this.queuedVoices.length = 0
    // The bus decodes each line on first use and places it by how much of its travel has passed.
    if (mix) for (const e of this.waitingVoices.splice(0)) mix.voices.say(e, this.listener, this.sim)
    else this.waitingVoices = this.waitingVoices.filter((e) => this.sim - e.at < 20)
    for (let i = this.arriving.length - 1; i >= 0; i--) {
      const a = this.arriving[i]!
      if (a.at > this.clock) continue
      this.arriving.splice(i, 1)
      this.onLine?.(a.e, a.heard)
    }
    if (this.tape) {
      this.tapeTime += dt
      this.tape.push({ t: this.tapeTime, sim: state.t, l: this.listener, signal: signalling, ...this.pending })
    }
    this.pending = { steps: [], distant: [], voices: [] }
    if (!mix) return
    const v = this.bank.volumes
    mix.levels(v.volumeMaster / 100, v.volumeEffects / 100, v.volumeAmbience / 100, this.bank.muted, v.volumeVoice / 100)
    mix.scape.update(this.listener, state.t, signalling)
    mix.voices.update(this.listener)
  }

  /** The session's events: a distant event plays where it happens, on the next `frame` (with that frame's clock). */
  event(e: WoodsEvent): void {
    if (e.kind === "distant" && (this.live || this.tape)) this.queued.push(e)
    // Lines are read even while the woods are silent (subtitles), but only once you're out there.
    if (e.kind === "voice" && (this.live || this.tape)) this.queuedVoices.push(e)
  }

  /** Have these lines decoded before they're needed (the opening's, from `StoryHud`). */
  preloadVoices(ids: Iterable<string>): void {
    for (const id of ids) this.wantVoices.add(id)
    if (this.mix) void this.mix.voices.preload(ids)
  }

  /** Plays one distant sound where the schedule would put it now. Automation and the proof; plays only once loaded. */
  audition(sound: DistantSound, seed = (this.sim * 1000) | 0): DistantEvent | null {
    if (!this.world) return null
    const e = placeDistant(this.world, sound, this.listener, this.sim, seed)
    if (e) this.queued.push(e)
    return e
  }

  /** The Lab's audition button (a gesture, so it may start the sound before Begin): waits for the files, then plays. */
  private async auditionNow(sound: DistantSound): Promise<void> {
    this.begun = true
    if (!(await this.bank.unlock())) return
    this.live = true
    const mix = this.ensureMix()
    if (!mix) return
    if (!mix.scape.loaded) await mix.scape.load().catch(() => {})
    this.audition(sound)
  }

  /** Footstep and cloth contacts from the walk clock (`Walk.events`, sample-accurate) or a friend's gait. */
  steps(events: readonly FootEvent[], surface: FootSurface, walkTime: number, gain = 1): void {
    if (!events.length) return
    if (this.tape) this.pending.steps.push({ events: events.map((e) => ({ ...e })), surface, walkTime, gain })
    if (this.live && this.mix && this.running()) this.mix.feet.play(events, surface, walkTime, gain)
  }

  play(id: (typeof WOODS_SFX)[number], x?: number, z?: number, gain = 1): void {
    if (this.live && this.running()) this.bank.play(id, x, z, { gain })
  }

  /**
   * Renders a tape through the same mix in an OfflineAudioContext (never to the speakers). `solo` keeps one layer;
   * `footsteps: false` drops the feet.
   */
  async renderTape(tape: readonly TapeFrame[], world: WoodsWorld, seconds: number, opts: { solo?: SoundLayer | null; footsteps?: boolean; voices?: boolean; sound?: Partial<SoundSettings>; volume?: { master: number; effects: number; ambience: number; voice?: number }; fetcher?: (url: string) => Promise<ArrayBuffer>; ctx?: OfflineAudioContext } = {}): Promise<AudioBuffer> {
    const sr = 48000
    const ctx = opts.ctx ?? new OfflineAudioContext(2, Math.ceil(seconds * sr), sr)
    const mix = new WoodsMix(ctx, { ...this.sound, ...opts.sound }, this.baseUrl, () => world, this.voice, opts.fetcher)
    mix.scape.solo = opts.solo ?? null
    await mix.scape.load(opts.fetcher)
    // Offline, every line on the tape is decoded up front so each starts on its frame.
    if (opts.voices !== false) await mix.voices.preload([...BRUSH_IDS, ...tape.flatMap((f) => (f.voices ?? []).map((e) => e.line))])
    const b = this.bank.volumes
    const v = opts.volume ?? { master: b.volumeMaster / 100, effects: b.volumeEffects / 100, ambience: b.volumeAmbience / 100, voice: b.volumeVoice / 100 }
    mix.feetOut.gain.value = v.master * v.effects
    mix.scapeOut.gain.value = v.master * v.ambience
    mix.voices.out.gain.value = opts.voices === false ? 0 : v.master * (v.voice ?? 1)
    let last = -1
    for (const f of tape) {
      if (f.t >= seconds - 0.05) break
      const at = Math.ceil((f.t * sr) / 128) * 128 / sr
      if (at <= last) continue
      last = at
      void ctx.suspend(at).then(() => {
        mix.scape.update(f.l, f.sim, f.signal ?? false)
        if (opts.footsteps !== false) for (const s of f.steps) mix.feet.play(s.events, s.surface, s.walkTime, s.gain)
        for (const e of f.distant) mix.scape.distant(e, f.l, f.sim)
        mix.voices.update(f.l)
        for (const e of f.voices ?? []) mix.voices.say(e, f.l, f.sim)
        void ctx.resume()
      })
    }
    return ctx.startRendering()
  }
}
