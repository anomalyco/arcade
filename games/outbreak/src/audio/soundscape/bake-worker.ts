/// <reference lib="webworker" />
import { scapeSound, SCAPE_SAMPLE_RATE } from "./catalog"

/** Bakes soundscape sounds off the main thread: `{ id }` in, `{ id, pcm, ms }` out (the PCM is transferred). */
self.onmessage = (e: MessageEvent<{ id: string }>) => {
  const def = scapeSound(e.data.id)
  if (!def) return
  const t0 = performance.now()
  const pcm = def.bake(SCAPE_SAMPLE_RATE)
  ;(self as unknown as Worker).postMessage({ id: def.id, pcm, ms: performance.now() - t0 }, [pcm.buffer])
}
