import type { UIActions, UIState } from "../contracts"
import { CLASSES } from "../../sim/classes"
import { levelProgress } from "../profile"
import { cls, fmtNum, h, show, style, text } from "./dom"
import { wordmark } from "./common"
import { createClassStrip } from "./classes"

export function createTitle(actions: UIActions) {
  const el = h("div", "screen title")
  el.innerHTML = `
    <div class="tt-block">
      <div class="tt-top">
        ${wordmark("wm-title", 34)}
        <div class="tt-sub">SIMULTANEOUS ARTILLERY</div>
        <p class="tt-copy">Every player aims at once. Eight seconds on the clock.<br>Then every shell in the sky lands together.</p>
      </div>
      <form class="tt-form">
        <label class="tt-label" for="tt-name">CALLSIGN</label>
        <div class="tt-field"><input id="tt-name" class="tt-input" maxlength="16" autocomplete="off" spellcheck="false" placeholder="ENTER A NAME"/><span class="tt-req">REQUIRED</span></div>
        <div class="tt-actions">
          <button type="button" class="btn btn-primary tt-solo">PLAY SOLO <span class="btn-sub">VS BOTS</span></button>
          <button type="button" class="btn tt-create">CREATE ROOM</button>
          <button type="button" class="btn btn-accent tt-join">JOIN ROOM <span class="btn-sub tt-room"></span></button>
        </div>
      </form>
      <div class="tt-profile">
        <div class="tt-lvl"><span class="tt-lvl-l">LEVEL</span><span class="tt-lvl-v">1</span></div>
        <div class="tt-xp">
          <div class="tt-xp-row"><span class="tt-xp-t">0 / 0 XP</span><span class="tt-xp-next"></span></div>
          <div class="tt-xp-bar"><i></i></div>
          <div class="tt-record"></div>
        </div>
      </div>
    </div>
    <div class="tt-units">
      <div class="tt-units-head"><span>SELECT UNIT</span><span class="tt-unit-desc"></span></div>
    </div>
  `
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T
  const input = q<HTMLInputElement>(".tt-input")
  const form = q<HTMLFormElement>(".tt-form")
  const solo = q<HTMLButtonElement>(".tt-solo")
  const create = q<HTMLButtonElement>(".tt-create")
  const join = q<HTMLButtonElement>(".tt-join")
  const roomTag = q(".tt-room")
  const lvl = q(".tt-lvl-v")
  const xpT = q(".tt-xp-t")
  const xpNext = q(".tt-xp-next")
  const xpBar = q(".tt-xp-bar i")
  const record = q(".tt-record")
  const units = q(".tt-units")
  const unitDesc = q(".tt-unit-desc")

  const strip = createClassStrip((id) => actions.setClass(id))
  units.append(strip.el)

  let room = ""
  const nameOk = () => input.value.trim().length > 0
  const go = (online: boolean, withRoom: boolean) => {
    if (!nameOk()) {
      input.focus()
      el.classList.remove("shake")
      void el.offsetWidth
      el.classList.add("shake")
      return
    }
    actions.setName(input.value.trim())
    actions.play(withRoom && room ? { online: true, room } : { online })
  }
  input.addEventListener("input", () => actions.setName(input.value))
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    go(!!room, !!room)
  })
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      go(!!room, !!room)
    }
  })
  solo.addEventListener("click", () => go(false, false))
  create.addEventListener("click", () => go(true, false))
  join.addEventListener("click", () => go(true, true))

  let first = true

  function update(state: UIState): void {
    const pr = state.profile
    if (first || (document.activeElement !== input && input.value !== pr.name)) {
      input.value = pr.name
      first = false
    }
    const hasName = nameOk()
    cls(el, "noname", !hasName)

    const m = state.roomLink.match(/\/r\/([A-Za-z0-9]+)\/?$/) ?? state.roomLink.match(/[?&]room=([A-Za-z0-9]+)/)
    room = m ? m[1] : ""
    show(join, !!room)
    text(roomTag, room ? room.toUpperCase() : "")
    cls(el, "has-room", !!room)

    const lp = levelProgress(pr.xp)
    text(lvl, lp.level)
    text(xpT, `${fmtNum(lp.into)} / ${fmtNum(lp.need)} XP`)
    const next = Object.values(CLASSES)
      .filter((c) => c.unlock > lp.level)
      .sort((a, b) => a.unlock - b.unlock)[0]
    text(xpNext, next ? `LVL ${next.unlock} UNLOCKS ${next.name.toUpperCase()}` : "ALL UNITS UNLOCKED")
    style(xpBar, "width", `${(lp.frac * 100).toFixed(1)}%`)
    text(record, `${pr.matches} MATCHES  ·  ${pr.wins} WINS  ·  ${pr.kills} KILLS`)

    strip.update(pr.cls, lp.level)
    text(unitDesc, CLASSES[pr.cls]?.desc ?? "")
  }

  return { el, update }
}
