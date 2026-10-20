// The boot overlay lives in index.html (inline CSS) so it paints before any script loads. This drives it: the stage
// name, a percentage and a bar that never moves backwards (the first ~15% is WebGPU, terrain and the render rig, the
// rest the world warm-up weighted by measured stage cost), then a fade to the warm, settled world.

export type Loader = {
  step(label: string, fraction: number): void
  /** The first real frame is on screen: fade the cover, keep a small streaming indicator. */
  live(): void
  stream(label: string, done: number, total: number): void
  /** World warm-up progress (0..1 of the part after the first frame). */
  progress(label: string, fraction: number): void
  done(): void
  fail(message: string): void
}

export function createLoader(hidden: boolean): Loader {
  const root = document.querySelector<HTMLDivElement>("#boot")
  const label = root?.querySelector<HTMLElement>(".boot-label")
  const bar = root?.querySelector<HTMLElement>(".boot-bar i")
  if (!root || hidden) {
    root?.remove()
    const noop = () => {}
    return { step: noop, live: noop, stream: noop, progress: noop, done: noop, fail: noop }
  }
  let shown = 0
  const set = (text: string, f: number) => {
    shown = Math.max(shown, Math.min(1, f))
    if (label) label.textContent = text ? `${text} · ${Math.floor(shown * 100)}%` : ""
    if (bar) bar.style.transform = `scaleX(${Math.max(0.02, shown)})`
  }
  return {
    step: (text, f) => set(text, f * 0.15),
    live() {
      root.classList.add("live")
    },
    stream(text, done, total) {
      set(text, 0.15 + 0.82 * (done / Math.max(total, 1)))
    },
    progress(text, f) {
      set(text, 0.15 + 0.82 * f)
    },
    done() {
      set("", 1)
      root.classList.add("done")
      setTimeout(() => root.remove(), 1200)
    },
    fail(message) {
      root.classList.add("failed")
      if (label) label.textContent = message
    },
  }
}
