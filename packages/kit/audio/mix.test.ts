import { describe, expect, test } from "bun:test"
import { AudioRuntime, impulseResponse, type MixSpec, noiseBank, NOISE_RMS, softClipCurve } from "@arcade/kit/audio"
import { DeterministicOfflineAudioContext } from "./test-context"

const SPEC: MixSpec<"world" | "own" | "ui", "verb" | "slap"> = {
  buses: { world: { muffled: true, ducked: true }, own: { ducked: true }, ui: {} },
  sends: {
    verb: { impulse: (ctx) => impulseResponse(ctx, { rt60: 0.5, preDelay: 0.01, brightHz: 3000, open: true }), wet: 0.5, muffled: true },
    slap: { delay: 0.1, lowpassHz: 2000, wet: 0.3, feed: { send: "verb", gain: 0.25 } },
  },
  muffle: { closedHz: 1000, q: 0.6 },
  glue: { threshold: -20, knee: 12, ratio: 2, attack: 0.02, release: 0.3 },
  limiter: { threshold: -3, knee: 1, ratio: 20, attack: 0.001, release: 0.15 },
  trim: 0.9,
  softClipKnee: 0.85,
  route: { engine: "world", tyre: "world", impact: "world", weapon: "world", ambience: "world", spell: "own", foley: "own", voice: "own", ui: "ui" },
  reverb: "verb",
}

const make = (seconds = 1) => {
  const ctx = new DeterministicOfflineAudioContext(2, 48000 * seconds, 48000) as unknown as OfflineAudioContext
  const runtime = new AudioRuntime({ context: ctx, mix: SPEC, manifest: [], cues: [] })
  return { ctx, runtime }
}

describe("game-defined mix", () => {
  test("named buses, routes, sends and the muffle are built and reachable", () => {
    const { runtime } = make()
    expect(runtime.mix).not.toBeNull()
    for (const b of ["world", "own", "ui"]) expect(runtime.mixBus(b)).not.toBeNull()
    expect(runtime.buses.engine).toBe(runtime.mixBus("world")!)
    expect(runtime.buses.ui).toBe(runtime.mixBus("ui")!)
    expect(runtime.verb).toBe(runtime.mixSend("verb")!)
    expect(Object.keys(runtime.mix!.ducks).sort()).toEqual(["own", "world"])
    runtime.setMuffle(1, 0.01)
    const f = runtime.mix!.muffle!.frequency as unknown as { sampleAt(t: number): number }
    expect(f.sampleAt(0.5)).toBeCloseTo(1000, 0)
  })

  test("duckBuses dips ducked buses except the spared ones, then recovers", () => {
    const { runtime } = make()
    runtime.duckBuses(0.4, 0.2, { spare: ["own"] })
    const w = runtime.mix!.ducks.world!.gain as unknown as { sampleAt(t: number): number }
    const o = runtime.mix!.ducks.own!.gain as unknown as { sampleAt(t: number): number }
    expect(w.sampleAt(0.15)).toBeLessThan(0.45)
    expect(o.sampleAt(0.15)).toBe(1)
    expect(w.sampleAt(3)).toBeGreaterThan(0.99)
  })

  test("a source on a bus reaches the output, and muting silences it", async () => {
    for (const muted of [false, true]) {
      const { ctx, runtime } = make()
      if (muted) runtime.setMuted(true)
      const src = ctx.createBufferSource()
      src.buffer = noiseBank(ctx).pink
      src.loop = true
      src.connect(runtime.mixBus("world")!)
      src.start(0)
      const out = await ctx.startRendering()
      let sum = 0
      const l = out.getChannelData(0)
      for (let i = 24000; i < l.length; i++) sum += l[i]! * l[i]!
      const rms = Math.sqrt(sum / (l.length - 24000))
      if (muted) expect(rms).toBeLessThan(1e-4)
      else expect(rms).toBeGreaterThan(0.05)
    }
  })

  test("noise bank is RMS-normalised and cached per context; soft clip is unity below its knee", () => {
    const { ctx } = make()
    const bank = noiseBank(ctx)
    expect(noiseBank(ctx)).toBe(bank)
    for (const b of [bank.white, bank.pink, bank.brown]) {
      const d = b.getChannelData(0)
      let s = 0
      for (const v of d) s += v * v
      expect(Math.sqrt(s / d.length)).toBeCloseTo(NOISE_RMS, 1)
    }
    const curve = softClipCurve(0.85, 2049)
    expect(curve[1024 + 512]).toBeCloseTo(0.5, 3)
    expect(Math.max(...curve)).toBeLessThanOrEqual(1)
  })
})
