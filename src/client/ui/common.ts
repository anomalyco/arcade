import type { UIState } from "../contracts"
import { TEAM_COLORS, type PlayerView, type Unit } from "../../sim/protocol"

export function teamColor(team: number): string {
  return TEAM_COLORS[((team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length]
}

export function me(state: UIState): PlayerView | null {
  return state.view?.players.find((p) => p.id === state.you) ?? null
}

export function myUnit(state: UIState): Unit | null {
  const p = me(state)
  if (!p || !state.view) return null
  return state.view.units.find((u) => u.id === p.unit) ?? null
}

// battleWinner / matchWinner carry a player id; team modes may send a team label instead.
export function winnerName(state: UIState, id: string | null): { name: string; color: string } | null {
  if (!id || !state.view) return null
  const p = state.view.players.find((pl) => pl.id === id || pl.name === id)
  if (p) return { name: p.name, color: teamColor(p.team) }
  if (state.view.mode === "teams") {
    const n = /CYAN/i.test(id) ? 0 : /ORANGE/i.test(id) ? 1 : Number(id.match(/(\d+)/)?.[1] ?? 1) - 1
    return { name: id, color: teamColor(Math.max(0, n)) }
  }
  return { name: id, color: "#e8f0ff" }
}

// Geometric stroke wordmark: S Λ L V O on 40x48 cells.
const LETTERS = [
  "M35 11C32 6.5 27 4 20.5 4 12 4 6.5 8 6.5 14c0 13 28.5 7.5 28.5 21 0 6-5.5 9-14.5 9C13 44 7.5 41.5 4.5 37",
  "M3 44 20 4l17 40",
  "M7 4v40h28",
  "M3 4l17 40L37 4",
  "M20 4a20 20 0 1 0 .01 0z",
]

export function wordmark(extra = "", gap = 30): string {
  const step = 40 + gap
  const w = 5 * 40 + 4 * gap
  const paths = LETTERS.map((d, i) => `<path transform="translate(${i * step} 0)" d="${d}"/>`).join("")
  return `<svg class="wordmark ${extra}" viewBox="-3 0 ${w + 6} 48" fill="none" stroke="currentColor" stroke-linecap="square" stroke-linejoin="miter" aria-label="SALVO">${paths}</svg>`
}

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
