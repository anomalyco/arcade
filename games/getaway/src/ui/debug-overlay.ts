import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { chassisSettings } from "../game/chassis"
import { vehicleEffects } from "../game/vehicle-emissions"
import type { Scene } from "../game/scene"
import type { GameAudio } from "../audio/game-audio"
import type { LightStyle } from "../render/car-lights"
import { lightControls } from "../../../../packages/kit/vehicle/lab"

/** Presentation only; these values never enter shared vehicle physics. */
export const juice = { ...chassisSettings(true), clutter: true, explosions: true, physicsDebug: false }
const controls: LabControl[] = [
  { key: "emissions", label: "Vehicle emissions", group: "Emissions" },
  { key: "coldExhaust", label: "Cold exhaust", group: "Emissions" },
  { key: "clutter", label: "Street clutter", group: "Props" },
  { key: "explosions", label: "Explosions", group: "Props" },
  { key: "physicsDebug", label: "Physics debug", group: "Props" },
  ...([
    ["suspension", "Suspension springs"],
    ["wheelContact", "Per-wheel contact"],
    ["visibleWheels", "Steer & spin wheels"],
    ["vehicleFeel", "Vehicle-specific feel"],
  ] as const).map(([key, label]) => ({ key, label, group: "Chassis" })),
]

export type PerfSample = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastUpdate = 0
  sample: PerfSample = { fps: 0, frameMs: 0, p95Ms: 0, gpuMs: null, gpuKind: "timestamp", draws: 0, verts: 0, chunks: 0, lights: 0 }
  constructor(q: URLSearchParams, release: () => void, scene: Scene, sound?: GameAudio) {
    super({ ...juice, ...scene.lightSettings, emissions: scene.emissions.visible, coldExhaust: vehicleEffects.coldExhaust, proceduralAudio: sound?.procedural ?? true }, [
      ...lightControls.map(control => "min" in control ? { ...control, enabled: (settings: Readonly<Record<string, boolean | number | string>>) => settings.style === 4 } : control),
      ...controls,
      ...(sound ? [{ key: "proceduralAudio", label: "Procedural audio", group: "Audio" }] : []),
    ], q, release, (key, value) => {
      if (key === "style") scene.setLightStyle(value as LightStyle)
      else if (key in scene.lightSettings) Object.assign(scene.lightSettings, { [key]: value })
      else if (key === "emissions") scene.emissions.visible = Boolean(value)
      else if (key === "coldExhaust") vehicleEffects.coldExhaust = Boolean(value)
      else if (key === "proceduralAudio" && sound) { sound.reset(); sound.procedural = Boolean(value) }
      else Object.assign(juice, { [key]: value })
    })
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
