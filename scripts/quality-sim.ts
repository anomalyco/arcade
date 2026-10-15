// What `@arcade/kit/quality` Auto does on a slower GPU, without one: replays a deterministic frame model through the
// controller. GPU cost per frame is a measured Studio baseline (sustained `games/outbreak/scripts/gpu-sustained.ts`)
// times a speed factor, scaled by pixels drawn (0.17 fixed + 0.83 × pixel share, fitted to Outbreak's per-tier
// timings), with ±12 % jitter and a 1-in-40 spike. A frame takes whole 60 Hz ticks: Outbreak keeps one frame in
// flight, so CPU + GPU past 16.7 ms misses the tick. The run walks the street, then a house, then back out.
//
//   bun scripts/quality-sim.ts [--factors=1,2,2.5,3] [--cpu=1] [--street=4.5] [--interior=5.3] [--pixels=1.18]
import { AdaptiveQualityController } from "../packages/kit/quality"

const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const factors = opt("factors", "1,2,2.5,3").split(",").map(Number)
const cpuMs = Number(opt("cpu", "1"))
const scenes = { street: Number(opt("street", "4.5")), interior: Number(opt("interior", "5.3")) }
// Kit's 16" MacBook Pro full-screen window (1728×1117 CSS) has 18 % more pixels than the 1728×947 bench viewport.
const pixels = Number(opt("pixels", "1.18"))
const TICK = 1000 / 60

export type SimPhase = { scene: keyof typeof scenes; seconds: number }
export type PhaseResult = { scene: string; tier: string; pixelRatio: number; missed: number; gpuMs: number }

export function simulate(factor: number, phases: SimPhase[], opts: { cpu?: number; base?: Record<string, number>; pixels?: number; seed?: number } = {}): { phases: PhaseResult[]; adaptations: number } {
  const ctrl = new AdaptiveQualityController({ mode: "auto" })
  const base = opts.base ?? scenes
  const px = opts.pixels ?? pixels
  const cpu = opts.cpu ?? cpuMs
  let seed = opts.seed ?? 1
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  let now = 0
  let frame = 0
  const out: PhaseResult[] = []
  for (const phase of phases) {
    let missed = 0
    let frames = 0
    let gpuSum = 0
    const end = now + phase.seconds * 1000
    while (now < end) {
      const pr = ctrl.effectivePixelRatio(2)
      const share = (pr / 2) ** 2
      const jitter = 1 + (rand() - 0.5) * 0.24
      const spike = ++frame % 40 === 0 ? 1.5 : 1
      const gpu = base[phase.scene]! * factor * px * (0.17 + 0.83 * share) * jitter * spike
      const work = cpu + gpu + 0.6
      const interval = Math.max(1, Math.ceil(work / TICK - 1e-6)) * TICK
      now += interval
      frames++
      gpuSum += gpu
      if (interval > TICK + 0.5) missed++
      ctrl.recordFrame(interval, gpu, now)
    }
    const st = ctrl.state(2)
    out.push({ scene: phase.scene, tier: st.activeTier, pixelRatio: st.pixelRatio, missed: missed / frames, gpuMs: gpuSum / frames })
  }
  return { phases: out, adaptations: ctrl.state(2).adaptations }
}

if (import.meta.main) {
  const phases: SimPhase[] = [{ scene: "street", seconds: 15 }, { scene: "interior", seconds: 30 }, { scene: "street", seconds: 30 }]
  console.log(`cpu ${cpuMs} ms · Studio GPU street ${scenes.street} ms, interior ${scenes.interior} ms at 2.0× (×${pixels} pixels)`)
  for (const f of factors) {
    const r = simulate(f, phases)
    const cells = r.phases.map((p) => `${p.scene} → ${p.tier} ${p.pixelRatio.toFixed(2)}× (GPU ${p.gpuMs.toFixed(1)} ms, ${(p.missed * 100).toFixed(0)}% missed)`)
    console.log(`GPU ×${f}: ${cells.join(" · ")} · ${r.adaptations} changes`)
  }
}
