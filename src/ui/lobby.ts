import type { RoomConfig, RoomSummary } from "../sim/protocol"
import { DEFAULT_ROOM_CONFIG } from "../sim/protocol"
import type { Quality } from "../sim/types"
import { callsign, randomCallsign, settings, updateSettings } from "./settings"
import { getNet } from "./net-adapter"
import type { ControlScheme } from "../input"

// Mirrors CONTROL_SCHEMES / CONTROL_SCHEME_LABELS / controlScheme() / setControlScheme() from input.ts.
// Importing input.ts here would drag the whole Input module into the instant-paint entry chunk (+8 kB).
const CONTROL_SCHEMES: readonly ControlScheme[] = ["point", "battlefield", "aim"]
const CONTROL_SCHEME_LABELS: Record<ControlScheme, string> = { point: "Point & turn", battlefield: "Battlefield (mouse = roll)", aim: "Mouse-aim cursor" }
const controlScheme = (): ControlScheme => settings.controlStyle === "aim" ? "aim" : settings.controlScheme === "battlefield" ? "battlefield" : "point"
const setControlScheme = (scheme: ControlScheme) => updateSettings({ controlStyle: scheme === "aim" ? "aim" : "direct", controlScheme: scheme })

const kb = (...keys: string[]) => keys.map(x => `<kbd>${x}</kbd>`).join("")

/** Control rows for a scheme, grouped into sections (shared by the help modal, spawn screen and pause menu). */
export function controlRows(scheme: ControlScheme = controlScheme()): { title: string; rows: [string, string][] }[] {
  const flight: [string, string][] = scheme === "battlefield"
    ? [
        ["Nose up / down", `Mouse ↑↓ (forward = nose down) · ${kb("↑")} down ${kb("↓")} up`],
        ["Roll", `Mouse ←→ · ${kb("←", "→")}`],
        ["Yaw / pedals", `${kb("A", "D")} · ${kb("Q", "E")}`],
      ]
    : scheme === "aim"
    ? [
        ["Steer", "Point the mouse cursor where you want to fly"],
        ["Roll / strafe (heli)", kb("A", "D")],
        ["Rudder / pedal", kb("Q", "E")],
      ]
    : [
        ["Turn", `Mouse ←→ · ${kb("←", "→")}`],
        ["Nose up / down", `Mouse ↑↓ · ${kb("↓")} up ${kb("↑")} down`],
        ["Roll / strafe (heli)", kb("A", "D")],
        ["Rudder / pedal", kb("Q", "E")],
      ]
  flight.push(["Throttle / collective", kb("W", "S")], ["Boost · brake / auto-hover", `${kb("Shift")} · ${kb("X")}`])
  return [
    { title: `Flight · ${CONTROL_SCHEME_LABELS[scheme]}`, rows: flight },
    { title: "Combat", rows: [
      ["Guns", kb("LMB", "Space")], ["Missiles", kb("RMB", "V")], ["Flares · ability", `${kb("F")} · ${kb("R")}`],
      ["Switch seat", `${kb("1", "2")} · gunners aim with the mouse`],
    ] },
    { title: "View & chat", rows: [
      ["Free-look · camera", `hold ${kb("C")} · ${kb("T")}`], ["Chat · scores · menu", `${kb("Enter")} · ${kb("Tab")} · ${kb("Esc")}`],
    ] },
  ]
}

/** 3-way steering selector markup (buttons carry data-scheme). */
export function schemeSegHtml(): string {
  return CONTROL_SCHEMES.map(s => `<button data-scheme="${s}">${CONTROL_SCHEME_LABELS[s].replace(/ \(.*\)$/, "")}</button>`).join("")
}

/** Wire a steering selector: paints the current scheme and persists clicks. */
export function bindSchemeSeg(seg: HTMLElement, onChange?: () => void): () => void {
  if (!seg.querySelector("[data-scheme]")) seg.innerHTML = schemeSegHtml()
  const paint = () => {
    const cur = controlScheme()
    seg.querySelectorAll<HTMLElement>("[data-scheme]").forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.scheme === cur))
      b.title = CONTROL_SCHEME_LABELS[b.dataset.scheme as ControlScheme]
    })
  }
  seg.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-scheme]")
    if (!b) return
    setControlScheme(b.dataset.scheme as ControlScheme)
    paint()
    onChange?.()
  })
  paint()
  return paint
}

export type StartRequest =
  | { mode: "quick" }
  | { mode: "join"; code: string }
  | { mode: "create"; config: Partial<RoomConfig> }
  | { mode: "offline"; config: RoomConfig }

export interface LobbyApi {
  show(): void
  hide(): void
  busy(text: string | null): void
  status(html: string): void
  refreshRooms(): void
}

export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
export const TEAM_NAMES = ["Cobalt", "Amber", "Emerald", "Crimson"]

/** Colorblind-safe team glyph (circle / triangle / square / diamond) in the team colour. */
export function teamGlyph(team: number): string {
  return `<i class="tg" style="--c:${TEAM_COLORS[team]}" aria-hidden="true"></i>`
}


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export function toast(text: string, error = false): void {
  const host = $("toast")
  const el = document.createElement("div")
  el.textContent = text
  if (error) el.className = "err"
  host.appendChild(el)
  setTimeout(() => el.remove(), 3300)
  while (host.childElementCount > 4) host.firstElementChild!.remove()
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

export function initLobby(opts: { onStart(req: StartRequest): void; onQuality(q: Quality): void; onClick?(): void }): LobbyApi {
  const lobby = $("lobby")
  const name = $<HTMLInputElement>("callsign")
  name.value = settings.name
  name.placeholder = randomCallsign()
  name.addEventListener("input", () => updateSettings({ name: name.value.toUpperCase().slice(0, 16) }))
  name.addEventListener("blur", () => { name.value = settings.name })

  const click = () => opts.onClick?.()
  lobby.addEventListener("click", e => { if ((e.target as HTMLElement).closest("button")) click() })

  // Settings bar
  const seg = $("seg-quality")
  const paintQuality = () => seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.q === settings.quality)))
  paintQuality()
  seg.addEventListener("click", e => {
    const q = (e.target as HTMLElement).dataset.q as Quality | undefined
    if (!q) return
    updateSettings({ quality: q })
    paintQuality()
    opts.onQuality(q)
  })
  const sound = $("btn-sound")
  const paintSound = () => { sound.textContent = settings.muted ? "Off" : "On"; sound.setAttribute("aria-pressed", String(!settings.muted)) }
  paintSound()
  sound.addEventListener("click", () => { updateSettings({ muted: !settings.muted }); paintSound() })
  const paintScheme = bindSchemeSeg($("seg-style"), () => renderHelp())
  const renderHelp = () => {
    $("help-keys").innerHTML = controlRows().map(sec =>
      `<tr class="sec"><td colspan="2">${escapeHtml(sec.title)}</td></tr>` + sec.rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")).join("")
  }
  renderHelp()
  const sens = $<HTMLInputElement>("sens")
  sens.value = String(settings.sensitivity)
  sens.addEventListener("input", () => updateSettings({ sensitivity: Number(sens.value) }))

  // Modals
  const openModal = (id: string) => { $(id).hidden = false }
  document.querySelectorAll<HTMLElement>(".modal").forEach(m => {
    m.addEventListener("click", e => {
      if (e.target === m || (e.target as HTMLElement).closest("[data-close]")) m.hidden = true
    })
  })
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") document.querySelectorAll<HTMLElement>(".modal").forEach(m => (m.hidden = true))
  })
  $("btn-help").addEventListener("click", () => { renderHelp(); openModal("help-modal") })
  $("btn-create").addEventListener("click", () => openModal("create-modal"))

  const form = $<HTMLFormElement>("create-form")
  const readForm = (): RoomConfig => {
    const f = new FormData(form)
    const num = (k: string, lo: number, hi: number, d: number) => {
      const v = Math.round(Number(f.get(k)))
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
    }
    return {
      ...DEFAULT_ROOM_CONFIG,
      name: String(f.get("name") || DEFAULT_ROOM_CONFIG.name).slice(0, 32),
      teams: num("teams", 2, 4, 2),
      bots: 0,
      maxPerTeam: num("maxPerTeam", 1, 10, 10),
      scoreLimit: num("scoreLimit", 5, 500, 50),
      timeLimit: num("timeLimit", 2, 60, 15) * 60,
      listed: f.get("listed") === "on",
    }
  }
  form.addEventListener("submit", e => {
    e.preventDefault()
    $("create-modal").hidden = true
    opts.onStart({ mode: "create", config: readForm() })
  })
  $("create-offline").addEventListener("click", () => {
    $("create-modal").hidden = true
    opts.onStart({ mode: "offline", config: readForm() })
  })

  $("btn-quick").addEventListener("click", () => opts.onStart({ mode: "quick" }))
  $("btn-practice").addEventListener("click", () =>
    opts.onStart({ mode: "offline", config: { ...DEFAULT_ROOM_CONFIG, name: "Practice", teams: 2, bots: 0, listed: false } }))
  const code = $<HTMLInputElement>("join-code")
  const join = () => {
    const c = code.value.trim().toUpperCase()
    if (!c) { code.focus(); return }
    opts.onStart({ mode: "join", code: c })
  }
  $("btn-join").addEventListener("click", join)
  code.addEventListener("keydown", e => { if (e.key === "Enter") join() })

  const invite = new URLSearchParams(location.search).get("join")
  if (invite) {
    const c = invite.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
    code.value = c
    $("invite-code").textContent = c
    $("invite").hidden = false
    $("invite-join").addEventListener("click", () => opts.onStart({ mode: "join", code: c }))
  }

  // Room browser
  const list = $("rooms")
  let refreshing = false
  const renderRooms = (rooms: RoomSummary[]) => {
    if (!rooms.length) {
      list.innerHTML = `<li class="empty">No open lobbies right now.<br>Hit <b>Play</b> or <b>Create Lobby</b> to start one.</li>`
      return
    }
    list.innerHTML = rooms.map(r => `<li data-code="${escapeHtml(r.code)}" tabindex="0" class="${r.players >= r.maxPlayers ? "full" : ""}">
      <div class="name">${escapeHtml(r.name)}</div>
      <div class="right"><span class="meta">${r.players >= r.maxPlayers ? "FULL" : `${r.players}/${r.maxPlayers}`}</span><span class="cap"><i style="width:${Math.round(100 * Math.min(1, r.players / Math.max(1, r.maxPlayers)))}%"></i></span></div>
      <div class="meta"><span class="code">${escapeHtml(r.code)}</span><span class="tgs">${Array.from({ length: r.teams }, (_, t) => teamGlyph(t)).join("")}</span><span>${r.humans} pilot${r.humans === 1 ? "" : "s"}</span><span class="go">JOIN</span></div></li>`).join("")
  }
  list.addEventListener("keydown", e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-code]")
    if (li && e.key === "Enter") opts.onStart({ mode: "join", code: li.dataset.code! })
  })
  list.addEventListener("click", e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-code]")
    if (li) opts.onStart({ mode: "join", code: li.dataset.code! })
  })
  const refreshRooms = async () => {
    if (refreshing) return
    refreshing = true
    list.innerHTML = `<li class="empty">Looking for lobbies…</li>`
    try {
      const net = await getNet()
      renderRooms(await net.listRooms())
    } catch {
      list.innerHTML = `<li class="empty">Can't reach the server right now.<br><b>Practice</b> still works offline.</li>`
    } finally {
      refreshing = false
    }
  }
  $("btn-refresh").addEventListener("click", refreshRooms)
  refreshRooms()

  const busyEl = $("busy")
  return {
    show() { paintScheme(); renderHelp(); lobby.hidden = false; document.body.classList.add("in-lobby"); refreshRooms() },
    hide() { lobby.hidden = true; document.body.classList.remove("in-lobby") },
    busy(text) {
      busyEl.hidden = text === null
      if (text !== null) busyEl.querySelector("span")!.textContent = text
    },
    status(html) {
      // Plain status only: hide once the world is up, show failures.
      const el = $("load-status")
      if (/unavailable|failed/i.test(html)) { el.hidden = false; el.textContent = "3D unavailable — WebGL failed to start" }
      else el.hidden = /awake|ready/i.test(html)
    },
    refreshRooms,
  }
}

export { callsign }
