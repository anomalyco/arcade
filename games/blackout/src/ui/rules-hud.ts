import type { ModeId } from "../../shared/sim/modes"
import { FIXED_LOADOUT, INF_TEAMS, OITC } from "../../shared/sim/modes-rules"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { type Game, css } from "../game/game"
import { INF_COLORS } from "../game/rules-fx"

/** HUD bits for infected, gun game and one in the chamber. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const stat = (r: RosterRow, k: string) => r.stats?.[k] ?? 0

/** Whether the mode hands out the loadout, so the gun and equipment picks are hidden. */
export const fixedLoadout = (s: Snapshot | null) => !!s && (s.mode.id === "wizards" || FIXED_LOADOUT.includes(s.mode.id))

/** The number on the mini leaderboard and how it ranks: score, tier or lives instead of kills. */
export function boardStat(id: ModeId): ((r: RosterRow) => number) | null {
  if (id === "inf") return (r) => stat(r, "score")
  if (id === "gun") return (r) => stat(r, "tier") + 1
  if (id === "oitc") return (r) => stat(r, "lives") * 1000 + r.kills
  return null
}

/** Scoreboard columns these modes add. */
export function rulesColumns(id: ModeId): [string, (r: RosterRow) => number][] {
  if (id === "inf") return [["SCORE", (r) => stat(r, "score")]]
  if (id === "gun") return [["TIER", (r) => stat(r, "tier") + 1]]
  if (id === "oitc") return [["LIVES", (r) => stat(r, "lives")]]
  return []
}

/** Team names and colours on the scoreboard in infected. */
export const rulesTeam = (id: ModeId, t: number): { name: string; color: string } | null => (id === "inf" ? { name: INF_TEAMS[t] ?? "", color: css(INF_COLORS[t === 1 ? 1 : 0]) } : null)

/** What the mode asks of you, for the intro banner. */
export function rulesObjective(s: Snapshot, team: number): string | null {
  const id = s.mode.id
  if (id === "inf") return team === 1 ? "you're infected · swipe the survivors" : "survive three minutes · one of you is about to turn"
  if (id === "gun") return "a new gun every kill · a knife kill finishes"
  if (id === "oitc") return "one bullet kills · a kill gives another · three lives"
  return null
}

/** The line under the clock, or null for the usual mode HUD. */
export function rulesTop(g: Game): string | null {
  const s = g.snap
  const r = s?.mode.rules
  if (!s || !r) return null
  const me = g.roster.find((x) => x.id === g.myId)
  if (r.id === "inf") {
    const [sc, ic] = INF_COLORS.map(css)
    const line = `<div class="scores"><b style="color:${sc}">${r.survivors}</b><span class="tgt">${r.countdown > 0 ? `TURNS IN ${Math.ceil(r.countdown)}` : "ALIVE"}</span><b style="color:${ic}">${r.infected}</b></div>`
    const role = me ? `<div class="snd"><span class="role" style="color:${me.team === 1 ? ic : sc}">${me.team === 1 ? "INFECTED" : "SURVIVOR"} · ${stat(me, "score")} PTS</span></div>` : ""
    return line + role
  }
  if (r.id === "gun") {
    const tier = me ? stat(me, "tier") : 0
    const next = r.ladder[tier + 1]
    return `<div class="scores"><span class="tgt">TIER ${tier + 1}/${r.ladder.length}</span></div><div class="snd"><span class="role">${esc(r.ladder[tier] ?? "")}${next ? ` · NEXT ${esc(next)}` : " · FINAL"}</span></div>`
  }
  const lives = me ? stat(me, "lives") : 0
  const bullets = g.alive ? g.mag : 0
  return `<div class="scores"><span class="tgt">${"●".repeat(bullets)}${"○".repeat(Math.max(0, r.max - bullets))}</span></div><div class="snd"><span class="role">${"♥".repeat(lives)}${"♡".repeat(Math.max(0, OITC.lives - lives))} · ${r.left} LEFT</span></div>`
}

/** Who won a free-for-all mode that doesn't go by kills, once it's over. */
export function rulesWinner(s: Snapshot, roster: RosterRow[]): RosterRow | null {
  const r = s.mode.rules
  return r && "winner" in r ? (roster.find((x) => x.id === r.winner) ?? null) : null
}

/** Shown while you're out for good: one in the chamber with no lives left. */
export function rulesOut(s: Snapshot): string | null {
  return s.mode.id === "oitc" ? "out of lives" : null
}
