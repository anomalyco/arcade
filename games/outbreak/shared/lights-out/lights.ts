import type { StoreState } from "@arcade/kit/sim/ledger"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Lamp, Town } from "../map"

/**
 * Lights Out (AR-56, D-37 pick 1): street lamps and porch lights you can put out. Shoot one and the glass pops, it
 * rains onto the ground and the lamp is dark for good; a porch light can also be switched off (and on again) at its
 * front door. A dark lamp lights nothing, so the dead see less of a survivor standing under it. Pure geometry and store
 * naming; the state is one ledger store per lamp anyone has touched.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `lamp:<x>,<y>` | `broken`, `off`, `t` (deciseconds) | shot out (for good); switched off; when it was shot |
 *
 * No store means a lamp nobody has touched, lit whenever the hour lights it.
 */

export type LightsTuning = {
  /** How close a shot must pass a lamp's head to put it out, in metres. */
  lampHitRadius: number
  /** How far the pop of a lamp's glass carries to the dead, in metres (the gunshot itself is louder). */
  lampPopNoise: number
}

export const DEFAULT_LIGHTS_TUNING: LightsTuning = {
  lampHitRadius: 0.5,
  lampPopNoise: 9,
}

/** Lab controls for Lights Out (Backquote › Lights out); the values live in the Discovery settings. */
export const lightsControls = [
  { key: "lampHitRadius", label: "Shot puts a lamp out within", group: "Lights out", min: 0.2, max: 1.2, step: 0.05, unit: "m" },
  { key: "lampPopNoise", label: "Lamp pop noise", group: "Lights out", min: 0, max: 30, step: 0.5, unit: "m" },
] as const

/** Stable id for a lamp (streamed lamps change index but not position). */
export const lampStoreId = (lamp: Pick<Lamp, "x" | "y">) => `lamp:${lamp.x.toFixed(1)},${lamp.y.toFixed(1)}`

/** Lamps a bullet can put out: the street lamps and the porch lights. */
export const shootable = (lamp: Lamp) => lamp.kind === "street" || lamp.kind === "porch"

/**
 * Where a lamp's glass is, in plan, for a shot to hit: a street lamp's head hangs off its post on the arm (as
 * `resolveLampLight` places its light); a porch light is the pair of coach lanterns either side of the front door.
 */
export function lampHeads(lamp: Lamp): { x: number; y: number }[] {
  if (lamp.kind === "street") return [{ x: lamp.x + 0.4, y: lamp.y }]
  return [
    { x: lamp.x - 0.94, y: lamp.y - 0.46 },
    { x: lamp.x + 0.94, y: lamp.y - 0.46 },
  ]
}

/** The porch light's switch, beside the front door on the lantern's side, where a survivor on the step reaches it. */
export function porchSwitch(lamp: Lamp): { x: number; y: number; rect: Rect } {
  const x = lamp.x + 0.94
  const y = lamp.y - 0.38
  return { x, y, rect: [x - 0.12, y - 0.06, x + 0.12, y + 0.06] }
}

/** Whether a lamp gives no light: shot out, or switched off. */
export function lampDark(st: StoreState | undefined): boolean {
  return Boolean(st && (st.counts.broken || st.counts.off))
}

/**
 * The first lamp a shot from `(x0, y0)` to `(x1, y1)` passes within `radius` of, and how far along the shot, or null.
 * The shot stops at what it hit (a wall or one of the dead), so a lamp behind that is safe.
 */
export function lampOnShot(town: Town, x0: number, y0: number, x1: number, y1: number, radius: number, skip: (lamp: Lamp) => boolean): { lamp: Lamp; t: number } | null {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-4) return null
  const ux = dx / len
  const uy = dy / len
  let best: { lamp: Lamp; t: number } | null = null
  for (const lamp of town.lamps) {
    if (!shootable(lamp) || skip(lamp)) continue
    for (const h of lampHeads(lamp)) {
      const t = (h.x - x0) * ux + (h.y - y0) * uy
      // A lantern on a wall's face is hit by a shot that stops at that wall, but not through it from indoors.
      if (t < 0 || t > len + 0.25) continue
      const off = Math.abs((h.x - x0) * uy - (h.y - y0) * ux)
      if (off > radius) continue
      if (!best || t < best.t) best = { lamp, t }
    }
  }
  return best
}
