import { MAP_CHOICES, type MapChoice, mapChoiceOf, mapLabel } from "../../shared/maps"
import { MODES, MODE_IDS, type ModeId, TEAM_NAMES, modeOf } from "../../shared/sim/modes"
import { hostPicks } from "../../shared/sim/host"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import "./teams.css"
import "./maps.css"
import { css, type Rgb3 } from "../game/game"
import { TEAM_COLORS } from "../game/mode-fx"
import { boardStat, rulesColumns, rulesTeam, rulesWinner } from "./rules-hud"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
  quick(name: string): void
  practice(name: string, mode: ModeId): void
  sandbox(name: string): void
  /** A private room whose first match is `mode`, playing on `maps`. */
  create(name: string, mode: ModeId, maps: MapChoice): void
  join(name: string, room: string): void
  /** End screen: a vote for the next mode. */
  vote(mode: ModeId): void
  /** Room host, team modes: move a player to a team, or deal random even teams. */
  team(id: string, team: 0 | 1): void
  shuffle(): void
  /** Room host: what the room plays on from the next new map. */
  maps(maps: MapChoice): void
  /** Room host: restart now in the current mode (null) or switch to `mode`, on a new floor or the same one. */
  host(mode: ModeId | null, newFloor: boolean): void
}

/** A host restart needs a second click within this long. */
const CONFIRM_MS = 2000

const MODE_KEY = "blackout.mode"
const MAP_KEY = "blackout.map"
const MAP_NAMES: Record<MapChoice, string> = { office: "OFFICE", downtown: "DOWNTOWN", random: "RANDOM" }
const MAP_BLURBS: Record<MapChoice, string> = { office: "A new office tower floor every match.", downtown: "City blocks at night: streets, alleys, shops and a plaza.", random: "Office or downtown, picked fresh every match." }

/** The landing page and the scoreboard (held with Tab, and shown between floors). */
export class Menus {
  private key = ""
  private busy = false
  /** The mode Create game will use. */
  private mode: ModeId = modeOf(localStorage.getItem(MODE_KEY)) ?? "tdm"
  /** What Create game plays on. */
  private maps: MapChoice = mapChoiceOf(localStorage.getItem(MAP_KEY)) ?? "random"
  /** Host controls: the restart waiting on its confirming click ("reset" or a mode), and whether it's a new floor. */
  private armed: { what: string; at: number } | null = null
  private newFloor = true

  constructor(
    private root: HTMLElement,
    private name: string,
    private a: MenuActions,
  ) {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (t?.dataset.act === "map") return this.pickMap(mapChoiceOf(t.dataset.map) ?? this.maps)
      if (t) this.act(t.dataset.act!, t.dataset.mode)
    })
    // Team picks act on press: the scoreboard re-renders as the match goes on, which can swallow a click.
    root.addEventListener("pointerdown", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-host]")
      if (!t || e.button !== 0) return
      e.preventDefault()
      if (t.dataset.host === "move") this.a.team(t.dataset.id!, t.dataset.team === "1" ? 1 : 0)
      else if (t.dataset.host === "shuffle") this.a.shuffle()
      else if (t.dataset.host === "floor") this.newFloor = !this.newFloor
      else if (t.dataset.host === "maps") this.a.maps(mapChoiceOf(t.dataset.map) ?? "random")
      else if (t.dataset.host === "reset" || t.dataset.host === "mode") this.confirm(t.dataset.host === "mode" ? (modeOf(t.dataset.mode) ?? "") : "reset")
      this.key = ""
    })
    // Hovering a mode chip shows its blurb; anywhere else, the picked mode's.
    root.addEventListener("mouseover", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".modepick [data-mode]")
      this.blurb(modeOf(t?.dataset.mode) ?? this.mode)
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
    else if (act === "practice") this.a.practice(name, this.mode)
    else if (act === "sandbox") this.a.sandbox(name)
    else if (act === "create") this.a.create(name, this.mode, this.maps)
    else if (act === "join") {
      const fixed = this.root.querySelector<HTMLElement>("[data-room]")?.dataset.room
      const code = (fixed ?? this.root.querySelector<HTMLInputElement>("#code")?.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
      if (!code) return void this.root.querySelector<HTMLInputElement>("#code")?.focus()
      this.a.join(name, code)
    } else return
    this.busy = true
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true
  }

  /** The first click arms a restart, a second within CONFIRM_MS sends it. */
  private confirm(what: string): void {
    if (!what) return
    const now = performance.now()
    if (this.armed?.what !== what || now - this.armed.at > CONFIRM_MS) {
      this.armed = { what, at: now }
      return
    }
    this.armed = null
    this.a.host(modeOf(what), this.newFloor)
  }

  private pickMode(m: ModeId): void {
    this.mode = m
    localStorage.setItem(MODE_KEY, m)
    for (const b of this.root.querySelectorAll<HTMLElement>(".modepick [data-mode]")) b.classList.toggle("on", b.dataset.mode === m)
    this.blurb(m)
  }

  private pickMap(m: MapChoice): void {
    this.maps = m
    localStorage.setItem(MAP_KEY, m)
    for (const b of this.root.querySelectorAll<HTMLElement>(".mappick [data-map]")) b.classList.toggle("on", b.dataset.map === m)
    const el = this.root.querySelector(".mappick + .modeblurb")
    if (el) el.innerHTML = `<b>${MAP_NAMES[m]}</b>${esc(MAP_BLURBS[m])}`
  }

  /** Map chips under the modes: what a created room plays on. */
  private mapPicker(): string {
    return `<div class="mappick">${MAP_CHOICES.map((m) => `<button class="${m === this.maps ? "on" : ""}" data-act="map" data-map="${m}" title="${esc(MAP_BLURBS[m])}">${MAP_NAMES[m]}</button>`).join("")}</div>
      <div class="modeblurb"><b>${MAP_NAMES[this.maps]}</b>${esc(MAP_BLURBS[this.maps])}</div>`
  }

  private blurb(m: ModeId): void {
    const el = this.root.querySelector(".modepick + .modeblurb")
    const html = this.blurbHtml(m)
    if (el && el.innerHTML !== html) el.innerHTML = html
  }

  private blurbHtml(m: ModeId): string {
    return `<b>${esc(MODES[m].label.toUpperCase())}</b>${esc(MODES[m].blurb)}`
  }

  /** The mode chips under Create game: a compact grid of short names, the hovered or picked mode's blurb below. */
  private modePicker(): string {
    return `<div class="modepick">${MODE_IDS.map((m) => `<button class="${m === this.mode ? "on" : ""}" data-act="mode" data-mode="${m}" title="${esc(MODES[m].label)}">${esc(MODES[m].short)}</button>`).join("")}</div>
      <div class="modeblurb">${this.blurbHtml(this.mode)}</div>`
  }

  /** Name, then quick join, create game, or join a room by code. A shared link (?room=) offers just that room. */
  landing(room: string | null, notice = ""): void {
    this.key = "landing"
    this.busy = false
    this.root.className = "full"
    this.root.innerHTML = `<div class="landing">
      <div class="logo">BLACKOUT</div>
      <div class="tag">Firefights at night: office floors and downtown streets.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label>NAME<input id="name" maxlength="14" value="${esc(this.name)}" placeholder="your name" autofocus /></label>
      ${
        room
          ? `<div class="room" data-room="${esc(room)}">ROOM <b>${esc(room.toUpperCase())}</b></div><button class="primary" data-act="join" data-primary>JOIN GAME</button>`
          : `<button class="primary" data-act="quick" data-primary>QUICK JOIN</button>
             <button data-act="create">CREATE GAME</button>
             <button data-act="practice">BOT PRACTICE</button>
             <button data-act="sandbox">SOLO SANDBOX</button>
             ${this.modePicker()}
             ${this.mapPicker()}
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

  /**
   * Shows the scoreboard while Tab is held (or T toggled it open) and between floors, grouped by team in team modes,
   * with the host's team picks and, between floors, the vote.
   */
  update(s: Snapshot | null, roster: RosterRow[], myId: string, room: string | null, held: boolean, colorOf: (id: string) => Rgb3): void {
    if (!s) return
    const show = held || s.phase === "end"
    const m = s.mode
    if (this.armed && performance.now() - this.armed.at > CONFIRM_MS) this.armed = null
    const key = show ? JSON.stringify([s.phase, roster, room, s.phase === "end" ? Math.ceil(s.left) : 0, m.id, m.score, m.votes, this.armed?.what, this.newFloor, s.maps]) : ""
    if (key === this.key) return
    this.key = key
    if (!show) {
      this.root.className = ""
      this.root.innerHTML = ""
      return
    }
    const info = MODES[m.id]
    const by = boardStat(m.id)
    const ranked = [...roster].sort((a, b) => (by ? by(b) - by(a) : 0) || b.kills - a.kills || a.deaths - b.deaths)
    const cols: [string, (r: RosterRow) => number][] = [
      ["KILLS", (r) => r.kills],
      ["DEATHS", (r) => r.deaths],
    ]
    if (m.id === "dom") cols.push(["CAPS", (r) => r.caps])
    if (m.id === "snd") cols.push(["PLANTS", (r) => r.plants], ["DEFUSES", (r) => r.defuses])
    const stat = (k: string) => (r: RosterRow) => r.stats?.[k] ?? 0
    if (m.id === "kc") cols.push(["CONFIRMS", stat("confirms")], ["DENIES", stat("denies")])
    if (m.id === "hp") cols.push(["ZONE TIME", stat("hill")])
    if (m.id === "ctf") cols.push(["CAPTURES", stat("captures")], ["RETURNS", stat("returns")])
    cols.push(...rulesColumns(m.id))
    const teamName = (t: number) => rulesTeam(m.id, t)?.name ?? TEAM_NAMES[t]
    const teamColor = (t: number) => rulesTeam(m.id, t)?.color ?? css(TEAM_COLORS[t]!)
    // The room host picks sides in team modes: a move button on every row, and shuffle.
    const picks = hostPicks(m.id)
    const amHost = picks && !!roster.find((r) => r.id === myId)?.host
    const move = (r: RosterRow) => {
      const to = r.team === 0 ? 1 : 0
      return `<td class="mv"><button data-host="move" data-id="${esc(r.id)}" data-team="${to}" title="Move to ${TEAM_NAMES[to]}" style="color:${css(TEAM_COLORS[to]!)}">${to ? "→" : "←"} ${TEAM_NAMES[to]}</button></td>`
    }
    const span = cols.length + (amHost ? 2 : 1)
    const row = (r: RosterRow) =>
      `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${css(colorOf(r.id))}"></i>${esc(r.name)}${r.host ? `<em class="hosttag" title="Room host${picks ? ": picks teams" : ""}">♛ HOST</em>` : ""}</td>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}${amHost ? move(r) : ""}</tr>`
    const head = `<thead><tr><th></th>${cols.map(([c]) => `<th>${c}</th>`).join("")}${amHost ? "<th></th>" : ""}</tr></thead>`
    const body = info.teams
      ? [0, 1]
          .map((t) => `<tr class="team"><td colspan="${span}"><b style="color:${teamColor(t)}">${teamName(t)}</b><span>${m.score[t]}${m.target ? ` / ${m.target}` : ""}</span></td></tr>${ranked.filter((r) => r.team === t).map(row).join("")}`)
          .join("")
      : ranked.map(row).join("")
    const hostbar = !picks
      ? ""
      : amHost
        ? `<div class="hostbar"><span>YOU'RE THE HOST · move players between teams · picks stick until you shuffle · <kbd>T</kbd> keeps this open</span><button data-host="shuffle">SHUFFLE</button></div>`
        : `<div class="hostbar"><span>The host picks teams · <kbd>T</kbd> keeps this open</span></div>`
    let result = ""
    if (s.phase === "end") {
      const winner = rulesWinner(s, roster) ?? ranked[0]
      const text = info.teams ? (m.winner >= 0 ? `<span style="color:${teamColor(m.winner)}">${teamName(m.winner)}</span> WIN${m.id === "inf" ? "" : "S"}` : "DRAW") : winner ? `<span style="color:${css(colorOf(winner.id))}">${esc(winner.name.toUpperCase())}</span> WINS` : ""
      result = `<div class="result">${text}</div><div class="sub">Next ${s.maps === "random" ? "map" : MAP_NAMES[s.maps ?? "office"].toLowerCase()} in ${Math.ceil(s.left)}</div>`
    }
    const url = room ? `${location.origin}${location.pathname}?room=${room}` : ""
    this.root.className = s.phase === "end" ? "full" : "over"
    this.root.innerHTML = `<div class="score">
      <div class="head"><div class="logo small">BLACKOUT</div><span>${esc(info.label.toUpperCase())} · ${mapLabel(s.mapKind, s.map)}</span></div>
      ${result}
      <table>${head}<tbody>${body}</tbody></table>
      ${hostbar}
      ${roster.find((r) => r.id === myId)?.host ? this.hostControls(m.id, picks, s.maps ?? "office") : ""}
      ${m.votes ? this.votes(m.votes, m.id) : ""}
      ${url ? `<div class="share">Invite: <span>${esc(url)}</span></div>` : ""}
    </div>`
  }

  /** The host's restart: RESET MATCH, a new-floor toggle and the ten modes; each restart needs a confirming click. */
  private hostControls(current: ModeId, picks: boolean, maps: MapChoice): string {
    const armed = this.armed?.what ?? ""
    const target = modeOf(armed)
    const hint = armed === "reset" ? "click again to reset the match" : target ? `click again to switch to ${esc(MODES[target].label.toLowerCase())}` : `restarts for everyone · click twice${picks ? "" : " · <kbd>T</kbd> keeps this open"}`
    const chips = MODE_IDS.map((id) => {
      const cls = [id === current ? "on" : "", id === armed ? "armed" : ""].join(" ").trim()
      const label = id === armed ? "SURE?" : esc(MODES[id].short)
      return `<button class="${cls}" data-host="${id === current ? "reset" : "mode"}" data-mode="${id}" title="${esc(MODES[id].label)}${id === current ? " (current: reset)" : ""}">${label}</button>`
    }).join("")
    return `<div class="hostctl">
      <div class="hh"><b>HOST</b><span>${hint}</span></div>
      <div class="hrow"><button class="reset ${armed === "reset" ? "armed" : ""}" data-host="reset">${armed === "reset" ? "CONFIRM RESET?" : "RESET MATCH"}</button><button class="floor ${this.newFloor ? "on" : ""}" data-host="floor" title="Restart on a new procedural floor, or keep this one">${this.newFloor ? "☑ NEW FLOOR" : "☐ SAME FLOOR"}</button></div>
      <div class="hmodes">${chips}</div>
      <div class="hmaps"><span>MAP</span>${MAP_CHOICES.map((c) => `<button class="${c === maps ? "on" : ""}" data-host="maps" data-map="${c}" title="${esc(MAP_BLURBS[c])} From the next new floor.">${MAP_NAMES[c]}</button>`).join("")}</div>
    </div>`
  }

  /** Vote buttons for the next mode: the current one ("same again") and the three on offer, with live counts. */
  private votes(v: NonNullable<Snapshot["mode"]["votes"]>, current: ModeId): string {
    const options = v.options?.length ? v.options : MODE_IDS.slice(0, 4)
    return `<div class="vote"><div class="vh">NEXT MODE <span>click or press 1–${options.length} · no votes keeps ${esc(MODES[current].short)}</span></div><div class="vopts">${options
      .map(
        (id, i) =>
          `<button class="${v.mine === id ? "on" : ""}" data-act="vote" data-mode="${id}" title="${esc(MODES[id].blurb)}"><kbd>${i + 1}</kbd><b>${esc(MODES[id].label.toUpperCase())}${id === current ? "<small>SAME AGAIN</small>" : ""}</b><em>${v.counts[id] || ""}</em></button>`,
      )
      .join("")}</div></div>`
  }
}
