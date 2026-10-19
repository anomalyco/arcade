// One AudioContext for every game sound, created only on the first user input and never in `?shot` mode (callers
// never call `unlockAudio` there). The mix (no music):
//
//   footsteps ─┐
//   doors ─────┼─► world ─┬─ dry ─────────────────────► master ─► limiter ─► out
//   ambience ──┤          ├─ room send ─► room reverb ─┘
//   horror ────┘          └─ outdoor send ─► slap ─────┘
//   ui ────────────────────────────────────────────────┘
//
// `setSpace` crossfades the two reverbs as the listener moves through doorways. Category levels are the Lab's Audio
// knobs (`setLevels`).

export type Bus = "footsteps" | "doors" | "ambience" | "horror" | "ui"
export const BUSES: readonly Bus[] = ["footsteps", "doors", "ambience", "horror", "ui"]

export type SharedAudio = {
  ctx: AudioContext
  /** Everything ends here (before the limiter). */
  master: GainNode
  /** Category inputs. */
  buses: Record<Bus, GainNode>
  /** Where world sounds without a category connect (feeds the dry path and both reverb sends). */
  bus: GainNode
  /** 2 s of white noise for procedural layers. */
  noise: AudioBuffer
}

let shared: SharedAudio | null = null
let roomSend: GainNode | null = null
let outSend: GainNode | null = null

/** Set by the first user input; until then nothing plays even where a browser would let the context run. */
let unlocked = false
let impulses: { room: AudioBuffer; out: AudioBuffer; noise: AudioBuffer } | null = null

/**
 * Prepares, before any input (behind the boot overlay, in idle time), everything the first key press would otherwise
 * stall on: the two reverb impulses, the noise buffer and the context itself with its whole mix, created suspended
 * (creating an AudioContext costs ~90 ms of main thread; it makes no sound until `unlockAudio` resumes it on input).
 */
export function prepareAudio() {
  if (!impulses) makeImpulses()
  createContext()
}

function makeImpulses() {
  if (typeof AudioBuffer === "undefined") return
  const rate = 48000
  const noise = new AudioBuffer({ numberOfChannels: 1, length: rate * 2, sampleRate: rate })
  const d = noise.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  impulses = {
    // Interior: dense early reflections off hard walls, 1.1 s tail, darkening as it decays.
    room: impulse(rate, 1.1, 2400, 0.012, 7),
    // Exterior: a faint slap off the building and trees, 0.5 s, mostly low.
    out: impulse(rate, 0.5, 1100, 0.06, 2),
    noise,
  }
}

/** Resumes the context (creating it first if `prepareAudio` hasn't run). Call only from a user-input handler. */
export function unlockAudio(): SharedAudio | null {
  createContext()
  if (!shared) return null
  unlocked = true
  if (shared.ctx.state === "suspended") void shared.ctx.resume()
  return shared
}

function createContext() {
  if (!shared) {
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor({ latencyHint: "interactive" })
    const master = ctx.createGain()
    // A gentle limiter so a thunder crack over rain never clips.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 4
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.25
    master.connect(limiter).connect(ctx.destination)
    const world = ctx.createGain()
    world.connect(master)
    if (!impulses) makeImpulses()
    const { noise, room: roomIr, out: outIr } = impulses!
    const room = ctx.createConvolver()
    room.buffer = roomIr
    const out = ctx.createConvolver()
    out.buffer = outIr
    roomSend = ctx.createGain()
    outSend = ctx.createGain()
    roomSend.gain.value = 0
    outSend.gain.value = 0.12
    world.connect(roomSend).connect(room).connect(master)
    world.connect(outSend).connect(out).connect(master)
    const buses = {} as Record<Bus, GainNode>
    for (const b of BUSES) {
      buses[b] = ctx.createGain()
      buses[b].connect(b === "ui" ? master : world)
    }
    shared = { ctx, master, buses, bus: world, noise }
  }
}

/** The context once unlocked and running, else null (nothing plays before user input). */
export function audio(): SharedAudio | null {
  return unlocked && shared && shared.ctx.state === "running" ? shared : null
}

/** Master and category levels (linear, eased). */
export function setLevels(master: number, levels: Partial<Record<Bus, number>>) {
  if (!shared) return
  const t = shared.ctx.currentTime
  shared.master.gain.setTargetAtTime(master, t, 0.05)
  for (const b of BUSES) if (levels[b] !== undefined) shared.buses[b].gain.setTargetAtTime(levels[b]!, t, 0.05)
}

/**
 * Listener space: `indoor` 0..1 (eased by the caller) and `size` 0..1 (0 a small room or corridor, 1 a stairwell or
 * hall). Indoors the room reverb comes up; outdoors only the faint slap remains.
 */
export function setSpace(indoor: number, size: number) {
  if (!shared || !roomSend || !outSend) return
  const t = shared.ctx.currentTime
  roomSend.gain.setTargetAtTime(indoor * (0.22 + 0.28 * size), t, 0.15)
  outSend.gain.setTargetAtTime((1 - indoor) * 0.12, t, 0.15)
}

/** Stereo exponentially decaying noise with early reflections, low-passed over time (1-pole, cutoff falls). */
function impulse(rate: number, seconds: number, cutoff: number, gap: number, taps: number) {
  const n = Math.floor(seconds * rate)
  const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: rate })
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const env = Math.exp((-6.9 * t) / seconds)
      // Cutoff falls from `cutoff` to a quarter of it over the tail.
      const fc = cutoff * (1 - 0.75 * (t / seconds))
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
      lp += a * (Math.random() * 2 - 1 - lp)
      d[i] = lp * env * 0.6
    }
    for (let k = 0; k < taps; k++) {
      const at = Math.floor((gap * (k + 1) * (1 + 0.37 * Math.random()) + c * 0.0013) * rate)
      if (at < n) d[at]! += (Math.random() < 0.5 ? -1 : 1) * 0.5 * Math.exp(-k * 0.35)
    }
  }
  return buf
}
