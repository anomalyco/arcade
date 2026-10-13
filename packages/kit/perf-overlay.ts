import { GpuPerf } from "./gpu-perf"

/** Minimal telemetry for baseline builds that do not have the effect-control panel. */
export class PerfOverlay {
  private panel = document.createElement("div")
  private frames: number[] = []
  private last = 0
  private posted = 0
  constructor(private gpu: GpuPerf, private counts: () => Record<string, unknown>) {
    this.panel.id = "arcade-perf"
    this.panel.hidden = new URLSearchParams(location.search).get("perf") !== "1"
    this.panel.style.cssText = "position:fixed;top:10px;right:10px;z-index:999;padding:8px 10px;border-radius:6px;background:#10151aee;color:#e3e8ed;font:11px/1.6 monospace;white-space:pre;pointer-events:none"
    document.body.append(this.panel)
  }
  toggle() { this.panel.hidden = !this.panel.hidden }
  frame(now: number) {
    if (this.last && !document.hidden) this.frames.push(now - this.last)
    this.last = now
    if (document.hidden) { this.frames = []; this.last = 0; return }
    if (this.frames.length > 180) this.frames.shift()
    if (now - this.posted < 150 || !this.frames.length) return
    this.posted = now
    const sorted = [...this.frames].sort((a, b) => a - b)
    const frameMs = sorted[Math.floor((sorted.length - 1) * 0.5)]!
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!
    const fps = 1000 * this.frames.length / this.frames.reduce((a, b) => a + b, 0)
    const { gpuMs, gpuKind, draws, verts } = this.gpu
    const counts = this.counts()
    this.panel.textContent = `FPS ${fps.toFixed(0)} · Frame ms (p50 / p95) ${frameMs.toFixed(1)} / ${p95Ms.toFixed(1)}\nGPU ${gpuKind} ms ${gpuMs?.toFixed(2) ?? "—"}\nChunks ${counts.chunks ?? "—"} · Draws ${draws} · Verts ${verts.toLocaleString()} · Lights ${counts.lights ?? "—"}`
    if (parent !== window) parent.postMessage({ type: "arcade-perf", fps, frameMs, p95Ms, gpuMs, gpuKind, draws, verts, ...counts, run: new URLSearchParams(location.search).get("muxRun") ?? "" }, document.referrer ? new URL(document.referrer).origin : location.origin)
  }
}
