import { MODES, SND } from "../../shared/sim/modes"
import type { RosterRow, Snapshot } from "../../shared/sim/view"

export type Rgb = [number, number, number]
/** Orange and cyan, the first two colours of the free-for-all palette. */
export const TEAM_COLORS: [Rgb, Rgb] = [
  [1.0, 0.38, 0.08],
  [0.08, 0.72, 1.0],
]
const NEUTRAL: Rgb = [0.85, 0.85, 0.85]

export const teamsOn = (s: Snapshot | null) => !!s && MODES[s.mode.id].teams

/** A player's team in a team mode, else -1. */
export function teamOf(s: Snapshot | null, roster: RosterRow[], id: string): number {
  if (!teamsOn(s)) return -1
  return roster.find((r) => r.id === id)?.team ?? -1
}

/** Whether holding the use key at (x, y) plants or defuses: the client roots you exactly as the server will. */
export function canUse(s: Snapshot | null, team: number, myId: string, x: number, y: number): boolean {
  const r = s?.mode.round
  const b = s?.mode.bomb
  if (!s || !r || !b || r.post || s.phase !== "play") return false
  if (b.state === "carried" && b.carrier === myId) return s.mode.sites.some((site) => Math.hypot(site.x - x, site.y - y) <= site.r)
  return b.state === "planted" && team === 1 - r.attack && Math.hypot(b.x - x, b.y - y) <= SND.defuseRange
}

type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void

/**
 * Objectives on the floor: domination rings in their owner's colour with a capture wedge filling in the capturer's,
 * bomb sites as dashed rings, and the bomb itself, blinking faster as the fuse runs down once planted.
 */
export function modeSprites(s: Snapshot | null, t: number, sprite: Sprite): void {
  if (!s) return
  for (const p of s.mode.points) {
    const c = p.owner >= 0 ? TEAM_COLORS[p.owner] : NEUTRAL
    const pulse = p.contested ? 0.6 + 0.4 * Math.sin(t * 12) : 1
    sprite(true, p.x, 0.035, p.y, p.r, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.9 * pulse, 2, 0, 0.035)
    sprite(true, p.x, 0.03, p.y, p.r - 0.25, c[0], c[1], c[2], 0.35, 5, t * 0.3, 0.02)
    sprite(false, p.x, 0.012, p.y, p.r, c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, 0.25, 6)
    if (p.capper >= 0 && p.progress > 0) {
      const k = TEAM_COLORS[p.capper]
      sprite(true, p.x, 0.04, p.y, p.r * 0.92, k[0], k[1], k[2], 0.4, 8, -Math.PI / 2, 1, Math.max(0.02, p.progress * Math.PI))
    }
  }
  for (const site of s.mode.sites) {
    sprite(true, site.x, 0.035, site.y, site.r, 1.3, 0.25, 0.15, 0.8, 5, t * 0.2, 0.03)
    sprite(false, site.x, 0.012, site.y, site.r, 0.3, 0.05, 0.03, 0.25, 6)
  }
  const b = s.mode.bomb
  if (b && (b.state === "dropped" || b.state === "planted")) {
    const rate = b.state === "planted" ? (b.fuse < 5 ? 10 : b.fuse < 15 ? 4 : 2) : 1
    const on = Math.sin(t * rate * Math.PI) > 0
    sprite(true, b.x, 0.25, b.y, on ? 0.4 : 0.2, 2.5, 0.2, 0.1, 1, 0)
    sprite(true, b.x, 0.03, b.y, b.state === "planted" ? SND.defuseRange : 0.6, 1.5, 0.15, 0.1, on ? 0.8 : 0.4, 2, 0, 0.06)
  }
}
