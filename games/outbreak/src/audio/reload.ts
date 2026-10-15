import { PISTOL_RELOAD_TIME } from "../../shared/combat"

/**
 * The pistol reload's sounds, keyed to the reload pose (`PISTOL_RELOAD_LEFT` in `survivor.ts`, as a fraction of the
 * 1.15 s clip): the left hand reaches the gun at 0.12 (release), the empty magazine falls as the hand leaves for the
 * belt (0.19), the fresh one seats where the magazine disappears into the grip (0.63), and the slide snaps forward
 * after the hand pulls it back (0.74–0.82, released by 0.84). `lead` starts each sample early by the median time to its
 * loudest transient across its variants, so that transient lands on the pose.
 */
export const RELOAD_EVENTS = [
  { id: "gun.pistol.mag-release", at: 0.11, lead: 0.03 },
  { id: "gun.pistol.mag-out", at: 0.19, lead: 0.12 },
  { id: "gun.pistol.mag-in", at: 0.63, lead: 0.18 },
  { id: "gun.pistol.slide", at: 0.84, lead: 0.05 },
] as const

/** Start time of each part in seconds after the reload began. */
export const RELOAD_STARTS = RELOAD_EVENTS.map((e) => ({ id: e.id, start: Math.max(0, e.at * PISTOL_RELOAD_TIME - e.lead) }))

/** Co-op snapshots carry only "reloading": remote survivors report this sentinel for the whole reload (see `survivor.ts`). */
export const REMOTE_RELOADING = 0.5

/**
 * Seconds into the reload: from `reloadRemaining` while it counts down, or from when it was first seen while it holds
 * the remote sentinel (a local countdown passes 0.5 too, but never holds it two frames running or starts on it).
 */
export function reloadElapsed(remaining: number, previous: number, startedAt: number, now: number): number {
  const sentinel = (v: number) => Math.abs(v - REMOTE_RELOADING) < 1e-4
  return sentinel(remaining) && (previous <= 0 || sentinel(previous)) ? now - startedAt : PISTOL_RELOAD_TIME - remaining
}
