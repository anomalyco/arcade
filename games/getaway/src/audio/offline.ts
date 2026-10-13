import { AudioEngine } from "./audio"
import { GameAudio } from "./game-audio"
import { Camera } from "../game/camera"
import { generateCity } from "../../shared/sim/city"
import type { WorldView, SimEvent } from "../../shared/sim/world"
import type { Input } from "../../shared/sim/vehicle"
import { mulberry32 } from "../../shared/sim/rng"

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
  return { wav: wav(rendered), stats: { peak, peakDb: 20 * Math.log10(peak), maxAdjacentDelta: delta, maxControlBoundaryDelta: boundaryDelta, maxIsolatedSpike: isolatedSpike, dc, clipped, updateMedianMs: times[Math.floor(times.length / 2)], updateP95Ms: times[Math.floor(times.length * 0.95)], shifts } }
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
