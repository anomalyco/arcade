import { LabPanel, type LabControl } from "../../../../packages/kit/lab-panel"

export const lookSettings = (enabled = true) => ({ tightPools: enabled, flatGround: enabled, shopSpill: enabled, grounding: enabled, wallGradients: enabled, colourGrade: enabled })
export const juiceSettings = (enabled = true) => ({ ...lookSettings(enabled), sparks: enabled, scrape: enabled, skids: enabled, backfire: enabled, rush: enabled, curb: enabled, trauma: enabled, landing: enabled, spotlightRadius: 1, spotlightSoftness: 1, roadSheen: 0.55 })
/** Presentation only; these values never enter shared vehicle physics. */
export const juice = juiceSettings()
export const smokeStyles = ["Current", "Faceted puffs", "Soft volume", "Cel smoke", "Flame & wisps", "Ribbon trails", "Advected billows", "Directional billows", "Raymarched cloud"] as const
export const smoke = { style: 6, visible: true }
const controls: LabControl[] = [
  ...([
    ["tightPools", "Tighter lamp pools"],
    ["flatGround", "Flatter ground"],
    ["shopSpill", "Shop-window spill"],
    ["grounding", "Grounding"],
    ["wallGradients", "Wall & roof gradients"],
    ["colourGrade", "Colour grade"],
  ] as const).map(([key, label]) => ({ key, label, group: "Look" })),
  { key: "spotlightRadius", label: "Wide Spotlight", off: 1, on: 1.4, group: "Effects" },
  { key: "spotlightSoftness", label: "Soft Spotlight", off: 1, on: 1.4 },
  { key: "roadSheen", label: "Wet Road Sheen", off: 0.55, on: 1.2 },
  ...([
    ["sparks", "Bouncing Sparks"],
    ["scrape", "Scrape Sparks"],
    ["skids", "Skid Ribbons"],
    ["backfire", "Backfire"],
    ["rush", "Nitro Camera Rush"],
    ["curb", "Curb-Hop Spring"],
    ["trauma", "Shake & PIT Hit-Stop"],
    ["landing", "Landing Effects"],
  ] as const).map(([key, label]) => ({ key, label })),
]
export type PerfSample = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastUpdate = 0
  sample: PerfSample = { fps: 0, frameMs: 0, p95Ms: 0, gpuMs: null, gpuKind: "timestamp", draws: 0, verts: 0, chunks: 0, lights: 0 }
  constructor(q: URLSearchParams, release: () => void) {
    if (q.get("vanilla") === "1") Object.assign(juice, juiceSettings(false))
    // ?off=landing,trauma turns individual switches off from the URL.
    const defaults = juiceSettings(false) as Record<string, boolean | number>
    for (const key of q.get("off")?.split(",") ?? []) if (key in juice) (juice as Record<string, boolean | number>)[key] = defaults[key]!
    super(juice, controls, q, release)
    const requested = Number(q.get("smoke") ?? 6)
    smoke.style = Number.isInteger(requested) && requested >= 0 && requested < smokeStyles.length ? requested : 6
    const label = document.createElement("label")
    label.textContent = "Smoke"
    const select = document.createElement("select")
    select.setAttribute("aria-label", "Smoke style")
    smokeStyles.forEach((name, i) => select.add(new Option(`${i} · ${name}`, String(i))))
    select.value = String(smoke.style)
    select.style.cssText = "margin-left:auto;max-width:195px;background:#263039;color:inherit;border:1px solid #ffffff30;border-radius:4px;font:inherit;padding:3px"
    select.onchange = () => {
      smoke.style = Number(select.value)
      const url = new URL(location.href)
      url.searchParams.set("smoke", select.value)
      history.replaceState(null, "", url)
    }
    label.append(select)
    this.header.after(label)
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
