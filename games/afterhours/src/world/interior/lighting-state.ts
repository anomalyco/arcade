import { type Face, type Rect, SHELL, WINDOWS } from "./plan"

// The building at 3 a.m.: which rooms have a light on, what kind, and where the light is. ONE source of truth for
//  - the interior (the storeys' real lamps are placed at these sources; `checkNightState` warns if they drift),
//  - the outdoor storey proxies (interior/windowproxy.ts),
//  - the facility's lit window panes (facility/shell.ts: `litWindows()` / `windowLight()`).
// Rooms not listed are dark. Coordinates are world x/z; storeys 0–4.

export type NightLit = "off" | "desk" | "full" | "work" | "beacon" | "crt" | "hood"
/** A light inside the room: world (x, z) and how far it carries to a window (m). */
export type NightSource = { x: number; z: number; reach?: number }
export type NightRoom = { room: string; storey: number; rect: Rect; lit: NightLit; /** Linear RGB window tint (×1). */ tint: readonly [number, number, number]; sources: NightSource[] }

const WARM = [1.4, 0.78, 0.36] as const
const LAMP = [1.0, 0.6, 0.28] as const
const COOL = [0.85, 1.1, 0.95] as const
const HOOD = [0.55, 0.85, 0.75] as const
const RED = [1.3, 0.08, 0.05] as const
const WORK = [1.5, 1.3, 0.9] as const
const GREEN = [0.35, 0.95, 0.55] as const

const r = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 })
const REACH: Record<NightLit, number> = { off: 0, desk: 9, full: 30, work: 14, beacon: 7, crt: 5, hood: 7 }

export const NIGHT_ROOMS: readonly NightRoom[] = [
  // Storey 0: lived-in: security, food, the auditorium projector left running, facilities office.
  { room: "0-14", storey: 0, rect: r(-47.8, -41.5, -21.65, -14.15), lit: "full", tint: COOL, sources: [{ x: -43.2, z: -19.2 }] },
  { room: "0-15", storey: 0, rect: r(-41.5, -37, -21.65, -14.15), lit: "desk", tint: LAMP, sources: [{ x: -39.2, z: -17.8 }, { x: -37.4, z: -20.4 }] },
  { room: "0-20", storey: 0, rect: r(6.2, 11.6, -21.65, -1.75), lit: "desk", tint: LAMP, sources: [{ x: 10.7, z: -12.9 }] },
  { room: "0-30", storey: 0, rect: r(-54.65, -47.8, 1.75, 8.1), lit: "desk", tint: LAMP, sources: [{ x: -50.7, z: 5.2 }] },
  { room: "0-31", storey: 0, rect: r(-54.65, -47.8, 8.25, 21.65), lit: "full", tint: COOL, sources: [{ x: -52.2, z: 13.2 }] },
  { room: "0-35", storey: 0, rect: r(-36, -20.8, 9.75, 21.65), lit: "crt", tint: COOL, sources: [{ x: -28.4, z: 19.3, reach: 10 }] },
  { room: "0-38", storey: 0, rect: r(9.15, 17, 9, 21.65), lit: "desk", tint: WARM, sources: [{ x: 12.5, z: 11.4, reach: 11 }] },
  { room: "0-39", storey: 0, rect: r(17, 34.65, 9.75, 21.65), lit: "full", tint: COOL, sources: [{ x: 24.6, z: 15.6 }] },
  // Storey 1: dark open office, isolated desk lamps; conference B left on.
  { room: "1-01", storey: 1, rect: r(-48.4, -37, -21.65, -1.75), lit: "full", tint: COOL, sources: [{ x: -43.8, z: -17.4 }] },
  { room: "1-07", storey: 1, rect: r(-20.8, -15.4, -21.65, -11.925), lit: "desk", tint: LAMP, sources: [{ x: -18.7, z: -17.4 }] },
  { room: "1-09f", storey: 1, rect: r(11.6, 17, -21.65, -14), lit: "desk", tint: LAMP, sources: [{ x: 13.7, z: -18.6 }] },
  { room: "1-10", storey: 1, rect: r(17, 34.65, -21.65, -1.75), lit: "desk", tint: LAMP, sources: [{ x: 25.6, z: -9.3 }] },
  { room: "1-24", storey: 1, rect: r(-26.2, 22.4, 1.75, 21.65), lit: "desk", tint: LAMP, sources: [{ x: 12.4, z: 17.0 }] },
  { room: "1-25", storey: 1, rect: r(22.4, 34.65, 9.45, 21.65), lit: "full", tint: COOL, sources: [{ x: 24.0, z: 15.6 }, { x: 31.2, z: 15.6 }] },
  // Storey 2: labs stay lit for safety; the lit fume hood in 2-04.
  { room: "2-04", storey: 2, rect: r(-42.4, -31.6, -21.65, -1.75), lit: "hood", tint: HOOD, sources: [{ x: -41.9, z: -19.4 }] },
  { room: "2-05L", storey: 2, rect: r(-31.6, -20.8, -21.65, -12), lit: "full", tint: COOL, sources: [{ x: -26.2, z: -21.0 }] },
  { room: "2-10", storey: 2, rect: r(22.4, 34.65, -21.65, -1.75), lit: "full", tint: COOL, sources: [{ x: 28.0, z: -4.5 }] },
  { room: "2-25", storey: 2, rect: r(-20.8, -4.6, 1.75, 21.65), lit: "desk", tint: LAMP, sources: [{ x: -12.1, z: 8.0, reach: 14 }] },
  { room: "2-27", storey: 2, rect: r(6.2, 22.4, 1.75, 21.65), lit: "full", tint: COOL, sources: [{ x: 8.4, z: 15.6 }, { x: 12.0, z: 12.0 }, { x: 14.4, z: 15.6 }] },
  // Storey 3: green CRTs in the terminal pool, desk lamps in the listening booth and offices.
  { room: "3-06", storey: 3, rect: r(-15.4, -4.6, -21.65, -11.925), lit: "desk", tint: LAMP, sources: [{ x: -7.1, z: -12.7, reach: 10 }] },
  { room: "3-08b", storey: 3, rect: r(6.2, 11.6, -21.65, -14.925), lit: "desk", tint: WARM, sources: [{ x: 9.4, z: -19.8 }] },
  { room: "3-09", storey: 3, rect: r(11.6, 34.65, -21.65, -1.75), lit: "desk", tint: LAMP, sources: [{ x: 13.9, z: -6.5, reach: 16 }, { x: 22.9, z: -16.4 }] },
  { room: "3-24", storey: 3, rect: r(-26.2, -4.6, 1.75, 21.65), lit: "crt", tint: GREEN, sources: [{ x: -12.5, z: 17.1 }, { x: -13.5, z: 17.9 }] },
  { room: "3-25c", storey: 3, rect: r(27.8, 34.65, 7.875, 21.65), lit: "desk", tint: LAMP, sources: [{ x: 30.6, z: 19.0 }] },
  // Storey 4: dark construction site with two clamp work lights; the red receiver beacon; the Director.
  { room: "4-01", storey: 4, rect: r(-54.65, -4.6, -21.65, -1.75), lit: "work", tint: WORK, sources: [{ x: -38.6, z: -3.5 }, { x: -18.9, z: -17.0 }] },
  { room: "4-10", storey: 4, rect: r(0.8, 11.6, 1.75, 21.65), lit: "desk", tint: LAMP, sources: [{ x: 4.6, z: 19.9 }] },
  { room: "4-11", storey: 4, rect: r(0.8, 11.6, -21.65, -1.75), lit: "beacon", tint: RED, sources: [{ x: 3.0, z: -19.6 }] },
  { room: "4-14", storey: 4, rect: r(22.55, 34.65, -1.6, 21.65), lit: "desk", tint: WARM, sources: [{ x: 28.5, z: 13.6, reach: 10 }, { x: 23.7, z: -1.1 }] },
]

const inRect = (t: Rect, x: number, z: number) => x >= t.x0 - 1e-3 && x <= t.x1 + 1e-3 && z >= t.z0 - 1e-3 && z <= t.z1 + 1e-3

/** The lit room at a world point on a storey, if any. */
export function nightRoomAt(storey: number, x: number, z: number): NightRoom | undefined {
  return NIGHT_ROOMS.find((n) => n.storey === storey && inRect(n.rect, x, z))
}

export type LitWindow = {
  face: Face
  storey: number
  /** Opening along the facade (x for north/south, z for west/east), sill/head above the storey floor. */
  u0: number
  u1: number
  sill: number
  head: number
  room: string
  lit: NightLit
  tint: readonly [number, number, number]
  /** 0..1: how strongly the room's light reaches this window (1 = fixture right behind it). */
  strength: number
}

/** The room light seen through one window bay (undefined: dark). */
export function windowLight(storey: number, face: Face, u: number): LitWindow | undefined {
  const w = WINDOWS(storey, face).find((o) => u > o.u0 - 0.06 && u < o.u1 + 0.06)
  if (!w) return undefined
  const c = (w.u0 + w.u1) / 2
  const [x, z] = face === "north" ? [c, SHELL.z0 + 0.3] : face === "south" ? [c, SHELL.z1 - 0.3] : face === "west" ? [SHELL.x0 + 0.3, c] : [SHELL.x1 - 0.3, c]
  const n = nightRoomAt(storey, x, z)
  if (!n || n.lit === "off") return undefined
  let best = 0
  for (const s of n.sources) {
    const reach = s.reach ?? REACH[n.lit]
    const d = Math.hypot(s.x - x, s.z - z)
    if (d < reach) best = Math.max(best, 1 - (d / reach) * 0.6)
  }
  if (best <= 0) return undefined
  return { face, storey, u0: w.u0, u1: w.u1, sill: w.sill, head: w.head, room: n.room, lit: n.lit, tint: n.tint, strength: best }
}

/** Every lit window bay of the main block at 3 a.m. (for the facility's panes and the outdoor proxies). */
export function litWindows(): LitWindow[] {
  const out: LitWindow[] = []
  for (let s = 0; s < 5; s++)
    for (const face of ["north", "south", "west", "east"] as Face[])
      for (const w of WINDOWS(s, face)) {
        const l = windowLight(s, face, (w.u0 + w.u1) / 2)
        if (l) out.push(l)
      }
  return out
}

/**
 * Dev check: every listed source has a real lamp within 1.5 m. Returns the mismatches (logged by interior.ts).
 */
export function checkNightState(lamps: readonly { kind: string; zone?: string; position: readonly number[]; intensity: number }[]): string[] {
  const out: string[] = []
  const real = lamps.filter((l) => l.kind !== "exit" && l.intensity >= 0.5 && l.zone?.startsWith("interior:"))
  for (const n of NIGHT_ROOMS)
    for (const s of n.sources)
      if (!real.some((l) => l.zone === `interior:${n.storey}` && Math.hypot(l.position[0]! - s.x, l.position[2]! - s.z) < 1.5)) out.push(`${n.room}: no lamp at source (${s.x}, ${s.z})`)
  return out
}
