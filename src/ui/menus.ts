import { floorOf } from "../../shared/maps"
import { MODES, MODE_IDS, type ModeId, TEAM_NAMES, modeOf } from "../../shared/sim/modes"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { css, type Rgb3 } from "../game/game"
import { TEAM_COLORS } from "../game/mode-fx"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
  quick(name: string): void
  /** A private room whose first match is `mode`. */
  create(name: string, mode: ModeId): void
  join(name: string, room: string): void
  /** End screen: a vote for the next mode. */
  vote(mode: ModeId): void
}

const MODE_KEY = "blackout.mode"

/** The landing page and the scoreboard (held with Tab, and shown between floors). */
export class Menus {
  private key = ""
  private busy = false
  /** The mode Create game will use. */
  private mode: ModeId = modeOf(localStorage.getItem(MODE_KEY)) ?? "tdm"

  constructor(
    private root: HTMLElement,
    private name: string,
    private a: MenuActions,
  ) {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (t) this.act(t.dataset.act!, t.dataset.mode)
    })
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement
      if (e.key !== "Enter") return
      if (t.id === "code") this.act("join")
      else if (t.id === "name") this.act(this.root.querySelector("[data-primary]")?.getAttribute("data-act") ?? "quick")
    })
  }

  private act(act: string, mode?: string): void {
    const m = modeOf(mode)
    if (act === "vote" && m) return this.a.vote(m)
    if (act === "mode" && m) return this.pickMode(m)
    if (this.busy) return
    const name = this.root.querySelector<HTMLInputElement>("#name")?.value ?? this.name
    if (act === "quick") this.a.quick(name)
    else if (act === "create") this.a.create(name, this.mode)
    else if (act === "join") {
      const fixed = this.root.querySelector<HTMLElement>("[data-room]")?.dataset.room
      const code = (fixed ?? this.root.querySelector<HTMLInputElement>("#code")?.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
      if (!code) return void this.root.querySelector<HTMLInputElement>("#code")?.focus()
      this.a.join(name, code)
    } else return
    this.busy = true
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true
  }

  private pickMode(m: ModeId): void {
    this.mode = m
    localStorage.setItem(MODE_KEY, m)
    for (const b of this.root.querySelectorAll<HTMLElement>(".modepick [data-mode]")) b.classList.toggle("on", b.dataset.mode === m)
    const blurb = this.root.querySelector(".modeblurb")
    if (blurb) blurb.textContent = MODES[m].blurb
  }

  /** The mode chips under Create game. */
  private modePicker(): string {
    return `<div class="modepick">${MODE_IDS.map((m) => `<button class="${m === this.mode ? "on" : ""}" data-act="mode" data-mode="${m}" title="${esc(MODES[m].label)}">${esc(MODES[m].short)}</button>`).join("")}</div>
      <div class="modeblurb">${esc(MODES[this.mode].blurb)}</div>`
  }

  /** Name, then quick join, create game, or join a room by code. A shared link (?room=) offers just that room. */
  landing(room: string | null, notice = ""): void {
    this.key = "landing"
    this.busy = false
    this.root.className = "full"
    this.root.innerHTML = `<div class="landing">
      <div class="logo">BLACKOUT</div>
      <div class="tag">Firefights on an office floor at night.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label>NAME<input id="name" maxlength="14" value="${esc(this.name)}" placeholder="your name" autofocus /></label>
      ${
        room
          ? `<div class="room" data-room="${esc(room)}">ROOM <b>${esc(room.toUpperCase())}</b></div><button class="primary" data-act="join" data-primary>JOIN GAME</button>`
          : `<button class="primary" data-act="quick" data-primary>QUICK JOIN</button>
             <button data-act="create">CREATE GAME</button>
             ${this.modePicker()}
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

  /** Shows the scoreboard while Tab is held or between floors, grouped by team in team modes, with the vote between floors. */
  update(s: Snapshot | null, roster: RosterRow[], myId: string, room: string | null, held: boolean, colorOf: (id: string) => Rgb3): void {
    if (!s) return
    const show = held || s.phase === "end"
    const m = s.mode
    const key = show ? JSON.stringify([s.phase, roster, room, s.phase === "end" ? Math.ceil(s.left) : 0, m.id, m.score, m.votes]) : ""
    if (key === this.key) return
    this.key = key
    if (!show) {
      this.root.className = ""
      this.root.innerHTML = ""
      return
    }
    const info = MODES[m.id]
    const ranked = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    const cols: [string, (r: RosterRow) => number][] = [
      ["KILLS", (r) => r.kills],
      ["DEATHS", (r) => r.deaths],
    ]
    if (m.id === "dom") cols.push(["CAPS", (r) => r.caps])
    if (m.id === "snd") cols.push(["PLANTS", (r) => r.plants], ["DEFUSES", (r) => r.defuses])
    const row = (r: RosterRow) => `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${css(colorOf(r.id))}"></i>${esc(r.name)}</td>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}</tr>`
    const head = `<thead><tr><th></th>${cols.map(([c]) => `<th>${c}</th>`).join("")}</tr></thead>`
    const body = info.teams
      ? [0, 1]
          .map((t) => `<tr class="team"><td colspan="${cols.length + 1}"><b style="color:${css(TEAM_COLORS[t]!)}">${TEAM_NAMES[t]}</b><span>${m.score[t]}${m.target ? ` / ${m.target}` : ""}</span></td></tr>${ranked.filter((r) => r.team === t).map(row).join("")}`)
          .join("")
      : ranked.map(row).join("")
    let result = ""
    if (s.phase === "end") {
      const winner = ranked[0]
      const text = info.teams ? (m.winner >= 0 ? `<span style="color:${css(TEAM_COLORS[m.winner]!)}">${TEAM_NAMES[m.winner]}</span> WINS` : "DRAW") : winner ? `<span style="color:${css(colorOf(winner.id))}">${esc(winner.name.toUpperCase())}</span> WINS` : ""
      result = `<div class="result">${text}</div><div class="sub">Next floor in ${Math.ceil(s.left)}</div>`
    }
    const url = room ? `${location.origin}${location.pathname}?room=${room}` : ""
    this.root.className = s.phase === "end" ? "full" : "over"
    this.root.innerHTML = `<div class="score">
      <div class="head"><div class="logo small">BLACKOUT</div><span>${esc(info.label.toUpperCase())} · FL ${floorOf(s.map)}</span></div>
      ${result}
      <table>${head}<tbody>${body}</tbody></table>
      ${m.votes ? this.votes(m.votes, m.id) : ""}
      ${url ? `<div class="share">Invite: <span>${esc(url)}</span></div>` : ""}
    </div>`
  }

  /** Vote buttons for the next mode, with live counts. */
  private votes(v: NonNullable<Snapshot["mode"]["votes"]>, current: ModeId): string {
    return `<div class="vote"><div class="vh">NEXT MODE <span>click or press 1–4 · no votes keeps ${esc(MODES[current].short)}</span></div><div class="vopts">${MODE_IDS.map(
      (id, i) =>
        `<button class="${v.mine === id ? "on" : ""}" data-act="vote" data-mode="${id}"><kbd>${i + 1}</kbd><b>${esc(MODES[id].label.toUpperCase())}</b><em>${v.counts[id] || ""}</em></button>`,
    ).join("")}</div></div>`
  }
}
