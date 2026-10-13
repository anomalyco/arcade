import { LabPanel, type LabControl } from "../../../../packages/kit/lab-panel"

export const JUICE_LABELS = {
  volumes: "Volume Smoke",
  monitors: "Monitor Lights", chairs: "Chair Shadows", ao: "Multi-Bounce AO",
  rings: "Sound Rings", paper: "Fluttering Paper", glass: "Glass Shards",
  sparks: "Monitor Sparks", casings: "Shell Casings", lamps: "Lamp Flicker", trauma: "Shake & Kill Punch",
} as const
export type Juice = Record<keyof typeof JUICE_LABELS, boolean> & { monitorIntensity: number; aoStrength: number }
export const juiceSettings = (enabled = true): Juice => ({ volumes: enabled, monitors: enabled, chairs: enabled, ao: enabled, monitorIntensity: 1, aoStrength: 1, rings: false, paper: enabled, glass: enabled, sparks: enabled, casings: enabled, lamps: false, trauma: enabled })
export type Perf = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
const controls: LabControl[] = Object.entries(JUICE_LABELS).map(([key, label]) => ({ key, label }))

export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastReport = 0
  constructor(settings: Juice, params: URLSearchParams, release: () => void = () => {}) {
    super(settings, controls, params, release)
  }
  sample(now: number, elapsed: number, gpu: Pick<Perf, "gpuMs" | "gpuKind" | "draws" | "verts">, chunks: number, lights: number): Perf | null {
    if (elapsed > 0 && Number.isFinite(elapsed)) this.samples.push(elapsed)
    if (this.samples.length > 180) this.samples.shift()
    if (document.hidden) { this.samples = []; return null }
    if (now - this.lastReport < 150 || !this.samples.length) return null
    this.lastReport = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const frameMs = sorted[Math.floor((sorted.length - 1) * 0.5)]!
    const p95Ms = sorted[Math.floor((sorted.length - 1) * 0.95)]!
    const fps = 1000 * this.samples.length / this.samples.reduce((a, b) => a + b, 0)
    const perf = { fps, frameMs, p95Ms, ...gpu, chunks, lights }
    this.header.textContent = `FPS ${fps.toFixed(0)} · Frame ms ${frameMs.toFixed(1)} / ${p95Ms.toFixed(1)}\nGPU ${gpu.gpuKind === "timestamp" ? "HW" : "queue-wait"} ms ${gpu.gpuMs?.toFixed(2) ?? "—"}`
    return perf
  }
}
