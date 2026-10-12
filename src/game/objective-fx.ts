import { TEAM_NAMES } from "../../shared/sim/modes"
import { CTF } from "../../shared/sim/modes-objective"
import type { Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import type { Rgb } from "./mode-fx"

type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void
/** Where a player is drawn right now (smoother than the snapshot), or null. */
export type Where = (id: string) => { x: number; y: number } | null

const NEUTRAL: Rgb = [0.85, 0.85, 0.85]

/**
 * Kill confirmed tags bob and glow in the victim's colour, blinking before they go. The hardpoint is a bright ring in
 * its holder's colour (pulsing red when contested) with the next zone a faint dashed ring once it's announced. Flags
 * are a glowing pole and pennant at their base ring, on a dropped spot, or over the carrier's head with a ring at
 * their feet.
 */
export function objectiveSprites(s: Snapshot, t: number, team: [Rgb, Rgb], sprite: Sprite, where?: Where): void {
  for (const g of s.mode.tags ?? []) {
    const c = team[g.team] ?? NEUTRAL
    const blink = g.left < 5 && Math.sin(t * 14) < 0 ? 0.35 : 1
    const bob = 0.45 + Math.sin(t * 3 + g.id) * 0.08
    sprite(true, g.x, bob, g.y, 0.3, c[0] * 2, c[1] * 2, c[2] * 2, blink, 0)
    sprite(true, g.x, bob, g.y, 0.12, 1.6, 1.6, 1.6, blink, 0)
    sprite(true, g.x, 0.03, g.y, 0.45, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.55 * blink, 2, 0, 0.1)
  }
  const z = s.mode.zone
  if (z) {
    const c = z.contested ? ([1, 0.2, 0.15] as Rgb) : z.holder >= 0 ? team[z.holder]! : NEUTRAL
    const pulse = z.contested ? 0.55 + 0.45 * Math.sin(t * 12) : 1
    sprite(true, z.x, 0.035, z.y, z.r, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.95 * pulse, 2, 0, 0.03)
    sprite(true, z.x, 0.03, z.y, z.r - 0.3, c[0], c[1], c[2], 0.4, 5, t * 0.35, 0.02)
    sprite(false, z.x, 0.012, z.y, z.r, c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, 0.3, 6)
    // The last ten seconds: the ring blinks, and the next zone shows faintly.
    if (z.next) {
      const on = 0.5 + 0.5 * Math.sin(t * 5)
      sprite(true, z.next.x, 0.03, z.next.y, z.r, 0.8, 0.8, 0.85, 0.15 + 0.2 * on, 5, -t * 0.3, 0.025)
    }
  }
  for (const f of s.mode.flags ?? []) {
    const c = team[f.team]!
    sprite(true, f.base.x, 0.035, f.base.y, CTF.capture, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, f.state === "home" ? 0.8 : 0.35, 5, t * 0.25, 0.04)
    sprite(false, f.base.x, 0.012, f.base.y, CTF.capture, c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, 0.3, 6)
    let at = { x: f.x, y: f.y }
    let lift = 0
    if (f.state === "carried") {
      at = where?.(f.carrier) ?? at
      lift = 1.2
      const pulse = 0.6 + 0.4 * Math.sin(t * 8)
      sprite(true, at.x, 0.04, at.y, 0.75, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, pulse, 2, 0, 0.12)
    }
    const blink = f.state === "dropped" && f.returnIn < 5 && Math.sin(t * 12) < 0 ? 0.4 : 1
    // The pole, then the pennant at the top.
    for (let k = 0; k < 6; k++) sprite(true, at.x, lift + 0.1 + k * 0.22, at.y, 0.07, 1.2, 1.2, 1.2, 0.8 * blink, 0)
    sprite(true, at.x + 0.18, lift + 1.2, at.y, 0.32, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, blink, 0)
    if (f.state === "dropped") sprite(true, at.x, 0.03, at.y, CTF.touch, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.6 * blink, 2, 0, 0.08)
  }
}

/** A banner line for an objective event, or null. */
export function objectiveBanner(e: Extract<SimEvent, { k: "obj" }>, myId: string, myTeam: number, nameOf: (id: string) => string): string | null {
  const who = e.by === myId ? "YOU" : nameOf(e.by).toUpperCase()
  const flag = `${TEAM_NAMES[e.team] ?? ""} FLAG`
  switch (e.what) {
    case "confirm":
      return e.by === myId ? "KILL CONFIRMED" : null
    case "deny":
      return e.by === myId ? "KILL DENIED" : null
    case "move":
      return "HARDPOINT MOVED"
    case "take":
      return e.team === myTeam ? `${who} TOOK YOUR FLAG` : `${who} TOOK THE ${flag}`
    case "drop":
      return `${flag} DROPPED`
    case "return":
      return `${flag} RETURNED`
    case "capture":
      return e.team === myTeam ? `${who} CAPTURED THE FLAG` : `${TEAM_NAMES[e.team]} CAPTURED YOUR FLAG`
    default:
      return null
  }
}
