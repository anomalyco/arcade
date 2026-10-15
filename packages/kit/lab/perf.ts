import { createRemoteControls, type RemoteControls } from "@arcade/knobs"
import { mountPanel } from "@arcade/knobs/panel"
import { arcadePreset } from "../lab-knobs"

const STORAGE_KEY = "arcade.lab.perf.v1"
/** One 60 Hz frame. */
const BUDGET_MS = 16.7

export type PerfReadout = ReturnType<typeof createPerfReadout>

/**
 * The Lab's frame-time readout over the viewport: a graph of the frame interval, CPU (the frame's script work) and GPU
 * (timestamp queries) against a 16.7 ms line, and CPU and GPU meters against the same budget. Frames are pushed only
 * while it shows, so a closed readout costs nothing; knobs redraws the rows at most once a frame.
 */
export function createPerfReadout(host: HTMLElement) {
  const el = document.createElement("div")
  el.className = "lab-perf"
  el.dataset.labPerf = ""
  el.setAttribute("aria-label", "Frame time")
  host.append(el)
  const meter = (label: string) => ({ kind: "meter" as const, label, unit: "ms", decimals: 1, max: BUDGET_MS * 2, warn: BUDGET_MS * 0.75, critical: BUDGET_MS, group: "perf" })
  let store: RemoteControls | null = null
  /** The store and its panel, made the first time the readout shows. */
  const mount = () => {
    if (store) return store
    store = createRemoteControls(
      "lab-perf",
      [
        {
          kind: "graph",
          key: "frame",
          label: "Frame time",
          series: [
            { id: "frame", label: "Frame", area: true },
            { id: "cpu", label: "CPU" },
            { id: "gpu", label: "GPU" },
          ],
          unit: "ms",
          decimals: 1,
          min: 0,
          history: 150,
          height: 52,
          thresholds: [{ value: BUDGET_MS, label: "60 fps" }],
          group: "perf",
          groupLabel: "Frame",
        },
        { key: "cpu", ...meter("CPU") },
        { key: "gpu", ...meter("GPU") },
      ],
      { storage: null, persist: "none", theme: "dark", density: "compact" },
    )
    mountPanel(store, el, {
      title: false,
      header: false,
      preset: arcadePreset,
      theme: "dark",
      density: "compact",
      renderer: "dom",
      variants: false,
      haptics: false,
      session: false,
    })
    return store
  }
  let shown = false
  try {
    shown = localStorage.getItem(STORAGE_KEY) === "1"
  } catch {}
  el.hidden = !shown
  if (shown) mount()
  let gpuLast: number | null = null

  return {
    el,
    get visible() {
      return shown
    },
    /** Shows or hides it (remembered in this browser); returns whether it shows. */
    toggle(on = !shown) {
      shown = on
      if (on) mount()
      el.hidden = !on
      try {
        localStorage.setItem(STORAGE_KEY, on ? "1" : "0")
      } catch {}
      return on
    },
    /** One frame: its interval, the script time it took and the GPU's last measured time (null when unavailable). */
    push(frameMs: number, cpuMs: number, gpuMs: number | null) {
      if (!shown || !store) return
      if (gpuMs !== null) gpuLast = gpuMs
      store.watch("frame", { frame: frameMs, cpu: cpuMs, ...(gpuLast !== null ? { gpu: gpuLast } : {}) })
      store.watch("cpu", cpuMs)
      if (gpuLast !== null) store.watch("gpu", gpuLast)
    },
  }
}
