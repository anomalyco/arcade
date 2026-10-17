// The boot overlay lives in index.html (inline CSS) so it paints before any script loads. This drives it: progress
// while the first frame is prepared, then it fades to reveal the live frame and shrinks to a corner line while the
// rest of the world streams in.

export type Loader = {
  step(label: string, fraction: number): void
  /** The first real frame is on screen: fade the cover, keep a small streaming indicator. */
  live(): void
  stream(label: string, done: number, total: number): void
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
    return { step: noop, live: noop, stream: noop, done: noop, fail: noop }
  }
  const set = (text: string, f: number) => {
    if (label) label.textContent = text
    if (bar) bar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, f))})`
  }
  return {
    step: (text, f) => set(text, f * 0.5),
    live() {
      root.classList.add("live")
    },
    stream(text, done, total) {
      set(text, 0.5 + 0.5 * (done / Math.max(total, 1)))
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
