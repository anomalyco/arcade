import type { UIActions, UIState } from "../contracts"
import type { PlayerView } from "../../sim/protocol"
import { cls, fmtClock, fmtNum, h, Keyed, style, text } from "./dom"
import { me, teamColor, winnerName, wordmark } from "./common"

interface Row {
  el: HTMLElement
  rank: HTMLElement
  chip: HTMLElement
  name: HTMLElement
  w: HTMLElement
  k: HTMLElement
  d: HTMLElement
  s: HTMLElement
}

export function createResults(actions: UIActions) {
  const el = h("div", "screen results")
  el.innerHTML = `
    <div class="rs-wrap">
      <div class="rs-head">
        ${wordmark("wm-results")}
        <div class="rs-kicker">MATCH COMPLETE</div>
        <h1 class="rs-winner"><span class="rs-wname"></span><span class="rs-wsuf">WINS THE MATCH</span></h1>
        <div class="rs-you"></div>
      </div>
      <div class="rs-body">
        <div class="rs-table cham-soft">
          <div class="rt-head"><span class="rt-rank">#</span><span class="rt-name">PLAYER</span><span>WINS</span><span>KILLS</span><span>DAMAGE</span><span>SCORE</span></div>
          <div class="rt-rows"></div>
        </div>
        <div class="rs-side">
          <div class="rs-next"><span>NEXT MATCH IN</span><b class="rs-clock">0:00</b></div>
          <button class="btn btn-ghost rs-back">BACK TO TITLE</button>
        </div>
      </div>
    </div>
  `
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T
  const wname = q(".rs-wname")
  const winnerEl = q(".rs-winner")
  const you = q(".rs-you")
  const rowsEl = q(".rt-rows")
  const clock = q(".rs-clock")
  q(".rs-back").addEventListener("click", () => actions.leave())

  let cur: UIState
  const rows = new Keyed<PlayerView, Row>(
    rowsEl,
    () => {
      const row = h("div", "rt-row")
      row.innerHTML = `<span class="rt-rank"></span><span class="rt-name"><i class="rt-chip"></i><b></b></span><span class="rt-w"></span><span class="rt-k"></span><span class="rt-d"></span><span class="rt-s"></span>`
      const g = (s: string) => row.querySelector(s) as HTMLElement
      return { el: row, rank: g(".rt-rank"), chip: g(".rt-chip"), name: g(".rt-name b"), w: g(".rt-w"), k: g(".rt-k"), d: g(".rt-d"), s: g(".rt-s") }
    },
    (row, p, i) => {
      text(row.rank, String(i + 1).padStart(2, "0"))
      style(row.chip, "--c", teamColor(p.team))
      text(row.name, p.name)
      text(row.w, p.wins)
      text(row.k, p.kills)
      text(row.d, fmtNum(p.damage))
      text(row.s, fmtNum(p.score))
      cls(row.el, "you", p.id === cur.you)
      cls(row.el, "first", i === 0)
    },
  )


  function update(state: UIState): void {
    const view = state.view
    if (!view) return
    cur = state
    const p = me(state)
    const w = winnerName(state, view.matchWinner)
    text(wname, w ? w.name.toUpperCase() : "NO ONE")
    style(winnerEl, "--c", w?.color ?? "#e8f0ff")
    const won = !!p && (view.matchWinner === p.id || view.matchWinner === p.name)
    text(you, !p || p.spectator ? "SPECTATED" : won ? "VICTORY — YOUR MATCH" : `YOU FINISHED ${ordinal(rankOf(view.players, p.id))}`)
    cls(you, "won", won)

    const ranked = view.players.filter((x) => !x.spectator).sort((a, b) => b.score - a.score || b.wins - a.wins || b.kills - a.kills)
    rows.sync(ranked, (x) => x.id)

    text(clock, fmtClock(view.phaseEndsAt - state.serverNow))
  }

  return { el, update }
}

function rankOf(players: PlayerView[], id: string): number {
  const ranked = players.filter((x) => !x.spectator).sort((a, b) => b.score - a.score || b.wins - a.wins || b.kills - a.kills)
  return ranked.findIndex((x) => x.id === id) + 1
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "TH" : (["TH", "ST", "ND", "RD"][n % 10] ?? "TH")
  return `${n}${n % 10 > 3 ? "TH" : s}`
}
