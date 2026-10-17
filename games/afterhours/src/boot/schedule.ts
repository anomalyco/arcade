// Yielding helpers so boot work never holds the main thread for long.

const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler

/** Lets the browser handle input and paint before continuing (scheduler.yield where available). */
export function yieldToMain(): Promise<void> {
  if (sched?.yield) return sched.yield()
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(null)
  })
}

/** Resolves just after the next animation frame has been rendered. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}
