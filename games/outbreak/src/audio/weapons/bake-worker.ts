/// <reference lib="webworker" />
import { WEAPON_SAMPLE_RATE, weaponSound } from "./catalog"

/** Bakes every take of a weapon sound off the main thread: `{ id }` in, `{ id, takes, ms }` out (PCM transferred). */
self.onmessage = (e: MessageEvent<{ id: string }>) => {
  const def = weaponSound(e.data.id)
  if (!def) return
  const t0 = performance.now()
  const takes = Array.from({ length: def.variants }, (_, v) => def.bake(WEAPON_SAMPLE_RATE, v))
  ;(self as unknown as Worker).postMessage({ id: def.id, takes, ms: performance.now() - t0 }, takes.map((t) => t.buffer))
}
