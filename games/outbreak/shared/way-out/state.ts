import type { Ledger, StoreState } from "@arcade/kit/sim/ledger"

/**
 * The Way Out's shared state (AR-64): one counters store, `wayout`, so it snapshots, saves and reaches every co-op
 * seat like any other shared store, and the feature adds nothing to the wire. Times are deciseconds of sim time.
 *
 * | Count | Meaning |
 * | --- | --- |
 * | `tier` | 0 nothing, 1 rumour, 2 direction, 3 confirmed |
 * | `c:<clue id>` | the squad has this clue (`note:<building>`, `flyer:<body>`, `police:<building>`, `sign`, `soldier`, `radio`, `arrive`) |
 * | `last`, `lastAt`, `lastBy` | the latest event (`CLUE_CODE` or `EVENT_*`), when, and who (slot index + 1) |
 * | `night`, `deadline` | nights begun (1 from the first dusk) and the night whose dawn the last evac leaves at |
 * | `sig`, `standEnd` | signalled at (the stand is on while set), and when a fixed hold ends (0: at dawn) |
 * | `wave`, `nextWave` | siege waves sent, and when the next comes |
 * | `missed`, `late` | the way out is gone; the late boat has been used |
 * | `won`, `wonNight`, `played` | escaped at, on that night, after this many seconds of play |
 * | `esc:<index>`, `kills:<index>` | who made it out, and each survivor's kills at the end |
 */

export const WAY_OUT_STORE = "wayout"
export const ds = (seconds: number) => Math.round(seconds * 10)

export type WayOutView = {
  tier: number
  clues: Set<string>
  last: number
  lastAt: number
  lastBy: number
  night: number
  deadline: number
  signalled: boolean
  signalAt: number
  standEnd: number
  wave: number
  missed: boolean
  late: boolean
  won: boolean
  wonAt: number
  wonNight: number
  played: number
  escaped: number[]
  kills: Record<number, number>
}

export function readWayOut(st: StoreState | undefined): WayOutView | null {
  if (!st) return null
  const c = st.counts
  const clues = new Set<string>()
  const escaped: number[] = []
  const kills: Record<number, number> = {}
  for (const [k, v] of Object.entries(c)) {
    if (!v) continue
    if (k.startsWith("c:")) clues.add(k.slice(2))
    else if (k.startsWith("esc:")) escaped.push(Number(k.slice(4)))
    else if (k.startsWith("kills:")) kills[Number(k.slice(6))] = v
  }
  escaped.sort((a, b) => a - b)
  return {
    tier: c.tier ?? 0,
    clues,
    last: c.last ?? 0,
    lastAt: c.lastAt ?? 0,
    lastBy: (c.lastBy ?? 0) - 1,
    night: c.night ?? 0,
    deadline: c.deadline ?? 0,
    signalled: (c.sig ?? 0) > 0,
    signalAt: (c.sig ?? 0) / 10,
    standEnd: (c.standEnd ?? 0) / 10,
    wave: c.wave ?? 0,
    missed: Boolean(c.missed),
    late: Boolean(c.late),
    won: (c.won ?? 0) > 0,
    wonAt: (c.won ?? 0) / 10,
    wonNight: c.wonNight ?? 0,
    played: c.played ?? 0,
    escaped,
    kills,
  }
}

export const wayOutOf = (ledger: Pick<Ledger, "store">) => readWayOut(ledger.store(WAY_OUT_STORE))

/** Whether the run was won (read by the room to allow a restart, and by the death HUD's neighbours). */
export const wayOutWon = (ledger: Pick<Ledger, "store">) => (ledger.store(WAY_OUT_STORE)?.counts.won ?? 0) > 0
