import { holdsValue, type LabNavigation, type LabSettings } from "../lab-navigation"
import type { Region } from "./legibility"

/** Absolute state: adapters restore their baseline before applying it; probes never advance simulation time. */
export type LookState = {
  look?: string
  camera?: string
  torch?: boolean
  time?: number
  settings?: LabSettings
}
export type LookCapture = { png: string; width: number; height: number; exposure: number; time: number; region?: Region }
export type LookHook = {
  version: 1
  capabilities: { subject: boolean; shift: boolean; albedo: boolean }
  apply(state: LookState): void | Promise<void>
  settle(frames: number): Promise<void>
  grab(): LookCapture
  subject?(visible: boolean): void
  shift?(metres: number): void
  albedo?(): Promise<{ capture: LookCapture; mask: number[] }>
}
declare global { interface Window { look?: LookHook } }

/** Validate the entire patch before touching the live controls; use their normal callbacks on commit. */
export function controlPatch(nav: LabNavigation, values: LabSettings = {}): () => void {
  const rows = Object.entries(values).map(([key, value]) => {
    const c = nav.rows.find(r => r.control?.key === key)?.control
    if (!c || !holdsValue(c) || c.derived) throw new Error(`Unknown or non-setting control: ${key}`)
    if (typeof value !== typeof nav.settings[key]) throw new Error(`Wrong type for ${key}`)
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Non-finite ${key}`)
    if ("min" in c && (typeof value !== "number" || value < c.min || value > c.max)) throw new Error(`Out-of-range ${key}`)
    if ("options" in c && !c.options.some(o => o.value === value)) throw new Error(`Unknown choice for ${key}`)
    return { c, value }
  })
  return () => { for (const { c, value } of rows) nav.set(c, value) }
}

/** Copy immediately after the synchronous render, before Chromium discards the presented WebGPU canvas. */
export function captureCanvas(canvas: HTMLCanvasElement, draw: () => void, meta: () => Omit<LookCapture, "png" | "width" | "height">): LookCapture {
  draw()
  const copy = document.createElement("canvas")
  copy.width = canvas.width; copy.height = canvas.height
  copy.getContext("2d", { alpha: false })!.drawImage(canvas, 0, 0)
  return { png: copy.toDataURL("image/png"), width: copy.width, height: copy.height, ...meta() }
}

export async function settleFrames(frames: number, draw: () => void, queue: GPUQueue) {
  if (!Number.isInteger(frames) || frames < 1 || frames > 600) throw new Error("settle requires 1–600 frames")
  // Drain each batch: exposure meter readbacks need an event-loop turn, not just many queued draws.
  for (let i = 0; i < frames; i++) {
    draw()
    if (i % 4 === 3 || i === frames - 1) { await queue.onSubmittedWorkDone(); await new Promise(r => setTimeout(r, 0)) }
  }
}
