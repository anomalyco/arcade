/**
 * The viewport canvas's backing size, tracked with a ResizeObserver so the render loop never reads layout.
 * Resolution follows the display's pixel ratio: `auto` caps it at 1.5× (the games' MAX_DPR), `device` at 2×, and
 * `css` renders one pixel per CSS pixel.
 */

export type ViewportResolution = "auto" | "device" | "css"
export const RESOLUTION_KEY = "arcade.lab.viewport-resolution"
export const RESOLUTIONS: readonly { id: ViewportResolution; label: string }[] = [
  { id: "auto", label: "Auto (up to 1.5×)" },
  { id: "device", label: "Device pixels (up to 2×)" },
  { id: "css", label: "1× (fastest)" },
]

export function resolutionScale(mode: ViewportResolution, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return mode === "css" ? 1 : Math.min(d, mode === "device" ? 2 : 1.5)
}

/**
 * Backing pixels for a CSS box. When the scale equals the pixel ratio and the browser reports the exact device
 * pixel box, that box is used as is so the canvas maps 1:1 onto screen pixels.
 */
export function backingSize(css: { width: number; height: number }, dpr: number, scale: number, device?: { width: number; height: number }) {
  // Emulated pixel ratios (DevTools, Playwright's deviceScaleFactor) can report a device box in CSS pixels, so the
  // box is only trusted when it agrees with the CSS box times the ratio.
  const agrees = device && Math.abs(device.width - css.width * dpr) <= 1 && Math.abs(device.height - css.height * dpr) <= 1
  if (device && agrees && Math.abs(scale - dpr) < 1e-6) return { width: Math.max(1, device.width), height: Math.max(1, device.height) }
  return { width: Math.max(1, Math.round(css.width * scale)), height: Math.max(1, Math.round(css.height * scale)) }
}

function loadResolution(): ViewportResolution {
  try {
    const v = localStorage.getItem(RESOLUTION_KEY)
    return v === "device" || v === "css" ? v : "auto"
  } catch {
    return "auto"
  }
}

export type ViewportSize = ReturnType<typeof trackViewportSize>

export function trackViewportSize(host: HTMLElement, onChange?: () => void) {
  let mode = loadResolution()
  const rect = host.getBoundingClientRect()
  let css = { width: rect.width || innerWidth, height: rect.height || innerHeight }
  let device: { width: number; height: number } | undefined
  let size = compute()
  let changes = 0
  let dirty = false

  function compute() {
    const dpr = devicePixelRatio || 1
    return { ...backingSize(css, dpr, resolutionScale(mode, dpr), device), cssWidth: css.width, cssHeight: css.height, dpr }
  }

  function update() {
    const next = compute()
    if (next.width === size.width && next.height === size.height && next.dpr === size.dpr) return
    size = next
    changes++
    onChange?.()
  }

  // Content-box observations arrive in the frame the layout changes; Chrome delivers device-pixel-content-box ones
  // several frames later (measured 7-8 frames while dragging a panel). So the content box drives the size, and the
  // exact device-pixel box is only used once it describes the same CSS box.
  let devicePair: { css: { width: number; height: number }; device: { width: number; height: number } } | undefined
  const cssOf = (e: ResizeObserverEntry) => {
    const box = e.contentBoxSize?.[0]
    return box ? { width: box.inlineSize, height: box.blockSize } : { width: e.contentRect.width, height: e.contentRect.height }
  }
  const sameBox = (a: { width: number; height: number }, b: { width: number; height: number }) => Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01
  const syncDevice = () => {
    device = devicePair && sameBox(devicePair.css, css) ? devicePair.device : undefined
  }
  const observer = new ResizeObserver(entries => {
    const e = entries[0]
    if (!e) return
    css = cssOf(e)
    syncDevice()
    update()
  })
  observer.observe(host)
  const deviceObserver = new ResizeObserver(entries => {
    const e = entries[0]
    const dev = e?.devicePixelContentBoxSize?.[0]
    if (!e || !dev) return
    devicePair = { css: cssOf(e), device: { width: dev.inlineSize, height: dev.blockSize } }
    syncDevice()
    update()
  })
  try {
    deviceObserver.observe(host, { box: "device-pixel-content-box" })
  } catch {}

  return {
    /** Backing width and height in pixels, plus the CSS box and pixel ratio they came from. */
    get() {
      if (dirty) {
        dirty = false
        const r = host.getBoundingClientRect()
        css = { width: r.width, height: r.height }
        syncDevice()
        update()
      }
      return size
    },
    /**
     * The layout just changed (a panel handle moved): the next `get` measures the box directly instead of waiting
     * for the observer, which can arrive frames late. Costs one layout read on those frames only.
     */
    invalidate() {
      dirty = true
    },
    get resolution() {
      return mode
    },
    /** How many times the backing size changed (for proofs). */
    get changes() {
      return changes
    },
    setResolution(next: ViewportResolution) {
      mode = next
      try {
        localStorage.setItem(RESOLUTION_KEY, next)
      } catch {}
      update()
    },
    dispose: () => {
      observer.disconnect()
      deviceObserver.disconnect()
    },
  }
}
