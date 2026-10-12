import { GUNS, GUN_IDS, type Gun } from "../../shared/config"
import { floorOf } from "../../shared/maps"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { css, type Rgb3 } from "../game/game"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
  practice(name: string, gun: Gun): void
  create(name: string, gun: Gun): void
  join(name: string, gun: Gun, room: string): void
}

/** The landing page and the scoreboard (held with Tab, and shown between floors). */
export class Menus {
  private gun: Gun
  private key = ""

  constructor(
    private root: HTMLElement,
    private name: string,
    gun: Gun,
    private a: MenuActions,
  ) {
    this.gun = gun
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (t) this.act(t.dataset.act!, t.dataset.v ?? "")
    })
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement
      if (e.key !== "Enter") return
      if (t.id === "code") this.act("join", "")
      else if (t.id === "name") this.act(this.root.querySelector("[data-primary]")?.getAttribute("data-act") ?? "practice", "")
    })
  }

  private nameValue(): string {
    return this.root.querySelector<HTMLInputElement>("#name")?.value ?? this.name
  }

  private act(act: string, v: string): void {
    if (act === "gun") {
      this.gun = v as Gun
      for (const b of this.root.querySelectorAll<HTMLElement>("[data-act=gun]")) b.classList.toggle("on", b.dataset.v === v)
      return
    }
    const name = this.nameValue()
    if (act === "practice") this.a.practice(name, this.gun)
    if (act === "create") this.a.create(name, this.gun)
    if (act === "join") {
      const fixed = this.root.querySelector<HTMLElement>("[data-room]")?.dataset.room
      const code = (fixed ?? this.root.querySelector<HTMLInputElement>("#code")?.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
      if (code) this.a.join(name, this.gun, code)
    }
  }

  landing(room: string | null, notice = ""): void {
    this.key = "landing"
    this.root.className = "full"
    this.root.innerHTML = `<div class="landing">
      <div class="logo">BLACKOUT</div>
      <div class="tag">Deathmatch on an office floor at night.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label>NAME<input id="name" maxlength="14" value="${esc(this.name)}" placeholder="your name" autofocus /></label>
      <div class="guns">${GUN_IDS.map((g, i) => `<button class="gun ${g === this.gun ? "on" : ""}" data-act="gun" data-v="${g}"><kbd>${i + 1}</kbd><b>${GUNS[g].label.toUpperCase()}</b><span>${GUNS[g].blurb}</span></button>`).join("")}</div>
      ${
        room
          ? `<div class="room" data-room="${esc(room)}">ROOM <b>${esc(room.toUpperCase())}</b></div><button class="primary" data-act="join" data-primary>JOIN</button>`
          : `<button class="primary" data-act="create" data-primary>CREATE ROOM</button>
             <button data-act="practice">PRACTICE VS BOTS</button>
             <div class="row"><input id="code" maxlength="8" placeholder="room code" /><button data-act="join">JOIN</button></div>`
      }
    </div>`
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
        .map((r) => `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${css(colorOf(r.id))}"></i>${esc(r.name)}${r.human ? "" : " <em>bot</em>"}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`)
        .join("")}</tbody></table>
      ${url ? `<div class="share">Invite: <span>${esc(url)}</span></div>` : ""}
    </div>`
  }
}
