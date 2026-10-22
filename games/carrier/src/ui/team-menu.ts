import "./team-menu.css"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { gunOp } from "../../shared/ops"
import { CAPACITY, CREW, type Crew, type CrewError, type CrewPlayer, type CrewShip, createShipError, crewCount, freeTeam, joinShipError, playerOf, teamCss } from "../../shared/crew"
import { kickLeft, members } from "../../shared/squad"
import { inviteUrl } from "./lobby"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** What the Tab menu asks the room for; the answer is a new crew (shared/crew.ts and shared/squad.ts rules). */
export type TeamActions = {
  /** Move to ship `ship` (its side becomes mine). */
  join(ship: number): void
  /** Commission a new ship on the team that has none, with me as its captain. */
  create(): void
  /** Captain: hand the captaincy to `player`. */
  promote(player: number): void
  /** Captain: move `player` off my ship. */
  kick(player: number): void
  /** Captain: lock or unlock my ship. */
  lock(locked: boolean): void
}

/** Where a pilot's jet is: on the deck, in the air, or down (crashed, about to be back on the deck); or out in the boat. */
export type JetStatus = "deck" | "air" | "down" | "boat"
const STATUS: Record<JetStatus, string> = { deck: "ON DECK", air: "AIRBORNE", down: "DOWN", boat: "BOAT" }

/** A Tab press shorter than this pins the menu open (or unpins it). */
const TAP_MS = 220
/** A kick or promote needs a second click within this long. */
const CONFIRM_MS = 3000

/** Disabled JOIN buttons say why instead of a tooltip. */
const WHY: Partial<Record<CrewError, string>> = {
  "ship-full": "FULL",
  locked: "LOCKED",
}

/**
 * The Tab menu: who is where, and moving between ships. Hold Tab to see it, tap Tab (or PIN) to keep it open, Esc to
 * close; main.ts frees the mouse while it is open. Every carrier for itself: a card per carrier in its own colour, with
 * its crew count, hull, captain (★), helm and pilots (airborne, on deck, down), and an empty berth where a sunk one's
 * replacement is not out yet. The only actions: JOIN a ship (its side becomes yours), CREATE SHIP in an empty berth,
 * and on your own ship, if you are its captain, LOCK, and per member CAPTAIN (promote) and KICK, each needing a second
 * click.
 */
export class TeamMenu {
  private el: HTMLElement
  private held = false
  private pinned = false
  private tabAt = 0
  private key = ""
  private crew: Crew | null = null
  private me = -1
  private room: string | null = null
  private now = 0
  private copiedAt = -Infinity
  private armed: { what: "kick" | "promote"; id: number; at: number } | null = null
  /** Off while the load screen shows: Tab does nothing. */
  enabled = true
  /** Each pilot's jet status by player id (null: unknown). */
  jet: ((id: number) => JetStatus | null) | null = null
  /** Kills and deaths by player id, once the weapons side keeps them; the column shows only when this is set. */
  stats: ((id: number) => { kills: number; deaths: number } | null) | null = null
  /** Each ship's health 0..1 and whether it is sinking (shared/fleet.ts), once the room sends hulls; null: no bar. */
  hull: ((ship: number) => { hp: number; sinking: boolean } | null) | null = null
  /** Called when it opens or closes (the game pauses its controls, other menus close). */
  onToggle: ((open: boolean) => void) | null = null

  constructor(
    parent: HTMLElement,
    private a: TeamActions,
  ) {
    this.el = document.createElement("div")
    this.el.className = "tm"
    this.el.hidden = true
    parent.append(this.el)
    addEventListener("keydown", (e) => {
      if (isEditableEventTarget(e.target)) return
      if (e.code === "Tab") {
        if (!this.enabled) return
        e.preventDefault()
        if (e.repeat || this.held) return
        this.held = true
        this.tabAt = performance.now()
        this.refresh()
      } else if (e.code === "Escape" && this.pinned) {
        this.pinned = false
        this.refresh()
      }
    })
    addEventListener("keyup", (e) => {
      if (e.code !== "Tab" || !this.held) return
      this.held = false
      if (performance.now() - this.tabAt < TAP_MS) this.pinned = !this.pinned
      this.refresh()
    })
    addEventListener("blur", () => {
      this.held = false
      this.refresh()
    })
    // Act on press: the menu re-renders as the crew changes, which can swallow a slow click.
    this.el.addEventListener("pointerdown", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tm]")
      if (!t || e.button !== 0 || t.hasAttribute("disabled")) return
      e.preventDefault()
      const n = (k: string) => Number(t.dataset[k])
      switch (t.dataset.tm) {
        case "join":
          return this.a.join(n("ship"))
        case "create":
          return this.a.create()
        case "lock":
          return this.a.lock(t.dataset.on !== "1")
        case "kick":
        case "promote":
          return this.confirm(t.dataset.tm, n("id"))
        case "pin":
          this.pinned = !this.pinned
          return this.refresh()
        case "copy":
          return this.copy()
      }
    })
  }

  get open(): boolean {
    return this.held || this.pinned
  }

  /** Pins it open, or closes it. */
  pin(open: boolean): void {
    this.pinned = open
    if (!open) this.held = false
    this.refresh()
  }

  /** The latest crew, my player id, the room code and the room clock (ms: sinking and kick countdowns). */
  update(crew: Crew | null, me: number, room: string | null, now = Date.now()): void {
    this.crew = crew
    this.me = me
    this.room = room
    this.now = now
    if (this.open) this.render()
  }

  private confirm(what: "kick" | "promote", id: number): void {
    const now = performance.now()
    const a = this.armed
    if (!a || a.what !== what || a.id !== id || now - a.at > CONFIRM_MS) {
      this.armed = { what, id, at: now }
      this.render()
      setTimeout(() => this.render(), CONFIRM_MS + 50)
      return
    }
    this.armed = null
    if (what === "kick") this.a.kick(id)
    else this.a.promote(id)
    this.render()
  }

  private refresh(): void {
    const open = this.open
    if (open === !this.el.hidden) {
      if (open) this.render()
      return
    }
    this.el.hidden = !open
    this.key = ""
    this.armed = null
    // The owner suspends Pointer Lock while the menu is open (main.ts).
    this.onToggle?.(open)
    if (open) this.render()
  }

  private copy(): void {
    if (!this.room) return
    void navigator.clipboard?.writeText(inviteUrl(this.room)).catch(() => {})
    this.copiedAt = performance.now()
    this.render()
    setTimeout(() => this.render(), 1600)
  }

  /** Whole seconds left on my kick bans (part of the render key, so countdowns tick). */
  private clocks(c: Crew): string {
    return c.ships.map((s) => kickLeft(s, this.me, this.now)).join()
  }

  private render(): void {
    if (this.el.hidden) return
    const c = this.crew
    const copied = performance.now() - this.copiedAt < 1500
    if (this.armed && performance.now() - this.armed.at > CONFIRM_MS) this.armed = null
    const jets = c && this.jet ? c.players.map((p) => (p.plane >= 0 ? this.jet!(p.id) : "")).join() : ""
    const stats = c && this.stats ? c.players.map((p) => JSON.stringify(this.stats!(p.id))).join() : ""
    const hulls = c && this.hull ? c.ships.map((s) => JSON.stringify(this.hull!(s.id))).join() : ""
    const key = JSON.stringify([c, this.me, this.room, this.pinned, copied, this.armed?.what, this.armed?.id, c ? this.clocks(c) : "", jets, stats, hulls])
    if (key === this.key) return
    this.key = key
    const room = this.room
      ? `<span class="tm-room">ROOM <b>${esc(this.room.toUpperCase())}</b><button data-tm="copy">${copied ? "COPIED" : "COPY INVITE"}</button></span>`
      : `<span class="tm-room">OFFLINE</span>`
    this.el.innerHTML = `<div class="tm-panel">
      <div class="tm-head"><span class="tm-logo">CARRIER</span><span class="tm-mode">FREE FOR ALL</span>${room}<button class="tm-pin ${this.pinned ? "on" : ""}" data-tm="pin">${this.pinned ? "PINNED" : "PIN"}</button></div>
      <div class="tm-ships">${c ? this.berths(c) : `<div class="tm-wait">JOINING…</div>`}</div>
    </div>`
  }

  /** One card per team in team order: its carrier, or an empty berth (sunk, the replacement refitting). */
  private berths(c: Crew): string {
    const free = freeTeam(c)
    return Array.from({ length: CREW.ships }, (_, t) => {
      const s = c.ships.find((x) => x.team === t)
      if (s) return this.ship(c, s)
      const create = t === free && !createShipError(c, this.me) ? `<button class="tm-new" data-tm="create">+ CREATE SHIP</button>` : ""
      return `<div class="tm-ship tm-berth" style="--tc:${teamCss(t)}"><div class="tm-sh"><i class="tm-swatch"></i><b>NO CARRIER</b><span class="tm-warn">REFITTING</span>${create}</div></div>`
    }).join("")
  }

  private ship(c: Crew, s: CrewShip): string {
    const mine = playerOf(c, this.me)?.ship === s.id
    const captain = mine && s.captain === this.me
    let act: string
    if (captain) act = `<button class="tm-lockbtn ${s.locked ? "on" : ""}" data-tm="lock" data-on="${s.locked ? 1 : 0}"><i class="tm-padlock"></i>${s.locked ? "LOCKED" : "LOCK"}</button>`
    else if (mine) act = `<span class="tm-you">YOUR SHIP</span>`
    else {
      const why = joinShipError(c, this.me, s.id)
      const kicked = kickLeft(s, this.me, this.now)
      const label = why === "kicked" ? `KICKED ${kicked}S` : why && why !== "same-ship" ? (WHY[why] ?? "JOIN") : "JOIN"
      act = `<button class="tm-join" data-tm="join" data-ship="${s.id}" ${why ? "disabled" : ""}>${label}</button>`
    }
    const hull = this.hull?.(s.id) ?? null
    const note = hull?.sinking ? `<span class="tm-warn">SINKING</span>` : s.emptySince !== null ? `<span class="tm-warn">ADRIFT</span>` : ""
    const pct = hull ? Math.max(0, Math.min(1, hull.hp)) : 1
    const bar = hull ? `<div class="tm-hull ${pct < 0.25 ? "low" : pct < 0.5 ? "mid" : ""}"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>` : ""
    const lock = s.locked && !captain ? `<i class="tm-padlock" aria-label="locked"></i>` : ""
    const crew = members(c, s)
      .map((id) => this.member(c, s, playerOf(c, id)!, captain))
      .join("")
    return `<div class="tm-ship ${mine ? "mine" : ""} ${s.locked ? "locked" : ""}" style="--tc:${teamCss(s.team)}">
      <div class="tm-sh"><i class="tm-swatch"></i><b>${esc(s.name)}</b>${lock}<span class="tm-n">${crewCount(s)}/${CAPACITY}</span>${note}${act}</div>
      ${bar}
      ${crew ? `<ol class="tm-crew">${crew}</ol>` : ""}
    </div>`
  }

  private member(c: Crew, s: CrewShip, p: CrewPlayer, captain: boolean): string {
    const helm = s.helm === p.id
    const st = helm ? null : (this.jet?.(p.id) ?? null)
    const gun = p.role === "gunner" ? gunOp(p.mount) : undefined
    const role = helm ? `<span class="tm-role helm">HELM</span>` : gun ? `<span class="tm-role gun">${esc(gun.name)}</span>` : `<span class="tm-role ${st ?? ""}">${st ? STATUS[st] : "PILOT"}</span>`
    const kd = this.stats ? this.stats(p.id) : null
    const stats = this.stats ? `<span class="tm-kd">${kd ? `${kd.kills}<i>/</i>${kd.deaths}` : "–"}</span>` : ""
    // A captain's own row keeps an empty actions column, so the roles line up.
    let acts = captain ? `<span class="tm-acts"></span>` : ""
    if (captain && p.id !== this.me) {
      const armed = (w: string) => this.armed?.what === w && this.armed.id === p.id
      acts = `<span class="tm-acts"><button class="${armed("promote") ? "armed" : ""}" data-tm="promote" data-id="${p.id}">${armed("promote") ? "SURE?" : "★ CAPTAIN"}</button><button class="${armed("kick") ? "armed" : ""}" data-tm="kick" data-id="${p.id}">${armed("kick") ? "SURE?" : "KICK"}</button></span>`
    }
    const cap = s.captain === p.id ? `<i class="tm-cap">★</i>` : `<i class="tm-cap"></i>`
    return `<li class="${p.id === this.me ? "me" : ""}">${cap}<span class="tm-name">${esc(p.name)}</span>${role}${stats}${acts}</li>`
  }
}
