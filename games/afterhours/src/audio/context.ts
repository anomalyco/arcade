// One AudioContext for the walker's sounds (footsteps, doors), created only on the first user input and never in
// `?shot` mode (callers simply never call `unlockAudio` there). Sounds connect to `bus`: a dry path plus sends into two
// procedural reverbs, a hard-walled interior (corridors, stairwell) and a short, open exterior, crossfaded by
// `setSpace` as the listener moves through doorways.

export type SharedAudio = {
  ctx: AudioContext
  /** Everything ends here (dry + reverb returns). */
  master: GainNode
  /** Where sounds connect: feeds the dry path and both reverb sends. */
  bus: GainNode
  /** 2 s of white noise for procedural layers. */
  noise: AudioBuffer
}

let shared: SharedAudio | null = null
let roomSend: GainNode | null = null
let outSend: GainNode | null = null

/** Creates (first call) or resumes the context. Call only from a user-input handler. */
export function unlockAudio(): SharedAudio | null {
  if (!shared) {
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    const ctx = new Ctor()
    const master = ctx.createGain()
    master.connect(ctx.destination)
    const bus = ctx.createGain()
    bus.connect(master)
    const n = ctx.sampleRate * 2
    const noise = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
    // Interior: dense early reflections off hard walls, 1.1 s tail, darkening as it decays.
    const room = ctx.createConvolver()
    room.buffer = impulse(ctx, 1.1, 2400, 0.012, 7)
    // Exterior: a faint slap off the building and trees, 0.5 s, mostly low.
    const out = ctx.createConvolver()
    out.buffer = impulse(ctx, 0.5, 1100, 0.06, 2)
    roomSend = ctx.createGain()
    outSend = ctx.createGain()
    roomSend.gain.value = 0
    outSend.gain.value = 0.12
    bus.connect(roomSend).connect(room).connect(master)
    bus.connect(outSend).connect(out).connect(master)
    shared = { ctx, master, bus, noise }
  }
  if (shared.ctx.state === "suspended") void shared.ctx.resume()
  return shared
}

/** The context once unlocked and running, else null (nothing plays before user input). */
export function audio(): SharedAudio | null {
  return shared && shared.ctx.state === "running" ? shared : null
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
function impulse(ctx: AudioContext, seconds: number, cutoff: number, gap: number, taps: number) {
  const rate = ctx.sampleRate
  const n = Math.floor(seconds * rate)
  const buf = ctx.createBuffer(2, n, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const env = Math.exp((-6.9 * t) / seconds)
      // Cutoff falls from `cutoff` to a quarter of it over the tail.
      const fc = cutoff * (1 - 0.75 * (t / seconds))
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
      lp += a * ((Math.random() * 2 - 1) - lp)
      d[i] = lp * env * 0.6
    }
    for (let k = 0; k < taps; k++) {
      const at = Math.floor((gap * (k + 1) * (1 + 0.37 * Math.random()) + c * 0.0013) * rate)
      if (at < n) d[at]! += (Math.random() < 0.5 ? -1 : 1) * 0.5 * Math.exp(-k * 0.35)
    }
  }
  return buf
}
