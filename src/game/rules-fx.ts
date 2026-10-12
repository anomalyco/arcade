import { at } from "./rig"
import type { Avatar } from "./anim"
import type { RosterRow, Snapshot } from "../../shared/sim/view"

type Rgb = [number, number, number]
/** Infected: survivors in orange, the infected a sickly green. */
export const INF_COLORS: [Rgb, Rgb] = [
  [1.0, 0.38, 0.08],
  [0.35, 1.0, 0.12],
]

/** Whether someone is infected right now. */
export const infected = (s: Snapshot | null, roster: RosterRow[], id: string): boolean => s?.mode.id === "inf" && roster.find((r) => r.id === id)?.team === 1

type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number) => void

/** Two glowing eyes on the visor, flickering a little. */
export function eyes(a: Avatar, t: number, sprite: Sprite): void {
  const h = a.body?.head
  if (!h) return
  const k = 0.85 + 0.15 * Math.sin(t * 9 + a.seed)
  for (const side of [-1, 1]) {
    const p = at(h, 0.17, 0.165, side * 0.05)
    sprite(true, p[0], p[1], p[2], 0.05, 1.6 * k, 3 * k, 0.3 * k, 1, 0)
  }
}
