import { MAP_CHOICES, type MapChoice, mapChoiceOf, mapLabel } from "../../shared/maps"
import { MODES, modeChoices, type ModeId, TEAM_NAMES, modeOf } from "../../shared/sim/modes"
import { hostPicks } from "../../shared/sim/host"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import "./teams.css"
import "./maps.css"
import { css, type Rgb3 } from "../game/game"
import { TEAM_COLORS } from "../game/mode-fx"
import { boardStat, rulesColumns, rulesTeam, rulesWinner } from "./rules-hud"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
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

/**
 * Blackout's picks on the shell's title card: the mode for Bot practice and a new private room, the map that room
 * plays on, Solo sandbox, and the live player count.
 */
export class LandingPicks {
  readonly el: HTMLDivElement
  /** The mode Bot practice and Play with friends use. */
  mode: ModeId = modeChoices().find((id) => id === localStorage.getItem(MODE_KEY)) ?? "tdm"
  /** What a new private room plays on. */
  maps: MapChoice = mapChoiceOf(localStorage.getItem(MAP_KEY)) ?? "random"

  constructor(sandbox: () => void) {
    this.el = document.createElement("div")
    this.el.className = "landing picks"
    this.el.innerHTML = `<div class="pickhead">MODE <span>bot practice and new rooms</span></div>
      <div class="modepick">${modeChoices().map((m) => `<button class="${m === this.mode ? "on" : ""}" data-mode="${m}" title="${esc(MODES[m].label)}">${esc(MODES[m].short)}</button>`).join("")}</div>
      <div class="modeblurb">${this.blurbHtml(this.mode)}</div>
      <div class="pickhead">MAP <span>new rooms</span></div>
      <div class="mappick">${MAP_CHOICES.map((m) => `<button class="${m === this.maps ? "on" : ""}" data-map="${m}" title="${esc(MAP_BLURBS[m])}">${MAP_NAMES[m]}</button>`).join("")}</div>
      <div class="modeblurb">${this.mapBlurbHtml(this.maps)}</div>
      <div class="pickfoot"><button class="sandbox" data-act="sandbox">SOLO SANDBOX</button><div class="stats"></div></div>`
    this.el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("button")
      if (!t) return
      if (t.dataset.act === "sandbox") return sandbox()
      const m = modeOf(t.dataset.mode)
      if (m) return this.pickMode(m)
      const map = mapChoiceOf(t.dataset.map)
      if (map) this.pickMap(map)
    })
    // Hovering a mode chip shows its blurb; anywhere else, the picked mode's.
    this.el.addEventListener("mouseover", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".modepick [data-mode]")
      this.blurb(modeOf(t?.dataset.mode) ?? this.mode)
    })
  }

  /** Live counts under the picks. */
  stats(players: number, games: number): void {
    const el = this.el.querySelector(".stats")
    if (el) el.textContent = players ? `${players} playing · ${games} open game${games === 1 ? "" : "s"}` : ""
  }

  private pickMode(m: ModeId): void {
    this.mode = m
    localStorage.setItem(MODE_KEY, m)
    for (const b of this.el.querySelectorAll<HTMLElement>(".modepick [data-mode]")) b.classList.toggle("on", b.dataset.mode === m)
    this.blurb(m)
  }

  private pickMap(m: MapChoice): void {
    this.maps = m
    localStorage.setItem(MAP_KEY, m)
    for (const b of this.el.querySelectorAll<HTMLElement>(".mappick [data-map]")) b.classList.toggle("on", b.dataset.map === m)
    const el = this.el.querySelector(".mappick + .modeblurb")
    if (el) el.innerHTML = this.mapBlurbHtml(m)
  }

  private blurb(m: ModeId): void {
    const el = this.el.querySelector(".modepick + .modeblurb")
    const html = this.blurbHtml(m)
    if (el && el.innerHTML !== html) el.innerHTML = html
  }

  private blurbHtml(m: ModeId): string {
    return `<b>${esc(MODES[m].label.toUpperCase())}</b>${esc(MODES[m].blurb)}`
  }

  private mapBlurbHtml(m: MapChoice): string {
    return `<b>${MAP_NAMES[m]}</b>${esc(MAP_BLURBS[m])}`
  }
}

/** The scoreboard (held with Tab, and shown between floors). */
export class Menus {
  private key = ""
  /** Host controls: the restart waiting on its confirming click ("reset" or a mode), and whether it's a new floor. */
  private armed: { what: string; at: number } | null = null
  private newFloor = true

  constructor(
    private root: HTMLElement,
    private a: MenuActions,
  ) {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act=vote]")
      const m = modeOf(t?.dataset.mode)
      if (m) this.a.vote(m)
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
    const chips = modeChoices(current).map((id) => {
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
    const choices = modeChoices(current)
    const options = (v.options?.length ? v.options : choices.slice(0, 4)).filter((id) => choices.includes(id))
    return `<div class="vote"><div class="vh">NEXT MODE <span>click or press 1–${options.length} · no votes keeps ${esc(MODES[current].short)}</span></div><div class="vopts">${options
      .map(
        (id, i) =>
          `<button class="${v.mine === id ? "on" : ""}" data-act="vote" data-mode="${id}" title="${esc(MODES[id].blurb)}"><kbd>${i + 1}</kbd><b>${esc(MODES[id].label.toUpperCase())}${id === current ? "<small>SAME AGAIN</small>" : ""}</b><em>${v.counts[id] || ""}</em></button>`,
      )
      .join("")}</div></div>`
  }
}
