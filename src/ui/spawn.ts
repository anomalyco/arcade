// Spawn / respawn screen: a numbered aircraft list (same menu language as the main menu) with the selected
// aircraft's detail on the right, team switch, open seats on teammates' aircraft and the respawn timer.
import type { RoomConfig } from "../sim/protocol"
import type { PlayerInfo, SeatIndex, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { VEHICLES, VEHICLE_KINDS, WEAPONS } from "../sim/vehicles"
import { MenuNav, TEAM_COLORS, TEAM_NAMES, controlsTable, escapeHtml, hintsHtml, type MenuItem } from "./lobby"

interface RoleInfo { role: string; blurb: string; agility: number; firepower: number }
const ROLES: Record<VehicleKind, RoleInfo> = {
  fighter: { role: "strike fighter", agility: 0.85, firepower: 0.7, blurb: "Fast, agile all-rounder. Guns and heat-seekers up front, lock-on radar missiles in the back." },
  apache: { role: "attack helicopter", agility: 0.95, firepower: 0.8, blurb: "Hovers, strafes and hides behind ridges. Rockets for the pilot, chain gun and Hellfires for the gunner." },
  warthog: { role: "close air support", agility: 0.45, firepower: 1, blurb: "Slow, armoured, terrifying. The GAU-8 shreds anything it points at." },
  blackbird: { role: "recon interceptor", agility: 0.35, firepower: 0.55, blurb: "The fastest thing in the sky. The pilot flies; the radar officer paints enemies and guides long-range missiles." },
}
const MAX_SPEED = Math.max(...VEHICLE_KINDS.map(k => VEHICLES[k].boost))
const MAX_HP = Math.max(...VEHICLE_KINDS.map(k => VEHICLES[k].maxHp))

/** Controls reference for the current steering scheme (pause menu). */
export function controlsHtml(_heli = false): string {
  return controlsTable()
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

const bar = (v: number) => `<i class="bar"><b style="width:${Math.round(Math.max(0.06, Math.min(1, v)) * 100)}%"></b></i>`

function detailHtml(k: VehicleKind, i: number): string {
  const v = VEHICLES[k], r = ROLES[k]
  const seats = [0, 1].map(s => {
    const ws = v.seatWeapons[s]
    const list = ws[0] === null && ws[1] === null ? [] : (ws[0] !== null && ws[0] === ws[1] ? [ws[0]] : ws).filter(Boolean).map(id => WEAPONS[id!].name.toLowerCase())
    if (s === 0) list.push("flares")
    return `<li><span class="n">${s + 1}</span><span class="s">${escapeHtml(v.seatNames[s])}</span><span class="w">${list.length ? list.join(" · ") : "flies only"}</span></li>`
  }).join("")
  return `<div class="crumb">${String(i + 1).padStart(2, "0")} — ${r.role} · ${v.flight === "heli" ? "vtol" : "jet"}</div>
    <h3 class="name">${escapeHtml(v.name)}</h3>
    <p class="blurb">${r.blurb}</p>
    <dl class="stats">
      <div><dt>speed</dt><dd>${Math.round(v.boost * 3.6)}<small> km/h</small></dd>${bar(v.boost / MAX_SPEED)}</div>
      <div><dt>hull</dt><dd>${v.maxHp}</dd>${bar(v.maxHp / MAX_HP)}</div>
      <div><dt>agility</dt><dd>${Math.round(r.agility * 10)}<small>/10</small></dd>${bar(r.agility)}</div>
      <div><dt>firepower</dt><dd>${Math.round(r.firepower * 10)}<small>/10</small></dd>${bar(r.firepower)}</div>
      <div><dt>flares</dt><dd>${v.flares}</dd></div>
    </dl>
    <ol class="seats">${seats}</ol>`
}

export function createSpawnScreen(parent: HTMLElement, actions: {
  spawn(kind: VehicleKind): void
  board(vehicle: string, seat: SeatIndex): void
  team(team: TeamId): void
  invite(): void
  leave(): void
  click(): void
  /** Optional rendered aircraft thumbnail (team livery). */
  thumb?(kind: VehicleKind, team: TeamId): Promise<string | null>
}): SpawnScreen {
  const root = document.createElement("div")
  root.className = "spawn"
  root.hidden = true
  root.innerHTML = `
    <div class="sp-head">
      <div class="crumb">room <b class="code"></b> · <button class="link invite">copy invite link</button></div>
      <h2 class="title">Choose aircraft</h2>
      <div class="teams" aria-label="Team"></div>
    </div>
    <nav class="screen sp-list"></nav>
    <section class="sp-detail"><img class="thumb" alt="" hidden /><div class="info"></div></section>
    <div class="countdown"><span class="lbl">respawn in</span><span class="num"></span></div>
    <footer class="foot"><div class="hints"></div></footer>`
  parent.appendChild(root)

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T
  const teamsEl = $(".teams")
  const title = $(".title")
  const code = $(".code")
  const info = $(".sp-detail .info")
  const thumbImg = $<HTMLImageElement>(".sp-detail .thumb")
  const countdown = $(".countdown")
  const cdNum = $(".countdown .num")
  const hints = $(".foot .hints")
  const nav = new MenuNav($(".sp-list"), actions.click)
  nav.onHints = h => { hints.innerHTML = hintsHtml(h) }

  let canSpawn = false
  let wait = 0
  let lastTeams = ""
  let boardKey = ""
  let myTeam: TeamId = 0
  let teamCount = 2
  let shownKind: VehicleKind | null = null
  const thumbs = new Map<string, string>()
  const requested = new Set<string>()

  const showDetail = (k: VehicleKind) => {
    if (k === shownKind) return
    shownKind = k
    info.innerHTML = detailHtml(k, VEHICLE_KINDS.indexOf(k))
    paintThumb()
  }
  const paintThumb = () => {
    if (!shownKind) return
    const url = thumbs.get(`${shownKind}:${myTeam}`)
    thumbImg.hidden = !url
    if (url && thumbImg.src !== url) thumbImg.src = url
  }
  const loadThumbs = (team: TeamId) => {
    if (!actions.thumb) return
    for (const k of VEHICLE_KINDS) {
      const key = `${k}:${team}`
      if (requested.has(key)) continue
      requested.add(key)
      actions.thumb(k, team).then(url => { if (url) { thumbs.set(key, url); paintThumb() } })
    }
  }

  let boardItems: MenuItem[] = []
  const launchMeta = () => (canSpawn ? "" : `respawn in ${Math.ceil(wait)} s · `)
  const build = (keepSel = true) => {
    const items: MenuItem[] = VEHICLE_KINDS.map(k => ({
      label: VEHICLES[k].name,
      value: () => (VEHICLES[k].flight === "heli" ? "vtol" : "jet"),
      meta: () => (canSpawn ? "" : `respawn in ${Math.ceil(wait)} s`),
      run: () => { if (canSpawn) actions.spawn(k) },
    }))
    items.push(...boardItems)
    items.push({ label: "Leave match", small: true, run: () => actions.leave(), meta: "back to the main menu" })
    const screen = {
      size: "big" as const, items, sel: keepSel ? nav.index : 0,
      hints: [["↑↓", "select"], ["enter", "launch"], ["←→", "team"], ["1–4", "quick launch"]] as [string, string][],
    }
    if (nav.depth) nav.replace(screen)
    else nav.push(screen)
  }
  nav.onMove = i => { const k = VEHICLE_KINDS[i]; if (k) showDetail(k) }
  nav.onSide = d => { if (teamCount > 1) actions.team(((myTeam + d + teamCount) % teamCount) as TeamId) }
  build(false)
  showDetail(VEHICLE_KINDS[0])

  const onKey = (e: KeyboardEvent) => {
    if (root.hidden || (e.target as HTMLElement)?.tagName === "INPUT") return
    const n = Number(e.key)
    if (n >= 1 && n <= VEHICLE_KINDS.length && !e.repeat) {
      if (canSpawn) { actions.click(); actions.spawn(VEHICLE_KINDS[n - 1]) }
      return
    }
    if (e.key === "Escape") return
    if (nav.handleKey(e)) e.preventDefault()
  }
  window.addEventListener("keydown", onKey)

  root.addEventListener("click", e => {
    const t = e.target as HTMLElement
    const team = t.closest<HTMLElement>("[data-team]")
    if (team) { actions.click(); actions.team(Number(team.dataset.team) as TeamId); return }
    if (t.closest(".invite")) { actions.click(); actions.invite() }
  })

  return {
    root,
    show() { root.hidden = false },
    hide() { root.hidden = true },
    visible: () => !root.hidden,
    update(s) {
      code.textContent = s.room.toLowerCase()
      const me = s.me
      wait = me ? Math.max(0, me.respawnAt - s.time) : 0
      const could = canSpawn
      canSpawn = !!me && wait <= 0
      root.classList.toggle("waiting", !canSpawn)
      countdown.classList.toggle("on", !canSpawn)
      const num = String(Math.ceil(wait)).padStart(2, "0")
      if (cdNum.textContent !== num) cdNum.textContent = num
      const t = s.dead ? "Shot down" : "Choose aircraft"
      if (title.textContent !== t) title.textContent = t
      if (me && me.team !== myTeam) { myTeam = me.team; paintThumb() }
      loadThumbs(myTeam)
      teamCount = s.config.teams

      const counts = new Array(s.config.teams).fill(0)
      for (const p of s.players.values()) if (p.team < counts.length) counts[p.team]++
      const teamsHtml = `<span class="lbl">team</span>` + counts.map((n, t) =>
        `<button data-team="${t}" class="${me?.team === t ? "on" : ""}" style="--c:${TEAM_COLORS[t]}" aria-pressed="${me?.team === t}"><i class="sw"></i>${TEAM_NAMES[t].toLowerCase()}<span>${n}</span></button>`).join("")
      if (teamsHtml !== lastTeams) { teamsEl.innerHTML = teamsHtml; lastTeams = teamsHtml }

      const seats: { v: VehicleEntity; seat: SeatIndex; owner: string }[] = []
      if (me) for (const v of s.vehicles) {
        if (!v.alive || v.team !== me.team) continue
        for (const seat of [0, 1] as SeatIndex[]) {
          if (v.seats[seat] !== null) continue
          const owner = v.seats[seat === 0 ? 1 : 0]
          seats.push({ v, seat, owner: owner ? s.players.get(owner)?.name ?? "?" : "" })
        }
      }
      const key = seats.slice(0, 4).map(x => `${x.v.id}:${x.seat}:${x.owner}`).join("|")
      if (key !== boardKey || could !== canSpawn) {
        boardKey = key
        boardItems = seats.slice(0, 4).map(x => ({
          label: x.owner ? `Join ${x.owner.toLowerCase()}` : `Empty ${VEHICLES[x.v.kind].name}`,
          small: true,
          value: () => VEHICLES[x.v.kind].seatNames[x.seat].toLowerCase(),
          meta: () => `${launchMeta()}board as ${VEHICLES[x.v.kind].seatNames[x.seat].toLowerCase()} · ${VEHICLES[x.v.kind].name}`,
          run: () => { if (canSpawn) actions.board(x.v.id, x.seat) },
        }))
        build()
      } else if (!canSpawn) nav.refresh()
    },
    dispose() { window.removeEventListener("keydown", onKey); root.remove() },
  }
}
