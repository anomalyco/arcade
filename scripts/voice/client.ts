import { RoomSocket } from "../../packages/kit/net/room-socket"
import { VoiceChat } from "../../packages/kit/voice"
import { VoiceAudio } from "../../packages/kit/voice/audio"
import { VOICE_SPATIAL } from "../../packages/kit/voice/spatial"
import { createGameShell } from "../../packages/kit/shell"

let ctx: AudioContext, output: GainNode, analyser: AnalyserNode
let distance = 2, occlusion = 0
const voice = new VoiceChat({ audio: async () => {
  ctx ??= new AudioContext({ sampleRate: 48000 })
  if (!output) {
    output = ctx.createGain()
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048
    output.connect(analyser).connect(ctx.destination)
  }
  await ctx.resume()
  return { ctx, output }
} })
let permissions = 0
const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
navigator.mediaDevices.getUserMedia = (c) => { permissions++; return get(c) }
const socket = new RoomSocket({ game: "voice-proof", room: "test", url: new URLSearchParams(location.search).get("ws")!, hello: () => ({ type: "hello", build: "voice-proof" }), encode: JSON.stringify, decode: JSON.parse, fatal: (m) => { throw new Error(m) }, receive: () => {}, voice })
const shell = createGameShell({ game: "voice-proof", title: "Voice proof", voice, hidden: false, start: "title", leaveGuard: false })
const frame = () => {
  voice.update({ listener: { x: 0, y: 1.7, z: 0 }, source: () => ({ x: 0, y: 1.7, z: -distance }), occlusion: () => occlusion }, true)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length)
const proof = {
  voice, shell,
  state: () => ({ ...voice.diagnostics(), permissions, socket: socket.status() }),
  set(d: number, o = 0) { distance = d; occlusion = o },
  async level() {
    const a = new Float32Array(analyser.fftSize), levels: number[] = []
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 30)); analyser.getFloatTimeDomainData(a); levels.push(rms(a)) }
    return levels.reduce((a, b) => a + b, 0) / levels.length
  },
  async offline() {
    // Record the received WebRTC output, then render that exact PCM through the production chain offline.
    const chunks: Float32Array[] = []
    const tap = ctx.createScriptProcessor(2048, 1, 1)
    const done = new Promise<void>((resolve) => { tap.onaudioprocess = (e) => { chunks.push(e.inputBuffer.getChannelData(0).slice()); if (chunks.length >= 12) resolve() } })
    output.connect(tap); tap.connect(ctx.destination)
    await done
    output.disconnect(tap); tap.disconnect(); tap.onaudioprocess = null
    const input = new Float32Array(chunks.length * 2048)
    chunks.forEach((c, i) => input.set(c, i * 2048))
    const result: Record<string, number> = {}
    for (const [name, d, occ, radio] of [["near", 2, 0, false], ["far", 30, 0, false], ["occluded", 2, 1, false], ["outOfRange", 60, 0, false], ["radioFar", 300, 0, true]] as const) {
      const offline = new OfflineAudioContext(2, 48000, 48000)
      const src = offline.createBufferSource(), buffer = offline.createBuffer(1, input.length, 48000)
      buffer.copyToChannel(input, 0); src.buffer = buffer; src.loop = true
      const audio = new VoiceAudio(offline, offline.destination)
      src.connect(audio.input)
      audio.update({ x: 0, y: 0, z: -d }, { x: 0, y: 0, z: 0 }, occ, true, radio, 1, 1, VOICE_SPATIAL)
      src.start()
      const rendered = await offline.startRendering()
      result[name] = rms(rendered.getChannelData(0).slice(16000))
      audio.dispose()
    }
    return result
  },
  close() { socket.close(); voice.dispose(); shell.dispose(); void ctx?.close() },
}
Object.assign(window, { proof })
export type VoiceProof = typeof proof
