import { LabPanel, type LabControl } from "../../../../packages/kit/lab-panel"
import { chassisSettings } from "../game/chassis"
import { motionBlur } from '../render/motion'

/** Presentation only; these values never enter shared vehicle physics. */
export const juice = { ...chassisSettings(true), clutter: true, explosions: true, physicsDebug: false }
export const smokeStyles = ["Current", "Faceted puffs", "Soft volume", "Cel smoke", "Flame & wisps", "Ribbon trails", "Advected billows", "Directional billows", "Raymarched cloud"] as const
export const smoke = { style: 6, visible: true }
const controls: LabControl[] = [
  ...([
    ["suspension", "Suspension springs"],
    ["wheelContact", "Per-wheel contact"],
    ["visibleWheels", "Steer & spin wheels"],
    ["vehicleFeel", "Vehicle-specific feel"],
  ] as const).map(([key, label]) => ({ key, label, group: "Chassis" })),
  { key: "clutter", label: "Street clutter", group: "Props" },
  { key: "explosions", label: "Explosions" },
  { key: "physicsDebug", label: "Physics debug" },
]
export type PerfSample = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastUpdate = 0
  sample: PerfSample = { fps: 0, frameMs: 0, p95Ms: 0, gpuMs: null, gpuKind: "timestamp", draws: 0, verts: 0, chunks: 0, lights: 0 }
  constructor(q: URLSearchParams, release: () => void) {
    super(juice, controls, q, release)
    this.addControls(motionBlur,[
      {key:'enabled',label:'Motion blur',group:'Motion'},
      {key:'strength',label:'Strength',type:'range',min:0,max:2,step:.05},
      {key:'shutter',label:'Shutter',type:'range',min:0,max:1,step:.05},
    ])
    addEventListener("keydown", (event) => {
      if (q.has("mux") && parent !== window) return
      if (event.code !== "Backquote" || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      this.toggle()
    })
    // Query selection is retained only for deterministic automation.
    const requested = Number(q.has("bench") || q.has("mux") ? q.get("smoke") ?? 6 : 6)
    smoke.style = Number.isInteger(requested) && requested >= 0 && requested < smokeStyles.length ? requested : 6
    this.addControls(smoke, [{key:"style",label:"Smoke style",type:"select",options:smokeStyles.map((label,value)=>({label:`${value} · ${label}`,value}))}])
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
