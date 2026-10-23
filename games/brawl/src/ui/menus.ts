import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { ROSTER, CHARACTERS } from "../../shared/characters"
import { GAME } from "../../shared/config"
import type { RosterRow, Snapshot } from "../../shared/view"
import { SLOT_COLORS } from "../game/game"
import { SLOT_KEYS } from "./hud"

export type MenuActions = {
  pick: (char: string) => void
  ready: (ready: boolean) => void
}

const css = (c: readonly number[]) => `rgb(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)})`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const ordinal = (n: number) => ["1st", "2nd", "3rd"][n] ?? `${n + 1}th`

/** The title card's own art: the roster parade and Watch the bots, in the shell's title slot. */
export function titleArt(watch: () => void): HTMLElement {
  const el = document.createElement("div")
  el.className = "title-art"
  el.innerHTML = `<div class="parade">${ROSTER.map((c, i) => `<div class="parade-face" style="background-image:url(portraits/${c.id}.jpg);--i:${i};--c:${css(c.color)}"></div>`).join("")}</div>`
  const link = document.createElement("button")
  link.className = "as-link watch"
  link.textContent = "Watch the bots"
  link.addEventListener("click", watch)
  el.append(link)
  return el
}

/** The character select screen and the results, as DOM over the canvas (the title is the kit game shell). */
export class Menus {
  private mode: "select" | "results" | "none" = "none"
  private html = ""
  private hover = ""

  constructor(private root: HTMLElement, private act: MenuActions) {
    root.addEventListener("click", (e) => this.click(e))
    root.addEventListener("mouseover", (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-char]")
      this.hover = card?.dataset.char ?? ""
    })
    root.addEventListener("mouseleave", () => (this.hover = ""))
  }

  hide(): void {
    this.mode = "none"
    this.html = ""
    this.root.className = ""
    this.root.innerHTML = ""
  }

  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-char]")
    if (!el) return
    const act = el.dataset.act
    if (el.dataset.char) return this.act.pick(el.dataset.char)
    if (act === "random") {
      const c = ROSTER[Math.floor(Math.random() * ROSTER.length)]!
      this.act.pick(c.id)
    } else if (act === "ready") this.act.ready(el.dataset.ready !== "1")
  }

  /** Called every frame in a match: shows the select screen or the results as the phase changes. */
  update(snap: Snapshot | null, roster: RosterRow[], myId: string, room: string | null, colorOf: (id: string) => readonly number[]): void {
    const phase = snap?.phase
    if (phase === "select" && myId) this.select(snap!, roster, myId, room)
    else if (phase === "results") this.results(snap!, roster, colorOf)
    else if (this.mode !== "none") this.hide()
  }

  private set(mode: "select" | "results", cls: string, html: string): void {
    this.mode = mode
    this.root.className = cls
    if (html !== this.html) this.root.innerHTML = this.html = html
  }

  private select(s: Snapshot, roster: RosterRow[], myId: string, room: string | null): void {
    const me = roster.find((r) => r.id === myId)
    const pick = me?.pick ?? ""
    const show = CHARACTERS[this.hover || pick] ?? ROSTER[0]!
    const cards = ROSTER.map((c, i) => {
      const takers = roster.filter((r) => r.pick === c.id)
      const dots = takers.map((r) => `<i style="background:${css(SLOT_COLORS[r.slot % SLOT_COLORS.length]!)}" title="${esc(r.name)}"></i>`).join("")
      return `<button class="pick${pick === c.id ? " picked" : ""}" data-char="${c.id}" style="--c:${css(c.color)}">
        <div class="face" style="background-image:url(portraits/${c.id}.jpg)"></div>
        <div class="nm">${esc(c.name)}</div><div class="tt">${esc(c.title)}</div>
        <div class="dots">${dots}</div><kbd class="num">${i + 1}</kbd>
      </button>`
    }).join("")
    const stat = (label: string, v: number) => `<div class="stat"><span>${label}</span><b style="width:${Math.round(Math.max(0.1, Math.min(1, v)) * 100)}%"></b></div>`
    const abilities = show.abilities.map((a, i) => `<div class="abl">${keyCapHtml(SLOT_KEYS[i]!)}<div><b>${esc(a.name)}</b><span>${esc(a.blurb)}</span></div></div>`).join("")
    const players = roster.map((r) => {
      const c = CHARACTERS[r.pick]
      const col = css(SLOT_COLORS[r.slot % SLOT_COLORS.length]!)
      return `<div class="chip${r.id === myId ? " mine" : ""}" style="--slot:${col}">
        <div class="mini" style="${c ? `background-image:url(portraits/${c.id}.jpg)` : ""}"></div>
        <b>${esc(r.name)}${r.human ? "" : " <em>bot</em>"}</b><span>${c ? esc(c.name) : "choosing…"}</span>${r.ready ? `<i class="ok">READY</i>` : ""}
      </div>`
    }).join("")
    const ready = !!me?.ready
    const html = `<div class="select">
      <div class="top"><div class="logo small">${esc(GAME.title)}</div><div class="hint">Choose your fighter</div><div class="rules-pill"><b>HOW TO WIN:</b> Hits raise <em>Launch %</em> · Higher % = bigger knockback · Knock foes over the ropes (<b>3 lives</b>)</div>${room ? `<div class="room">Room <b>${esc(room.toUpperCase())}</b></div>` : ""}<div class="timer">${Math.ceil(s.left)}</div></div>
      <div class="grid">${cards}</div>
      <div class="detail" style="--c:${css(show.color)}">
        <div class="bio"><div class="big-nm">${esc(show.name)}</div><div class="tag">“${esc(show.tagline)}”</div>
          ${stat("Speed", (show.speed - 4.5) / 3.0)}${stat("Weight", (show.weight - 0.7) / 0.9)}</div>
        <div class="abls">${abilities}</div>
      </div>
      <div class="players">${players}</div>
      <div class="go">
        <button data-act="random">Random <kbd>R</kbd></button>
        <button data-act="ready" data-ready="${ready ? 1 : 0}" class="primary${ready ? " on" : ""}"${pick ? "" : " disabled"}>${ready ? "Ready! (cancel)" : "Ready"} <kbd>Enter</kbd></button>
      </div>
    </div>`
    this.set("select", "full select-bg", html)
  }

  private results(s: Snapshot, roster: RosterRow[], colorOf: (id: string) => readonly number[]): void {
    const order = [...roster].sort((a, b) => b.stocks - a.stocks || b.kos - a.kos || a.falls - b.falls)
    const win = roster.find((r) => r.id === s.winner) ?? order[0]
    const wc = win ? CHARACTERS[win.char] : undefined
    const standing = roster.filter((r) => r.stocks > 0)
    const winReason = standing.length === 1 && win
      ? `LAST FIGHTER STANDING · ${win.stocks} ${win.stocks === 1 ? "LIFE" : "LIVES"} LEFT · ${win.kos} RING-OUT${win.kos === 1 ? "" : "S"}`
      : win
        ? `WINNER ON STOCKS (${win.stocks} LEFT) · ${win.kos} RING-OUT${win.kos === 1 ? "" : "S"}`
        : ""
    const rows = order.map((r, i) => {
      const c = CHARACTERS[r.char]
      const status = r.stocks > 0 ? `${r.stocks} ${r.stocks === 1 ? "life" : "lives"} left` : "Eliminated"
      return `<div class="row" style="--slot:${css(colorOf(r.id))}"><span class="place">${ordinal(i)}</span><div class="mini" style="background-image:url(portraits/${r.char}.jpg)"></div><b>${esc(r.name)}</b><span class="ch">${esc(c?.name ?? "")}</span><span class="n">${status}</span><span class="n">${r.kos} KO${r.kos === 1 ? "" : "s"}</span><span class="n">${r.falls} fall${r.falls === 1 ? "" : "s"}</span></div>`
    }).join("")
    const html = `<div class="results">
      ${wc ? `<div class="winner" style="--c:${css(wc.color)}"><div class="face" style="background-image:url(portraits/${wc.id}.jpg)"></div><div><div class="wins">${esc(win!.name)} wins!</div><div class="as">as ${esc(wc.name)}</div><div class="win-reason">${esc(winReason)}</div></div></div>` : ""}
      <div class="table">${rows}</div>
      <div class="next">Next round in ${Math.ceil(s.left)}</div>
    </div>`
    this.set("results", "full results-bg", html)
  }
}
