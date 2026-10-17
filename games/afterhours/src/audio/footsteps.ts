import { LIBRARY_FILES } from "@arcade/kit/audio/library-files"
import type { WorldContext } from "../world/context"
import type { Player, StepEvent } from "../player"
import { insideBuilding } from "../render/atmosphere"
import { CORE, INTERIOR } from "../world/layout"
import { audio, setSpace, unlockAudio, type SharedAudio } from "./context"
import { surfaceAt, type Surface } from "./surfaces"
import type * as THREE from "three/webgpu"

// The walker's footsteps, driven by `Player.onStep`. Real recordings from the shared sound library
// (`foot.{concrete,grass,wood}.{walk,run}`, six steps each, loudness-matched; docs/sfx-library.md) are the body of
// each step; every other surface is one of them shaped (carpet muffled, tile and lino brightened, the access floor
// hollow) plus procedural layers the library has no recording for: steel ringing and rattling on grating, chequer
// plate and ladder rungs, gravel crunch, pine needles and the odd twig, and a splash on wet asphalt that follows the
// materials' wetness. Per step: no-repeat variant, pitch and gain jitter, the two feet slightly apart in pitch and pan,
// level by speed and crouch. Landings add a body thud, jumps a scuff. Steps go through the shared bus, so they pick up
// the room or outdoor reverb (`setSpace`, eased from `insideBuilding`, larger in the stairwell and lobby).
// Silent until the first input; never created in `?shot` mode.

type Kind = "walk" | "run"
type Base = "concrete" | "grass" | "wood"

const URLS = import.meta.glob("../../../../packages/kit/audio/sfx/foot.{concrete,grass,wood}.{walk,run}.*.ogg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>

/** How each surface uses a recording: which set, filter, level, pitch and the procedural layers on top. */
type Voicing = { base: Base; lp: number; hp: number; gain: number; pitch: number; layer?: (f: Footsteps, at: number, k: number) => void }

const VOICING: Record<Surface, Voicing> = {
  concrete: { base: "concrete", lp: 9000, hp: 60, gain: 1, pitch: 1 },
  linoleum: { base: "concrete", lp: 7000, hp: 140, gain: 0.85, pitch: 1.06, layer: (f, at, k) => f.tick(at, 3400, 0.05 * k) },
  tile: { base: "concrete", lp: 11000, hp: 180, gain: 0.95, pitch: 1.1, layer: (f, at, k) => f.tick(at, 4200, 0.09 * k) },
  carpet: { base: "concrete", lp: 900, hp: 60, gain: 0.5, pitch: 0.92, layer: (f, at, k) => f.rustle(at, 0.09, 1800, 0.06 * k) },
  raised: { base: "wood", lp: 5000, hp: 90, gain: 0.9, pitch: 1.05, layer: (f, at, k) => f.ring(at, [210, 470, 1130], 0.12, 0.12 * k) },
  wood: { base: "wood", lp: 9000, hp: 70, gain: 1, pitch: 1 },
  metal: { base: "concrete", lp: 6000, hp: 120, gain: 0.6, pitch: 0.95, layer: (f, at, k) => f.ring(at, [380, 960, 2210], 0.22, 0.16 * k) },
  grating: {
    base: "concrete",
    lp: 5000,
    hp: 200,
    gain: 0.45,
    pitch: 1,
    layer: (f, at, k) => {
      f.ring(at, [520, 1340, 2610, 3900], 0.35, 0.2 * k)
      f.rattle(at + 0.01, 3, 0.07 * k)
    },
  },
  gravel: { base: "grass", lp: 9000, hp: 200, gain: 0.7, pitch: 1.1, layer: (f, at, k) => f.crunch(at, 14, 0.16, 0.16 * k) },
  asphalt: { base: "concrete", lp: 6500, hp: 80, gain: 0.85, pitch: 0.97, layer: (f, at, k) => f.splash(at, k) },
  grass: { base: "grass", lp: 8000, hp: 60, gain: 0.9, pitch: 1 },
  forest: {
    base: "grass",
    lp: 7000,
    hp: 60,
    gain: 0.85,
    pitch: 0.95,
    layer: (f, at, k) => {
      f.rustle(at, 0.14, 3000, 0.05 * k)
      if (Math.random() < 0.07) f.crunch(at + 0.02, 4, 0.05, 0.22 * k)
    },
  },
  ladder: { base: "concrete", lp: 3000, hp: 300, gain: 0.25, pitch: 1.2, layer: (f, at, k) => f.ring(at, [640, 1710, 3050], 0.18, 0.2 * k) },
}

export class Footsteps {
  private buffers = new Map<string, AudioBuffer[]>()
  private gains = new Map<string, number[]>()
  private last = new Map<string, number>()
  private loading = false
  private out: GainNode | null = null
  private a: SharedAudio | null = null
  private indoor = 0
  /** Automation: steps played per surface, recordings decoded, and steps that fell back to the procedural stand-in. */
  readonly stats = { surfaces: {} as Record<string, number>, decoded: 0, fallback: 0 }

  constructor(
    private ctx: WorldContext,
    private player: Player,
  ) {
    ctx.settings["audio.footsteps"] ??= 0.8
    ctx.controls.push({ key: "audio.footsteps", label: "Footstep volume", group: "Audio", min: 0, max: 1.5, step: 0.05 })
    player.onStep((e) => this.step(e))
    ;(globalThis as { __afterhoursFootsteps?: Footsteps }).__afterhoursFootsteps = this
  }

  /** From a user-input handler: unlock the shared context and start fetching the recordings. */
  unlock() {
    const a = unlockAudio()
    if (!a || this.loading) return
    this.loading = true
    this.a = a
    this.out = a.ctx.createGain()
    this.out.connect(a.bus)
    for (const [path, url] of Object.entries(URLS)) {
      const file = path.slice(path.lastIndexOf("/") + 1)
      const m = /^foot\.(\w+)\.(walk|run)\.(\d+)\.ogg$/.exec(file)
      if (!m) continue
      const id = `foot.${m[1]}.${m[2]}`
      const gain = LIBRARY_FILES[id]?.find((f) => f.file === file)?.gain ?? 1
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => a.ctx.decodeAudioData(b))
        .then((buf) => {
          const list = this.buffers.get(id) ?? []
          const gains = this.gains.get(id) ?? []
          list.push(buf)
          gains.push(gain)
          this.buffers.set(id, list)
          this.gains.set(id, gains)
          this.stats.decoded++
        })
        .catch(() => {})
    }
  }

  /** Per frame: the reverb space follows the listener (eased through doorways). */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    if (!audio()) return
    const p = camera.position
    const inside = insideBuilding(p) ? 1 : 0
    this.indoor += (inside - this.indoor) * (1 - Math.exp(-dt * 4))
    // Big hard rooms: the stairwell and the lobby.
    const inRect = (r: { min: readonly [number, number]; max: readonly [number, number] }) => p.x >= r.min[0] && p.x <= r.max[0] && p.z >= r.min[1] && p.z <= r.max[1]
    const size = inRect(CORE.stair) ? 1 : inRect(INTERIOR.lobby) ? 0.7 : 0.25
    setSpace(this.indoor, size)
  }

  private step(e: StepEvent) {
    const a = audio()
    if (!a || !this.out) return
    const vol = Number(this.ctx.settings["audio.footsteps"] ?? 0.8)
    if (vol <= 0) return
    this.out.gain.value = vol
    const s = this.player.state
    const surface = surfaceAt(e.surface, s.pos.x, s.pos.y, s.pos.z)
    const v = VOICING[surface]
    this.stats.surfaces[surface] = (this.stats.surfaces[surface] ?? 0) + 1
    const crouch = 1 - 0.6 * s.crouch
    const at = a.ctx.currentTime + 0.005
    const right = e.foot === "right"
    const pan = right ? 0.07 : -0.07
    if (e.kind === "jump") {
      // Push-off: a short, light scuff and a little cloth.
      this.sample(a, v, "walk", at, 0.35 * crouch, pan, 1.08)
      this.rustle(at, 0.12, 2400, 0.03)
      return
    }
    const run = e.kind === "land" || s.running
    const level = (0.45 + 0.55 * e.intensity) * crouch * (e.kind === "land" ? 1.25 : 1)
    this.sample(a, v, run ? "run" : "walk", at, level, pan, right ? 1.02 : 0.98)
    v.layer?.(this, at, level)
    if (e.kind === "land") {
      // The body coming down: a low thud under the step.
      const o = a.ctx.createOscillator()
      o.frequency.setValueAtTime(95, at)
      o.frequency.exponentialRampToValueAtTime(48, at + 0.12)
      const g = a.ctx.createGain()
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.35 * e.intensity + 0.1, at + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25)
      o.connect(g).connect(this.out)
      o.start(at)
      o.stop(at + 0.3)
      // The second foot a beat later.
      this.sample(a, v, "run", at + 0.07, level * 0.6, -pan, 0.97)
    }
  }

  /** One recording through the surface's filters; no immediate repeat, ±4% pitch, ±15% gain. */
  private sample(a: SharedAudio, v: Voicing, kind: Kind, at: number, level: number, pan: number, foot: number) {
    const id = `foot.${v.base}.${kind}`
    const list = this.buffers.get(id)
    if (!list?.length) {
      this.stats.fallback++
      return this.procedural(at, v, level, pan)
    }
    let i = Math.floor(Math.random() * list.length)
    if (list.length > 1 && i === this.last.get(id)) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length
    this.last.set(id, i)
    const src = a.ctx.createBufferSource()
    src.buffer = list[i]!
    src.playbackRate.value = v.pitch * foot * (0.96 + Math.random() * 0.08)
    const hp = a.ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = v.hp
    const lp = a.ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = v.lp
    const g = a.ctx.createGain()
    g.gain.value = level * v.gain * (this.gains.get(id)?.[i] ?? 1) * (0.85 + Math.random() * 0.3) * 1.6
    const p = a.ctx.createStereoPanner()
    p.pan.value = pan
    src.connect(hp).connect(lp).connect(g).connect(p).connect(this.out!)
    src.start(at)
  }

  /** Stand-in while the recordings load (or if they fail): a soft heel-toe noise pair. */
  private procedural(at: number, v: Voicing, level: number, pan: number) {
    this.burst(at, 0.05, Math.min(v.lp, 2200), 120, 0.25 * level * v.gain, pan)
    this.burst(at + 0.045, 0.04, Math.min(v.lp, 3200), 300, 0.12 * level * v.gain, pan)
  }

  private burst(at: number, len: number, lpHz: number, hpHz: number, gain: number, pan = 0) {
    const a = this.a
    if (!a || !this.out) return
    const src = a.ctx.createBufferSource()
    src.buffer = a.noise
    const hp = a.ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = hpHz
    const lp = a.ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = lpHz
    const g = a.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    const p = a.ctx.createStereoPanner()
    p.pan.value = pan
    src.connect(hp).connect(lp).connect(g).connect(p).connect(this.out)
    src.start(at, Math.random() * 1.8, len + 0.02)
  }

  /** A hard heel tick (tile, lino). */
  tick(at: number, hz: number, gain: number) {
    this.burst(at + 0.002, 0.012, hz * 2, hz, gain)
  }

  /** Fabric or needles brushing: a soft, longer noise swell. */
  rustle(at: number, len: number, hz: number, gain: number) {
    const a = this.a
    if (!a || !this.out) return
    const src = a.ctx.createBufferSource()
    src.buffer = a.noise
    const bp = a.ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.value = hz
    bp.Q.value = 0.8
    const g = a.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + len * 0.3)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    src.connect(bp).connect(g).connect(this.out)
    src.start(at, Math.random() * 1.8, len + 0.02)
  }

  /** Steel plate or grating struck: decaying inharmonic partials, the upper ones dying faster. */
  ring(at: number, partials: number[], decay: number, gain: number) {
    const a = this.a
    if (!a || !this.out) return
    const detune = 0.97 + Math.random() * 0.06
    partials.forEach((hz, i) => {
      const o = a.ctx.createOscillator()
      o.frequency.value = hz * detune
      const g = a.ctx.createGain()
      const d = decay / (1 + i * 0.6)
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(gain / (1 + i * 0.7), at + 0.002)
      g.gain.exponentialRampToValueAtTime(0.0001, at + d)
      o.connect(g).connect(this.out!)
      o.start(at)
      o.stop(at + d + 0.02)
    })
  }

  /** Loose grating bars knocking. */
  rattle(at: number, n: number, gain: number) {
    for (let i = 0; i < n; i++) this.burst(at + i * 0.018 + Math.random() * 0.012, 0.018, 6000, 1800, gain * (1 - i * 0.2))
  }

  /** Gravel / twigs: many tiny grains over `len` seconds. */
  crunch(at: number, grains: number, len: number, gain: number) {
    for (let i = 0; i < grains; i++) {
      const t = at + Math.random() ** 1.6 * len
      this.burst(t, 0.006 + Math.random() * 0.01, 7000, 1500 + Math.random() * 2500, gain * (0.4 + Math.random() * 0.6))
    }
  }

  /** Wet asphalt: a short splash scaled by the materials' wetness, now and then a puddle. */
  splash(at: number, k: number) {
    const wet = Number(this.ctx.settings["materials.wetness"] ?? 1)
    if (wet <= 0.05) return
    const puddle = Math.random() < 0.18 * wet
    const a = this.a
    if (!a || !this.out) return
    const src = a.ctx.createBufferSource()
    src.buffer = a.noise
    const bp = a.ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.setValueAtTime(puddle ? 1400 : 2600, at)
    bp.frequency.exponentialRampToValueAtTime(puddle ? 700 : 1800, at + 0.12)
    bp.Q.value = 0.9
    const g = a.ctx.createGain()
    const peak = wet * k * (puddle ? 0.3 : 0.11)
    g.gain.setValueAtTime(0, at + 0.01)
    g.gain.linearRampToValueAtTime(peak, at + 0.025)
    g.gain.exponentialRampToValueAtTime(0.0001, at + (puddle ? 0.28 : 0.12))
    src.connect(bp).connect(g).connect(this.out)
    src.start(at, Math.random() * 1.8, 0.35)
    // Droplets flicking off the sole.
    for (let i = 0; i < (puddle ? 6 : 2); i++) this.burst(at + 0.04 + Math.random() * 0.12, 0.01, 6000, 2500, peak * 0.4)
  }
}
