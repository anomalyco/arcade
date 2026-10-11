import type { UIActions, UIState } from "../contracts"
import type { PlayerView } from "../../sim/protocol"
import { CLASSES } from "../../sim/classes"
import { levelProgress, unlocksBetween } from "../profile"
import { cls, fmtClock, fmtNum, h, Keyed, show, style, text } from "./dom"
import { me, teamColor, winnerName, wordmark } from "./common"
import { unitGlyph } from "./glyphs"

interface Row {
  el: HTMLElement
  rank: HTMLElement
  chip: HTMLElement
  name: HTMLElement
  cls: HTMLElement
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
          <div class="rt-head"><span class="rt-rank">#</span><span class="rt-name">PLAYER</span><span class="rt-cls">UNIT</span><span>WINS</span><span>KILLS</span><span>DAMAGE</span><span>SCORE</span></div>
          <div class="rt-rows"></div>
        </div>
        <div class="rs-side">
          <div class="rs-xp cham-soft">
            <div class="xp-top"><span class="xp-l">EXPERIENCE</span><span class="xp-gain"></span></div>
            <div class="xp-lvl"><span class="xp-lvl-l">LEVEL</span><span class="xp-lvl-v">1</span></div>
            <div class="xp-bar"><i></i></div>
            <div class="xp-meta"><span class="xp-into"></span><span class="xp-need"></span></div>
            <div class="xp-up">
              <div class="xp-up-t">LEVEL UP</div>
              <div class="xp-unlocks"></div>
            </div>
          </div>
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
  const gain = q(".xp-gain")
  const lvl = q(".xp-lvl-v")
  const bar = q(".xp-bar i")
  const into = q(".xp-into")
  const need = q(".xp-need")
  const up = q(".xp-up")
  const unlocks = q(".xp-unlocks")
  const clock = q(".rs-clock")
  const xpBox = q(".rs-xp")
  q(".rs-back").addEventListener("click", () => actions.leave())

  let cur: UIState
  const rows = new Keyed<PlayerView, Row>(
    rowsEl,
    () => {
      const row = h("div", "rt-row")
      row.innerHTML = `<span class="rt-rank"></span><span class="rt-name"><i class="rt-chip"></i><b></b></span><span class="rt-cls"></span><span class="rt-w"></span><span class="rt-k"></span><span class="rt-d"></span><span class="rt-s"></span>`
      const g = (s: string) => row.querySelector(s) as HTMLElement
      return { el: row, rank: g(".rt-rank"), chip: g(".rt-chip"), name: g(".rt-name b"), cls: g(".rt-cls"), w: g(".rt-w"), k: g(".rt-k"), d: g(".rt-d"), s: g(".rt-s") }
    },
    (row, p, i) => {
      text(row.rank, String(i + 1).padStart(2, "0"))
      style(row.chip, "--c", teamColor(p.team))
      text(row.name, p.name)
      text(row.cls, CLASSES[p.cls]?.name.toUpperCase() ?? "")
      text(row.w, p.wins)
      text(row.k, p.kills)
      text(row.d, fmtNum(p.damage))
      text(row.s, fmtNum(p.score))
      cls(row.el, "you", p.id === cur.you)
      cls(row.el, "first", i === 0)
    },
  )

  let animKey = ""
  let animStart = 0
  let from = 0
  let to = 0
  let unlockKey = ""

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

    // xp bar animation
    const xg = state.xpGain
    show(xpBox, !!xg)
    const key = xg ? `${state.profile.xp}:${xg.amount}` : ""
    const now = performance.now()
    if (key !== animKey) {
      animKey = key
      animStart = now + 400
      to = state.profile.xp
      from = Math.max(0, to - (xg?.amount ?? 0))
    }
    if (xg) {
      const t = Math.max(0, Math.min(1, (now - animStart) / 1800))
      const e = 1 - Math.pow(1 - t, 3)
      const x = from + (to - from) * e
      const lp = levelProgress(x)
      text(gain, `+${fmtNum(Math.round((to - from) * e))} XP`)
      text(lvl, lp.level)
      style(bar, "width", `${(lp.frac * 100).toFixed(2)}%`)
      text(into, `${fmtNum(lp.into)} XP`)
      text(need, `${fmtNum(lp.need)} TO NEXT`)
      const startLevel = levelProgress(from).level
      const leveled = lp.level > startLevel
      cls(up, "on", leveled)
      const uk = `${startLevel}-${lp.level}`
      if (leveled && uk !== unlockKey) {
        unlockKey = uk
        const u = unlocksBetween(startLevel, lp.level)
        unlocks.innerHTML = ""
        for (const c of u.classes) {
          const item = h("div", "xp-unlock")
          item.innerHTML = `${unitGlyph(c, 56, 28)}<span><em>NEW UNIT</em><b></b></span>`
          ;(item.querySelector("b") as HTMLElement).textContent = CLASSES[c].name.toUpperCase()
          unlocks.append(item)
        }
        for (const c of u.cosmetics) {
          const item = h("div", "xp-unlock cos")
          item.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l7 7 7-7"/></svg><span><em>NEW CHEVRON</em><b></b></span>`
          ;(item.querySelector("b") as HTMLElement).textContent = c.name.toUpperCase()
          unlocks.append(item)
        }
      }
    }
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
