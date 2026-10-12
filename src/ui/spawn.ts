// Spawn / respawn screen: team picker, vehicle picker, open seats on teammates' aircraft.
import type { RoomConfig } from "../sim/protocol"
import type { PlayerInfo, SeatIndex, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { VEHICLES, VEHICLE_KINDS, WEAPONS } from "../sim/vehicles"
import { TEAM_COLORS, TEAM_NAMES, escapeHtml, teamGlyph } from "./lobby"

interface RoleInfo { role: string; blurb: string; icon: string; agility: number; firepower: number }
const ROLES: Record<VehicleKind, RoleInfo> = {
  fighter: { role: "Strike Fighter", agility: 0.85, firepower: 0.7, blurb: "Fast, agile all-rounder. Guns and heat-seekers up front, lock-on radar missiles in the back.",
    icon: "M50 4C52 10 53 18 53.5 26L56 34 60 40 88 54 89 60 60 58 58 70 72 80 72 86 56 84 54 90H46L44 84 28 86V80L42 70 40 58 11 60 12 54 40 40 44 34 46.5 26C47 18 48 10 50 4Z" },
  apache: { role: "Attack Helicopter", agility: 0.95, firepower: 0.8, blurb: "Hovers, strafes and hides behind ridges. Rockets for the pilot, chain gun and Hellfires for the gunner.",
    icon: "M50 10C54 10 55 16 55 22V40L66 42V47L55 48 54 62 52 92H48L46 62 45 48 34 47V42L45 40V22C45 16 46 10 50 10ZM40 84H60V88H40ZM13 19 86 57 85 59 12 21ZM87 19 14 59 13 57 86 17Z" },
  warthog: { role: "Close Air Support", agility: 0.45, firepower: 1, blurb: "Slow, armoured, terrifying. The GAU-8 shreds anything it points at.",
    icon: "M50 6C53 6 54 12 54 18V36L94 40V47L54 48V62H58V58H65V74H58V70H54L53 80H70V86H53L52 92H48L47 86H30V80H47L46 70H42V74H35V58H42V62H46V48L6 47V40L46 36V18C46 12 47 6 50 6Z" },
  blackbird: { role: "Recon Interceptor", agility: 0.35, firepower: 0.55, blurb: "The fastest thing in the sky. The pilot flies; the radar officer paints enemies and guides long-range missiles.",
    icon: "M50 2C52 10 53 22 54 34L58 50 62 52 64 46 66 52 82 74V80L66 78 64 92H60L58 82 54 86H46L42 82 40 92H36L34 78 18 80V74L34 52 36 46 38 52 42 50 46 34C47 22 48 10 50 2Z" },
}
const MAX_SPEED = Math.max(...VEHICLE_KINDS.map(k => VEHICLES[k].boost))
const MAX_HP = Math.max(...VEHICLE_KINDS.map(k => VEHICLES[k].maxHp))

const statBar = (label: string, v: number) =>
  `<div class="stat"><span>${label}</span><i><b style="width:${Math.round(Math.max(0.06, Math.min(1, v)) * 100)}%"></b></i></div>`

/** Unified control scheme (identical for every aircraft); shared by the spawn screen and the pause menu. */
export function controlsHtml(_heli = false): string {
  const k = (...keys: string[]) => keys.map(x => `<kbd>${x}</kbd>`).join("")
  const rows: [string, string][] = [
    ["Pitch", `Mouse Y (fwd = nose down) · ${k("↑")} down ${k("↓")} up`],
    ["Roll", `Mouse X · ${k("←", "→")}`],
    ["Yaw", `${k("A", "D")} · ${k("Q", "E")}`],
    ["Throttle / collective", k("W", "S")],
    ["Boost · brake / hover", `${k("Shift")} · ${k("X")}`],
    ["Guns · missiles", `${k("LMB")}${k("Space")} · ${k("RMB")}${k("V")}`],
    ["Flares · ability", `${k("F")} · ${k("R")}`],
    ["Seat · free-look · view", `${k("1", "2")} · hold ${k("C")} · ${k("T")}`],
    ["Chat · scores · menu", `${k("Enter")} · ${k("Tab")} · ${k("Esc")}`],
  ]
  return `<div class="scheme-grid">${rows.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join("")}</div>`
}

export interface SpawnState {
  me: PlayerInfo | null
  players: Map<string, PlayerInfo>
  vehicles: VehicleEntity[]
  time: number
  config: RoomConfig
  room: string
  dead: boolean
}

export interface SpawnScreen {
  root: HTMLElement
  show(): void
  hide(): void
  visible(): boolean
  update(s: SpawnState): void
  dispose(): void
}

export function createSpawnScreen(parent: HTMLElement, actions: {
  spawn(kind: VehicleKind): void
  board(vehicle: string, seat: SeatIndex): void
  team(team: TeamId): void
  invite(): void
  leave(): void
  click(): void
  /** Optional rendered aircraft thumbnail (team livery); the SVG silhouette shows until it resolves. */
  thumb?(kind: VehicleKind, team: TeamId): Promise<string | null>
}): SpawnScreen {
  const root = document.createElement("div")
  root.className = "spawn"
  root.hidden = true
  root.innerHTML = `
    <header>
      <div class="head">
        <div class="eyebrow"><span>Room <b class="code"></b></span><button class="iconbtn invite">Copy invite link</button></div>
        <h2 class="title">Choose your wings</h2>
      </div>
      <div class="head-right"><div class="countdown"></div><section class="teams" aria-label="Team"></section></div>
    </header>
    <section class="cards">${VEHICLE_KINDS.map((k, i) => {
      const v = VEHICLES[k]
      const r = ROLES[k]
      return `<button class="card" data-kind="${k}" style="--i:${i}">
        <div class="art"><svg viewBox="0 0 100 100" class="icon" aria-hidden="true"><path d="${r.icon}"/></svg><span class="kind">${v.flight === "heli" ? "VTOL" : "JET"}</span></div>
        <div class="role">${r.role}</div>
        <div class="name">${escapeHtml(v.name)}</div>
        <div class="specs"><span><b>${Math.round(v.boost * 3.6)}</b> km/h</span><span><b>${v.maxHp}</b> hp</span><span><b>${v.flares}</b> flares</span></div>
        <p>${r.blurb}</p>
        <div class="stats">
          ${statBar("Speed", v.boost / MAX_SPEED)}
          ${statBar("Agility", r.agility)}
          ${statBar("Armor", v.maxHp / MAX_HP)}
          ${statBar("Firepower", r.firepower)}
        </div>
        <ol class="seats">${[0, 1].map(s => {
          const ws = v.seatWeapons[s]
          const list = ws[0] === null && ws[1] === null ? [] : (ws[0] !== null && ws[0] === ws[1] ? [ws[0]] : ws).filter(Boolean).map(id => WEAPONS[id!].name)
          if (s === 0) list.push("Flares")
          return `<li><span>${s + 1}</span><div><b>${v.seatNames[s]}</b><em>${list.length ? list.map(x => `<i>${x}</i>`).join("") : "<i class=none>Flies only</i>"}</em></div></li>`
        }).join("")}</ol>
        <div class="go"><span>Launch</span><kbd>${i + 1}</kbd></div>
      </button>`
    }).join("")}</section>
    <section class="lower">
      <div class="scheme panel"></div>
      <div class="board-list panel"><h3>Crew a teammate's aircraft</h3><ul></ul></div>
    </section>
    <footer><button class="iconbtn leave">Leave match</button><span class="hint panel"><kbd>1</kbd>–<kbd>4</kbd> quick launch · <kbd>Esc</kbd> menu · <kbd>Tab</kbd> scores</span></footer>`
  parent.appendChild(root)

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T
  const teamsEl = $(".teams")
  const boardUl = $(".board-list ul")
  const boardSec = $(".board-list")
  const countdown = $(".countdown")
  const title = $(".title")
  const code = $(".code")
  const scheme = $(".scheme")
  let schemeKind: VehicleKind | null = null
  const showScheme = (k: VehicleKind) => {
    if (k === schemeKind) return
    schemeKind = k
    scheme.innerHTML = `<h3>Controls <b>${escapeHtml(VEHICLES[k].name)}</b></h3>${controlsHtml(VEHICLES[k].flight === "heli")}`
    root.querySelectorAll(".card").forEach(c => c.classList.toggle("sel", (c as HTMLElement).dataset.kind === k))
  }
  showScheme("fighter")
  root.addEventListener("pointerover", e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card")
    if (card) showScheme(card.dataset.kind as VehicleKind)
  })
  root.addEventListener("focusin", e => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card")
    if (card) showScheme(card.dataset.kind as VehicleKind)
  })
  let canSpawn = false
  let lastTeams = ""
  let lastBoard = ""
  let lastCd = "-"
  let thumbTeam = -1
  const onKey = (e: KeyboardEvent) => {
    if (root.hidden || !canSpawn || e.repeat || (e.target as HTMLElement)?.tagName === "INPUT") return
    const n = Number(e.key)
    if (n >= 1 && n <= VEHICLE_KINDS.length) { actions.click(); actions.spawn(VEHICLE_KINDS[n - 1]) }
  }
  window.addEventListener("keydown", onKey)

  root.addEventListener("click", e => {
    const t = e.target as HTMLElement
    const btn = t.closest("button")
    if (btn) actions.click()
    const card = t.closest<HTMLElement>(".card")
    if (card && canSpawn) { actions.spawn(card.dataset.kind as VehicleKind); return }
    const team = t.closest<HTMLElement>("[data-team]")
    if (team) { actions.team(Number(team.dataset.team) as TeamId); return }
    const b = t.closest<HTMLElement>("[data-board]")
    if (b && canSpawn) { actions.board(b.dataset.board!, Number(b.dataset.seat) as SeatIndex); return }
    if (t.closest(".invite")) actions.invite()
    if (t.closest(".leave")) actions.leave()
  })

  return {
    root,
    show() { root.hidden = false },
    hide() { root.hidden = true },
    visible: () => !root.hidden,
    update(s) {
      code.textContent = s.room
      const me = s.me
      const wait = me ? Math.max(0, me.respawnAt - s.time) : 0
      canSpawn = !!me && wait <= 0
      root.classList.toggle("waiting", !canSpawn)
      const cd = canSpawn ? "" : `Respawn in <b>${Math.ceil(wait)}</b>`
      if (cd !== lastCd) { countdown.innerHTML = cd; lastCd = cd; countdown.classList.toggle("on", !canSpawn) }
      title.textContent = s.dead ? "Shot down. Again?" : "Choose your wings"
      if (me) root.style.setProperty("--team", TEAM_COLORS[me.team])
      if (me && me.team !== thumbTeam && actions.thumb) {
        const team = me.team
        thumbTeam = team
        for (const k of VEHICLE_KINDS) actions.thumb(k, team).then(url => {
          if (!url || thumbTeam !== team) return
          const art = root.querySelector<HTMLElement>(`.card[data-kind="${k}"] .art`)
          if (!art) return
          let img = art.querySelector("img")
          if (!img) { img = document.createElement("img"); img.className = "thumb"; img.alt = ""; art.appendChild(img) }
          img.src = url
          art.classList.add("has-thumb")
        })
      }

      const counts = new Array(s.config.teams).fill(0)
      for (const p of s.players.values()) if (p.team < counts.length) counts[p.team]++
      const teamsHtml = counts.map((n, t) =>
        `<button data-team="${t}" class="${me?.team === t ? "on" : ""}" style="--c:${TEAM_COLORS[t]}" aria-pressed="${me?.team === t}">${teamGlyph(t)}${TEAM_NAMES[t]}<span>${n}</span></button>`).join("")
      if (teamsHtml !== lastTeams) { teamsEl.innerHTML = teamsHtml; lastTeams = teamsHtml }

      const rows: string[] = []
      if (me) for (const v of s.vehicles) {
        if (!v.alive || v.team !== me.team) continue
        for (const seat of [0, 1] as SeatIndex[]) {
          if (v.seats[seat] !== null) continue
          const owner = v.seats[seat === 0 ? 1 : 0]
          const ownerName = owner ? s.players.get(owner)?.name ?? "?" : "Empty"
          rows.push(`<li><div><b>${escapeHtml(ownerName)}</b><span>${escapeHtml(VEHICLES[v.kind].name)}</span></div><button class="iconbtn" data-board="${v.id}" data-seat="${seat}">Board as ${VEHICLES[v.kind].seatNames[seat]}</button></li>`)
        }
      }
      const boardHtml = rows.slice(0, 8).join("")
      if (boardHtml !== lastBoard) { boardUl.innerHTML = boardHtml; lastBoard = boardHtml }
      const boardEmpty = rows.length === 0
      if (boardEmpty !== boardSec.classList.contains("empty")) {
        boardSec.classList.toggle("empty", boardEmpty)
        if (boardEmpty) { boardUl.innerHTML = `<li class="none">No open seats on your team yet — launch and a teammate can join you.</li>`; lastBoard = "" }
      }
    },
    dispose() { window.removeEventListener("keydown", onKey); root.remove() },
  }
}
