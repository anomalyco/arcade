import { AudioEngine } from "./audio"
import { GameAudio } from "./game-audio"
import { Camera } from "../game/camera"
import { generateCity } from "../../shared/sim/city"
import type { WorldView, SimEvent } from "../../shared/sim/world"
import type { Input } from "../../shared/sim/vehicle"
import { mulberry32 } from "../../shared/sim/rng"
import { NitroGate } from "./nitro"
import { NitroVoice } from "./synth"

export type AudioFrame = { view: WorldView; input: Input; events: SimEvent[]; myId: string; camera: { fx: number; fz: number } }

/** Schedule captured simulation frames into the exact live graph. No AudioContext is constructed. */
export async function renderOffline(frames: AudioFrame[], procedural: boolean, fps = 30) {
  const ctx = new OfflineAudioContext(2, Math.ceil((frames.length / fps + 1) * 48000), 48000)
  const engine = new AudioEngine(ctx)
  await engine.loadOffline()
  const sound = new GameAudio(undefined, generateCity(7), engine)
  sound.procedural = procedural
  const camera = new Camera(), times: number[] = [], shifts: number[] = []
  sound.onShift = () => shifts.push(engine.now)
  const oldRandom = Math.random
  Math.random = mulberry32(1337)
  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!
      engine.scheduleTime = i / fps
      camera.fx = f.camera.fx; camera.fz = f.camera.fz
      const start = performance.now()
      sound.update(f.view, { myId: f.myId, cam: camera, dt: 1 / fps, events: f.events, input: f.input })
      times.push(performance.now() - start)
    }
  } finally { Math.random = oldRandom }
  const end = frames.length / fps
  engine.scheduleTime = end
  const nitro = sound.nitroState
  sound.reset()
  engine.master.gain.setTargetAtTime(0, end, 0.12)
  const rendered = await ctx.startRendering()
  let peak = 0, delta = 0, clipped = 0, dc = 0, isolatedSpike = 0, boundaryDelta = 0
  for (let c = 0; c < 2; c++) {
    const d = rendered.getChannelData(c)
    let sum = 0
    for (let i = 1; i < d.length; i++) {
      const adjacent = Math.abs(d[i]! - d[i - 1]!)
      peak = Math.max(peak, Math.abs(d[i]!)); delta = Math.max(delta, adjacent)
      if (i % (48000 / fps) === 0) boundaryDelta = Math.max(boundaryDelta, adjacent)
      if (i < d.length - 1) isolatedSpike = Math.max(isolatedSpike, Math.abs(d[i]! - (d[i - 1]! + d[i + 1]!) / 2))
      if (Math.abs(d[i]!) >= 1) clipped++
      sum += d[i]!
    }
    dc = Math.max(dc, Math.abs(sum / d.length))
  }
  times.sort((a, b) => a - b)
  return { wav: wav(rendered), stats: { peak, peakDb: 20 * Math.log10(peak), maxAdjacentDelta: delta, maxControlBoundaryDelta: boundaryDelta, maxIsolatedSpike: isolatedSpike, dc, clipped, updateMedianMs: times[Math.floor(times.length / 2)], updateP95Ms: times[Math.floor(times.length * 0.95)], shifts, nitro } }
}

/** Real native-DSP tail check, independent of any master fade or engine masking. */
export async function renderNitroRegression() {
  const ctx = new OfflineAudioContext(2, 12 * 48000, 48000), engine = new AudioEngine(ctx)
  const gate = new NitroGate(), voice = new NitroVoice(engine)
  let maxVoices = 0
  const starts: number[] = [], quiet: number[] = []
  for (let i = 0; i < 12 * 60; i++) {
    const t = i / 60
    engine.scheduleTime = t
    const held = t >= 0.5 && t < 2.5 || t >= 3 && t < 3.2 || t >= 3.25 && t < 3.5 || t >= 3.55 && t < 3.8 || t >= 4.5 && t < 5.5 || t >= 6 && t < 7 || t >= 7.5 && t < 8.5 || t >= 9 && t < 10
    const fuel = t >= 1.5 && t < 2 ? 0 : t < 1.5 ? 1 - Math.floor(t * 10) / 15 : 0.5
    // Blur, pause, round end and reset: cancel while the button is still held.
    if ([4.75, 6.25, 7.75, 9.25].includes(t)) { gate.cancel(); voice.stop(); quiet.push(t + 0.3) }
    gate.update(held, fuel, 1 / 60)
    voice.update(gate, t * 4)
    if (gate.ignited) starts.push(t)
    maxVoices = Math.max(maxVoices, voice.voices)
  }
  quiet.push(2.3, 11)
  const active = voice.active, voices = voice.voices
  const buffer = await ctx.startRendering()
  const rms = quiet.map(t => {
    const samples = buffer.getChannelData(0).subarray(Math.floor(t * 48000), Math.floor((t + 0.1) * 48000))
    return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)
  })
  if (starts.length !== 8 || active || voices || rms.some(x => x > 0.00001)) throw new Error(`Nitro regression: ${JSON.stringify({ starts, active, voices, rms })}`)
  return { wav: wav(buffer), stats: { starts, active, voices, maxVoices, quietWindowRms: rms } }
}

function wav(buffer: AudioBuffer) {
  const bytes = new ArrayBuffer(44 + buffer.length * 4), v = new DataView(bytes)
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, "RIFF"); v.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVEfmt ")
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true)
  v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * 4, true)
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); text(36, "data"); v.setUint32(40, bytes.byteLength - 44, true)
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1)
  for (let i = 0; i < buffer.length; i++) for (let c = 0; c < 2; c++) v.setInt16(44 + i * 4 + c * 2, Math.round(Math.max(-1, Math.min(1, (c ? r : l)[i]!)) * 32767), true)
  return Array.from(new Uint8Array(bytes))
}
