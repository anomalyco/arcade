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

// ------------------------------------------------------------------------------------------------ bounded waits
// Every wait in the boot path is bounded, so a stalled download, a model or texture whose transcoder never answers, or a
// compile that never finishes can't leave the loading screen up forever. The bound is a *stall*, not a deadline: a
// wait gives up only after nothing at all has happened for `STALL_MS` (no resource finished downloading, no boot
// step completed, no shader finished compiling), so a slow connection or CPU that is still making progress is never
// cut short (that would change what's on screen). Giving up logs a warning and the boot carries on with what it has.

/** No progress at all for this long means stuck. */
export const STALL_MS = 45_000
let lastActivity = performance.now()
/** Milliseconds since anything last moved. */
export const stalledFor = () => performance.now() - lastActivity
/** Something moved (a download finished, a boot step completed). */
export function touch() {
  lastActivity = performance.now()
}
try {
  new PerformanceObserver(() => touch()).observe({ type: "resource", buffered: false })
} catch {}

/**
 * `p`, or `fallback` once nothing has happened for `stallMs` (checked every second). `onStall` runs on giving up
 * (log it). Never rejects: a rejection of `p` resolves `fallback` too, after `onError`.
 */
export function untilStalled<T>(p: Promise<T>, fallback: T, onStall: () => void, stallMs = STALL_MS, onError?: (e: unknown) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const finish = (v: T) => {
      if (done) return
      done = true
      clearInterval(timer)
      resolve(v)
    }
    const timer = setInterval(() => {
      if (performance.now() - lastActivity > stallMs) {
        onStall()
        finish(fallback)
      }
    }, 1000)
    p.then(finish, (e: unknown) => {
      onError?.(e)
      finish(fallback)
    })
  })
}
