import type { UIActions, UIState } from "../contracts"
import type { Mode, PlayerView } from "../../sim/protocol"
import { cls, h, Keyed, show, style, text } from "./dom"
import { me, teamColor, wordmark } from "./common"

const MAX_PLAYERS = 12

interface Row {
  el: HTMLElement
  chip: HTMLElement
  name: HTMLElement
  tags: HTMLElement
}

export function createLobby(actions: UIActions) {
  const el = h("div", "screen lobby")
  el.innerHTML = `
    <div class="lb-panel">
      <div class="lb-head">
        ${wordmark("wm-lobby")}
        <div class="lb-head-r"><span class="lb-kicker">ROOM</span><span class="lb-code"></span></div>
      </div>
      <div class="lb-link"><span class="lb-link-l">INVITE LINK</span><input class="lb-url" readonly/><button class="btn btn-sm lb-copy">COPY</button></div>
      <div class="lb-body">
        <div class="lb-roster">
          <div class="lb-sec"><span>OPERATORS</span><span class="lb-count"></span></div>
          <div class="lb-rows"></div>
        </div>
        <div class="lb-side">
          <div class="lb-sec"><span>MATCH SETUP</span></div>
          <div class="lb-host">
            <div class="lb-opt"><span class="lb-opt-l">MODE</span><div class="seg lb-mode"><button data-v="ffa">FREE FOR ALL</button><button data-v="teams">TEAMS</button></div></div>
            <div class="lb-opt"><span class="lb-opt-l">BOTS</span><div class="stepper"><button class="st-dn">−</button><span class="st-v">0</span><button class="st-up">+</button></div></div>
            <div class="lb-opt"><span class="lb-opt-l">BATTLES</span><div class="seg lb-battles"><button data-v="3">3</button><button data-v="5">5</button><button data-v="7">7</button></div></div>
            <button class="btn btn-primary lb-start">START MATCH</button>
          </div>
          <div class="lb-wait"><div class="lb-pulse"></div><div><b>WAITING FOR HOST</b><span class="lb-wait-s"></span></div></div>
          <div class="lb-summary"></div>
          <button class="btn btn-ghost lb-leave">LEAVE</button>
        </div>
      </div>
    </div>
  `
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T
  const code = q(".lb-code")
  const url = q<HTMLInputElement>(".lb-url")
  const copy = q<HTMLButtonElement>(".lb-copy")
  const count = q(".lb-count")
  const rowsEl = q(".lb-rows")
  const host = q(".lb-host")
  const wait = q(".lb-wait")
  const waitS = q(".lb-wait-s")
  const summary = q(".lb-summary")
  const modeBtns = [...el.querySelectorAll<HTMLButtonElement>(".lb-mode button")]
  const battleBtns = [...el.querySelectorAll<HTMLButtonElement>(".lb-battles button")]
  const botV = q(".st-v")
  const linkRow = q(".lb-link")

  let mode: Mode = "ffa"
  let bots = 5
  let battles = 5
  let humans = 1
  let cur: UIState


  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(url.value).catch(() => {})
    url.select()
    copy.textContent = "COPIED"
    setTimeout(() => (copy.textContent = "COPY"), 1400)
  })
  for (const b of modeBtns) b.addEventListener("click", () => (mode = b.dataset.v as Mode))
  for (const b of battleBtns) b.addEventListener("click", () => (battles = Number(b.dataset.v)))
  q(".st-dn").addEventListener("click", () => (bots = Math.max(0, bots - 1)))
  q(".st-up").addEventListener("click", () => (bots = Math.min(MAX_PLAYERS - humans, bots + 1)))
  q(".lb-start").addEventListener("click", () => actions.start({ mode, bots: Math.min(bots, MAX_PLAYERS - humans), battles }))
  q(".lb-leave").addEventListener("click", () => actions.leave())

  const rows = new Keyed<PlayerView, Row>(
    rowsEl,
    () => {
      const row = h("div", "lb-row")
      row.innerHTML = `<i class="lb-chip"></i><span class="lb-name"></span><span class="lb-tags"></span>`
      const g = (s: string) => row.querySelector(s) as HTMLElement
      return { el: row, chip: g(".lb-chip"), name: g(".lb-name"), tags: g(".lb-tags") }
    },
    (row, p) => {
      style(row.chip, "--c", teamColor(p.team))
      text(row.name, p.name)
      const tags = [p.host ? `<b class="tag tag-host">HOST</b>` : "", p.bot ? `<b class="tag">BOT</b>` : "", p.id === cur.you ? `<b class="tag tag-you">YOU</b>` : "", !p.connected && !p.bot ? `<b class="tag tag-off">OFFLINE</b>` : ""].join("")
      if (row.tags.innerHTML !== tags) row.tags.innerHTML = tags
      cls(row.el, "you", p.id === cur.you)
    },
  )

  function update(state: UIState): void {
    const view = state.view
    if (!view) return
    cur = state
    const p = me(state)
    const isHost = !!p?.host
    text(code, view.room ? view.room.toUpperCase() : "LOCAL")
    show(linkRow, state.online && !!state.roomLink)
    if (url.value !== state.roomLink) url.value = state.roomLink

    const players = view.players
    humans = Math.max(1, players.filter((x) => !x.bot).length)
    bots = Math.min(bots, MAX_PLAYERS - humans)
    rows.sync(players, (x) => x.id)
    const empty = Math.max(0, Math.min(MAX_PLAYERS, humans + (isHost ? bots : 0)) - players.length)
    while (rowsEl.querySelectorAll(".lb-ghost").length < empty) rowsEl.append(h("div", "lb-row lb-ghost", [h("i", "lb-chip"), h("span", "lb-name", ["BOT SLOT"])]))
    const ghosts = rowsEl.querySelectorAll(".lb-ghost")
    for (let i = ghosts.length - 1; i >= empty; i--) ghosts[i].remove()
    for (const g of rowsEl.querySelectorAll(".lb-ghost")) rowsEl.append(g)
    text(count, `${players.length} / ${MAX_PLAYERS}`)

    show(host, isHost)
    show(wait, !isHost)
    const hostP = players.find((x) => x.host)
    text(waitS, hostP ? `${hostP.name} is setting up the match` : "")
    for (const b of modeBtns) cls(b, "on", b.dataset.v === mode)
    for (const b of battleBtns) cls(b, "on", Number(b.dataset.v) === battles)
    text(botV, bots)
    text(summary, isHost ? `${humans + bots} UNITS  ·  ${mode === "ffa" ? "FREE FOR ALL" : "TEAMS"}  ·  ${battles} BATTLES` : `${players.length} IN ROOM`)

  }

  return { el, update }
}
