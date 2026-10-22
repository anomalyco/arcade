import type { TemporalSettings } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: 4× MSAA at the canvas size, no temporal resolve. */
export const AA_MSAA = 0
/** 4× MSAA plus the temporal resolve (jitter, reprojected history, sharpen) at the canvas size. */
export const AA_TAA = 1
/** The scene at `aaRenderScale` per axis, upscaled to the canvas by the temporal resolve. */
export const AA_TAA_UPSCALE = 2

/** Anti-aliasing settings; the values live in the view settings (Backquote › Anti-aliasing). */
export const DEFAULT_ANTI_ALIASING_SETTINGS = {
  /** 0 MSAA (today), 1 TAA, 2 TAA + upscale. */
  aaMode: AA_MSAA,
  /** Internal render scale per axis under TAA + upscale. */
  aaRenderScale: 0.67,
  /** RCAS sharpen after the resolve (0 off). */
  aaSharpen: 0.35,
  /** Weight of the reprojected history in a still pixel. */
  aaHistory: 0.9,
  /**
   * Seconds a street, porch or room lamp takes to fade in or out as the survivor walks across its reach (15.5 m, 16.5
   * m), instead of its pool popping on or off in one frame (0 Today). A still survivor sees no difference.
   */
  lampReachFade: 0.5,
}

export type AntiAliasingSettings = typeof DEFAULT_ANTI_ALIASING_SETTINGS

export const antiAliasingControls: LabControl[] = [
  {
    key: "aaMode",
    label: "Anti-aliasing",
    group: "Anti-aliasing",
    options: [
      { label: "MSAA (today)", value: AA_MSAA },
      { label: "TAA", value: AA_TAA },
      { label: "TAA + upscale", value: AA_TAA_UPSCALE },
    ],
  },
  { key: "aaRenderScale", label: "Render scale (TAA + upscale)", group: "Anti-aliasing", min: 0.5, max: 1, step: 0.01, unit: "×" },
  { key: "aaSharpen", label: "Sharpen", group: "Anti-aliasing", min: 0, max: 1, step: 0.05 },
  { key: "aaHistory", label: "History weight", group: "Anti-aliasing", min: 0.75, max: 0.97, step: 0.01 },
  { key: "lampReachFade", label: "Lamp reach fade (0 Today)", group: "Motion stability", min: 0, max: 2, step: 0.05, unit: "s" },
]

/** The renderer's temporal settings for these values (null keeps today's MSAA path). */
export function temporalSettings(s: AntiAliasingSettings): TemporalSettings | null {
  if (s.aaMode !== AA_TAA && s.aaMode !== AA_TAA_UPSCALE) return null
  return {
    mode: s.aaMode === AA_TAA_UPSCALE ? "taau" : "taa",
    renderScale: s.aaRenderScale,
    sharpen: s.aaSharpen,
    history: s.aaHistory,
  }
}
