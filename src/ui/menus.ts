import { floorOf } from "../../shared/maps"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { css, type Rgb3 } from "../game/game"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
  quick(name: string): void
  create(name: string): void
  join(name: string, room: string): void
}

/** The landing page and the scoreboard (held with Tab, and shown between floors). */
export class Menus {
  private key = ""
  private busy = false

  constructor(
    private root: HTMLElement,
    private name: string,
    private a: MenuActions,
  ) {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (t) this.act(t.dataset.act!)
    })
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement
      if (e.key !== "Enter") return
      if (t.id === "code") this.act("join")
      else if (t.id === "name") this.act(this.root.querySelector("[data-primary]")?.getAttribute("data-act") ?? "quick")
    })
  }

  private act(act: string): void {
    if (this.busy) return
    const name = this.root.querySelector<HTMLInputElement>("#name")?.value ?? this.name
    if (act === "quick") this.a.quick(name)
    else if (act === "create") this.a.create(name)
    else if (act === "join") {
      const fixed = this.root.querySelector<HTMLElement>("[data-room]")?.dataset.room
      const code = (fixed ?? this.root.querySelector<HTMLInputElement>("#code")?.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
      if (!code) return void this.root.querySelector<HTMLInputElement>("#code")?.focus()
      this.a.join(name, code)
    } else return
    this.busy = true
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true
  }

  /** Name, then quick join, create game, or join a room by code. A shared link (?room=) offers just that room. */
  landing(room: string | null, notice = ""): void {
    this.key = "landing"
    this.busy = false
    this.root.className = "full"
    this.root.innerHTML = `<div class="landing">
      <div class="logo">BLACKOUT</div>
      <div class="tag">Deathmatch on an office floor at night.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label>NAME<input id="name" maxlength="14" value="${esc(this.name)}" placeholder="your name" autofocus /></label>
      ${
        room
          ? `<div class="room" data-room="${esc(room)}">ROOM <b>${esc(room.toUpperCase())}</b></div><button class="primary" data-act="join" data-primary>JOIN GAME</button>`
          : `<button class="primary" data-act="quick" data-primary>QUICK JOIN</button>
             <button data-act="create">CREATE GAME</button>
             <div class="row"><input id="code" maxlength="8" placeholder="room code" autocapitalize="off" /><button data-act="join">JOIN</button></div>`
      }
      <div class="stats" id="stats"></div>
    </div>`
  }

  /** Live counts under the buttons. */
  stats(players: number, games: number): void {
    const el = this.root.querySelector("#stats")
    if (el) el.textContent = players ? `${players} playing · ${games} open game${games === 1 ? "" : "s"}` : ""
  }

  hide(): void {
    this.key = ""
    this.root.className = ""
    this.root.innerHTML = ""
  }

  /** Shows the scoreboard while Tab is held or between floors. */
  update(s: Snapshot | null, roster: RosterRow[], myId: string, room: string | null, held: boolean, colorOf: (id: string) => Rgb3): void {
    if (!s) return
    const show = held || s.phase === "end"
    const key = show ? JSON.stringify([s.phase, roster, room, s.phase === "end" ? Math.ceil(s.left) : 0]) : ""
    if (key === this.key) return
    this.key = key
    if (!show) {
      this.root.className = ""
      this.root.innerHTML = ""
      return
    }
    const ranked = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    const winner = ranked[0]
    const url = room ? `${location.origin}${location.pathname}?room=${room}` : ""
    this.root.className = s.phase === "end" ? "full" : "over"
    this.root.innerHTML = `<div class="score">
      <div class="head"><div class="logo small">BLACKOUT</div><span>OFFICE TOWER · FL ${floorOf(s.map)}</span></div>
      ${s.phase === "end" && winner ? `<div class="result"><span style="color:${css(colorOf(winner.id))}">${esc(winner.name.toUpperCase())}</span> WINS</div><div class="sub">Next floor in ${Math.ceil(s.left)}</div>` : ""}
      <table><thead><tr><th></th><th>KILLS</th><th>DEATHS</th></tr></thead><tbody>${ranked
        .map((r) => `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${css(colorOf(r.id))}"></i>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`)
        .join("")}</tbody></table>
      ${url ? `<div class="share">Invite: <span>${esc(url)}</span></div>` : ""}
    </div>`
  }
}
