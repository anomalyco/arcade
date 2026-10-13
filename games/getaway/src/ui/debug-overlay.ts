import { LabPanel, type LabControl } from "../../../../packages/kit/lab-panel"
import type { LightSettings } from "../render/car-lights"

const lightControls: (LabControl & { key: keyof LightSettings })[] = [
  { key: "style", label: "Style", group: "Lights", options: [
    { value: 0, label: "Reference" },
    { value: 1, label: "Recessed" },
    { value: 2, label: "Light bar" },
    { value: 3, label: "Cinematic" },
    { value: 4, label: "Soft pool" },
  ] },
  { key: "beamLength", label: "Beam length", min: 2, max: 24, step: 0.5, group: "Lights" },
  { key: "beamWidth", label: "Beam width", min: 0.05, max: 1, step: 0.01, group: "Lights" },
  { key: "beamSpread", label: "Beam spread", min: 0, max: 6, step: 0.1, group: "Lights" },
  { key: "beamIntensity", label: "Beam intensity", min: 0, max: 0.5, step: 0.01, group: "Lights" },
  { key: "poolSize", label: "Pool size", min: 0.5, max: 8, step: 0.1, group: "Lights" },
  { key: "poolIntensity", label: "Pool intensity", min: 0, max: 0.5, step: 0.01, group: "Lights" },
  { key: "poolAhead", label: "Pool ahead", min: 1, max: 14, step: 0.25, group: "Lights" },
  { key: "glowSize", label: "Lamp glow size", min: 0.1, max: 0.8, step: 0.01, group: "Lights" },
  { key: "glowIntensity", label: "Lamp glow intensity", min: 0, max: 2, step: 0.05, group: "Lights" },
  { key: "flareStrength", label: "Flare strength", min: 0, max: 0.4, step: 0.01, group: "Lights" },
  { key: "tailGlow", label: "Taillight glow", min: 0, max: 2, step: 0.05, group: "Lights" },
  { key: "brakeIntensity", label: "Brake intensity", min: 0, max: 4, step: 0.1, group: "Lights" },
]
export type PerfSample = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastUpdate = 0
  sample: PerfSample = { fps: 0, frameMs: 0, p95Ms: 0, gpuMs: null, gpuKind: "timestamp", draws: 0, verts: 0, chunks: 0, lights: 0 }
  constructor(q: URLSearchParams, release: () => void, lights?: LightSettings) {
    super(lights ?? {}, lights ? lightControls.map(control => "min" in control ? { ...control, enabled: settings => settings.style === 4 } : control) : [], q, release)
    addEventListener("keydown", (event) => {
      if (q.has("mux") && parent !== window) return
      if (event.code !== "Backquote" || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      this.toggle()
    })
  }
  reset() { this.samples.length = 0; this.lastUpdate = 0 }
  update(now: number, frameMs: number, stats: Pick<PerfSample, "gpuMs" | "gpuKind" | "draws" | "verts" | "chunks" | "lights">) {
    if (frameMs > 0 && frameMs < 1000) this.samples.push(frameMs)
    if (this.samples.length > 120) this.samples.shift()
    if (document.hidden) { this.reset(); return false }
    if (now - this.lastUpdate < 150) return false
    this.lastUpdate = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const p = (n: number) => sorted[Math.max(0, Math.ceil(sorted.length * n) - 1)] ?? 0
    const mean = this.samples.reduce((a, b) => a + b, 0) / Math.max(1, this.samples.length)
    this.sample = { ...stats, fps: mean ? 1000 / mean : 0, frameMs: p(0.5), p95Ms: p(0.95) }
    const s = this.sample
    this.header.textContent = `FPS ${s.fps.toFixed(0)} · Frame ms ${s.frameMs.toFixed(1)} / ${s.p95Ms.toFixed(1)}\nGPU ${s.gpuKind === "timestamp" ? "HW" : "queue-wait"} ms ${s.gpuMs?.toFixed(2) ?? "—"}`
    return true
  }
}
