// Spawn / respawn screen: team picker, vehicle picker, open seats on teammates' aircraft.
import type { RoomConfig } from "../sim/protocol"
import type { PlayerInfo, SeatIndex, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { VEHICLES, VEHICLE_KINDS, WEAPONS } from "../sim/vehicles"
import { TEAM_COLORS, TEAM_NAMES, escapeHtml } from "./lobby"

const ROLES: Record<VehicleKind, { role: string; blurb: string; icon: string }> = {
  fighter: { role: "Strike Fighter", blurb: "Fast, agile all-rounder. Guns and heat-seekers up front, lock-on radar missiles in the back.", icon: "M50 8 L58 40 L92 56 L92 62 L58 56 L56 80 L66 88 L66 92 L50 88 L34 92 L34 88 L44 80 L42 56 L8 62 L8 56 L42 40 Z" },
  apache: { role: "Attack Helicopter", blurb: "Hovers, strafes and hides behind ridges. Rockets for the pilot, chain gun and Hellfires for the gunner.", icon: "M50 14 L56 30 L56 58 L52 90 L48 90 L44 58 L44 30 Z M10 40 L90 40 L90 44 L10 44 Z M36 52 L64 52 L64 56 L36 56 Z" },
  warthog: { role: "Close Air Support", blurb: "Slow, armoured, terrifying. The GAU-8 shreds anything it points at.", icon: "M50 10 L55 34 L94 40 L94 48 L55 48 L54 72 L72 74 L72 80 L54 82 L50 90 L46 82 L28 80 L28 74 L46 72 L45 48 L6 48 L6 40 L45 34 Z" },
  blackbird: { role: "Recon Interceptor", blurb: "The fastest thing in the sky. The pilot just flies; the radar officer paints enemies and guides long-range missiles.", icon: "M50 4 L56 44 L80 70 L80 78 L56 72 L56 86 L62 94 L38 94 L44 86 L44 72 L20 78 L20 70 L44 44 Z" },
}

/** Pilot control scheme summary (shared by the spawn screen and the pause menu). */
export function controlsHtml(heli: boolean): string {
  const k = (...keys: string[]) => keys.map(x => `<kbd>${x}</kbd>`).join("")
  const rows: [string, string][] = heli
    ? [
        ["Nose up / down", `Mouse Y · ${k("↓")} up ${k("↑")} down`], ["Roll (cyclic)", `Mouse X · ${k("Q")}${k("E")}`],
        ["Yaw (pedals)", k("A", "D")], ["Collective", `${k("W")} up ${k("S")} down`], ["Auto-hover", k("X")], ["Boost", k("Shift")],
      ]
    : [
        ["Pitch", `Mouse Y · ${k("↓")} up ${k("↑")} down`], ["Turn", `Mouse X · ${k("←")}${k("→")}`], ["Roll", k("Q", "E")],
        ["Rudder", k("A", "D")], ["Throttle", `${k("W", "S")} · Wheel`], ["Boost / brake", `${k("Shift")} ${k("X")}`],
      ]
  rows.push(["Guns / missiles", `${k("LMB")}/${k("Space")} · ${k("RMB")}/${k("V")}`], ["Flares · ability", `${k("F")} · ${k("R")}`], ["Seat · free-look · view", `${k("1", "2")} · hold ${k("C")} · ${k("T")}`])
  return `<div class="scheme-grid">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join("")}</div>`
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
}): SpawnScreen {
  const root = document.createElement("div")
  root.className = "spawn"
  root.hidden = true
  root.innerHTML = `
    <header>
      <div><div class="eyebrow">Room <b class="code"></b> <button class="iconbtn invite">Copy invite link</button></div><h2 class="title">Choose your wings</h2></div>
      <div class="countdown"></div>
    </header>
    <section class="teams"></section>
    <section class="cards">${VEHICLE_KINDS.map(k => {
      const v = VEHICLES[k]
      const r = ROLES[k]
      return `<button class="card" data-kind="${k}">
        <svg viewBox="0 0 100 100" class="icon"><path d="${r.icon}"/></svg>
        <div class="role">${r.role} · ${v.flight === "heli" ? "VTOL" : "JET"}</div>
        <div class="name">${escapeHtml(v.name)}</div>
        <p>${r.blurb}</p>
        <div class="stats"><span>HP <b>${v.maxHp}</b></span><span>SPD <b>${Math.round(v.cruise * 3.6)}–${Math.round(v.boost * 3.6)}</b> km/h</span></div>
        <ol class="seats">${[0, 1].map(s => {
          const ws = v.seatWeapons[s]
          const list = ws[0] === null && ws[1] === null ? ["No weapons"] : (ws[0] !== null && ws[0] === ws[1] ? [ws[0]] : ws).map(id => (id ? WEAPONS[id].name : "—"))
          if (s === 0) list.push("Flares")
          return `<li><span>${s + 1}</span><div><b>${v.seatNames[s]}</b><em>${list.join(" · ")}</em></div></li>`
        }).join("")}</ol>
        <div class="go">Launch</div>
      </button>`
    }).join("")}</section>
    <section class="scheme"></section>
    <section class="board-list"><h3>Crew a teammate's aircraft</h3><ul></ul></section>
    <footer><button class="iconbtn leave">Leave match</button><span class="hint">Tip: mouse pitches and turns, <kbd>Q</kbd>/<kbd>E</kbd> roll, <kbd>LMB</kbd>/<kbd>Space</kbd> guns, <kbd>RMB</kbd>/<kbd>V</kbd> missiles. <kbd>Esc</kbd> for menu.</span></footer>`
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
    scheme.innerHTML = `<h3>${escapeHtml(VEHICLES[k].name)} controls</h3>${controlsHtml(VEHICLES[k].flight === "heli")}`
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
      countdown.textContent = canSpawn ? "" : `Respawn in ${Math.ceil(wait)}`
      title.textContent = s.dead ? "Shot down. Again?" : "Choose your wings"
      if (me) root.style.setProperty("--team", TEAM_COLORS[me.team])

      const counts = new Array(s.config.teams).fill(0)
      for (const p of s.players.values()) if (p.team < counts.length) counts[p.team]++
      const teamsHtml = counts.map((n, t) =>
        `<button data-team="${t}" class="${me?.team === t ? "on" : ""}" style="--c:${TEAM_COLORS[t]}"><i></i>${TEAM_NAMES[t]}<span>${n}</span></button>`).join("")
      if (teamsHtml !== lastTeams) { teamsEl.innerHTML = teamsHtml; lastTeams = teamsHtml }

      const rows: string[] = []
      if (me) for (const v of s.vehicles) {
        if (!v.alive || v.team !== me.team) continue
        for (const seat of [0, 1] as SeatIndex[]) {
          if (v.seats[seat] !== null) continue
          const owner = v.seats[seat === 0 ? 1 : 0]
          const ownerName = owner ? s.players.get(owner)?.name ?? "?" : "Empty"
          rows.push(`<li><div><b>${escapeHtml(ownerName)}</b> · ${escapeHtml(VEHICLES[v.kind].name)}</div><button class="iconbtn" data-board="${v.id}" data-seat="${seat}">Board as ${VEHICLES[v.kind].seatNames[seat]}</button></li>`)
        }
      }
      const boardHtml = rows.slice(0, 8).join("")
      if (boardHtml !== lastBoard) { boardUl.innerHTML = boardHtml; lastBoard = boardHtml }
      boardSec.hidden = rows.length === 0
    },
    dispose() { root.remove() },
  }
}
