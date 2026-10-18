import type { MotionKind } from "./motion"
import { unlockAudio } from "../../audio/context"
import { hooks } from "../../audio/hooks"
import { SFX } from "../../audio/sfx-manifest"

/** Time of a one-shot's loudest transient (s), from the build. */
const hitOf = (id: "door-fire-steel" | "gate-chainlink" | "light-switch") => SFX[id].variants[0]?.hit ?? 0

// Procedural door sounds (Web Audio, no samples). One-shots: the latch releasing, the latch catching on close, a
// locked door's rattle, roll-up ratchet ticks. Continuous, per moving door: a hinge creak whose stick-slip rate,
// pitch and loudness follow the leaf's speed, with irregular sticks and slips, plus a grinding roll and chain
// clinks for gates and a chain rumble for roll-ups. Uses the walker's shared AudioContext (src/audio/context.ts), unlocked
// on the first door use, which always comes from a key press. Never constructed in `?shot` mode.

export type DoorSound = "steel" | "wood" | "glass" | "gate"

/** What a door event needs to pick and place its recording. */
export type DoorVoice = { sound: DoorSound; kind: MotionKind; panic: boolean; control: boolean; x: number; y: number; z: number }

/**
 * How much of the procedural hinge creak stays under each kind of door: where a recording carries the door (office
 * wood's own creak, a roll-up's slats, the motorised gate), the creak is only a faint layer.
 */
function creakScale(sound: DoorSound, kind: MotionKind) {
  if (kind === "rollup" || kind === "slide") return 0.25
  if (sound === "wood") return 0.35
  if (kind === "gate") return 0.5
  return 0.55
}

type Voice = { ctx: AudioContext; out: AudioNode; t: number }

/** Per-material voicing: resonances of the leaf, thud weight, creak level and pitch. */
const VOICE: Record<DoorSound, { ring: number[]; thud: number; thudGain: number; creak: number; creakPitch: number; click: number }> = {
  steel: { ring: [620, 1480], thud: 58, thudGain: 0.95, creak: 0.7, creakPitch: 0.85, click: 2600 },
  wood: { ring: [240, 520], thud: 85, thudGain: 0.8, creak: 1, creakPitch: 1, click: 1900 },
  glass: { ring: [1900, 3400], thud: 120, thudGain: 0.45, creak: 0.25, creakPitch: 1.3, click: 3200 },
  gate: { ring: [900, 2300], thud: 66, thudGain: 0.6, creak: 0.9, creakPitch: 0.6, click: 2200 },
}

/** A moving door's continuous sound. */
type Loop = {
  osc: OscillatorNode
  creak: GainNode
  noise: AudioBufferSourceNode | null
  grind: GainNode | null
  grindFilter: BiquadFilterNode | null
  pan: StereoPannerNode
  wander: number
  stickUntil: number
  idle: number
}

export class DoorAudio {
  private ac: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private pulse: PeriodicWave | null = null
  private loops = new Map<string, Loop>()
  /** Procedural layer level (the doors bus carries the Lab's Doors knob). */
  volume = 1
  creakVolume = 1

  /** Call from a user-input handler; creates/resumes the shared context (src/audio/context.ts). */
  unlock() {
    const shared = unlockAudio()
    if (!shared || this.ac) return
    this.ac = shared.ctx
    this.master = this.ac.createGain()
    // Through the shared bus, so doors get the same room / outdoor reverb as footsteps.
    this.master.connect(shared.buses.doors)
    this.noise = shared.noise
    // An impulse train: each period is one stick-slip "release" that excites the leaf's resonances.
    const H = 48
    const real = new Float32Array(H + 1)
    const imag = new Float32Array(H + 1)
    for (let i = 1; i <= H; i++) real[i] = 1
    this.pulse = this.ac.createPeriodicWave(real, imag)
  }

  private get live() {
    return !!this.ac && !!this.master && this.ac.state === "running" && this.volume > 0
  }

  private voice(pan: number, delay = 0): Voice | null {
    const ac = this.ac
    if (!ac || !this.master || !this.live) return null
    this.master.gain.value = this.volume
    const p = ac.createStereoPanner()
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan))
    p.connect(this.master)
    return { ctx: ac, out: p, t: ac.currentTime + 0.005 + delay }
  }

  /** Short filtered noise burst through the leaf's resonances. */
  private burst(v: Voice, at: number, len: number, gain: number, hp: number, ring: number[]) {
    const src = v.ctx.createBufferSource()
    src.buffer = this.noise
    const f = v.ctx.createBiquadFilter()
    f.type = "highpass"
    f.frequency.value = hp
    const g = v.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    src.connect(f).connect(g)
    g.connect(v.out)
    for (const r of ring) {
      const b = v.ctx.createBiquadFilter()
      b.type = "bandpass"
      b.frequency.value = r
      b.Q.value = 18
      const bg = v.ctx.createGain()
      bg.gain.value = 0.9
      g.connect(b).connect(bg).connect(v.out)
    }
    src.start(at, Math.random() * 1.5, len + 0.05)
  }

  private thud(v: Voice, at: number, hz: number, gain: number) {
    const o = v.ctx.createOscillator()
    o.frequency.setValueAtTime(hz * 1.6, at)
    o.frequency.exponentialRampToValueAtTime(hz, at + 0.06)
    const g = v.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.26)
    o.connect(g).connect(v.out)
    o.start(at)
    o.stop(at + 0.3)
    const src = v.ctx.createBufferSource()
    src.buffer = this.noise
    const lp = v.ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 420
    const ng = v.ctx.createGain()
    ng.gain.setValueAtTime(gain * 0.7, at)
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.12)
    src.connect(lp).connect(ng).connect(v.out)
    src.start(at, Math.random() * 1.5, 0.15)
  }

  /** Chain links knocking: a cluster of bright, short bursts. */
  private chain(v: Voice, at: number, n: number, spread: number, gain: number) {
    for (let i = 0; i < n; i++) this.burst(v, at + Math.random() * spread, 0.035, gain * (0.5 + Math.random() * 0.5), 2400, VOICE.gate.ring)
  }

  /** A recorded door sound at the door (doors bus), `offset` s into the take. */
  private clip(id: "door-fire-steel" | "door-office-wood" | "door-panic-bar" | "door-rollup-dock" | "gate-chainlink" | "gate-motorized" | "light-switch", d: DoorVoice, gain: number, offset = 0) {
    return !!hooks.sfx?.play(id, { bus: "doors", pos: { x: d.x, y: d.y, z: d.z }, ref: 2, rolloff: 1.1, gain, offset, jitter: 0.02 })
  }

  /** A control (push button, switch) operated: one click. */
  control(d: DoorVoice) {
    this.clip("light-switch", d, 0.8, Math.max(0, hitOf("light-switch") - 0.03))
  }

  /** A roll-up or sliding gate starting to move (either way): its motor and slats. */
  moveStart(d: DoorVoice) {
    if (d.kind === "rollup") this.clip("door-rollup-dock", d, 0.9)
    else if (d.sound === "gate") this.clip("gate-motorized", d, 0.9)
  }

  /** A door at rest starting to open: the latch (or a gate's chain) releasing. */
  release(sound: DoorSound, kind: MotionKind, pan: number, d?: DoorVoice) {
    if (d?.panic && this.clip("door-panic-bar", d, 0.9)) return
    if (d && sound === "wood" && kind === "swing" && this.clip("door-office-wood", d, 0.85)) return
    if (d && kind === "gate" && this.clip("gate-chainlink", d, 0.8)) return
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[sound]
    if (kind === "gate") {
      this.chain(v, v.t, 7, 0.32, 0.22)
      this.thud(v, v.t + 0.3, s.thud * 1.2, s.thudGain * 0.35)
    } else if (kind === "rollup") {
      this.chain(v, v.t, 4, 0.2, 0.16)
      this.thud(v, v.t + 0.05, 48, 0.5)
    } else {
      this.burst(v, v.t, 0.03, 0.32, s.click, s.ring)
      this.burst(v, v.t + 0.07, 0.02, 0.16, s.click * 0.8, s.ring)
    }
  }

  /** Leaf meets the frame and the latch catches. */
  latch(sound: DoorSound, kind: MotionKind, pan: number, speed: number, d?: DoorVoice) {
    // Steel doors close on the fire door's latch clack (its loudest moment lined up with the leaf meeting the frame),
    // the chain-link gate on its own clank; wood, glass and the motorised doors keep the procedural latch.
    if (d && sound === "steel" && kind === "swing" && this.clip("door-fire-steel", d, 0.55 + 0.45 * Math.min(1, speed * 2), hitOf("door-fire-steel") - 0.06)) return
    if (d && kind === "gate" && this.clip("gate-chainlink", d, 0.6, hitOf("gate-chainlink") - 0.05)) return
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[sound]
    const k = Math.min(1, 0.55 + speed * 2)
    this.thud(v, v.t, s.thud, s.thudGain * k)
    this.burst(v, v.t + 0.004, 0.06, 0.28 * k, s.click * 0.6, s.ring)
    this.burst(v, v.t + 0.06 + Math.random() * 0.02, 0.015, 0.3, s.click, s.ring)
    if (kind === "gate" || kind === "rollup") this.chain(v, v.t + 0.02, 5, 0.25, 0.16)
  }

  /** A body (or the open stop) hitting the leaf: a hollow knock through the leaf's resonances, `k` 0..1. */
  bump(sound: DoorSound, pan: number, k: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[sound]
    this.thud(v, v.t, s.thud * 1.15, s.thudGain * (0.35 + 0.65 * k))
    this.burst(v, v.t + 0.003, 0.08 + 0.06 * k, 0.18 + 0.25 * k, s.click * 0.4, s.ring)
    if (sound === "gate") this.chain(v, v.t + 0.01, 3 + Math.round(4 * k), 0.2, 0.14)
  }

  /** Roll-up ratchet tooth. */
  tick(pan: number) {
    const v = this.voice(pan)
    if (!v) return
    this.burst(v, v.t, 0.02, 0.14, 1800, [1100, 2700])
  }

  /** A door or control operated with E: a very quiet interface confirmation. */
  confirm() {
    hooks.sfx?.play("ui-notify", { bus: "ui", gain: 0.18, jitter: 0 })
  }

  /** Locked: the handle tried a few times, the leaf knocking in its frame. */
  rattle(sound: DoorSound, pan: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[sound]
    for (let i = 0; i < 3; i++) {
      const at = v.t + i * 0.085 + Math.random() * 0.015
      this.burst(v, at, 0.025, 0.3, s.click, s.ring)
      this.thud(v, at + 0.01, s.thud * 1.4, s.thudGain * 0.35)
    }
  }

  /**
   * Continuous motion sound for door `id`, called every frame it moves. `speed` is the leaf speed relative to its
   * cruise (0..~1). Stick-slip: the impulse rate wanders with speed and randomly sticks (near silence) then slips.
   */
  motion(id: string, sound: DoorSound, kind: MotionKind, speed: number, pan: number, dt: number) {
    const ac = this.ac
    if (!ac || !this.live || !this.pulse) return
    let l = this.loops.get(id)
    if (!l) {
      if (speed < 0.02) return
      l = this.makeLoop(sound, kind)
      this.loops.set(id, l)
    }
    l.idle = speed < 0.02 ? l.idle + dt : 0
    const now = ac.currentTime
    const s = VOICE[sound]
    const sp = Math.min(1.2, speed)
    l.wander = Math.max(-1, Math.min(1, l.wander + (Math.random() - 0.5) * dt * 9))
    if (now > l.stickUntil && Math.random() < dt * (kind === "swing" ? 2.2 : 1.2)) l.stickUntil = now + 0.04 + Math.random() * 0.12
    const stuck = now < l.stickUntil
    // Faster leaf → faster slips (higher pitch) and louder; a stick drops it out, the slip after comes back hot.
    const rate = (22 + 95 * sp) * s.creakPitch * (1 + 0.18 * l.wander) * (stuck ? 0.6 : 1)
    l.osc.frequency.setTargetAtTime(rate, now, 0.02)
    const level = this.creakVolume * s.creak * 0.11 * creakScale(sound, kind) * sp ** 0.7 * (1 + 0.35 * l.wander)
    l.creak.gain.setTargetAtTime(stuck ? level * 0.06 : level, now, stuck ? 0.012 : 0.03)
    l.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, pan)), now, 0.05)
    if (l.grind && l.grindFilter) {
      l.grind.gain.setTargetAtTime(this.creakVolume * (kind === "gate" ? 0.5 : 0.35) * sp ** 0.8, now, 0.06)
      l.grindFilter.frequency.setTargetAtTime((kind === "gate" ? 160 : 110) + 260 * sp + 60 * l.wander, now, 0.05)
      // Chain links clinking as the gate rolls.
      if (kind === "gate" && Math.random() < dt * 5 * sp) {
        const v = this.voice(pan)
        if (v) this.chain(v, v.t, 2, 0.06, 0.1 * this.creakVolume)
      }
    }
    if (l.idle > 0.25) this.stopLoop(id)
  }

  /** The door stopped: fade its loop out. */
  stopLoop(id: string) {
    const l = this.loops.get(id)
    const ac = this.ac
    if (!l || !ac) return
    this.loops.delete(id)
    const now = ac.currentTime
    l.creak.gain.setTargetAtTime(0, now, 0.04)
    l.grind?.gain.setTargetAtTime(0, now, 0.06)
    l.osc.stop(now + 0.4)
    l.noise?.stop(now + 0.4)
    setTimeout(() => l.pan.disconnect(), 600)
  }

  private makeLoop(sound: DoorSound, kind: MotionKind): Loop {
    const ac = this.ac!
    const s = VOICE[sound]
    const pan = ac.createStereoPanner()
    pan.connect(this.master!)
    const osc = ac.createOscillator()
    osc.setPeriodicWave(this.pulse!)
    osc.frequency.value = 40
    const creak = ac.createGain()
    creak.gain.value = 0
    for (const [hz, q] of [
      [720 * s.creakPitch, 12],
      [1650 * s.creakPitch, 9],
      [2900 * s.creakPitch, 7],
    ] as const) {
      const b = ac.createBiquadFilter()
      b.type = "bandpass"
      b.frequency.value = hz
      b.Q.value = q
      osc.connect(b).connect(creak)
    }
    creak.connect(pan)
    osc.start()
    let noise: AudioBufferSourceNode | null = null
    let grind: GainNode | null = null
    let grindFilter: BiquadFilterNode | null = null
    if (kind === "gate" || kind === "rollup") {
      noise = ac.createBufferSource()
      noise.buffer = this.noise
      noise.loop = true
      grindFilter = ac.createBiquadFilter()
      grindFilter.type = "bandpass"
      grindFilter.Q.value = 1.6
      const lp = ac.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = 900
      grind = ac.createGain()
      grind.gain.value = 0
      noise.connect(grindFilter).connect(lp).connect(grind).connect(pan)
      noise.start(0, Math.random() * 1.5)
    }
    return { osc, creak, noise, grind, grindFilter, pan, wander: 0, stickUntil: 0, idle: 0 }
  }
}
