import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { ROSTER, CHARACTERS } from "../../shared/characters"
import { GAME } from "../../shared/config"
import { NAME_MAX } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/view"
import { SLOT_COLORS } from "../game/game"
import { SLOT_KEYS } from "./hud"

export type MenuActions = {
  quick: (name: string) => void
  practice: (name: string) => void
  create: (name: string) => void
  join: (name: string, room: string) => void
  watch: () => void
  pick: (char: string) => void
  ready: (ready: boolean) => void
}

const css = (c: readonly number[]) => `rgb(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)})`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const ordinal = (n: number) => ["1st", "2nd", "3rd"][n] ?? `${n + 1}th`

/** Landing page, the character select screen and the results, as DOM over the canvas. */
export class Menus {
  private mode: "landing" | "select" | "results" | "none" = "none"
  private html = ""
  private hover = ""

  constructor(private root: HTMLElement, private name: string, private act: MenuActions) {
    root.addEventListener("click", (e) => this.click(e))
    root.addEventListener("mouseover", (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-char]")
      this.hover = card?.dataset.char ?? ""
    })
    root.addEventListener("mouseleave", () => (this.hover = ""))
  }

  get landingShown(): boolean {
    return this.mode === "landing"
  }

  hide(): void {
    this.mode = "none"
    this.html = ""
    this.root.className = ""
    this.root.innerHTML = ""
  }

  landing(room: string | null, notice = ""): void {
    this.mode = "landing"
    this.html = ""
    this.root.className = "full landing-bg"
    const faces = ROSTER.map((c, i) => `<div class="parade-face" style="background-image:url(portraits/${c.id}.jpg);--i:${i};--c:${css(c.color)}"></div>`).join("")
    this.root.innerHTML = `<div class="landing">
      <div class="parade">${faces}</div>
      <div class="logo">${esc(GAME.title)}</div>
      <div class="sub">A party brawler. Knock everyone off the stage.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label class="field">Your name <input id="name" maxlength="${NAME_MAX}" value="${esc(this.name)}" autocomplete="off" spellcheck="false"></label>
      <div class="buttons">
        ${room ? `<button data-act="join-room" class="primary">Join room ${esc(room.toUpperCase())}</button>` : `<button data-act="quick" class="primary">Quick play</button>`}
        <button data-act="practice">Practice vs bots</button>
        <button data-act="create">Create private room</button>
        <span class="join"><input id="code" maxlength="8" placeholder="code" autocomplete="off" spellcheck="false"><button data-act="join">Join</button></span>
      </div>
      <div class="controls">${keyCapHtml("KeyW")}${keyCapHtml("KeyA")}${keyCapHtml("KeyS")}${keyCapHtml("KeyD")} move · ${keyCapHtml("Mouse0")} attack · ${keyCapHtml("KeyQ")} ${keyCapHtml("KeyE")} powers · ${keyCapHtml("Space")} dodge</div>
      <button data-act="watch" class="link">Watch the bots</button>
    </div>`
    this.room = room
  }
  private room: string | null = null

  private input(id: string): string {
    return (this.root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "").trim()
  }

  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-char]")
    if (!el) return
    const name = this.mode === "landing" ? this.input("name") || "guest" : this.name
    if (this.mode === "landing") this.name = name
    const act = el.dataset.act
    if (el.dataset.char) return this.act.pick(el.dataset.char)
    if (act === "quick") this.act.quick(name)
    else if (act === "practice") this.act.practice(name)
    else if (act === "create") this.act.create(name)
    else if (act === "join-room" && this.room) this.act.join(name, this.room)
    else if (act === "join") {
      const code = this.input("code").toLowerCase().replace(/[^a-z0-9]/g, "")
      if (code) this.act.join(name, code)
    } else if (act === "watch") this.act.watch()
    else if (act === "random") {
      const c = ROSTER[Math.floor(Math.random() * ROSTER.length)]!
      this.act.pick(c.id)
    } else if (act === "ready") this.act.ready(el.dataset.ready !== "1")
  }

  /** Called every frame in a match: shows the select screen or the results as the phase changes. */
  update(snap: Snapshot | null, roster: RosterRow[], myId: string, room: string | null, colorOf: (id: string) => readonly number[]): void {
    if (this.mode === "landing") return
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
      <div class="top"><div class="logo small">${esc(GAME.title)}</div><div class="hint">Choose your fighter</div>${room ? `<div class="room">Room <b>${esc(room.toUpperCase())}</b></div>` : ""}<div class="timer">${Math.ceil(s.left)}</div></div>
      <div class="grid">${cards}</div>
      <div class="detail" style="--c:${css(show.color)}">
        <div class="bio"><div class="big-nm">${esc(show.name)}</div><div class="tag">“${esc(show.tagline)}”</div>
          ${stat("Speed", (show.speed - 3.4) / 2.2)}${stat("Weight", (show.weight - 0.7) / 0.9)}</div>
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
    const rows = order.map((r, i) => {
      const c = CHARACTERS[r.char]
      return `<div class="row" style="--slot:${css(colorOf(r.id))}"><span class="place">${ordinal(i)}</span><div class="mini" style="background-image:url(portraits/${r.char}.jpg)"></div><b>${esc(r.name)}</b><span class="ch">${esc(c?.name ?? "")}</span><span class="n">${r.kos} KO</span><span class="n">${r.falls} fall${r.falls === 1 ? "" : "s"}</span></div>`
    }).join("")
    const html = `<div class="results">
      ${wc ? `<div class="winner" style="--c:${css(wc.color)}"><div class="face" style="background-image:url(portraits/${wc.id}.jpg)"></div><div><div class="wins">${esc(win!.name)} wins!</div><div class="as">as ${esc(wc.name)}</div></div></div>` : ""}
      <div class="table">${rows}</div>
      <div class="next">Next round in ${Math.ceil(s.left)}</div>
    </div>`
    this.set("results", "full results-bg", html)
  }
}
